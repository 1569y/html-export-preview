/**
 * Round 2A.2 — Fail-Closed Ownership & Safe Backup 测试套件
 *
 * 覆盖 B2（Manifest 严格版本与结构验证）、B3（验证能力不可用时 fail-closed）、
 * B4（Manifest 篡改处理）、B5（Backup 清理重设计：禁止自动递归删除）、
 * B6（修正后的 X6 所有权测试）。
 *
 * 不经过 Obsidian，用 esbuild 把真实 `writer.ts` 编到内存，喂给一个忠实实现
 * `adapter.list` 语义、并对 readBinary/stat/rename 提供可控故障注入的内存适配器。
 *
 * 运行：node tests/unit/run-round2a2.mjs
 */
import { build } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash, createHmac } from 'node:crypto'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = process.env.AB_ROOT
	? path.resolve(process.env.AB_ROOT)
	: path.resolve(here, '../..')
const out = path.join(here, '.out-round2a2')

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
		JSON.stringify({ name: 'obsidian', version: '0.0.0-stub', type: 'module', main: 'index.mjs', exports: './index.mjs' })
	)
}
async function bundle(entry, name) {
	prepareStub()
	const outfile = path.join(out, `${name}.mjs`)
	await build({ entryPoints: [path.join(root, entry)], outfile, bundle: true, format: 'esm', platform: 'node', target: 'node18', external: ['obsidian'], logLevel: 'error' })
	return import(`${pathToFileURL(outfile).href}?v=${Date.now()}`)
}

const { writeExport, inspectOwnership, MANIFEST_VERSION } = await bundle('src/export/writer.ts', 'writer')
const { AssetCollector } = await bundle('src/assets/resource-manager.ts', 'assets')
const { resolveExportDir, identitySuffix } = await bundle('src/export/path-safety.ts', 'path-safety')
const { signingPayload } = await bundle('src/export/manifest-signing.ts', 'manifest-signing')

/**
 * Round 2A.2.2 (S3): fixtures are signed like real exports.
 *
 * The HMAC is computed with `node:crypto` on purpose — the production code signs
 * with WebCrypto (`crypto.subtle`). If the two disagreed about the payload or the
 * algorithm, every "owned" assertion below would fail, so this doubles as a
 * cross-check of the signing implementation.
 */
const TEST_KEY = 'ab'.repeat(32)
function signFixture(manifest) {
	manifest.signature = {
		alg: 'HMAC-SHA256',
		v: 1,
		value: createHmac('sha256', Buffer.from(TEST_KEY, 'hex'))
			.update(signingPayload(manifest))
			.digest('hex')
	}
	return manifest
}

/* --------------------------------------------------------- fake adapter -- */
function makeVault(seed = {}, cfg = {}) {
	const files = new Map(Object.entries(seed.files ?? {}))
	const dirs = new Set(['.'])
	const addDirsFor = p => { const parts = p.split('/'); for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/')) }
	for (const p of files.keys()) addDirsFor(p)
	for (const d of seed.dirs ?? []) { dirs.add(d); addDirsFor(d) }
	const log = []
	const destroyed = []
	let renameCalls = 0
	const utf8 = s => new TextEncoder().encode(String(s))
	const adapter = {
		async exists(p) { return files.has(p) || dirs.has(p) },
		async mkdir(p) { log.push(['mkdir', p]); dirs.add(p) },
		async write(p, data) { log.push(['write', p]); files.set(p, String(data)); addDirsFor(p) },
		async read(p) { if (!files.has(p)) throw new Error(`ENOENT ${p}`); return files.get(p) },
		async readBinary(p) {
			if (cfg.readBinaryThrow) throw new Error('readBinary forced throw')
			if (!files.has(p)) throw new Error(`ENOENT ${p}`)
			return utf8(files.get(p))
		},
		async stat(p) {
			if (cfg.statThrow) throw new Error('stat forced throw')
			if (files.has(p)) return { size: String(files.get(p)).length, type: 'file' }
			if (dirs.has(p)) return { size: 0, type: 'folder' }
			return null
		},
		async list(p) {
			const res = { files: [], folders: [] }
			for (const k of files.keys()) if (path.posix.dirname(k) === p) res.files.push(k)
			for (const d of dirs) if (d !== '.' && d !== p && path.posix.dirname(d) === p) res.folders.push(d)
			return res
		},
		async rename(from, to) {
			renameCalls++
			if (cfg.renameFailAt && renameCalls === cfg.renameFailAt) throw new Error('EACCES simulated rename failure')
			log.push(['rename', from, to])
			const moved = [...files.keys()].filter(k => k === from || k.startsWith(`${from}/`))
			const movedDirs = [...dirs].filter(d => d === from || d.startsWith(`${from}/`))
			if (moved.length === 0 && movedDirs.length === 0) throw new Error(`rename: 源不存在 ${from}`)
			for (const k of moved) { const v = files.get(k); files.delete(k); files.set(`${to}${k.slice(from.length)}`, v) }
			for (const d of movedDirs) { dirs.delete(d); dirs.add(`${to}${d.slice(from.length)}`) }
		},
		async rmdir(p, recursive) {
			log.push(['rmdir', p, recursive])
			for (const k of [...files.keys()]) if (k === p || k.startsWith(`${p}/`)) { destroyed.push({ path: k, content: files.get(k), via: 'rmdir' }); files.delete(k) }
			for (const d of [...dirs]) if (d === p || d.startsWith(`${p}/`)) dirs.delete(d)
		},
		async remove(p) {
			if (!files.has(p)) return
			destroyed.push({ path: p, content: files.get(p), via: 'remove' })
			files.delete(p)
		}
	}
	return { app: { vault: { adapter } }, files, dirs, log, destroyed, get renameCalls() { return renameCalls } }
}

/* ------------------------------------------------------------- fixtures -- */
const BODY_START = '<!--he-body-start-->'
const BODY_END = '<!--he-body-end-->'
const page = (body = '<p>正文内容</p>') =>
	'<!doctype html>\n<html>\n<head><title>t</title></head>\n<body>\n' +
	`${BODY_START}\n${body}\n${BODY_END}\n</body>\n</html>\n`
const sha256hex = s => createHash('sha256').update(String(s), 'utf8').digest('hex')

function buildManifest(entries, { notePath = 'notes/note.md', noteTitle = '笔记', version = 2, filesOverride, assets, identitySuffix: suffixOverride, outputFolder } = {}) {
	const filesArr = Object.entries(entries).map(([rel, content]) => ({
		path: rel,
		bytes: Buffer.byteLength(String(content), 'utf8'),
		sha256: sha256hex(content)
	}))
	const manifest = {
		manifestVersion: version,
		generatedAt: 'x',
		notePath,
		noteTitle,
		// Round 2A.2.2 (S3.4/S3.5): both are signed *and* verified against the
		// note being exported and the directory on disk.
		identitySuffix: suffixOverride ?? identitySuffix(notePath),
		outputFolder: outputFolder ?? EXPORT_DIR.split('/').pop(),
		status: 'ok',
		assets: assets ?? { written: 0, attempted: 0, entries: [], failed: [] },
		files: filesOverride ?? filesArr
	}
	return JSON.stringify(signFixture(manifest))
}

/** Seed a v1 export under `dir` with the given file entries. */
function seedV1(dir, entries, opts = {}) {
	const files = {}
	for (const [rel, content] of Object.entries(entries)) files[`${dir}/${rel}`] = content
	files[`${dir}/export-manifest.json`] = buildManifest(entries, opts)
	return files
}

const EXPORT_DIR = resolveExportDir('html-export', '笔记', 'notes/note.md').dir
/**
 * Round 2A.2.1 (S2): `inspectOwnership` now takes the note path being exported.
 * Every fixture in this file belongs to `notes/note.md`, so the default keeps
 * the original call sites readable while still exercising the real signature.
 */
const NOTE_PATH = 'notes/note.md'
/**
 * Round 2A.2.2 (S3): ownership now requires the vault's signing key. Every
 * fixture here is signed with `TEST_KEY`, so the wrapper passes it through.
 */
const own = (app, dir = EXPORT_DIR, notePath = NOTE_PATH, key = TEST_KEY) =>
	inspectOwnership(app, dir, notePath, key)
const OWN_ENTRIES = {
	'index.html': page('<p>第一版</p>'),
	'assets/export.css': 'body{}',
	'runtime-audit.json': '{"generatedAt":"x"}'
}

const snap = (title = '笔记', notePath = 'notes/note.md') => ({
	notePath, noteTitle: title, captureWidth: 900,
	stats: { blocks: 1, images: 0, mermaid: 0, sidenotes: 0, bytesOfContent: 40 },
	resolution: { candidates: [], reason: '唯一可用候选', ambiguity: false },
	previewMetrics: { width: 900 }, warnings: []
})
const EXTRA = { css: { bytes: 10, sheets: [], warnings: [] }, pluginVersion: '0.1.0', audit: { generatedAt: 'x' } }

/* -------------------------------------------------------------- runner -- */
let pass = 0, fail = 0
const results = []
function record(id, name, ok, detail = '') {
	results.push({ id, name, verdict: ok ? 'PASS' : 'FAIL', detail })
	if (ok) pass++; else fail++
	console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${id}  ${name}${detail ? '  — ' + detail : ''}`)
}

/* ============================================================= B2: version */
console.log('\n=== B2 · Manifest 严格版本与结构验证 ===')
{
	const v = makeVault({ files: seedV1(EXPORT_DIR, OWN_ENTRIES) })
	const r = await own(v.app)
	record('B2-01', 'v2 签名清单 → 所有权成立', r.owned && r.basis === 'manifest-hmac', `basis=${r.basis} checked=${r.checked}`)
}
{
	// Round 2A.2.2 (S3): version 2 is now the supported signed format, so the
	// "unknown version" case moves to 3. The assertion's intent is unchanged:
	// an unrecognised version must never be downgraded to a weaker proof.
	const files = seedV1(EXPORT_DIR, OWN_ENTRIES, { version: 3 })
	const v = makeVault({ files })
	const r = await own(v.app)
	record('B2-02', 'manifestVersion=3 不支持 → 拒绝', !r.owned && /不支持|版本/.test(r.reason), r.reason)
}
{
	// version present but non-number
	const entries = OWN_ENTRIES
	const files = {}
	for (const [rel, c] of Object.entries(entries)) files[`${EXPORT_DIR}/${rel}`] = c
	const m = JSON.parse(buildManifest(entries))
	m.manifestVersion = '1' // string, not number
	files[`${EXPORT_DIR}/export-manifest.json`] = JSON.stringify(m)
	const v = makeVault({ files })
	const r = await own(v.app)
	record('B2-03', 'manifestVersion 非数字 → 拒绝', !r.owned, r.reason)
}
{
	// v1 + files missing
	const entries = OWN_ENTRIES
	const files = {}
	for (const [rel, c] of Object.entries(entries)) files[`${EXPORT_DIR}/${rel}`] = c
	const m = JSON.parse(buildManifest(entries)); delete m.files
	files[`${EXPORT_DIR}/export-manifest.json`] = JSON.stringify(m)
	const v = makeVault({ files })
	const r = await own(v.app)
	record('B2-04', 'v1 + files 缺失 → 拒绝（不得降级 legacy）', !r.owned, r.reason)
}
{
	// v1 + files = []
	const entries = OWN_ENTRIES
	const files = {}
	for (const [rel, c] of Object.entries(entries)) files[`${EXPORT_DIR}/${rel}`] = c
	const m = JSON.parse(buildManifest(entries)); m.files = []
	files[`${EXPORT_DIR}/export-manifest.json`] = JSON.stringify(m)
	const v = makeVault({ files })
	const r = await own(v.app)
	record('B2-05', 'v1 + files=[] → 拒绝', !r.owned, r.reason)
}
{
	// v1 + files wrong type (string)
	const entries = OWN_ENTRIES
	const files = {}
	for (const [rel, c] of Object.entries(entries)) files[`${EXPORT_DIR}/${rel}`] = c
	const m = JSON.parse(buildManifest(entries)); m.files = 'not-an-array'
	files[`${EXPORT_DIR}/export-manifest.json`] = JSON.stringify(m)
	const v = makeVault({ files })
	const r = await own(v.app)
	record('B2-06', 'v1 + files 类型错误 → 拒绝', !r.owned, r.reason)
}
{
	// v1 + duplicate path
	const entries = OWN_ENTRIES
	const files = {}
	for (const [rel, c] of Object.entries(entries)) files[`${EXPORT_DIR}/${rel}`] = c
	const m = JSON.parse(buildManifest(entries))
	m.files = [{ path: 'index.html', bytes: 1, sha256: 'a'.repeat(64) }, { path: 'index.html', bytes: 1, sha256: 'b'.repeat(64) }]
	files[`${EXPORT_DIR}/export-manifest.json`] = JSON.stringify(m)
	const v = makeVault({ files })
	const r = await own(v.app)
	record('B2-07', 'v1 + 重复路径 → 拒绝', !r.owned, r.reason)
}
{
	// v1 + illegal path (.. escape)
	const entries = OWN_ENTRIES
	const files = {}
	for (const [rel, c] of Object.entries(entries)) files[`${EXPORT_DIR}/${rel}`] = c
	files[`${EXPORT_DIR}/evil.txt`] = 'x'
	const m = JSON.parse(buildManifest(entries))
	m.files = [{ path: '../escape.txt', bytes: 1, sha256: sha256hex('x') }]
	files[`${EXPORT_DIR}/export-manifest.json`] = JSON.stringify(m)
	const v = makeVault({ files })
	const r = await own(v.app)
	record('B2-08', 'v1 + 非法路径(..) → 拒绝', !r.owned, r.reason)
}
{
	// legacy manifest (no version, only assets.entries) with body markers → still owned
	const files = {
		[`${EXPORT_DIR}/index.html`]: page('<p>旧版</p>'),
		[`${EXPORT_DIR}/assets/export.css`]: 'body{}',
		[`${EXPORT_DIR}/runtime-audit.json`]: '{}',
		[`${EXPORT_DIR}/export-manifest.json`]: JSON.stringify({ notePath: NOTE_PATH, status: 'ok', stats: { blocks: 1 }, assets: { written: 0, entries: [], failed: [] } })
	}
	const v = makeVault({ files })
	const r = await own(v.app)
	// Round 2A.2.2 (S1) — this case used to assert the opposite:
	//   record('B2-09', '旧版清单(无版本) → 受限 legacy 仍可由结构性证明认可',
	//          r.owned && r.basis === 'legacy-structure', `basis=${r.basis}`)
	// A legacy manifest is byte-identical to a signed one with two fields
	// deleted, so "legacy" can no longer be a reason to trust a directory.
	record('B2-09', '旧版清单(无版本) → 拒绝（S1：legacy 不再自动认可）', !r.owned && /旧版/.test(r.reason), `owned=${r.owned} reason=${r.reason}`)
}
{
	// corrupted v1 manifest must NOT be treated as legacy: tamper the files array content
	const entries = OWN_ENTRIES
	const files = {}
	for (const [rel, c] of Object.entries(entries)) files[`${EXPORT_DIR}/${rel}`] = c
	const m = JSON.parse(buildManifest(entries))
	m.files = [{ path: 'index.html', bytes: 'BROKEN', sha256: 'x'.repeat(64) }]
	files[`${EXPORT_DIR}/export-manifest.json`] = JSON.stringify(m)
	const v = makeVault({ files })
	const r = await own(v.app)
	record('B2-10', '损坏的 v1 files 不降级为 legacy（bytes 非法→拒绝）', !r.owned, r.reason)
}

/* ============================================================= B3: capability */
console.log('\n=== B3 · 验证能力不可用时 fail-closed ===')
{
	// hash mismatch → changed → reject
	const entries = OWN_ENTRIES
	const files = {}
	for (const [rel, c] of Object.entries(entries)) files[`${EXPORT_DIR}/${rel}`] = c
	// Round 2A.2.2 (S3): tampering with the manifest now fails the signature
	// before any file comparison runs, so this case keeps its meaning by changing
	// the file on disk instead — same length, different bytes — and leaving the
	// signed manifest untouched.
	const m = JSON.parse(buildManifest(entries))
	files[`${EXPORT_DIR}/export-manifest.json`] = JSON.stringify(m)
	files[`${EXPORT_DIR}/index.html`] = page('<p>第二版</p>')
	const v = makeVault({ files })
	const r = await own(v.app)
	record('B3-01', '文件内容与签名清单的 SHA-256 不一致 → 拒绝', !r.owned && r.changedFiles.length > 0, `changed=${r.changedFiles.length} reason=${r.reason.slice(0, 50)}`)
}
{
	// crypto unavailable → cannot verify → reject, basis 'none', checked 0
	const entries = OWN_ENTRIES
	const files = seedV1(EXPORT_DIR, entries)
	const v = makeVault({ files })
	const savedCrypto = globalThis.crypto
	Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {} }) // no subtle
	let r
	try { r = await own(v.app) } finally {
		Object.defineProperty(globalThis, 'crypto', { configurable: true, value: savedCrypto })
	}
	// Round 2A.2.2 (S3): without crypto.subtle the signature cannot be verified
	// at all, so the refusal happens one step earlier than the file comparison.
	record('B3-02', 'crypto.subtle 缺失 → 拒绝且 basis=none', !r.owned && r.basis === 'none' && r.checked === 0,
		`basis=${r.basis} checked=${r.checked} reason=${r.reason.slice(0, 40)}`)
}
{
	// readBinary throws → hash cannot run → reject
	const entries = OWN_ENTRIES
	const files = seedV1(EXPORT_DIR, entries)
	const v = makeVault({ files }, { readBinaryThrow: true })
	const r = await own(v.app)
	record('B3-03', 'readBinary 抛异常 → 拒绝', !r.owned && r.unverified > 0, `unverified=${r.unverified}`)
}
{
	// size mismatch → changed → reject
	const entries = OWN_ENTRIES
	const files = {}
	for (const [rel, c] of Object.entries(entries)) files[`${EXPORT_DIR}/${rel}`] = c
	const m = JSON.parse(buildManifest(entries))
	// Round 2A.2.2 (S3): again the manifest stays untouched (its signature must
	// keep verifying) and the file on disk changes length.
	files[`${EXPORT_DIR}/export-manifest.json`] = JSON.stringify(m)
	files[`${EXPORT_DIR}/index.html`] = page('<p>被拉长的正文内容</p>')
	const v = makeVault({ files })
	const r = await own(v.app)
	record('B3-04', '文件大小不匹配 → 拒绝', !r.owned && r.changedFiles.length > 0, `changed=${r.changedFiles.length}`)
}
{
	// Round 2A.2.2 (S2) — this case used to be "stat returns null → size cannot be
	// verified → reject". Size is no longer a verification method at all, so the
	// case now guards the rule that replaced it: a record without a SHA-256 makes
	// the whole manifest unusable (no size-only fallback).
	const entries = OWN_ENTRIES
	const files = {}
	for (const [rel, c] of Object.entries(entries)) files[`${EXPORT_DIR}/${rel}`] = c
	const m = JSON.parse(buildManifest(entries))
	m.files = m.files.map(f => ({ path: f.path, bytes: f.bytes })) // drop sha256
	signFixture(m) // re-sign: the signature must be valid so the *parser* is what refuses
	files[`${EXPORT_DIR}/export-manifest.json`] = JSON.stringify(m)
	const v = makeVault({ files })
	const r = await own(v.app)
	record('B3-05', 'files 记录缺 sha256 → 拒绝（S2：无 size-only 回退）', !r.owned && /sha256/.test(r.reason), r.reason.slice(0, 60))
}
{
	// stat throws → reject (manifest declares only bytes)
	const entries = OWN_ENTRIES
	const files = {}
	for (const [rel, c] of Object.entries(entries)) files[`${EXPORT_DIR}/${rel}`] = c
	// Round 2A.2.2 (S2): `bytes` no longer doubles as a verification method, so
	// this case now exercises the *read* path — a file that cannot be read cannot
	// be verified, and an unverifiable file is never a pass.
	const m = JSON.parse(buildManifest(entries))
	files[`${EXPORT_DIR}/export-manifest.json`] = JSON.stringify(m)
	const v = makeVault({ files })
	v.app.vault.adapter.readBinary = async () => { throw new Error('readBinary boom') }
	const r = await own(v.app)
	record('B3-06', 'readBinary 抛异常 → 拒绝（unverified>0）', !r.owned && r.unverified > 0, `unverified=${r.unverified} reason=${r.reason.slice(0, 60)}`)
}
{
	// truthful basis: v1 with sha256 but crypto absent must NOT claim manifest-hash
	const entries = OWN_ENTRIES
	const files = seedV1(EXPORT_DIR, entries)
	const v = makeVault({ files })
	const savedCrypto = globalThis.crypto
	Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {} })
	let r
	try { r = await own(v.app) } finally {
		Object.defineProperty(globalThis, 'crypto', { configurable: true, value: savedCrypto })
	}
	record('B3-07', 'basis 不虚报：crypto 缺失时既不声明 basis 也不放行', !r.owned && r.basis === 'none' && /crypto|签名/.test(r.reason), `basis=${r.basis} reason=${r.reason.slice(0, 60)}`)
}
{
	// fully verifiable → owned with truthful basis & checked>0
	const entries = OWN_ENTRIES
	const files = seedV1(EXPORT_DIR, entries)
	const v = makeVault({ files })
	const r = await own(v.app)
	record('B3-08', '可验证清单 → owned 且 checked>0、basis 真实', r.owned && r.checked === r.expected && r.unverified === 0,
		`checked=${r.checked} expected=${r.expected} basis=${r.basis}`)
}

/* ============================================================= B4: tamper */
console.log('\n=== B4 · Manifest 篡改处理 ===')
{
	// Round 2A.2.1 (S2) — this case used to assert the opposite:
	//   record('B4-01', '删除 notePath（元数据）→ 仍认可，manifestNotePath=null', r.owned && r.manifestNotePath === null)
	// Deleting notePath is not a metadata edit: it switched off the cross-note
	// guard in publish(), so a second note could overwrite this directory.
	const entries = OWN_ENTRIES
	const files = {}
	for (const [rel, c] of Object.entries(entries)) files[`${EXPORT_DIR}/${rel}`] = c
	const m = JSON.parse(buildManifest(entries)); delete m.notePath
	files[`${EXPORT_DIR}/export-manifest.json`] = JSON.stringify(m)
	const v = makeVault({ files })
	const r = await own(v.app)
	// Round 2A.2.2 (S3): deleting `notePath` also breaks the signature, so the
	// refusal is now reported one layer earlier. The property under test is
	// unchanged: a directory whose manifest cannot name its note is never replaced.
	record('B4-01', '删除 notePath（归属信息）→ 拒绝（S2 反转）', !r.owned && /notePath|签名/.test(r.reason), `owned=${r.owned} reason=${r.reason.slice(0, 50)}`)
}
{
	// modify noteTitle (metadata) → still owned
	const entries = OWN_ENTRIES
	const files = {}
	for (const [rel, c] of Object.entries(entries)) files[`${EXPORT_DIR}/${rel}`] = c
	const m = JSON.parse(buildManifest(entries)); m.noteTitle = '改名后的标题'
	files[`${EXPORT_DIR}/export-manifest.json`] = JSON.stringify(m)
	const v = makeVault({ files })
	const r = await own(v.app)
	record('B4-02', '修改 noteTitle（元数据）→ 仍认可', r.owned, `owned=${r.owned}`)
}
{
	// Round 2A.2.1 (S1) — this case used to assert the opposite:
	//   record('B4-03', '删除 manifestVersion → 进入受限 legacy（结构性证明认可）', r.owned && r.basis === 'legacy-structure')
	// A manifest that still carries `files` but lost `manifestVersion` is a
	// corrupted v1 manifest. Deleting one field must not downgrade the proof.
	const entries = OWN_ENTRIES
	const files = {}
	for (const [rel, c] of Object.entries(entries)) files[`${EXPORT_DIR}/${rel}`] = c
	const m = JSON.parse(buildManifest(entries)); delete m.manifestVersion
	files[`${EXPORT_DIR}/export-manifest.json`] = JSON.stringify(m)
	const v = makeVault({ files })
	const r = await own(v.app)
	record('B4-03', '删除 manifestVersion（保留 files）→ 拒绝，不得降级 legacy（S1 反转）', !r.owned && /manifestVersion/.test(r.reason), `owned=${r.owned} basis=${r.basis}`)
}
{
	// downgrade manifestVersion 2→1 → reject (an unsigned v1 is never trusted)
	const entries = OWN_ENTRIES
	const files = {}
	for (const [rel, c] of Object.entries(entries)) files[`${EXPORT_DIR}/${rel}`] = c
	const m = JSON.parse(buildManifest(entries)); m.manifestVersion = 1
	files[`${EXPORT_DIR}/export-manifest.json`] = JSON.stringify(m)
	const v = makeVault({ files })
	const r = await own(v.app)
	record('B4-04', '把 manifestVersion 改成 1 → 拒绝（未签名 v1）', !r.owned && /签名|v1|旧版/.test(r.reason), r.reason)
}
{
	// delete files → reject
	const entries = OWN_ENTRIES
	const files = {}
	for (const [rel, c] of Object.entries(entries)) files[`${EXPORT_DIR}/${rel}`] = c
	const m = JSON.parse(buildManifest(entries)); delete m.files
	files[`${EXPORT_DIR}/export-manifest.json`] = JSON.stringify(m)
	const v = makeVault({ files })
	const r = await own(v.app)
	record('B4-05', '删除 files → 拒绝', !r.owned, r.reason)
}
{
	// modify files (manifest lists a file absent on disk) → missingFiles → reject
	const entries = OWN_ENTRIES
	const files = {}
	// Seed only 2 of 3 files on disk; manifest still lists all 3.
	const keys = Object.keys(entries)
	for (const rel of keys.slice(1)) files[`${EXPORT_DIR}/${rel}`] = entries[rel]
	files[`${EXPORT_DIR}/export-manifest.json`] = buildManifest(entries)
	const v = makeVault({ files })
	const r = await own(v.app)
	record('B4-06', '篡改 files（清单含磁盘缺失项）→ 拒绝', !r.owned && r.missingFiles.length > 0, `missing=${r.missingFiles.length}`)
}
{
	// Round 2A.2.2 (S3) — this case used to assert the opposite:
	//   record('B4-07', '篡改 assets.entries（非关键）→ 仍认可', r.owned, ...)
	// `assets.entries` is part of the signed projection now: it is the record the
	// audit and the notice show, and it feeds the legacy expected-set. Editing it
	// is editing the manifest, so it fails the signature like any other field.
	const entries = OWN_ENTRIES
	const files = {}
	for (const [rel, c] of Object.entries(entries)) files[`${EXPORT_DIR}/${rel}`] = c
	const m = JSON.parse(buildManifest(entries)); m.assets.entries = [{ name: 'ghost.png' }]
	files[`${EXPORT_DIR}/export-manifest.json`] = JSON.stringify(m)
	const v = makeVault({ files })
	const r = await own(v.app)
	record('B4-07', '篡改 assets.entries → 拒绝（S3：entries 在签名范围内）', !r.owned && /签名/.test(r.reason), `owned=${r.owned}`)
}
{
	// modify file hash in manifest → changed → reject
	const entries = OWN_ENTRIES
	const files = {}
	for (const [rel, c] of Object.entries(entries)) files[`${EXPORT_DIR}/${rel}`] = c
	const m = JSON.parse(buildManifest(entries))
	m.files[0].sha256 = 'f'.repeat(64)
	files[`${EXPORT_DIR}/export-manifest.json`] = JSON.stringify(m)
	const v = makeVault({ files })
	const r = await own(v.app)
	record('B4-08', '篡改文件哈希 → 拒绝', !r.owned, r.reason)
}
{
	// modify file size in manifest → changed → reject (size-only manifest)
	const entries = OWN_ENTRIES
	const files = {}
	for (const [rel, c] of Object.entries(entries)) files[`${EXPORT_DIR}/${rel}`] = c
	const m = JSON.parse(buildManifest(entries))
	m.files = m.files.map(f => ({ path: f.path, bytes: f.bytes })) // size-only, no sha256
	m.files[0].bytes = (m.files[0].bytes ?? 0) + 5
	files[`${EXPORT_DIR}/export-manifest.json`] = JSON.stringify(m)
	const v = makeVault({ files })
	const r = await own(v.app)
	record('B4-09', '篡改文件大小 → 拒绝', !r.owned, r.reason)
}
{
	// illegal JSON → reject
	const files = {
		...seedV1(EXPORT_DIR, OWN_ENTRIES),
		[`${EXPORT_DIR}/export-manifest.json`]: 'NOT JSON AT ALL {'
	}
	const v = makeVault({ files })
	const r = await own(v.app)
	record('B4-10', '非法 JSON → 拒绝', !r.owned, r.reason)
}

/* ============================================================= B5: backup */
console.log('\n=== B5 · Backup 清理重设计（禁止自动递归删除） ===')
{
	// Replace an existing OWNED export: backup must be retained, never auto-deleted.
	const v = makeVault({ files: seedV1(EXPORT_DIR, OWN_ENTRIES) })
	const rmdirBefore = v.log.filter(l => l[0] === 'rmdir').length
	let report = null, err = null
	try { report = await writeExport(v.app, snap(), page('<p>第二版</p>'), 'body{}', new AssetCollector(v.app), 'html-export', EXTRA, TEST_KEY) }
	catch (e) { err = e }
	const rmdirAfter = v.log.filter(l => l[0] === 'rmdir').length
	const backupExists = await v.app.vault.adapter.exists(report ? report.leftoverBackup : '')
	const oldStillInBackup = backupExists && (await v.app.vault.adapter.read(`${report.leftoverBackup}/index.html`)).includes('第一版')
	const newInPlace = await v.app.vault.adapter.exists(`${EXPORT_DIR}/index.html`) && (await v.app.vault.adapter.read(`${EXPORT_DIR}/index.html`)).includes('第二版')
	record('B5-01', '覆盖自有导出成功且旧目录保留为 backup', !err && report && report.leftoverBackup && backupExists && oldStillInBackup && newInPlace,
		err ? `err:${err.message}` : `backup=${report.leftoverBackup}`)
	record('B5-02', '发布流程绝不自动 rmdir backup（反向对照）', rmdirAfter === rmdirBefore, `rmdir 次数=${rmdirAfter}`)
}
{
	// publish failure (2nd rename fails) → old export restored, not lost
	const v = makeVault({ files: seedV1(EXPORT_DIR, OWN_ENTRIES) }, { renameFailAt: 2 })
	let err = null
	try { await writeExport(v.app, snap(), page('<p>第二版</p>'), 'body{}', new AssetCollector(v.app), 'html-export', EXTRA, TEST_KEY) }
	catch (e) { err = e }
	const restored = (await v.app.vault.adapter.read(`${EXPORT_DIR}/index.html`)).includes('第一版')
	const tmpLeft = await v.app.vault.adapter.exists(`${EXPORT_DIR}.tmp-`) // tmp dirs use .tmp- prefix; check any
	const anyTmp = [...v.files.keys()].some(k => k.includes('.tmp-'))
	record('B5-03', '发布失败 → 旧导出恢复至 finalDir（不丢失）', !!err && restored, `err=${err ? err.stage : 'none'} restored=${restored}`)
	record('B5-04', '发布失败后临时目录保留（可恢复）', anyTmp, `tmp 残留=${anyTmp}`)
}
{
	// legacy backup also never auto-deleted
	const files = {
		[`${EXPORT_DIR}/index.html`]: page('<p>旧版</p>'),
		[`${EXPORT_DIR}/assets/export.css`]: 'body{}',
		[`${EXPORT_DIR}/runtime-audit.json`]: '{}',
		[`${EXPORT_DIR}/export-manifest.json`]: JSON.stringify({ notePath: NOTE_PATH, status: 'ok', stats: { blocks: 1 }, assets: { written: 0, entries: [], failed: [] } })
	}
	const v = makeVault({ files })
	let report = null, err = null
	try { report = await writeExport(v.app, snap(), page('<p>第二版</p>'), 'body{}', new AssetCollector(v.app), 'html-export', EXTRA, TEST_KEY) }
	catch (e) { err = e }
	const rmdirCount = v.log.filter(l => l[0] === 'rmdir').length
	const backupKept = report && (await v.app.vault.adapter.exists(report.leftoverBackup))
	// Round 2A.2.2 (S1) — this case used to assert that a legacy directory was
	// replaced and its backup kept. Legacy directories are no longer replaced at
	// all, so the property is now "refused, and every byte still on disk".
	const legacyUntouched = v.files.get(`${EXPORT_DIR}/index.html`) === page('<p>旧版</p>')
	record('B5-05', 'legacy 旧导出 → 拒绝覆盖且目录原样保留（S1）', !!err && legacyUntouched && rmdirCount === 0,
		err ? `err:${err.message}` : `rmdir=${rmdirCount} backup=${!!backupKept}`)
}
{
	// Round 2A.2.1 (S4): `safeRemoveBackup` was removed from the module surface.
	//
	// The three cases that used to live here (B5-06 removed an owned backup,
	// B5-07 refused one containing a foreign file, B5-08 refused a non-backup
	// path) all described a function that could not be made safe: `.bak-`
	// substring check, no containment proof, TOCTOU between the ownership
	// verdict and the unlink, an empty user directory removable, and
	// `removed: true` returned even when deletion failed. There is no cleanup
	// API in this build, so the assertion is that none is reachable.
	const writer = await bundle('src/export/writer.ts', 'writer-surface')
	record('B5-06', 'safeRemoveBackup 已从模块导出面移除（S4）', !('safeRemoveBackup' in writer),
		`exports=${Object.keys(writer).sort().join(',')}`)
	record('B5-07', '模块不再导出任何删除型入口（S4）',
		!Object.keys(writer).some(k => /remove|clean|purge|delete|prune/i.test(k)),
		`exports=${Object.keys(writer).join(',')}`)
}
{
	// Replacement for the old B5-08: the *only* disposal path left is "keep it".
	const v = makeVault({ files: seedV1(EXPORT_DIR, OWN_ENTRIES) })
	let report = null
	try { report = await writeExport(v.app, snap(), page('<p>第二版</p>'), 'body{}', new AssetCollector(v.app), 'html-export', EXTRA, TEST_KEY) } catch { /* recorded below */ }
	const rmdirCalls = v.log.filter(l => l[0] === 'rmdir').length
	const removeCalls = v.log.filter(l => l[0] === 'remove').length
	const backupIntact = !!report && (await v.app.vault.adapter.exists(`${report.leftoverBackup}/index.html`))
	record('B5-08', '成功发布后备份原样保留，无 rmdir/remove 调用（S4）',
		!!report && rmdirCalls === 0 && removeCalls === 0 && backupIntact,
		`rmdir=${rmdirCalls} remove=${removeCalls} backup=${backupIntact}`)
}

/* ============================================================= B6: X6 suite */
console.log('\n=== B6 · 修正后的 X6 所有权测试 ===')
async function runExport(vault, title = '笔记', body = '<p>第二版</p>') {
	try { return { report: await writeExport(vault.app, snap(title), page(body), 'body{}', new AssetCollector(vault.app), 'html-export', EXTRA, TEST_KEY), error: null } }
	catch (e) { return { report: null, error: e } }
}
{
	// X6-01 (unchanged meaning): only plugin files → replaced, backup kept
	const v = makeVault({ files: seedV1(EXPORT_DIR, OWN_ENTRIES) })
	const { error, report } = await runExport(v)
	const backupKept = report && (await v.app.vault.adapter.exists(report.leftoverBackup))
	record('X6-01', '正常导出目录（仅插件文件）→ 替换并保留 backup', !error && backupKept, error ? error.message : `backup=${!!backupKept}`)
}
{
	// X6-02 → renamed concept: 含用户 README 时拒绝覆盖
	const v = makeVault({ files: { ...seedV1(EXPORT_DIR, OWN_ENTRIES), [`${EXPORT_DIR}/README.md`]: '# 我自己写的说明' } })
	const { error } = await runExport(v)
	const alive = v.files.get(`${EXPORT_DIR}/README.md`)
	const destroyedReadme = v.destroyed.find(d => d.path.endsWith('README.md'))
	record('X6-11', '含用户 README 时拒绝覆盖（原 X6-11 误报成功路径）', !!error && alive === '# 我自己写的说明' && !destroyedReadme,
		`拒绝=${!!error} README=${alive === undefined ? '丢失' : alive === '# 我自己写的说明' ? '完好' : '被改写'}${destroyedReadme ? '（被删）' : ''}`)
}
{
	// 标记：原"成功清理"测试（旧的 X6-11）从未真正到达成功发布路径，因其 fixture 含 README 强制拒绝。
	record('X6-note', '标记：旧 X6-11 的成功清理断言为伪阳性，已被 X6-11(拒绝) + B5-02(无 rmdir) 取代', true, '见 supplementary 说明')
}
{
	// 新增：成功发布后 backup 保留且含旧版文件
	const v = makeVault({ files: seedV1(EXPORT_DIR, OWN_ENTRIES) })
	const { report } = await runExport(v)
	const backupHasOld = report && (await v.app.vault.adapter.exists(report.leftoverBackup)) &&
		(await v.app.vault.adapter.read(`${report.leftoverBackup}/index.html`)).includes('第一版')
	record('X6-12', '成功发布后 backup 保留且含旧版文件', !!report && backupHasOld, `backup=${report ? report.leftoverBackup : 'none'}`)
}
{
	// 新增：backup 内用户文件保留 —— 注入 README 到"上一次导出"，本次应被拒绝、用户文件不动
	const v = makeVault({ files: { ...seedV1(EXPORT_DIR, OWN_ENTRIES), [`${EXPORT_DIR}/README.md`]: '用户文件' } })
	const { error } = await runExport(v)
	const readmeAlive = v.files.get(`${EXPORT_DIR}/README.md`) === '用户文件'
	record('X6-13', 'backup 内用户文件保留（拒绝覆盖，文件不动）', !!error && readmeAlive, `拒绝=${!!error} README=${readmeAlive}`)
}
{
	// 新增：发布失败恢复 —— 第二次 rename 失败应回滚旧导出
	const v = makeVault({ files: seedV1(EXPORT_DIR, OWN_ENTRIES) }, { renameFailAt: 2 })
	const { error } = await runExport(v)
	const restored = (await v.app.vault.adapter.read(`${EXPORT_DIR}/index.html`)).includes('第一版')
	record('X6-14', '发布失败恢复（旧导出回滚）', !!error && restored, `err=${error ? error.stage : 'none'} restored=${restored}`)
}
{
	// 旧版格式 + 用户 README → 拒绝（legacy 也尊重 foreign 文件）
	const files = {
		[`${EXPORT_DIR}/index.html`]: page('<p>旧版</p>'),
		[`${EXPORT_DIR}/assets/export.css`]: 'body{}',
		[`${EXPORT_DIR}/runtime-audit.json`]: '{}',
		[`${EXPORT_DIR}/README.md`]: '用户文件',
		[`${EXPORT_DIR}/export-manifest.json`]: JSON.stringify({ notePath: NOTE_PATH, status: 'ok', stats: { blocks: 1 }, assets: { written: 0, entries: [], failed: [] } })
	}
	const v = makeVault({ files })
	const { error } = await runExport(v)
	const readmeAlive = v.files.get(`${EXPORT_DIR}/README.md`) === '用户文件'
	record('X6-15', '旧版格式含用户文件 → 拒绝且文件保留', !!error && readmeAlive, `拒绝=${!!error}`)
}

/* ------------------------------------------------------------- summary -- */
console.log(`\n小计：PASS ${pass} / FAIL ${fail} / 共 ${results.length}`)
fs.mkdirSync(path.join(here, '.out-round2a2'), { recursive: true })
fs.writeFileSync(path.join(here, '.out-round2a2', 'round2a2-results.json'), JSON.stringify({ pass, fail, total: results.length, results }, null, 2))
process.exit(fail > 0 ? 1 : 0)
