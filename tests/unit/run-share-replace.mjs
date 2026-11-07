/**
 * P2 使用反馈 #3 — single-file export conflict / replace flow (offline, real fs).
 *
 * The export pipeline is create-only by default: an exact target name that
 * already exists is refused with `TARGET_EXISTS` rather than overwritten. The
 * conflict modal turns that refusal into 替换 / 另存为 / 取消, and only an
 * explicit 替换 produces a `ShareReplacePlan` consumed by the adapter's
 * dedicated `replaceVerified`. This file exercises the safe-swap primitive
 * directly against a real temporary directory:
 *
 *   - an exact existing target is refused (no `replace` plan) — TARGET_EXISTS;
 *   - a replace plan swaps the file, reports `replaced: true`, and the bytes /
 *     SHA-256 of the published file match the document;
 *   - after a successful replace there is no leftover backup;
 *   - a plan whose expected-old fingerprint no longer matches the on-disk file
 *     is refused (TARGET_CHANGED) and the on-disk file is left untouched;
 *   - a foreign-looking change during the window is never silently destroyed.
 *
 * The modal itself (Obsidian UI) is exercised by the sandbox e2e; here we lock
 * down the security-critical primitive it depends on.
 *
 * Run with: node tests/unit/run-share-replace.mjs
 */
import { build } from 'esbuild'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const tmp = path.join(here, '.tmp')

/* --------------------------------------------------------------- harness -- */

let passed = 0
const failures = []

async function check(name, fn) {
	try {
		await fn()
		passed++
		console.log(`  ok   ${name}`)
	} catch (error) {
		failures.push({ name, message: error.message })
		console.log(`  FAIL ${name}`)
		console.log(`       ${error.message}`)
	}
}

function assert(condition, message) {
	if (!condition) throw new Error(message)
}

function sha256Hex(bytes) {
	return crypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex')
}

async function expectThrow(fn, predicate, label) {
	try {
		await fn()
	} catch (error) {
		if (predicate && !predicate(error)) {
			throw new Error(`${label}: 抛出的错误不符合预期：${error.message}`)
		}
		return error
	}
	throw new Error(`${label}: 预期抛错但没有`)
}

/** `obsidian` stays external; a local stub keeps the bundle runnable alone. */
function prepareObsidianStub() {
	const dir = path.join(tmp, 'node_modules', 'obsidian')
	fs.mkdirSync(dir, { recursive: true })
	fs.copyFileSync(path.join(here, 'obsidian-stub.mjs'), path.join(dir, 'index.mjs'))
	fs.writeFileSync(
		path.join(dir, 'package.json'),
		JSON.stringify(
			{ name: 'obsidian', version: '0.0.0-stub', type: 'module', main: 'index.mjs', exports: './index.mjs' },
			null,
			2
		)
	)
}

async function bundle(entry, name) {
	fs.mkdirSync(tmp, { recursive: true })
	const outfile = path.join(tmp, `${name}.mjs`)
	await build({
		entryPoints: [path.join(root, entry)],
		outfile,
		bundle: true,
		format: 'esm',
		platform: 'node',
		target: 'node18',
		external: ['obsidian'],
		logLevel: 'silent'
	})
	return import(`${pathToFileURL(outfile).href}?v=${Date.now()}`)
}

prepareObsidianStub()
const adapterMod = await bundle('src/export/external/adapter.ts', 'sr-adapter')
const shareMod = await bundle('src/export/share-publish.ts', 'sr-share')

const createExternalAdapter = adapterMod.createExternalAdapter
const writeShareFile = shareMod.writeShareFile
const ShareWriteError = shareMod.ShareWriteError
const moduleSha256 = shareMod.sha256Hex

/* -------------------------------------------------------------- fixtures -- */

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'he-sr-'))
const BASE = path.join(SCRATCH, 'export')
fs.mkdirSync(BASE, { recursive: true })

const host = {
	vaultBase: SCRATCH,
	pluginDir: path.join(SCRATCH, '.obsidian', 'plugins', 'html-export-preview'),
	configDir: path.join(SCRATCH, '.obsidian'),
	fs: fs.promises,
	path,
	async savePath() {
		throw new Error('these tests must not open a dialog')
	},
	async pickFolder() {
		throw new Error('these tests must not open a dialog')
	}
}

const adapter = createExternalAdapter(host, BASE)

/** `writeShareFile` only touches `app.vault.adapter` when no destination is given. */
const app = { vault: { adapter: {} } }

const NOTE_TITLE = '示例笔记'
const NOTE_PATH = 'docs/示例笔记.md'

function readFileBytes(rel) {
	return new Uint8Array(fs.readFileSync(path.join(BASE, rel)))
}

function writeForeign(rel, text) {
	fs.writeFileSync(path.join(BASE, rel), text)
}

function removeIfExists(rel) {
	try {
		fs.unlinkSync(path.join(BASE, rel))
	} catch {
		// nonexistent
	}
}

/* ----------------------------------------------------------------- tests -- */

console.log('P2 使用反馈 #3 — 单文件覆盖确认（离线，真实 fs）')

await check('有适配器时模块 sha256Hex 与 Node 一致', async () => {
	const bytes = new TextEncoder().encode('hello')
	const a = await moduleSha256(bytes)
	const b = sha256Hex(bytes)
	assert(a === b, `模块实现与 Node 不一致：${a} vs ${b}`)
})

await check('目标已存在且无 replace 计划：抛出 TARGET_EXISTS，文件逐字节不变', async () => {
	removeIfExists('a.html')
	const original = '<html><body>原始文件，不能被动</body></html>'
	writeForeign('a.html', original)

	await expectThrow(
		() =>
			writeShareFile(
				app,
				'<html><body>新内容</body></html>',
				'',
				NOTE_TITLE,
				NOTE_PATH,
				200,
				null,
				adapter,
				'a.html',
				null
			),
		error => error instanceof ShareWriteError && error.code === 'TARGET_EXISTS',
		'TARGET_EXISTS 拒绝'
	)

	const after = fs.readFileSync(path.join(BASE, 'a.html'), 'utf8')
	assert(after === original, '原文件被改动，违反了 no-clobber')
})

await check('明确的 replace 计划：安全替换，replaced=true，字节与 SHA-256 一致', async () => {
	removeIfExists('b.html')
	const original = '<html><body>将被替换的旧文件</body></html>'
	writeForeign('b.html', original)

	// Fingerprint the old file exactly as `main.makeReplacePlan` would.
	const oldBytes = readFileBytes('b.html')
	const plan = { bytes: oldBytes.byteLength, sha256: sha256Hex(oldBytes) }

	const newHtml = '<html><body>替换后的新内容 中文 ✅</body></html>'
	const expectedNew = sha256Hex(new TextEncoder().encode(newHtml))

	const result = await writeShareFile(
		app,
		newHtml,
		'',
		NOTE_TITLE,
		NOTE_PATH,
		200,
		null,
		adapter,
		'b.html',
		plan
	)

	assert(result.replaced === true, 'replaced 应为 true')
	assert(result.renamed === false, 'renamed 应为 false')
	assert(result.leftoverBackup === null, '不应遗留备份文件')
	assert(result.bytes === Buffer.byteLength(newHtml, 'utf8'), '字节数不一致')
	assert(result.sha256 === expectedNew, '报告的 SHA-256 与文档不一致')

	const onDisk = fs.readFileSync(path.join(BASE, 'b.html'), 'utf8')
	assert(onDisk === newHtml, '磁盘文件不是替换后的内容')
	assert(
		sha256Hex(readFileBytes('b.html')) === expectedNew,
		'磁盘文件 SHA-256 与文档不一致'
	)

	// No stray backup / temp files left behind.
	const leftovers = fs.readdirSync(BASE).filter(f => f.startsWith('.he-'))
	assert(leftovers.length === 0, `不应有残留的 .he-* 文件：${leftovers.join(', ')}`)
})

await check('确认后目标被改动（TARGET_CHANGED）：拒绝替换，原文件保持被篡改状态', async () => {
	removeIfExists('c.html')
	const original = '<html><body>确认时的旧文件</body></html>'
	writeForeign('c.html', original)

	// Plan fingerprinting a *different* (now-stale) old content.
	const plan = {
		bytes: Buffer.byteLength('完全不同的旧内容', 'utf8'),
		sha256: sha256Hex(new TextEncoder().encode('完全不同的旧内容'))
	}

	// Tamper with the target after the (hypothetical) confirmation: now it no
	// longer matches the plan's expected-old fingerprint.
	writeForeign('c.html', '<html><body>确认后被别的程序改写了</body></html>')

	await expectThrow(
		() =>
			writeShareFile(
				app,
				'<html><body>试图写入的新内容</body></html>',
				'',
				NOTE_TITLE,
				NOTE_PATH,
				200,
				null,
				adapter,
				'c.html',
				plan
			),
		error => error instanceof ShareWriteError && error.code === 'TARGET_CHANGED',
		'TARGET_CHANGED 拒绝'
	)

	const onDisk = fs.readFileSync(path.join(BASE, 'c.html'), 'utf8')
	assert(
		onDisk === '<html><body>确认后被别的程序改写了</body></html>',
		'原文件不应被替换'
	)
})

await check('replace 计划但适配器无 replaceVerified：REPLACE_UNSUPPORTED', async () => {
	removeIfExists('d.html')
	writeForeign('d.html', '<html><body>foreign</body></html>')
	const oldBytes = readFileBytes('d.html')
	const plan = { bytes: oldBytes.byteLength, sha256: sha256Hex(oldBytes) }

	// Strip the dedicated swap capability: the caller must refuse and offer 另存为.
	const stripped = Object.assign(Object.create(Object.getPrototypeOf(adapter)), adapter)
	delete stripped.replaceVerified

	await expectThrow(
		() =>
			writeShareFile(
				app,
				'<html><body>new</body></html>',
				'',
				NOTE_TITLE,
				NOTE_PATH,
				200,
				null,
				stripped,
				'd.html',
				plan
			),
		error => error instanceof ShareWriteError && error.code === 'REPLACE_UNSUPPORTED',
		'REPLACE_UNSUPPORTED 拒绝'
	)

	const onDisk = fs.readFileSync(path.join(BASE, 'd.html'), 'utf8')
	assert(onDisk === '<html><body>foreign</body></html>', '原文件不应被替换')
})

/* ----------------------------------------------------------------- close -- */

fs.rmSync(SCRATCH, { recursive: true, force: true })

console.log(`\n总计：PASS ${passed} / FAIL ${failures.length}`)
if (failures.length > 0) {
	console.log('FAILURES:')
	for (const f of failures) console.log(`  - ${f.name}: ${f.message}`)
	process.exit(1)
}
console.log('OK')
