/**
 * Round 2A.2.2 — Signed Manifest Ownership & Path Integrity
 *
 * This suite exists because round 2A.2.1 tried to prove "this directory is my
 * export" from fields *inside* the manifest. The manifest is a plain file in
 * the directory being proven, so every field used as evidence could be deleted
 * or rewritten by the same actor who wanted the directory replaced: deleting
 * `manifestVersion` and `files` produced a byte-identical copy of a legacy
 * manifest, and a one-line `notePath` edit walked past the cross-note guard.
 *
 * The fix is a secret that is not in the directory — a per-vault HMAC key kept
 * in the plugin's own configuration. Every case below is an attempt to get an
 * `owned = true` out of a manifest that the key did not sign.
 *
 *   M  Manifest 降级与完整性（16）— 删/改任何归属字段都不得变成「更弱的清单」
 *   H  HMAC 可信性（12）          — 签名覆盖什么、不覆盖什么、失效时说什么
 *   P  Windows 路径完整性（10）    — ADS / 保留名 / 尾点尾空格 / 大小写 / NFC
 *   T  发布事务（6）              — 拒绝时零 rename，成功时备份保留，无自动删除
 *   K  密钥管理（4）              — 生成、校验、持久化、不外泄
 *
 * 手法与 2A.2.1 相同：esbuild 把真实 `src/export/writer.ts` 编到内存，喂一个
 * 忠实实现 `adapter.list` 语义、可注入 rename 故障、并记录每一次 remove /
 * rmdir 的内存适配器。
 *
 * 运行：node tests/unit/run-round2a2-2.mjs
 * 隔离副本：AB_ROOT=<copy> node tests/unit/run-round2a2-2.mjs   （反向对照用）
 */
import { build } from 'esbuild'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash, createHmac } from 'node:crypto'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = process.env.AB_ROOT
	? path.resolve(process.env.AB_ROOT)
	: path.resolve(here, '../..')
const out = path.join(here, '.out-round2a2-2')

/* ------------------------------------------------------------- bundling -- */
function prepareStub() {
	const dir = path.join(out, 'node_modules', 'obsidian')
	fs.mkdirSync(dir, { recursive: true })
	fs.writeFileSync(
		path.join(dir, 'index.mjs'),
		`export class TFile { constructor(p, size = 1) { this.path = p; this.name = p.split('/').pop() ?? p; this.basename = this.name.replace(/\\.[^.]+$/, ''); this.stat = { size } } }
export class TFolder {}
export class App {}
export class Plugin {}
export class MarkdownView {}
export class Notice {}
export class PluginSettingTab {}
export class Setting {}
export function normalizePath(p) { return p.replace(/\\\\/g, '/').replace(/\\/{2,}/g, '/').replace(/^\\/+/, '').replace(/\\/+$/, '') }
`
	)
	fs.writeFileSync(
		path.join(dir, 'package.json'),
		JSON.stringify({
			name: 'obsidian',
			version: '0.0.0-stub',
			type: 'module',
			main: 'index.mjs',
			exports: './index.mjs'
		})
	)
}
async function bundle(entry, name) {
	prepareStub()
	const outfile = path.join(out, `${name}.mjs`)
	await build({
		entryPoints: [path.join(root, entry)],
		outfile,
		bundle: true,
		format: 'esm',
		platform: 'node',
		target: 'node18',
		external: ['obsidian'],
		logLevel: 'error'
	})
	return import(`${pathToFileURL(outfile).href}?v=${Date.now()}`)
}

const { writeExport, inspectOwnership, ExportError } = await bundle(
	'src/export/writer.ts',
	'writer'
)
const { AssetCollector } = await bundle('src/assets/resource-manager.ts', 'assets')
const { resolveExportDir, identitySuffix } = await bundle(
	'src/export/path-safety.ts',
	'path-safety'
)
const signing = await bundle('src/export/manifest-signing.ts', 'manifest-signing')
const { signingPayload, signManifest, verifyManifestSignature, generateSigningKeyHex, isValidSigningKey } =
	signing

/**
 * Fixtures are signed with node:crypto, the production code signs with
 * WebCrypto. If the two disagreed about the algorithm or the canonical payload,
 * every "owned" case would fail — so these fixtures cross-check the signing
 * implementation instead of trusting it.
 */
const TEST_KEY = '9f'.repeat(32)
const OTHER_KEY = '3c'.repeat(32)

function signFixture(manifest, key = TEST_KEY) {
	manifest.signature = {
		alg: 'HMAC-SHA256',
		v: 1,
		value: createHmac('sha256', Buffer.from(key, 'hex'))
			.update(signingPayload(manifest))
			.digest('hex')
	}
	return manifest
}

/* --------------------------------------------------------- fake adapter -- */
function makeVault(seed = {}, cfg = {}) {
	const files = new Map(Object.entries(seed.files ?? {}))
	const dirs = new Set(['.'])
	const addDirsFor = p => {
		const parts = p.split('/')
		for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'))
	}
	for (const p of files.keys()) addDirsFor(p)
	for (const d of seed.dirs ?? []) {
		dirs.add(d)
		addDirsFor(d)
	}
	const log = []
	const destroyed = []
	let renameCalls = 0
	const failAt = new Set(
		Array.isArray(cfg.renameFailAt) ? cfg.renameFailAt : cfg.renameFailAt ? [cfg.renameFailAt] : []
	)
	const utf8 = s => new TextEncoder().encode(String(s))
	const adapter = {
		async exists(p) {
			return files.has(p) || dirs.has(p)
		},
		async mkdir(p) {
			log.push(['mkdir', p])
			dirs.add(p)
			addDirsFor(p)
		},
		async write(p, data) {
			log.push(['write', p])
			files.set(p, String(data))
			addDirsFor(p)
		},
		async read(p) {
			if (!files.has(p)) throw new Error(`ENOENT ${p}`)
			return files.get(p)
		},
		async readBinary(p) {
			if (cfg.readBinaryThrow) throw new Error('readBinary forced throw')
			if (!files.has(p)) throw new Error(`ENOENT ${p}`)
			return utf8(files.get(p))
		},
		async stat(p) {
			if (files.has(p)) return { size: String(files.get(p)).length, type: 'file' }
			if (dirs.has(p)) return { size: 0, type: 'folder' }
			return null
		},
		async list(p) {
			const res = { files: [], folders: [] }
			for (const k of files.keys()) if (path.posix.dirname(k) === p) res.files.push(k)
			for (const d of dirs)
				if (d !== '.' && d !== p && path.posix.dirname(d) === p) res.folders.push(d)
			return res
		},
		async rename(from, to) {
			renameCalls++
			if (failAt.has(renameCalls))
				throw new Error(`EACCES simulated rename failure #${renameCalls}`)
			log.push(['rename', from, to])
			const moved = [...files.keys()].filter(k => k === from || k.startsWith(`${from}/`))
			const movedDirs = [...dirs].filter(d => d === from || d.startsWith(`${from}/`))
			if (moved.length === 0 && movedDirs.length === 0)
				throw new Error(`rename: 源不存在 ${from}`)
			for (const k of moved) {
				const v = files.get(k)
				files.delete(k)
				files.set(`${to}${k.slice(from.length)}`, v)
			}
			for (const d of movedDirs) {
				dirs.delete(d)
				dirs.add(`${to}${d.slice(from.length)}`)
			}
		},
		async rmdir(p, recursive) {
			log.push(['rmdir', p, recursive])
			for (const k of [...files.keys()])
				if (k === p || k.startsWith(`${p}/`)) {
					destroyed.push({ path: k, content: files.get(k), via: 'rmdir' })
					files.delete(k)
				}
			for (const d of [...dirs]) if (d === p || d.startsWith(`${p}/`)) dirs.delete(d)
		},
		async remove(p) {
			if (!files.has(p)) return
			destroyed.push({ path: p, content: files.get(p), via: 'remove' })
			files.delete(p)
		}
	}
	return {
		app: { vault: { adapter } },
		files,
		dirs,
		log,
		destroyed,
		get renameCalls() {
			return renameCalls
		}
	}
}

/* ------------------------------------------------------------- fixtures -- */
const BODY_START = '<!--he-body-start-->'
const BODY_END = '<!--he-body-end-->'
const page = (body = '<p>正文内容</p>') =>
	'<!doctype html>\n<html>\n<head><title>t</title></head>\n<body>\n' +
	`${BODY_START}\n${body}\n${BODY_END}\n</body>\n</html>\n`

const sha256hex = s => createHash('sha256').update(String(s), 'utf8').digest('hex')
const bytesOf = s => Buffer.byteLength(String(s), 'utf8')
const NOTE_PATH = 'notes/note.md'
const TITLE = '笔记'
const EXPORT_DIR = resolveExportDir('html-export', TITLE, NOTE_PATH).dir

const OWN_ENTRIES = {
	'index.html': page('<p>第一版</p>'),
	'assets/export.css': 'body{}',
	'runtime-audit.json': '{"generatedAt":"x"}'
}

function recordsFrom(entries) {
	return Object.entries(entries).map(([rel, content]) => ({
		path: rel,
		bytes: bytesOf(content),
		sha256: sha256hex(content)
	}))
}

function buildManifest(
	entries,
	{
		notePath = NOTE_PATH,
		version = 2,
		filesOverride,
		identitySuffix: suffixOverride,
		outputFolder,
		assetsEntries,
		sign = true,
		key = TEST_KEY
	} = {}
) {
	const manifest = {
		manifestVersion: version,
		generatedAt: 'x',
		notePath,
		noteTitle: TITLE,
		identitySuffix: suffixOverride ?? identitySuffix(notePath),
		outputFolder: outputFolder ?? EXPORT_DIR.split('/').pop(),
		status: 'ok',
		assets: {
			written: 0,
			attempted: 0,
			entries: assetsEntries ?? [],
			failed: []
		},
		files: filesOverride ?? recordsFrom(entries)
	}
	return JSON.stringify(sign ? signFixture(manifest, key) : manifest)
}

/** Build a seeded export directory as a `files` map. */
function seed(dir, entries, opts = {}) {
	const files = {}
	for (const [rel, content] of Object.entries(entries)) files[`${dir}/${rel}`] = content
	files[`${dir}/export-manifest.json`] = buildManifest(entries, {
		outputFolder: dir.split('/').pop(),
		...opts
	})
	return files
}

const snap = (title = TITLE, notePath = NOTE_PATH) => ({
	notePath,
	noteTitle: title,
	captureWidth: 900,
	stats: { blocks: 1, images: 0, mermaid: 0, sidenotes: 0, bytesOfContent: 40 },
	resolution: { candidates: [], reason: '唯一可用候选', ambiguity: false },
	previewMetrics: { width: 900 },
	warnings: []
})
const EXTRA = {
	css: { bytes: 10, sheets: [], warnings: [] },
	pluginVersion: '0.1.0',
	audit: { generatedAt: 'x' }
}

const own = (app, dir = EXPORT_DIR, notePath = NOTE_PATH, key = TEST_KEY) =>
	inspectOwnership(app, dir, notePath, key)

/**
 * Byte-for-byte snapshot of one directory subtree.
 *
 * A failed export still writes a `.tmp-` staging directory, so comparing the
 * whole vault would always differ. What must not change is the *final* export
 * directory — that is what a user would lose.
 */
function snapshotDir(v, dir) {
	const out = new Map()
	for (const [k, val] of v.files) if (k === dir || k.startsWith(`${dir}/`)) out.set(k, val)
	return out
}
function sameDir(v, dir, before) {
	const after = snapshotDir(v, dir)
	if (after.size !== before.size) return false
	for (const [k, val] of before) if (after.get(k) !== val) return false
	return true
}
/** Top-level sibling directories of the export root that carry `marker`. */
function siblings(v, marker) {
	return [...v.dirs].filter(
		d => path.posix.dirname(d) === 'html-export' && path.posix.basename(d).includes(marker)
	)
}

async function runExport(
	vault,
	{ title = TITLE, notePath = NOTE_PATH, body = '<p>第二版</p>', key = TEST_KEY } = {}
) {
	try {
		return {
			report: await writeExport(
				vault.app,
				snap(title, notePath),
				page(body),
				'body{}',
				new AssetCollector(vault.app),
				'html-export',
				EXTRA,
				key
			),
			error: null
		}
	} catch (e) {
		return { report: null, error: e }
	}
}

/** Read the manifest back, mutate it, optionally re-sign, write it back. */
function mutate(files, dir, fn, { resign = true } = {}) {
	const key = `${dir}/export-manifest.json`
	const m = JSON.parse(files[key])
	fn(m)
	files[key] = JSON.stringify(resign ? signFixture(m) : m)
	return m
}

/* -------------------------------------------------------------- runner -- */
let pass = 0,
	fail = 0
const results = []
function record(id, name, ok, detail = '') {
	results.push({ id, name, verdict: ok ? 'PASS' : 'FAIL', detail })
	if (ok) pass++
	else fail++
	console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${id}  ${name}${detail ? '  — ' + detail : ''}`)
}

/* ================================================== M · 降级与完整性 === */
console.log('\n=== M · Manifest 降级与完整性（删/改字段不得变成更弱的清单）===')

{
	const files = seed(EXPORT_DIR, OWN_ENTRIES)
	mutate(files, EXPORT_DIR, m => delete m.manifestVersion)
	const r = await own(makeVault({ files }).app)
	record(
		'M-01',
		'删除 manifestVersion（files 完好）→ 拒绝',
		!r.owned && /manifestVersion|旧版/.test(r.reason),
		`owned=${r.owned} reason=${r.reason}`
	)
}
{
	const files = seed(EXPORT_DIR, OWN_ENTRIES)
	mutate(files, EXPORT_DIR, m => delete m.files)
	const r = await own(makeVault({ files }).app)
	record('M-02', '删除 files（版本号完好）→ 拒绝', !r.owned && /files/.test(r.reason), `owned=${r.owned} reason=${r.reason}`)
}
{
	// The exact 2A.2.1 downgrade: delete both, keep `notePath` and
	// `assets.entries`. The result used to be byte-identical to a real legacy
	// manifest and came back `owned = true, checked = 0`.
	const files = seed(EXPORT_DIR, OWN_ENTRIES)
	mutate(files, EXPORT_DIR, m => {
		delete m.manifestVersion
		delete m.files
	})
	const r = await own(makeVault({ files }).app)
	record(
		'M-03',
		'同时删除 manifestVersion 与 files（保留 notePath / assets.entries）→ 拒绝',
		!r.owned && /旧版/.test(r.reason),
		`owned=${r.owned} basis=${r.basis} reason=${r.reason}`
	)
}
{
	const files = seed(EXPORT_DIR, OWN_ENTRIES)
	mutate(files, EXPORT_DIR, m => {
		delete m.files[1].sha256
	})
	const r = await own(makeVault({ files }).app)
	record(
		'M-04',
		'删除单条记录的 sha256 → 拒绝（无 size-only 回退）',
		!r.owned && /sha256/.test(r.reason),
		`owned=${r.owned} reason=${r.reason}`
	)
}
{
	const files = seed(EXPORT_DIR, OWN_ENTRIES)
	mutate(files, EXPORT_DIR, m => {
		delete m.files[0].bytes
	})
	const r = await own(makeVault({ files }).app)
	record('M-05', '删除单条记录的 bytes → 拒绝', !r.owned && /bytes/.test(r.reason), `owned=${r.owned} reason=${r.reason}`)
}
{
	const files = seed(EXPORT_DIR, OWN_ENTRIES)
	mutate(files, EXPORT_DIR, m => delete m.notePath)
	const r = await own(makeVault({ files }).app)
	record('M-06', '删除 notePath → 拒绝', !r.owned && /notePath/.test(r.reason), `owned=${r.owned} reason=${r.reason}`)
}
{
	// No re-sign: this is what an attacker can actually do.
	const files = seed(EXPORT_DIR, OWN_ENTRIES)
	mutate(files, EXPORT_DIR, m => {
		m.notePath = 'notes/other.md'
	}, { resign: false })
	const r = await own(makeVault({ files }).app)
	record('M-07', '修改 notePath（不重签）→ 签名失效拒绝', !r.owned && /签名/.test(r.reason), `owned=${r.owned} reason=${r.reason}`)
}
{
	// Re-signed: models "a manifest from another note copied into this folder".
	const files = seed(EXPORT_DIR, OWN_ENTRIES)
	mutate(files, EXPORT_DIR, m => {
		m.notePath = 'notes/other.md'
		m.identitySuffix = identitySuffix('notes/other.md')
	})
	const r = await own(makeVault({ files }).app)
	record('M-08', '修改 notePath（重新签名）→ 属于另一篇笔记，拒绝', !r.owned && /另一篇笔记/.test(r.reason), `owned=${r.owned} reason=${r.reason}`)
}
{
	const files = seed(EXPORT_DIR, OWN_ENTRIES)
	mutate(files, EXPORT_DIR, m => {
		m.identitySuffix = identitySuffix('notes/other.md')
	})
	const r = await own(makeVault({ files }).app)
	record('M-09', '修改 identitySuffix（重新签名）→ 拒绝', !r.owned && /identitySuffix/.test(r.reason), `owned=${r.owned} reason=${r.reason}`)
}
{
	const files = seed(EXPORT_DIR, OWN_ENTRIES)
	mutate(files, EXPORT_DIR, m => {
		m.outputFolder = '别人的目录-000000000000'
	})
	const r = await own(makeVault({ files }).app)
	record('M-10', '修改 outputFolder（重新签名）→ 拒绝', !r.owned && /outputFolder/.test(r.reason), `owned=${r.owned} reason=${r.reason}`)
}
{
	const files = seed(EXPORT_DIR, OWN_ENTRIES, {
		assetsEntries: [{ name: 'a.png', bytes: 3, role: 'media' }]
	})
	mutate(files, EXPORT_DIR, m => {
		m.assets.entries.push({ name: '偷加的.png', bytes: 9, role: 'media' })
	}, { resign: false })
	const r = await own(makeVault({ files }).app)
	record('M-11', '修改 assets.entries（不重签）→ 签名覆盖该字段，拒绝', !r.owned && /签名/.test(r.reason), `owned=${r.owned} reason=${r.reason}`)
}
{
	// Change a file and update the manifest to match, but without the key.
	const files = seed(EXPORT_DIR, OWN_ENTRIES)
	const next = page('<p>被别人改过</p>')
	files[`${EXPORT_DIR}/index.html`] = next
	mutate(files, EXPORT_DIR, m => {
		m.files[0].bytes = bytesOf(next)
		m.files[0].sha256 = sha256hex(next)
	}, { resign: false })
	const r = await own(makeVault({ files }).app)
	record('M-12', '改内容并同步 bytes/sha256（不重签）→ 签名失效拒绝', !r.owned && /签名/.test(r.reason), `owned=${r.owned} reason=${r.reason}`)
}
{
	// Reverse control: the same rewrite *with* the key is a legitimate export.
	const files = seed(EXPORT_DIR, OWN_ENTRIES)
	const next = page('<p>合法的第二版</p>')
	files[`${EXPORT_DIR}/index.html`] = next
	mutate(files, EXPORT_DIR, m => {
		m.files[0].bytes = bytesOf(next)
		m.files[0].sha256 = sha256hex(next)
	})
	const r = await own(makeVault({ files }).app)
	record('M-13', '改内容并同步 bytes/sha256（有密钥、重签）→ 认可（反向对照）', r.owned && r.basis === 'manifest-hmac', `owned=${r.owned} basis=${r.basis}`)
}
{
	const files = seed(EXPORT_DIR, OWN_ENTRIES)
	mutate(files, EXPORT_DIR, m => {
		m.files.push({ ...m.files[0] })
	})
	const r = await own(makeVault({ files }).app)
	record('M-14', 'files 含重复 path → 拒绝', !r.owned && /重复/.test(r.reason), `owned=${r.owned} reason=${r.reason}`)
}
{
	const files = seed(EXPORT_DIR, OWN_ENTRIES)
	mutate(files, EXPORT_DIR, m => {
		m.files[0].bytes = -1
	})
	const r = await own(makeVault({ files }).app)
	record('M-15', 'bytes = -1（旧的「未记录大小」哨兵）→ 拒绝', !r.owned && /bytes/.test(r.reason), `owned=${r.owned} reason=${r.reason}`)
}
{
	const files = seed(EXPORT_DIR, OWN_ENTRIES)
	mutate(files, EXPORT_DIR, m => {
		m.files[0].sha256 = 'abc'
	})
	const r = await own(makeVault({ files }).app)
	record('M-16', 'sha256 不是 64 位十六进制 → 拒绝', !r.owned && /sha256/.test(r.reason), `owned=${r.owned} reason=${r.reason}`)
}
{
	// `basis` must describe what really happened, not what was attempted.
	const files = seed(EXPORT_DIR, OWN_ENTRIES)
	delete files[`${EXPORT_DIR}/assets/export.css`]
	const r = await own(makeVault({ files }).app)
	record(
		'M-17',
		'缺一个文件时 basis 必须降为 none（不得仍报 manifest-hmac）',
		!r.owned && r.basis === 'none' && r.checked < 3,
		`owned=${r.owned} basis=${r.basis} checked=${r.checked}`
	)
}
{
	// Size matches, hash does not, signature valid. This is the case a
	// "size is enough" comparison would wave through, so it is the direct guard
	// on the S2 rule that both fields are always compared.
	const files = seed(EXPORT_DIR, OWN_ENTRIES)
	mutate(files, EXPORT_DIR, m => {
		m.files[0].sha256 = 'e'.repeat(64)
	})
	const r = await own(makeVault({ files }).app)
	record(
		'M-18',
		'签名有效、bytes 正确、sha256 错误 → 拒绝（不接受只比大小）',
		!r.owned && r.basis === 'none' && r.changedFiles.length === 1,
		`owned=${r.owned} changed=${JSON.stringify(r.changedFiles)}`
	)
}

{
	// Boundary, stated on purpose: the signed projection sorts `files` by path,
	// so reordering the array without re-signing still verifies. Order carries
	// no meaning here — the records are turned into a path → record map — so
	// this is not a tamper window, it is the price of deterministic serialising.
	const files = seed(EXPORT_DIR, OWN_ENTRIES)
	mutate(files, EXPORT_DIR, m => {
		m.files.reverse()
	}, { resign: false })
	const r = await own(makeVault({ files }).app)
	record(
		'M-19',
		'调换 files 数组顺序（不重签）→ 仍认可（顺序不承载语义）',
		r.owned && r.basis === 'manifest-hmac',
		`owned=${r.owned} basis=${r.basis}`
	)
}

/* ============================================================ H · HMAC === */
console.log('\n=== H · HMAC 可信性（签名覆盖范围与失效表达）===')

{
	const files = seed(EXPORT_DIR, OWN_ENTRIES)
	const r = await own(makeVault({ files }).app)
	record(
		'H-01',
		'正常签名 → 认可，basis=manifest-hmac，signatureVerified=true',
		r.owned && r.basis === 'manifest-hmac' && r.signatureVerified === true && r.checked === 3,
		`owned=${r.owned} basis=${r.basis} sig=${r.signatureVerified} checked=${r.checked}`
	)
}
{
	const files = seed(EXPORT_DIR, OWN_ENTRIES)
	mutate(files, EXPORT_DIR, m => {
		m.notePath = 'notes/other.md'
	}, { resign: false })
	const r = await own(makeVault({ files }).app)
	record('H-02', '改 notePath 不重签 → 「签名与内容不匹配」', !r.owned && /签名与内容不匹配/.test(r.reason), `reason=${r.reason}`)
}
{
	const files = seed(EXPORT_DIR, OWN_ENTRIES)
	mutate(files, EXPORT_DIR, m => {
		m.files.push({ path: 'assets/extra.css', bytes: 3, sha256: 'a'.repeat(64) })
	}, { resign: false })
	const r = await own(makeVault({ files }).app)
	record('H-03', '往 files 里加一条记录不重签 → 拒绝', !r.owned && /签名/.test(r.reason), `reason=${r.reason}`)
}
{
	const files = seed(EXPORT_DIR, OWN_ENTRIES)
	mutate(files, EXPORT_DIR, m => {
		m.files[0].sha256 = 'b'.repeat(64)
	}, { resign: false })
	const r = await own(makeVault({ files }).app)
	record('H-04', '改某条 sha256 不重签 → 拒绝', !r.owned && /签名/.test(r.reason), `reason=${r.reason}`)
}
{
	const files = seed(EXPORT_DIR, OWN_ENTRIES)
	mutate(files, EXPORT_DIR, m => {
		m.signature.value = 'c'.repeat(64)
	}, { resign: false })
	const r = await own(makeVault({ files }).app)
	record('H-05', '篡改签名值 → 拒绝', !r.owned && /签名与内容不匹配/.test(r.reason), `reason=${r.reason}`)
}
{
	const files = seed(EXPORT_DIR, OWN_ENTRIES)
	const r = await own(makeVault({ files }).app, EXPORT_DIR, NOTE_PATH, OTHER_KEY)
	record('H-06', '换一把密钥验证 → 拒绝', !r.owned && /签名与内容不匹配|来自另一个 Vault/.test(r.reason), `reason=${r.reason}`)
}
{
	const files = seed(EXPORT_DIR, OWN_ENTRIES)
	const r = await own(makeVault({ files }).app, EXPORT_DIR, NOTE_PATH, null)
	record(
		'H-07',
		'密钥缺失（同步到新设备）→ 明确报「签名密钥不可用」，不静默信任',
		!r.owned && /签名密钥不可用/.test(r.reason),
		`owned=${r.owned} reason=${r.reason}`
	)
}
{
	// A restart must not invalidate existing exports: verify with a *fresh*
	// module instance so no in-memory state can help.
	const files = seed(EXPORT_DIR, OWN_ENTRIES)
	const fresh = await bundle('src/export/manifest-signing.ts', 'manifest-signing-reload')
	const manifest = JSON.parse(files[`${EXPORT_DIR}/export-manifest.json`])
	const verdict = await fresh.verifyManifestSignature(manifest, TEST_KEY)
	const r = await own(makeVault({ files }).app)
	record(
		'H-08',
		'重启后（全新模块实例）仍能验证既有导出',
		verdict.ok === true && r.owned,
		`fresh=${verdict.ok} ${verdict.reason} owned=${r.owned}`
	)
}
{
	// A different vault must not inherit another vault's key.
	const a = signManifest
	const manifest = {
		manifestVersion: 2,
		notePath: NOTE_PATH,
		identitySuffix: identitySuffix(NOTE_PATH),
		outputFolder: EXPORT_DIR.split('/').pop(),
		status: 'ok',
		generatedAt: 'x',
		assets: { entries: [] },
		files: recordsFrom(OWN_ENTRIES)
	}
	const signed = await a(manifest, TEST_KEY)
	const underOwn = await verifyManifestSignature({ ...manifest, signature: signed }, TEST_KEY)
	const underOther = await verifyManifestSignature({ ...manifest, signature: signed }, OTHER_KEY)
	record(
		'H-09',
		'A 的签名在 A 的密钥下有效、在 B 的密钥下无效（Vault 之间不通用）',
		underOwn.ok === true && underOther.ok === false,
		`own=${underOwn.ok} other=${underOther.ok}`
	)
}
{
	const files = seed(EXPORT_DIR, OWN_ENTRIES)
	mutate(files, EXPORT_DIR, m => delete m.signature, { resign: false })
	const r1 = await own(makeVault({ files }).app)

	const files2 = seed(EXPORT_DIR, OWN_ENTRIES)
	mutate(files2, EXPORT_DIR, m => {
		m.signature = { alg: 'MD5', v: 1, value: 'd'.repeat(64) }
	}, { resign: false })
	const r2 = await own(makeVault({ files: files2 }).app)
	record(
		'H-10',
		'signature 缺失 / 算法不受支持 → 均拒绝且理由具体',
		!r1.owned && /缺少 signature/.test(r1.reason) && !r2.owned && /算法/.test(r2.reason),
		`missing=${r1.reason} | badAlg=${r2.reason}`
	)
}
{
	// `noteTitle` is deliberately outside the signed projection: renaming a note
	// is metadata, not tampering, and must not strand the old export.
	const files = seed(EXPORT_DIR, OWN_ENTRIES)
	mutate(files, EXPORT_DIR, m => {
		m.noteTitle = '改了个标题'
	}, { resign: false })
	const r = await own(makeVault({ files }).app)
	record('H-11', '改 noteTitle（投影外字段）→ 仍认可（反向对照）', r.owned, `owned=${r.owned} reason=${r.reason}`)
}
{
	// Round 1 B2, now with an intact signature: copy A's export into B's
	// directory without touching a byte. The signature still verifies, so the
	// refusal has to come from the note identity.
	const dirB = resolveExportDir('html-export', TITLE, 'notes/同名-B.md').dir
	const dirA = resolveExportDir('html-export', TITLE, 'notes/同名-A.md').dir
	const seedA = seed(dirA, OWN_ENTRIES, { notePath: 'notes/同名-A.md' })
	const files = {}
	for (const [k, v] of Object.entries(seedA)) files[k.replace(dirA, dirB)] = v
	const r = await own(makeVault({ files }).app, dirB, 'notes/同名-B.md')
	record(
		'H-12',
		'整目录搬到另一篇笔记（SHA-256 与签名全部不变）→ 拒绝',
		!r.owned && /另一篇笔记/.test(r.reason),
		`owned=${r.owned} reason=${r.reason}`
	)
}

/* ================================================== P · Windows 路径 === */
console.log('\n=== P · Windows 路径完整性（ADS / 保留名 / 尾点空格 / 归一化）===')

/** Seed a signed manifest that claims `paths`, with matching files on disk. */
function seedPaths(paths) {
	const entries = { 'index.html': page() }
	const files = {}
	for (const p of paths) {
		entries[p] = 'binary:3'
		files[`${EXPORT_DIR}/${p}`] = 'binary:3'
	}
	for (const [rel, content] of Object.entries(entries)) {
		if (rel === 'index.html') files[`${EXPORT_DIR}/${rel}`] = content
	}
	const filesArr = Object.entries(entries).map(([rel, content]) => ({
		path: rel,
		bytes: bytesOf(content),
		sha256: sha256hex(content)
	}))
	files[`${EXPORT_DIR}/export-manifest.json`] = buildManifest(entries, {
		filesOverride: filesArr,
		outputFolder: EXPORT_DIR.split('/').pop()
	})
	return files
}

const pathCase = async (id, name, paths, expect) => {
	const files = seedPaths(paths)
	const r = await own(makeVault({ files }).app)
	record(id, name, !r.owned && expect.test(r.reason), `owned=${r.owned} reason=${r.reason}`)
}

await pathCase('P-01', 'assets/a:b.png（NTFS 备用数据流）→ 拒绝', ['assets/a:b.png'], /非法路径/)
await pathCase('P-02', 'assets/CON（保留设备名）→ 拒绝', ['assets/CON'], /非法路径/)
await pathCase('P-03', 'assets/NUL.txt（带扩展名的保留名）→ 拒绝', ['assets/NUL.txt'], /非法路径/)
await pathCase('P-04', 'assets/file.（尾点会被 Windows 截断）→ 拒绝', ['assets/file.'], /非法路径/)
await pathCase('P-05', 'assets/file （尾空格会被 Windows 截断）→ 拒绝', ['assets/file '], /非法路径/)
await pathCase('P-06', 'assets/A.png 与 assets/a.png 并存 → 拒绝', ['assets/A.png', 'assets/a.png'], /归一化|重复/)
await pathCase(
	'P-07',
	'café 的 NFC 与 NFD 两种写法并存 → 拒绝',
	['assets/caf\u00e9.png', 'assets/cafe\u0301.png'],
	/归一化|重复/
)
{
	const cases = [
		['/index.html', '绝对路径'],
		['C:/index.html', '盘符'],
		['assets\\export.css', '反斜杠'],
		['../escape.html', '上跳'],
		['//server/share/x.png', 'UNC']
	]
	const failures = []
	for (const [bad, label] of cases) {
		const files = seedPaths([bad])
		const r = await own(makeVault({ files }).app)
		if (r.owned || !/非法路径/.test(r.reason)) failures.push(`${label}=${r.owned ? '认可' : r.reason}`)
	}
	record('P-08', '绝对路径 / 盘符 / 反斜杠 / .. / UNC → 全部拒绝', failures.length === 0, failures.join('; ') || '5/5 拒绝')
}
{
	// Real filesystem probe. Node on Windows prefixes paths with `\\?\`
	// (extended-length syntax), which bypasses the Win32 name rules entirely:
	// `CON` becomes creatable and `taildot.` keeps its dot. That is *why* the
	// earlier review saw these names "work" — and it is exactly why the manifest
	// must not record them. The two behaviours below are the ones that matter and
	// that no `\\?\` trick can undo:
	//
	//   1. `name:stream` writes successfully but never appears in a directory
	//      listing, so an ADS can hold data the manifest diff cannot see;
	//   2. `Case.PNG` and `case.png` are one file, so two records can name the
	//      same bytes.
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'he-win-'))
	const observed = {}
	try {
		fs.writeFileSync(path.join(dir, 'probe.txt'), 'x')
		try {
			fs.writeFileSync(path.join(dir, 'probe.txt:stream'), 'ads')
			observed.ads = fs.readdirSync(dir).includes('probe.txt:stream')
				? '可见'
				: '不可见（写入成功）'
		} catch (e) {
			observed.ads = `拒绝(${e.code})`
		}
		try {
			fs.writeFileSync(path.join(dir, 'CON'), 'x')
			observed.con = '可创建（Node 用 \\\\?\\ 绕过了 Win32 规则）'
		} catch (e) {
			observed.con = `拒绝(${e.code})`
		}
		fs.writeFileSync(path.join(dir, 'taildot.'), 'x')
		observed.taildot = fs.readdirSync(dir).includes('taildot.') ? '保留（同上）' : '被截断为 taildot'
		fs.writeFileSync(path.join(dir, 'Case.PNG'), 'a')
		fs.writeFileSync(path.join(dir, 'case.png'), 'b')
		observed.case = fs.readdirSync(dir).filter(n => n.toLowerCase() === 'case.png').length
	} finally {
		fs.rmSync(dir, { recursive: true, force: true })
	}
	const win = process.platform === 'win32'
	const ok = !win || (observed.ads !== '可见' && observed.case === 1)
	record(
		'P-09',
		'真实 Windows 探针：ADS 写入后不可见、大小写折叠为同一文件（因此清单必须拒绝这类名字）',
		ok,
		`platform=${process.platform} ${JSON.stringify(observed)}`
	)
}

{
	// Reverse control: a legal nested media path must still work, otherwise the
	// tightening above would just be a blanket refusal.
	const files = seedPaths(['assets/media/pic.png'])
	const r = await own(makeVault({ files }).app)
	record('P-10', '合法嵌套路径 assets/media/pic.png → 仍认可（反向对照）', r.owned, `owned=${r.owned} reason=${r.reason}`)
}
/* ================================================== T · 发布事务 === */
console.log('\n=== T · 发布事务（拒绝时零 rename，成功时备份保留，无自动删除）===')

{
	const v = makeVault({ files: seed(EXPORT_DIR, OWN_ENTRIES) })
	v.files.set(`${EXPORT_DIR}/README.md`, '# 我写的说明')
	const before = snapshotDir(v, EXPORT_DIR)
	const { error } = await runExport(v)
	const unchanged = sameDir(v, EXPORT_DIR, before)
	record(
		'T-01',
		'所有权失败：旧目录逐字节不变，且没有发生任何 rename',
		!!error && error.stage === 'publish' && unchanged && v.renameCalls === 0,
		`stage=${error?.stage} renameCalls=${v.renameCalls} unchanged=${unchanged}`
	)
}
{
	// The directory is ours, but the manifest was signed with another key.
	const v = makeVault({ files: seed(EXPORT_DIR, OWN_ENTRIES, { key: OTHER_KEY }) })
	const before = snapshotDir(v, EXPORT_DIR)
	const { error } = await runExport(v)
	const unchanged = sameDir(v, EXPORT_DIR, before)
	record(
		'T-02',
		'签名失败：不发生 publish rename，旧目录原样保留',
		!!error && v.renameCalls === 0 && unchanged && /签名/.test(error.message),
		`renameCalls=${v.renameCalls} unchanged=${unchanged}`
	)
}
{
	const v = makeVault({ files: seed(EXPORT_DIR, OWN_ENTRIES) })
	const firstHtml = v.files.get(`${EXPORT_DIR}/index.html`)
	const { report, error } = await runExport(v)
	const backups = siblings(v, '.bak-')
	const backupHtml = backups.length === 1 ? v.files.get(`${backups[0]}/index.html`) : null
	record(
		'T-03',
		'正常发布：旧导出保留为 .bak- 且内容完整',
		!error && !!report?.leftoverBackup && backupHtml === firstHtml,
		`backup=${report?.leftoverBackup} intact=${backupHtml === firstHtml}`
	)
}
{
	const v = makeVault({ files: seed(EXPORT_DIR, OWN_ENTRIES) }, { renameFailAt: [2] })
	const before = snapshotDir(v, EXPORT_DIR)
	const { error } = await runExport(v)
	const restored = sameDir(v, EXPORT_DIR, before)
	record(
		'T-04',
		'发布 rename 失败：自动恢复旧目录，内容逐字节一致',
		!!error && restored && /已恢复/.test(error.message),
		`restored=${restored} msg=${error ? error.message.split('\n')[0] : 'none'}`
	)
}
{
	const writerSrc = fs.readFileSync(path.join(root, 'src/export/writer.ts'), 'utf8')
	const signingSrc = fs.readFileSync(path.join(root, 'src/export/manifest-signing.ts'), 'utf8')
	const banned = [
		['adapter.remove(', /adapter\.remove\s*\(/],
		['adapter.rmdir(', /adapter\.rmdir\s*\(/],
		['vault.delete(', /vault\.delete\s*\(/],
		['.trash(', /\.trash\s*\(/],
		['rm -rf', /rm\s+-rf/]
	]
	const hits = banned.filter(([, re]) => re.test(writerSrc) || re.test(signingSrc)).map(([n]) => n)
	const exportNames = Object.keys(await bundle('src/export/writer.ts', 'writer-surface'))
	const deleteExports = exportNames.filter(n => /remove|rmdir|delete|clean|purge/i.test(n))
	record(
		'T-05',
		'源码与导出面中不存在任何自动删除入口',
		hits.length === 0 && deleteExports.length === 0,
		`hits=${JSON.stringify(hits)} deleteExports=${JSON.stringify(deleteExports)}`
	)
}
{
	const v = makeVault({ files: seed(EXPORT_DIR, OWN_ENTRIES) })
	v.files.set(`${EXPORT_DIR}/README.md`, '# 我写的说明')
	const { error } = await runExport(v)
	const tmpDirs = siblings(v, '.tmp-')
	const tmpKept = tmpDirs.length === 1 && tmpDirs[0] === error?.tmpDir
	record(
		'T-06',
		'失败时临时目录不自动清理，且错误里给出位置',
		!!error && tmpKept && error.message.includes(tmpDirs[0]),
		`tmp=${error?.tmpDir}`
	)
}

/* ================================================== K · 密钥管理 === */
console.log('\n=== K · 密钥管理（生成 / 校验 / 持久化 / 不外泄）===')

{
	const keys = new Set()
	let shapeOk = true
	for (let i = 0; i < 1000; i++) {
		const k = generateSigningKeyHex()
		if (!/^[0-9a-f]{64}$/.test(k)) shapeOk = false
		keys.add(k)
	}
	record(
		'K-01',
		'生成的密钥是 64 位小写十六进制，1000 次互不相同',
		shapeOk && keys.size === 1000,
		`shape=${shapeOk} unique=${keys.size}/1000`
	)
}
{
	const good = '0123456789abcdef'.repeat(4)
	const bad = ['', null, undefined, 'abc', 'g'.repeat(64), good + 'a', good.slice(0, 63)]
	const accepted = bad.filter(v => isValidSigningKey(v))
	record(
		'K-02',
		'校验函数只接受 64 位十六进制，其余一律拒绝',
		isValidSigningKey(good) && accepted.length === 0,
		`good=${isValidSigningKey(good)} acceptedBad=${JSON.stringify(accepted)}`
	)
}
{
	// `data.json` round-trip: the key must survive a restart unchanged, so
	// exports written before the restart stay verifiable afterwards.
	const key = generateSigningKeyHex()
	const persisted = JSON.stringify({ signingKey: key, outputFolder: 'html-export' })
	const reloaded = JSON.parse(persisted)
	const manifest = {
		manifestVersion: 2,
		notePath: NOTE_PATH,
		identitySuffix: identitySuffix(NOTE_PATH),
		outputFolder: EXPORT_DIR.split('/').pop(),
		status: 'ok',
		generatedAt: 'x',
		assets: { entries: [] },
		files: recordsFrom(OWN_ENTRIES)
	}
	const signature = await signManifest(manifest, key)
	const afterRestart = await verifyManifestSignature(
		{ ...manifest, signature },
		reloaded.signingKey
	)
	record(
		'K-03',
		'密钥经 data.json 序列化往返后仍能验证重启前的导出',
		reloaded.signingKey === key && afterRestart.ok === true,
		`sameKey=${reloaded.signingKey === key} verify=${afterRestart.ok}`
	)
}
{
	const v = makeVault({})
	const { report, error } = await runExport(v)
	const tree = [...v.files.entries()]
	const leaked = tree.filter(([, content]) => String(content).includes(TEST_KEY))
	const manifest = JSON.parse(v.files.get(`${report?.dir}/export-manifest.json`) ?? '{}')
	const hasKeyField = Object.keys(manifest).some(k => /key/i.test(k))

	const empty = makeVault({})
	const refused = await runExport(empty, { key: null })
	const wroteNothing = empty.log.filter(([op]) => op === 'write' || op === 'mkdir').length === 0
	record(
		'K-04',
		'密钥不写入导出目录/清单；缺密钥时在写任何文件前拒绝',
		!error && leaked.length === 0 && !hasKeyField && refused.error?.stage === '签名密钥' && wroteNothing,
		`leaked=${leaked.length} keyField=${hasKeyField} stage=${refused.error?.stage} wroteNothing=${wroteNothing}`
	)
}

/* ------------------------------------------------------------- summary -- */
console.log(`\n小计：PASS ${pass} / FAIL ${fail} / 共 ${results.length}`)
fs.mkdirSync(out, { recursive: true })
fs.writeFileSync(
	path.join(out, 'round2a2-2-results.json'),
	JSON.stringify({ pass, fail, total: results.length, results }, null, 2)
)
process.exit(fail > 0 ? 1 : 0)
