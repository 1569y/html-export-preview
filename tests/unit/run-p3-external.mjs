/**
 * Task 3 offline tests — exporting to a folder outside the Vault.
 *
 * These run against a **real** temporary directory tree, not a fake adapter:
 * the whole point of the external mode is that it reaches the real filesystem,
 * so the containment rule, the exclusive create and the post-write verification
 * are only meaningful if a real `fs` is on the other side.
 *
 * What is covered:
 *
 *   1. the facade's containment (no `..`, no absolute path, nothing outside base)
 *   2. the target validator (relative / `..` / plugin dir / `.obsidian` /
 *      symlink or junction ancestor / file-vs-folder)
 *   3. the share file: exact name, SHA-256 verified, existing file never replaced
 *   4. the package: a `slug-suffix` directory inside the chosen folder, signed
 *      manifest, verified on disk, and a foreign directory left untouched
 *   5. the host probe: a runtime without `require` reports why, instead of throwing
 *
 * Run with: npm run test:p3-external
 */
import { build } from 'esbuild'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { El, installDomGlobals } from './dom-double.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const tmp = path.join(here, '.tmp')

installDomGlobals()

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

function assertEqual(actual, expected, label) {
	const a = JSON.stringify(actual)
	const e = JSON.stringify(expected)
	if (a !== e) throw new Error(`${label}: expected ${e}, got ${a}`)
}

function assertMatch(value, regex, label) {
	if (!regex.test(String(value))) {
		throw new Error(`${label}: ${regex} 未匹配 ${JSON.stringify(String(value).slice(0, 300))}`)
	}
}

async function expectThrow(fn, matcher, label) {
	try {
		await fn()
	} catch (error) {
		if (matcher && !matcher(error)) {
			throw new Error(`${label}: 抛出的错误不符合预期：${error.message}`)
		}
		return error
	}
	throw new Error(`${label}: 预期抛错但没有`)
}

/** `obsidian` stays external; a tiny local stub keeps this file runnable alone. */
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
const hostMod = await bundle('src/export/external/host.ts', 'p3-host')
const adapterMod = await bundle('src/export/external/adapter.ts', 'p3-adapter')
const targetMod = await bundle('src/export/external/target.ts', 'p3-target')
const writerMod = await bundle('src/export/writer.ts', 'p3-writer')
const shareMod = await bundle('src/export/share-publish.ts', 'p3-share')
const assetsMod = await bundle('src/assets/resource-manager.ts', 'p3-assets')
const pathSafetyMod = await bundle('src/export/path-safety.ts', 'p3-path-safety')
const signingMod = await bundle('src/export/manifest-signing.ts', 'p3-signing')

/* -------------------------------------------------------------- fixtures -- */

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'he-p3-'))
const VAULT = path.join(SCRATCH, 'vault')
const OUTSIDE = path.join(SCRATCH, 'outside')
const PLUGIN_DIR = path.join(VAULT, '.obsidian', 'plugins', 'html-export-preview')
const CONFIG_DIR = path.join(VAULT, '.obsidian')

for (const dir of [VAULT, OUTSIDE, PLUGIN_DIR]) fs.mkdirSync(dir, { recursive: true })

/** A real host, with the dialog functions never called by these tests. */
const host = {
	vaultBase: VAULT,
	pluginDir: PLUGIN_DIR,
	configDir: CONFIG_DIR,
	fs: fs.promises,
	path,
	async savePath() {
		throw new Error('these tests must not open a dialog')
	},
	async pickFolder() {
		throw new Error('these tests must not open a dialog')
	}
}

/**
 * The `App` shape the writer needs. `vaultFiles` seeds real bytes for the
 * media/font fixtures used by test E; `getAbstractFileByPath` deliberately
 * returns null so `AssetCollector` resolves through the exact-match branch of
 * `getFiles()` (no `TFile` instance identity needed).
 */
function makeApp(vaultFiles = []) {
	const files = new Map()
	for (const entry of vaultFiles) files.set(entry.path, entry.bytes)
	const adapter = {
		async exists(p) { return files.has(p) },
		async mkdir() {},
		async write(p, data) { files.set(p, String(data)) },
		async writeBinary(p, data) { files.set(p, Buffer.from(data)) },
		async read(p) { return files.get(p) ?? '' },
		async readBinary(p) { return files.get(p) ?? new ArrayBuffer(0) },
		async rename(from, to) {
			for (const key of [...files.keys()]) {
				if (key === from || key.startsWith(`${from}/`)) {
					const value = files.get(key)
					files.delete(key)
					files.set(`${to}${key.slice(from.length)}`, value)
				}
			}
		},
		async remove(p) { files.delete(p) },
		async rmdir(p) {
			for (const key of [...files.keys()]) if (key.startsWith(p)) files.delete(key)
		},
		async list() { return { files: [], folders: [] } },
		async stat() { return { size: 1, mtime: 0, ctime: 0, type: 'file' } }
	}
	const index = vaultFiles.map(entry => ({
		path: entry.path,
		name: entry.path.split('/').pop() ?? entry.path,
		stat: { size: entry.bytes.byteLength }
	}))
	return {
		vault: {
			adapter,
			getAbstractFileByPath: () => null,
			getFiles: () => index
		},
		files
	}
}

const SNAPSHOT = {
	notePath: 'notes/外部导出.md',
	noteTitle: '外部导出',
	capturedAt: '2026-11-06T00:00:00.000Z',
	captureWidth: 1200,
	root: { className: '', style: '', data: {}, bodyClassName: 'theme-light' },
	reading: { className: '', style: '', data: {} },
	preview: { className: '', style: '', data: {} },
	resolution: { sizer: null, readingRoot: null, previewRoot: null, candidates: [], reason: '', ambiguity: false, error: null },
	previewMetrics: { width: 1200, paddingLeft: 0, paddingRight: 0, readableLineWidth: true, fileLineWidth: null },
	sizer: new El('div'),
	stats: { images: 0, mermaid: 0, mermaidWithSvg: 0, sidenotes: 0, sidenoteLeft: 0, sidenoteRight: 0, marginNotes: 0, stylesheets: 0, bytesOfContent: 10, blocks: 1, math: 0 },
	warnings: []
}

const SIGNING_KEY = 'a1'.repeat(32)
const BODY_START = '<!--he-body-start-->'
const BODY_END = '<!--he-body-end-->'
const page = (body = '<p>正文</p>') =>
	`<!doctype html>\n<html>\n<head><title>t</title></head>\n<body>\n${BODY_START}\n${body}\n${BODY_END}\n</body>\n</html>\n`
const EXTRA = {
	css: { bytes: 100, sheets: [], warnings: [] },
	pluginVersion: '0.1.0',
	audit: { generatedAt: 'x', U1_sidenoteStructure: {} }
}

const sha = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
const shaBytes = b => crypto.createHash('sha256').update(b).digest('hex')
const readText = p => fs.readFileSync(p, 'utf8')

/* ------------------------------------------- no-clobber shared fixtures -- */

/** `writeExport(..., outputRoot = '')` always picks this relative folder. */
const finalDirName = pathSafetyMod.resolveExportDir('', SNAPSHOT.noteTitle, SNAPSHOT.notePath).dir
const freshBase = label => fs.mkdtempSync(path.join(SCRATCH, `${label}-`))

/** Byte-identical, non-trivial media/font payloads for the completeness test. */
const IMG_BYTES = Buffer.from(crypto.randomBytes(4096))
IMG_BYTES.writeUInt32BE(0x89504e47, 0)
const FONT_BYTES = Buffer.from(crypto.randomBytes(2048))
FONT_BYTES.write('wOF2', 0, 'ascii')
const MEDIA_FILES = [
	{ path: 'media/figure.png', bytes: IMG_BYTES },
	{ path: 'fonts/theme.woff2', bytes: FONT_BYTES }
]
const MEDIA_REFS = [
	{ url: 'app://vault/media/figure.png', prefix: 'assets/media/', source: 'html', role: 'content' },
	{ url: 'app://vault/fonts/theme.woff2', prefix: 'media/', source: 'css', role: 'environment' }
]

/**
 * Run the *real* export transaction against a real folder on disk.
 * `opts.host` / `opts.wrapAdapter` inject deterministic faults at the syscall
 * or adapter boundary; every actual file operation still goes through node:fs.
 */
async function exportOnce(base, opts = {}) {
	const app = makeApp(opts.vaultFiles ?? [])
	let adapter = adapterMod.createExternalAdapter(opts.host ?? host, base)
	if (opts.wrapAdapter) adapter = opts.wrapAdapter(adapter)
	const assets = new assetsMod.AssetCollector(app)
	for (const ref of opts.refs ?? []) {
		const mapped = assets.resolve(ref.url, ref.prefix, ref.source, ref.role)
		assert(mapped, `资源应解析成功：${ref.url}`)
	}
	return writerMod.writeExport(
		app,
		SNAPSHOT,
		opts.html ?? page('<p>pkg</p>'),
		opts.css ?? 'body{}',
		assets,
		'',
		EXTRA,
		SIGNING_KEY,
		null,
		adapter
	)
}

/** Recursively hash every file in a tree, so "unchanged" is byte-level. */
function treeHash(root) {
	const out = {}
	const walk = dir => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const full = path.join(dir, entry.name)
			const rel = path.relative(root, full).replace(/\\/g, '/')
			if (entry.isDirectory()) {
				out[`${rel}/`] = '<dir>'
				walk(full)
			} else if (entry.isFile()) out[rel] = sha(full)
		}
	}
	walk(root)
	return out
}

/** Wrap node:fs/promises so other methods keep their real `this`. */
function fsProxy(overrides) {
	return new Proxy(fs.promises, {
		get(target, prop) {
			if (prop in overrides) return overrides[prop]
			const value = Reflect.get(target, prop)
			return typeof value === 'function' ? value.bind(target) : value
		}
	})
}

/* ------------------------------------------------- 1. facade containment -- */

console.log('\n1 — 外部适配器的路径围栏')

await check('1.1 拒绝 “..”、绝对路径与盘符跳出所选目录', () => {
	const base = OUTSIDE
	for (const bad of ['../escape.txt', 'a/../../escape.txt', path.join(OUTSIDE, 'x.txt'), 'C:/Windows/x.txt']) {
		let threw = false
		try {
			adapterMod.resolveUnderBase(path, base, bad)
		} catch (error) {
			threw = true
			assertMatch(error.message, /路径越界/, `${bad} 的拒绝理由`)
		}
		assert(threw, `${bad} 必须被拒绝`)
	}
	const ok = adapterMod.resolveUnderBase(path, base, 'note/sub/file.html')
	assert(ok.startsWith(base), '合法相对路径应落在所选目录内')
})

await check('1.2 适配器读写往返，list 返回带前缀的相对路径', async () => {
	const base = fs.mkdtempSync(path.join(SCRATCH, 'roundtrip-'))
	const adapter = adapterMod.createExternalAdapter(host, base)
	await adapter.mkdir('assets/media')
	await adapter.write('assets/media/a.txt', 'hello')
	await adapter.writeBinary('b.bin', new Uint8Array([1, 2, 3]))
	assertEqual(await adapter.read('assets/media/a.txt'), 'hello', '文本往返')
	const bin = new Uint8Array(await adapter.readBinary('b.bin'))
	assertEqual([...bin], [1, 2, 3], '二进制往返')
	const listed = await adapter.list('assets')
	assertEqual(listed.files, [], 'list 只列直接子项，不递归')
	assertEqual(listed.folders, ['assets/media'], 'list 的目录路径带前缀')
	const inner = await adapter.list('assets/media')
	assertEqual(inner.files, ['assets/media/a.txt'], 'list 的文件路径带前缀')
	assertEqual((await adapter.stat('assets/media/a.txt')).size, 5, 'stat 提供真实大小')
})

await check('1.3 createExclusive 只创建一次，第二次返回 exists 且原内容不变', async () => {
	const base = fs.mkdtempSync(path.join(SCRATCH, 'excl-'))
	const adapter = adapterMod.createExternalAdapter(host, base)
	assertEqual(await adapter.createExclusive('a.html', new TextEncoder().encode('first')), 'created', '首次创建')
	assertEqual(await adapter.createExclusive('a.html', new TextEncoder().encode('second')), 'exists', '同名返回 exists')
	assertEqual(readText(path.join(base, 'a.html')), 'first', '原文件不得被覆盖')
})

await check('1.4 rename 拒绝覆盖同名文件，旧文件逐字节不变', async () => {
	// Node's fs.rename maps to MoveFileExW(MOVEFILE_REPLACE_EXISTING); measured
	// on this machine, renaming a *directory* onto an existing *file* succeeds
	// and the file is replaced by a directory. The facade must refuse instead.
	const base = fs.mkdtempSync(path.join(SCRATCH, 'rename-file-'))
	const adapter = adapterMod.createExternalAdapter(host, base)
	fs.writeFileSync(path.join(base, 'target'), 'USER DATA')
	fs.mkdirSync(path.join(base, 'staging'))
	fs.writeFileSync(path.join(base, 'staging', 'index.html'), '<p>x</p>')
	const before = sha(path.join(base, 'target'))

	let threw = null
	try {
		await adapter.rename('staging', 'target')
	} catch (error) {
		threw = error
	}
	assert(threw, '目录 rename 到同名文件必须被拒绝')
	assertEqual(threw.code, 'EEXIST', '应报 EEXIST 而不是可重试的 EPERM')
	assertEqual(sha(path.join(base, 'target')), before, '原文件内容必须逐字节不变')
	assertEqual(fs.statSync(path.join(base, 'target')).isFile(), true, '原文件仍是文件')
	assertEqual(fs.existsSync(path.join(base, 'staging', 'index.html')), true, '暂存内容仍完整')
})

await check('1.5 rename 拒绝覆盖同名目录；目标空闲时仍可发布', async () => {
	const base = fs.mkdtempSync(path.join(SCRATCH, 'rename-dir-'))
	const adapter = adapterMod.createExternalAdapter(host, base)
	fs.mkdirSync(path.join(base, 'occupied'))
	fs.writeFileSync(path.join(base, 'occupied', 'keep.txt'), 'USER')
	fs.mkdirSync(path.join(base, 'staging'))
	fs.writeFileSync(path.join(base, 'staging', 'index.html'), '<p>x</p>')

	let threw = null
	try {
		await adapter.rename('staging', 'occupied')
	} catch (error) {
		threw = error
	}
	assert(threw, '目标目录已存在时必须拒绝')
	assertEqual(readText(path.join(base, 'occupied', 'keep.txt')), 'USER', '目标目录内容不变')

	// A free destination still publishes, which is the normal transaction path.
	await adapter.rename('staging', 'published')
	assertEqual(readText(path.join(base, 'published', 'index.html')), '<p>x</p>', '空闲目标正常发布')
})

/* ------------------------------------------------------ 2. target checks -- */

console.log('\n2 — 目标路径校验')

await check('2.1 相对路径被拒绝（绝不当作“相对 Vault”）', async () => {
	await expectThrow(
		() => targetMod.resolveExternalTarget(host, 'some/relative.html', 'file'),
		e => /绝对路径/.test(e.message),
		'相对路径'
	)
})

await check('2.2 含 “..” 的路径被拒绝，且不先做归一化', async () => {
	await expectThrow(
		() => targetMod.resolveExternalTarget(host, `${OUTSIDE}/../escape.html`, 'file'),
		e => /\.\./.test(e.message),
		'.. 路径'
	)
})

await check('2.3 插件安装目录被拒绝', async () => {
	const target = path.join(PLUGIN_DIR, 'main.js')
	await expectThrow(
		() => targetMod.resolveExternalTarget(host, target, 'file'),
		e => /插件自己的安装目录/.test(e.message),
		'插件目录'
	)
})

await check('2.4 .obsidian 配置目录被拒绝', async () => {
	await expectThrow(
		() => targetMod.resolveExternalTarget(host, path.join(CONFIG_DIR, 'appearance.json'), 'file'),
		e => /配置目录/.test(e.message),
		'.obsidian'
	)
})

await check('2.5 经目录联接（junction）的路径被拒绝', async () => {
	const real = fs.mkdtempSync(path.join(SCRATCH, 'real-'))
	const link = path.join(SCRATCH, `link-${Date.now().toString(36)}`)
	let created = false
	try {
		fs.symlinkSync(real, link, 'junction')
		created = true
	} catch {
		created = false
	}
	if (!created) {
		console.log('       （跳过：当前环境不允许创建目录联接）')
		return
	}
	await expectThrow(
		() => targetMod.resolveExternalTarget(host, path.join(link, 'out.html'), 'file'),
		e => /符号链接或目录联接/.test(e.message),
		'junction'
	)
})

await check('2.6 文件夹目标指向普通文件时被拒绝', async () => {
	const file = path.join(OUTSIDE, 'not-a-folder.txt')
	fs.writeFileSync(file, 'x')
	await expectThrow(
		() => targetMod.resolveExternalTarget(host, file, 'folder'),
		e => /不是文件夹/.test(e.message),
		'文件当文件夹'
	)
})

await check('2.7 合法文件目标拆出 base 与文件名', async () => {
	const target = await targetMod.resolveExternalTarget(host, path.join(OUTSIDE, 'note.html'), 'file')
	assertEqual(target.base, OUTSIDE, 'base 是父目录')
	assertEqual(target.relative, 'note.html', 'relative 是文件名')
})

/* --------------------------------------------------------- 3. share file -- */

console.log('\n3 — 单文件：指定文件名、校验、绝不覆盖')

await check('3.1 写到用户指定的文件名，SHA-256 与内存一致，临时目录已清理', async () => {
	const base = fs.mkdtempSync(path.join(SCRATCH, 'share-'))
	const app = makeApp()
	const adapter = adapterMod.createExternalAdapter(host, base)
	const html = page('<p>share</p>')
	const result = await shareMod.writeShareFile(
		app, html, '', '笔记', 'notes/note.md', 200, null, adapter, 'my-note.html'
	)
	const written = path.join(base, 'my-note.html')
	assert(fs.existsSync(written), '文件应写在该名字上')
	assertEqual(readText(written), html, '内容完整')
	assertEqual(result.sha256, sha(written), '返回的 SHA-256 与磁盘一致')
	assertEqual(result.renamed, false, '指定文件名不应加 -2')
	const leftovers = fs.readdirSync(base).filter(n => n.startsWith('.he-tmp-'))
	assertEqual(leftovers, [], '临时目录必须清理')
})

await check('3.2 同名文件已存在：拒绝写入，原文件逐字节不变', async () => {
	const base = fs.mkdtempSync(path.join(SCRATCH, 'share-exists-'))
	const existing = path.join(base, 'taken.html')
	fs.writeFileSync(existing, 'USER FILE')
	const before = sha(existing)
	const adapter = adapterMod.createExternalAdapter(host, base)
	await expectThrow(
		() =>
			shareMod.writeShareFile(
				makeApp(), page('<p>x</p>'), '', '笔记', 'notes/note.md', 200, null, adapter, 'taken.html'
			),
		e => /已存在/.test(e.message),
		'同名文件'
	)
	assertEqual(sha(existing), before, '原文件不得被改动')
	assertEqual(fs.readdirSync(base).filter(n => n.endsWith('.html')), ['taken.html'], '不得生成第二个文件')
})

/* ------------------------------------------------------------ 4. package -- */

console.log('\n4 — 完整资源包：子目录、签名清单、校验、陌生目录不动')

await check('4.1 在所选文件夹内新建 slug-suffix 子目录，清单已签名且磁盘校验通过', async () => {
	const base = fs.mkdtempSync(path.join(SCRATCH, 'pkg-'))
	const app = makeApp()
	const adapter = adapterMod.createExternalAdapter(host, base)
	const assets = new assetsMod.AssetCollector(app)
	const report = await writerMod.writeExport(
		app, SNAPSHOT, page('<p>pkg</p>'), 'body{}', assets, '', EXTRA, SIGNING_KEY, null, adapter
	)
	const dir = path.join(base, report.dir)
	assert(fs.existsSync(path.join(dir, 'index.html')), 'index.html 落在所选文件夹内')
	assert(fs.existsSync(path.join(dir, 'export-manifest.json')), '清单存在')
	assert(report.stages.includes('verify'), '走了写入后校验')
	assert(report.stages.includes('publish'), '走了发布')
	assert(report.stages.includes('published-verify'), '外部发布后重新校验了最终目录')
	assertEqual(report.tmpDir, null, '成功发布后不再报告暂存目录')
	const manifest = JSON.parse(readText(path.join(dir, 'export-manifest.json')))
	assert(!!manifest.signature && manifest.signature.alg === 'HMAC-SHA256', '清单带 HMAC 签名')
	assertEqual(
		manifest.files.find(f => f.path === 'index.html')?.sha256,
		sha(path.join(dir, 'index.html')),
		'清单里的 index.html 哈希与磁盘一致'
	)
})

await check('4.2 同一目标再次导出：安全拒绝（不再替换任何已有目录），第一次产物与陌生目录都不变', async () => {
	// External publishing now claims the final directory atomically. There is no
	// race-free "replace only if it is ours" in Node's public API, so a second
	// export to an occupied name is refused instead of replacing — even when the
	// occupying directory was produced by this plugin. Vault-internal exports
	// keep their ownership-checked backup/restore behaviour.
	const base = fs.mkdtempSync(path.join(SCRATCH, 'pkg-twice-'))
	const foreign = path.join(base, '我的资料')
	fs.mkdirSync(foreign)
	fs.writeFileSync(path.join(foreign, 'keep.txt'), 'MINE')
	const foreignHash = sha(path.join(foreign, 'keep.txt'))

	const first = await exportOnce(base, { html: page('<p>one</p>') })
	const firstDir = path.join(base, first.dir)
	const before = treeHash(firstDir)

	await expectThrow(
		() => exportOnce(base, { html: page('<p>two</p>') }),
		e => /没有覆盖|已存在|发布外部资源包失败/.test(e.message),
		'第二次导出到同名目标'
	)
	assertEqual(treeHash(firstDir), before, '第一次导出的全部文件逐字节不变')
	assert(readText(path.join(firstDir, 'index.html')).includes('one'), '第一次内容仍然生效')
	assertEqual(sha(path.join(foreign, 'keep.txt')), foreignHash, '陌生目录逐字节未变')
	assertEqual(
		fs.readdirSync(base).filter(n => n.includes('.bak-')),
		[],
		'外部模式不产生 .bak 目录，也不尝试备份/恢复'
	)
})

await check('4.3 目标子目录被陌生内容占据时拒绝覆盖', async () => {
	const base = fs.mkdtempSync(path.join(SCRATCH, 'pkg-foreign-'))
	const app = makeApp()
	const adapter = adapterMod.createExternalAdapter(host, base)
	const first = await writerMod.writeExport(
		app, SNAPSHOT, page('<p>one</p>'), 'body{}', new assetsMod.AssetCollector(app), '', EXTRA, SIGNING_KEY, null, adapter
	)
	// Drop a file the plugin did not write into its own export directory.
	// The external path now refuses *any* occupied target before looking at
	// ownership; the vault path still runs `inspectOwnership` here.
	const intruder = path.join(base, first.dir, 'intruder.txt')
	fs.writeFileSync(intruder, 'NOT OURS')
	await expectThrow(
		() =>
			writerMod.writeExport(
				app, SNAPSHOT, page('<p>two</p>'), 'body{}', new assetsMod.AssetCollector(app), '', EXTRA, SIGNING_KEY, null, adapter
			),
		e => /无法证明|没有覆盖/.test(e.message),
		'陌生文件'
	)
	assertEqual(readText(intruder), 'NOT OURS', '陌生文件必须保留')
	assert(readText(path.join(base, first.dir, 'index.html')).includes('one'), '旧导出未被替换')
})

/* --------------------------------------------------------------- 5. host -- */

console.log('\n5 — 宿主能力探测')

await check('5.1 没有模块加载器时给出原因而不是抛错', () => {
	const { host: built, reason } = hostMod.createExternalHost({
		load: undefined,
		vaultBase: VAULT,
		pluginDirRelative: '.obsidian/plugins/html-export-preview',
		configDirRelative: '.obsidian'
	})
	// `load` undefined falls back to the real `require`, which Node has — so a
	// host is expected here. The *no-require* case is the next check.
	assert(!!built || !!reason, '要么给出宿主，要么给出原因')
})

await check('5.2 缺少 require 时返回 null 并说明只能在 Vault 内导出', () => {
	const saved = globalThis.require
	globalThis.require = undefined
	try {
		const { host: built, reason } = hostMod.createExternalHost({
			vaultBase: VAULT,
			pluginDirRelative: '.obsidian/plugins/html-export-preview',
			configDirRelative: '.obsidian'
		})
		assertEqual(built, null, '没有 require 就不该有宿主')
		assertMatch(reason, /移动端|模块加载器/, '原因可读')
		const caps = hostMod.hostCapabilities()
		assertEqual(caps.desktop, false, '能力报告为不可用')
	} finally {
		globalThis.require = saved
	}
})

/* ------------------------------------------ 6. no-clobber / 真实文件操作 -- */

/*
 * These five cases exercise the real `node:fs` publish path end to end. The
 * only injections are deterministic timing/fault hooks at the syscall or
 * adapter boundary; no adapter is mocked away. Every destructive operation is
 * confined to a fresh directory under SCRATCH (os.tmpdir()).
 */

console.log('\n6 — 外部资源包可靠 no-clobber（A–E，真实 fs）')

await check('A1 目标路径原本是陌生“文件”：拒绝发布，文件逐字节不变', async () => {
	// Worst case from the old code: Windows fs.rename of a directory onto an
	// existing *file* succeeded and destroyed that file.
	const base = freshBase('noclobber-a1')
	const target = path.join(base, finalDirName)
	fs.writeFileSync(target, 'USER-OWNED FILE - DO NOT TOUCH')
	const before = sha(target)

	await expectThrow(
		() => exportOnce(base),
		e => /没有覆盖|已存在|发布外部资源包失败/.test(e.message),
		'同名文件目标'
	)
	assertEqual(sha(target), before, '原文件逐字节不变')
	assertEqual(fs.statSync(target).isFile(), true, '仍然是普通文件')
	assertEqual(readText(target), 'USER-OWNED FILE - DO NOT TOUCH', '内容未被改写')
	assertEqual(
		fs.readdirSync(base).filter(n => n.startsWith(`${finalDirName}.bak-`)),
		[],
		'没有产生任何备份/替换目录'
	)
})

await check('A2 目标路径原本是陌生目录（含子目录与文件）：整棵目录逐字节不变', async () => {
	const base = freshBase('noclobber-a2')
	const target = path.join(base, finalDirName)
	fs.mkdirSync(path.join(target, 'sub'), { recursive: true })
	fs.writeFileSync(path.join(target, '我的资料.txt'), 'MINE')
	fs.writeFileSync(path.join(target, 'sub', 'deep.bin'), Buffer.from([9, 8, 7, 6]))
	const before = treeHash(target)

	await expectThrow(
		() => exportOnce(base),
		e => /没有覆盖|已存在|发布外部资源包失败/.test(e.message),
		'同名目录目标'
	)
	assertEqual(treeHash(target), before, '陌生目录整棵树逐字节不变')
	assertEqual(fs.readdirSync(target).sort(), ['sub', '我的资料.txt'].sort(), '没有混入插件文件')
})

await check('B 所有检查之后、发布之前被别的任务抢先创建同名目标：安全拒绝，旧内容完全不变', async () => {
	const base = freshBase('noclobber-b')
	const targetAbs = path.join(base, finalDirName)
	let fired = false
	// `materializeExclusive` calls `fs.mkdir(to)` with NO options as its atomic
	// claim. Just before that claim, another process wins the name. Note the
	// staging mkdirs use `{recursive:true}` and are not intercepted.
	const raceFs = fsProxy({
		mkdir: async (p, options) => {
			if (!fired && options?.recursive !== true && path.resolve(p) === path.resolve(targetAbs)) {
				fired = true
				await fs.promises.mkdir(targetAbs, { recursive: true })
				await fs.promises.writeFile(path.join(targetAbs, 'OTHER-TASK.txt'), 'ANOTHER TASK OWNS THIS')
			}
			return fs.promises.mkdir(p, options)
		}
	})

	await expectThrow(
		() => exportOnce(base, { host: { ...host, fs: raceFs } }),
		e => /没有覆盖|已存在|发布外部资源包失败/.test(e.message),
		'竞态中失去目标名'
	)
	assert(fired, '抢先创建确实发生在发布阶段的独占 claim 处')
	assertEqual(readText(path.join(targetAbs, 'OTHER-TASK.txt')), 'ANOTHER TASK OWNS THIS', '抢先者内容逐字节不变')
	assertEqual(fs.readdirSync(targetAbs), ['OTHER-TASK.txt'], '抢先者的目录里没有混入插件文件')
})

await check('C 两个并发导出争用同一目标：至多一个成功，成功者的产物不被改写', async () => {
	const base = freshBase('noclobber-c')
	const run = label => exportOnce(base, { html: page(`<p>${label}</p>`) })
	const results = await Promise.allSettled([run('TASK-A'), run('TASK-B')])
	const ok = results.filter(r => r.status === 'fulfilled')
	const bad = results.filter(r => r.status === 'rejected')

	assert(ok.length <= 1, `至多一个成功，实际 ${ok.length} 个`)
	assertEqual(ok.length, 1, '竞争同一空闲目标时恰好一个成功（不能两败俱伤）')
	assertEqual(bad.length, 1, '另一个必须显式安全失败')
	for (const failure of bad) {
		assertMatch(failure.reason.message, /没有覆盖|已存在|发布外部资源包失败/, '失败必须是安全拒绝')
	}
	const report = ok[0].value
	const dir = path.join(base, report.dir)
	const winner = readText(path.join(dir, 'index.html'))
	assert(/<p>TASK-[AB]<\/p>/.test(winner), '成功者的 HTML 完整且只属于一个任务')
	assert(report.stages.includes('published-verify'), '成功者通过了发布后校验')
	const verdict = await signingMod.verifyManifestSignature(
		JSON.parse(readText(path.join(dir, 'export-manifest.json'))),
		SIGNING_KEY
	)
	assert(verdict.ok, `成功者的 HMAC 清单有效：${verdict.reason}`)
	assertEqual(
		fs.readdirSync(base).filter(n => n.includes('.bak-')),
		[],
		'并发失败不产生备份/恢复副作用'
	)
})

await check('D1 发布写入中途失败：不删除原有陌生文件，也不留下“成功”标记', async () => {
	const base = freshBase('noclobber-d1')
	const foreign = path.join(base, '我的资料')
	fs.mkdirSync(foreign, { recursive: true })
	fs.writeFileSync(path.join(foreign, 'keep.txt'), 'STILL MINE')
	const foreignBefore = treeHash(foreign)

	// Fail one exclusive file create inside the claimed root, before the signed
	// manifest (the completion marker) can be written.
	const faultFs = fsProxy({
		open: async (p, flags) => {
			if (flags === 'wx' && path.basename(p) === 'runtime-audit.json') {
				const error = new Error('injected EIO during publish')
				error.code = 'EIO'
				throw error
			}
			return fs.promises.open(p, flags)
		}
	})

	await expectThrow(
		() => exportOnce(base, { host: { ...host, fs: faultFs } }),
		e => /发布外部资源包失败|没有覆盖/.test(e.message),
		'发布中途写入失败'
	)
	assertEqual(treeHash(foreign), foreignBefore, '原有陌生目录逐字节不变')
	const target = path.join(base, finalDirName)
	if (fs.existsSync(target)) {
		assertEqual(
			fs.existsSync(path.join(target, 'export-manifest.json')),
			false,
			'部分完成目录没有签名清单，不能被当作成功产物'
		)
	}
	assert(
		fs.readdirSync(base).some(n => n.includes('.tmp-')),
		'失败时保留本次暂存内容，且没有删除任何其它目录'
	)
})

await check('D2 发布后校验失败：不删除任何文件，原目录与陌生文件都保留', async () => {
	const base = freshBase('noclobber-d2')
	const foreign = path.join(base, '我的资料.txt')
	fs.writeFileSync(foreign, 'STILL MINE')
	const foreignBefore = sha(foreign)

	// Reading the *published* path fails only after publish, so the post-publish
	// verifyExport rejects the run. Nothing may be deleted or relabelled.
	const wrapAdapter = adapter => ({
		...adapter,
		async read(p) {
			if (String(p).startsWith(`${finalDirName}/`)) {
				throw new Error('injected read failure on published path')
			}
			return adapter.read(p)
		}
	})
	await expectThrow(
		() => exportOnce(base, { wrapAdapter }),
		e => /发布后校验失败|发布后校验/.test(e.message),
		'发布后校验失败'
	)
	assertEqual(sha(foreign), foreignBefore, '陌生文件逐字节不变')
	const target = path.join(base, finalDirName)
	assert(fs.existsSync(path.join(target, 'index.html')), '失败没有删除已发布目录')
	const verdict = await signingMod.verifyManifestSignature(
		JSON.parse(readText(path.join(target, 'export-manifest.json'))),
		SIGNING_KEY
	)
	assert(verdict.ok, '磁盘上的签名清单仍然完好（只是本次没有报告成功）')
})

await check('E 正常发布：HTML / 图片 / 字体 / HMAC 清单完整，发布后校验通过', async () => {
	const base = freshBase('noclobber-e')
	const html = page('<p>完整资源包</p><img src="figure.png">')
	const css = '@font-face{font-family:T;src:url(media/theme.woff2)}body{color:#123}'
	const report = await exportOnce(base, {
		html,
		css,
		vaultFiles: MEDIA_FILES,
		refs: MEDIA_REFS
	})
	const dir = path.join(base, report.dir)

	assert(report.stages.includes('verify'), '暂存阶段完成校验')
	assert(report.stages.includes('publish'), '完成发布')
	assert(report.stages.includes('published-verify'), '发布后再次校验')
	assert(report.verified.ok, '发布前校验通过')
	assertEqual(readText(path.join(dir, 'index.html')), html, 'HTML 逐字节一致')
	assertEqual(readText(path.join(dir, 'assets', 'export.css')), css, 'CSS 逐字节一致')

	const mediaDir = path.join(dir, 'assets', 'media')
	const names = fs.readdirSync(mediaDir).sort()
	assertEqual(names.length, 2, '图片与字体两个资源都已发布')
	const img = names.find(n => n.endsWith('.png'))
	const font = names.find(n => n.endsWith('.woff2'))
	assert(!!img && !!font, `应包含 .png 与 .woff2，实际 ${names.join(', ')}`)
	assertEqual(sha(path.join(mediaDir, img)), shaBytes(IMG_BYTES), '图片逐字节一致')
	assertEqual(sha(path.join(mediaDir, font)), shaBytes(FONT_BYTES), '字体逐字节一致')

	const manifest = JSON.parse(readText(path.join(dir, 'export-manifest.json')))
	assertEqual(manifest.signature?.alg, 'HMAC-SHA256', '清单带 HMAC-SHA256 签名')
	const verdict = await signingMod.verifyManifestSignature(manifest, SIGNING_KEY)
	assert(verdict.ok, `清单签名有效：${verdict.reason}`)
	assert(manifest.assets.written === 2, '清单记录两个已写入资源')
	for (const record of manifest.files) {
		const onDisk = path.join(dir, record.path)
		assert(fs.existsSync(onDisk), `清单文件存在：${record.path}`)
		assertEqual(sha(onDisk), record.sha256, `清单 SHA-256 与磁盘一致：${record.path}`)
	}
	assertEqual(
		fs.readdirSync(base).filter(n => n.includes('.tmp-')),
		[],
		'成功发布后暂存目录已清理'
	)
	assertEqual(fs.readdirSync(base), [finalDirName], '所选文件夹里只新增了这一个资源包目录')
})

/* ------------------------------------------------------------- teardown -- */

fs.rmSync(SCRATCH, { recursive: true, force: true })

console.log('')
if (failures.length) {
	console.log(`✗ ${failures.length} 项失败，${passed} 项通过\n`)
	for (const failure of failures) console.log(`  - ${failure.name}: ${failure.message}`)
	process.exit(1)
}
console.log(`✓ 全部 ${passed} 项通过\n`)
