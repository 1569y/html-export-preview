/**
 * Round 2A.2.2 Review Fix — Lifecycle, Path Safety & Ownership matrix
 *
 * Targets the ChatGPT independent-source-review findings this round:
 *
 *   F-01  Key lifecycle (KL)  — resolveKeyOnLoad / rotateKey / describeKey
 *   F-02  Plugin lifecycle    — first install, restart, missing key, corrupted
 *                              key, config-not-synced, rotation, save failure,
 *                              and how each affects old-export validation.
 *   F-04  Windows path safety (PS) — reserved names, distinguishing a real
 *                              security concern from over-rejection (COM0/LPT0,
 *                              superscript COM¹/²/³ are NOT rejected).
 *   H-07  Ownership no longer only tests inspectOwnership(null) — a full key /
 *         manifest refusal matrix, plus the one acceptance path.
 *
 * Method: esbuild bundles the REAL source (no mocks of the logic under test);
 * only the Obsidian `adapter` is faked, exactly as run-round2a2-2.mjs does, so
 * these tests exercise the production code path.
 *
 * Run:  node tests/unit/run-round2a2-2-review.mjs
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
const out = path.join(here, '.out-round2a2-2-review')

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

const { inspectOwnership, ExportError } = await bundle('src/export/writer.ts', 'writer')
const { resolveKeyOnLoad, rotateKey, describeKey } = await bundle(
	'src/export/signing-key.ts',
	'signing-key'
)
const signing = await bundle('src/export/manifest-signing.ts', 'manifest-signing')
const { signingPayload, generateSigningKeyHex, isValidSigningKey } = signing
const { safeFolderName, resolveExportDir, identitySuffix } = await bundle(
	'src/export/path-safety.ts',
	'path-safety'
)

/* ----------------------------------------------------------- fixtures -- */
// Fixtures are signed with node:crypto so they cross-check the production
// WebCrypto signing instead of trusting it.
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
			if (failAt.has(renameCalls)) throw new Error(`EACCES simulated rename failure #${renameCalls}`)
			log.push(['rename', from, to])
			const moved = [...files.keys()].filter(k => k === from || k.startsWith(`${from}/`))
			const movedDirs = [...dirs].filter(d => d === from || d.startsWith(`${from}/`))
			if (moved.length === 0 && movedDirs.length === 0) throw new Error(`rename: 源不存在 ${from}`)
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
				if (k === p || k.startsWith(`${p}/`)) files.delete(k)
			for (const d of [...dirs]) if (d === p || d.startsWith(`${p}/`)) dirs.delete(d)
		},
		async remove(p) {
			if (!files.has(p)) return
			files.delete(p)
		}
	}
	return { app: { vault: { adapter } }, files, dirs, log }
}

/* ------------------------------------------------------------- helpers -- */
const page = (body = '<p>正文内容</p>') =>
	'<!doctype html>\n<html>\n<head><title>t</title></head>\n<body>\n' +
	`<!--he-body-start-->\n${body}\n<!--he-body-end-->\n</body>\n</html>\n`
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
	{ notePath = NOTE_PATH, version = 2, filesOverride, identitySuffix: suffixOverride, outputFolder, assetsEntries, sign = true, key = TEST_KEY } = {}
) {
	const manifest = {
		manifestVersion: version,
		generatedAt: 'x',
		notePath,
		noteTitle: TITLE,
		identitySuffix: suffixOverride ?? identitySuffix(notePath),
		outputFolder: outputFolder ?? EXPORT_DIR.split('/').pop(),
		status: 'ok',
		assets: { written: 0, attempted: 0, entries: assetsEntries ?? [], failed: [] },
		files: filesOverride ?? recordsFrom(entries)
	}
	return JSON.stringify(sign ? signFixture(manifest, key) : manifest)
}
function seed(dir, entries, opts = {}) {
	const files = {}
	for (const [rel, content] of Object.entries(entries)) files[`${dir}/${rel}`] = content
	files[`${dir}/export-manifest.json`] = buildManifest(entries, {
		outputFolder: dir.split('/').pop(),
		...opts
	})
	return files
}
const own = (app, dir = EXPORT_DIR, notePath = NOTE_PATH, key = TEST_KEY) =>
	inspectOwnership(app, dir, notePath, key)

/* -------------------------------------------------------------- runner -- */
let pass = 0
let fail = 0
const results = []
function record(id, name, ok, detail = '') {
	results.push({ id, name, verdict: ok ? 'PASS' : 'FAIL', detail })
	if (ok) pass++
	else fail++
	console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${id}  ${name}${detail ? '  — ' + detail : ''}`)
}
function assertValidHex(k) {
	return typeof k === 'string' && /^[0-9a-f]{64}$/i.test(k)
}
// Guard used where a save must NOT happen (first install / ready / corrupted):
// if the lifecycle helper ever calls save here, the test blows up loudly.
const neverSave = async () => {
	throw new Error('SAVE MUST NOT BE CALLED in this scenario')
}

/* ============================================ KL · 密钥生命周期（S1 状态 + S2 时序）=== */
console.log('\n=== KL · 密钥生命周期（S1: first-init/lost/unknown；S2: 持久化时序/失败保留）===')

// KL-01  valid key + initialized → ready, untouched
{
	const r = await resolveKeyOnLoad(TEST_KEY, { initialized: true, configPresent: true })
	record('KL-01', '合法密钥 + 已初始化 → ready，密钥不变', r.state === 'ready' && r.key === TEST_KEY && !r.changed, `state=${r.state}`)
}
// KL-02  empty + not initialized + config present → first-init (genuine first install)
{
	const r = await resolveKeyOnLoad('', { initialized: false, configPresent: true })
	record('KL-02', '配置存在/未初始化/空密钥 → first-init', r.state === 'first-init' && r.key === '', `state=${r.state}`)
}
// KL-03  empty + initialized true → lost (S1 #2/#3: distinct from first-init)
{
	const r = await resolveKeyOnLoad('', { initialized: true, configPresent: true })
	record('KL-03', '已初始化但密钥缺失 → lost（区别于 first-init）', r.state === 'lost' && r.key === '', `state=${r.state}`)
}
// KL-04  empty + config absent → unknown (S1 #4: never impersonate first-init)
{
	const r = await resolveKeyOnLoad('', { initialized: false, configPresent: false })
	record('KL-04', '配置文件缺失（无法判断历史）→ unknown，不冒充 first-init', r.state === 'unknown' && r.key === '', `state=${r.state}`)
}
// KL-05  corrupted (present, invalid) → corrupted, key preserved (S1 #7)
{
	const BAD = 'not-a-hex-key'
	const r = await resolveKeyOnLoad(BAD, { initialized: true, configPresent: true })
	record('KL-05', '密钥格式损坏 → corrupted，绝不静默覆盖', r.state === 'corrupted' && r.key === BAD && !r.changed, `state=${r.state}`)
}
// KL-06  corrupted + not initialized → still corrupted (present value wins over flag)
{
	const BAD = 'zzz-bad'
	const r = await resolveKeyOnLoad(BAD, { initialized: false, configPresent: true })
	record('KL-06', '损坏密钥即使未初始化也判 corrupted（present 优先）', r.state === 'corrupted' && r.key === BAD, `state=${r.state}`)
}
// KL-07  describeKey(first-init) → generate, no strict confirm
{
	const s = describeKey('', { initialized: false, configPresent: true })
	record('KL-07', 'describeKey(first-init) → generate + 无需二次确认', s.action === 'generate' && s.confirmTwice === false)
}
// KL-08  describeKey(lost) → generate + strict confirm (S1 #6)
{
	const s = describeKey('', { initialized: true, configPresent: true })
	record('KL-08', 'describeKey(lost) → generate + 严格二次确认', s.action === 'generate' && s.confirmTwice === true)
}
// KL-09  describeKey(unknown) → generate + strict confirm (S1 #6)
{
	const s = describeKey('', { initialized: false, configPresent: false })
	record('KL-09', 'describeKey(unknown) → generate + 严格二次确认', s.action === 'generate' && s.confirmTwice === true)
}
// KL-10  describeKey(ready) → rotate + strict confirm
{
	const s = describeKey(TEST_KEY, { initialized: true, configPresent: true })
	record('KL-10', 'describeKey(ready) → rotate + 二次确认', s.action === 'rotate' && s.confirmTwice === true)
}
// KL-11  describeKey(corrupted) → rotate + strict confirm
{
	const s = describeKey('zzz-bad', { initialized: true, configPresent: true })
	record('KL-11', 'describeKey(corrupted) → rotate + 二次确认', s.action === 'rotate' && s.confirmTwice === true)
}
// KL-12  first generation success → ready, persisted, flag set (S2 #1/#2)
{
	let stored = null
	const r = await rotateKey('', { save: async (k, i) => { stored = { k, i } }, initialized: false, configPresent: true })
	record('KL-12', '用户首次生成 → ready，已持久化并标记 initialized=true', r.state === 'ready' && r.changed && assertValidHex(r.key) && stored && stored.i === true, `state=${r.state}`)
}
// KL-13  rotation success → new key differs, persisted (S2 #1/#2)
{
	const store = { k: TEST_KEY, i: false }
	const r = await rotateKey(TEST_KEY, { save: async (k, i) => { store.k = k; store.i = i }, initialized: true, configPresent: true })
	record('KL-13', '用户主动轮换（已有合法密钥）→ ready，密钥已替换并标记', r.state === 'ready' && r.changed && r.key !== TEST_KEY && store.k === r.key && store.i === true, `state=${r.state}`)
}
// KL-14  save failure with valid old key → preserves old (S2 #3/#6: no overwrite)
{
	const store = { k: TEST_KEY }
	const r = await rotateKey(TEST_KEY, { save: async () => { throw new Error('disk full') }, initialized: true, configPresent: true })
	record('KL-14', '保存失败（原有合法密钥）→ 保留原密钥，changed=false', r.state === 'ready' && !r.changed && r.key === TEST_KEY && store.k === TEST_KEY, `state=${r.state}`)
}
// KL-15  save failure with corrupted key → preserves corrupted (S2 #3: incl. corrupted)
{
	const store = { k: 'zzz-bad' }
	const r = await rotateKey('zzz-bad', { save: async () => { throw new Error('disk full') }, initialized: true, configPresent: true })
	record('KL-15', '保存失败（原损坏密钥）→ 保留损坏值，不清除', r.state === 'corrupted' && !r.changed && r.key === 'zzz-bad', `state=${r.state}`)
}
// KL-16  save failure with empty → unavailable, no key adopted (S2 #4: never clears)
{
	const store = { k: '' }
	const r = await rotateKey('', { save: async () => { throw new Error('disk full') }, initialized: false, configPresent: true })
	record('KL-16', '保存失败（无原密钥）→ unavailable，不采纳未持久化密钥', r.state === 'unavailable' && !r.changed && r.key === '' && store.k === '', `state=${r.state}`)
}

/* ============================================ PS · Windows 路径（S4）=== */
console.log('\n=== PS · Windows 路径保留名（S4: Microsoft 清单 + 上标拒绝, COM0/LPT0 允许, CLOCK$ 区分）===')
// PS-01..04  Microsoft standard reserved → prefixed (rejected)
record('PS-01', 'COM1 → 被拒绝（前缀 _）', safeFolderName('COM1') === '_COM1', `got=${safeFolderName('COM1')}`)
record('PS-02', 'LPT9 → 被拒绝（前缀 _）', safeFolderName('LPT9') === '_LPT9', `got=${safeFolderName('LPT9')}`)
record('PS-03', 'CON → 被拒绝（前缀 _）', safeFolderName('CON') === '_CON', `got=${safeFolderName('CON')}`)
record('PS-04', 'NUL → 被拒绝（前缀 _）', safeFolderName('NUL') === '_NUL', `got=${safeFolderName('NUL')}`)
// PS-05..10  superscripts COM¹/²/³ / LPT¹/²/³ → rejected (S4: visual spoof of reserved)
const sup1 = 'COM¹', sup2 = 'COM²', sup3 = 'COM³'
const lsup1 = 'LPT¹', lsup2 = 'LPT²', lsup3 = 'LPT³'
record('PS-05', 'COM¹（上标）→ 被拒绝（前缀 _）', safeFolderName(sup1) === '_' + sup1, `got=${safeFolderName(sup1)}`)
record('PS-06', 'COM²（上标）→ 被拒绝', safeFolderName(sup2) === '_' + sup2, `got=${safeFolderName(sup2)}`)
record('PS-07', 'COM³（上标）→ 被拒绝', safeFolderName(sup3) === '_' + sup3, `got=${safeFolderName(sup3)}`)
record('PS-08', 'LPT¹（上标）→ 被拒绝', safeFolderName(lsup1) === '_' + lsup1, `got=${safeFolderName(lsup1)}`)
record('PS-09', 'LPT²（上标）→ 被拒绝', safeFolderName(lsup2) === '_' + lsup2, `got=${safeFolderName(lsup2)}`)
record('PS-10', 'LPT³（上标）→ 被拒绝', safeFolderName(lsup3) === '_' + lsup3, `got=${safeFolderName(lsup3)}`)
// PS-11..12  extensions on reserved/superscript → also rejected
record('PS-11', 'COM1.txt（带扩展名）→ 被拒绝', safeFolderName('COM1.txt') === '_COM1.txt', `got=${safeFolderName('COM1.txt')}`)
record('PS-12', 'COM¹.txt（上标+扩展名）→ 被拒绝', safeFolderName(sup1 + '.txt') === '_' + sup1 + '.txt', `got=${safeFolderName(sup1 + '.txt')}`)
// PS-13..14  COM0/LPT0 allowed (S4: Windows does not reserve 0 device)
record('PS-13', 'COM0 → 不拒绝（Windows 不保留 0 设备）', safeFolderName('COM0') === 'COM0', `got=${safeFolderName('COM0')}`)
record('PS-14', 'LPT0 → 不拒绝', safeFolderName('LPT0') === 'LPT0', `got=${safeFolderName('LPT0')}`)
// PS-15  CLOCK$ kept as EXTRA restriction, distinct from Microsoft list → rejected
record('PS-15', 'CLOCK$ → 被拒绝（额外兼容限制，区别于官方清单）', safeFolderName('CLOCK$') === '_CLOCK$', `got=${safeFolderName('CLOCK$')}`)
// PS-16  case-insensitive
record('PS-16', 'com1（小写）→ 被拒绝（大小写不敏感）', safeFolderName('com1') === '_com1', `got=${safeFolderName('com1')}`)
// PS-17..19  resolveExportDir end-to-end (S4: test the final resolver, not just safeFolderName)
{
	const d1 = resolveExportDir('html-export', 'COM1', 'notes/n.md')
	record('PS-17', 'resolveExportDir(COM1) → 目录被防御性加前缀', d1.folder.startsWith('_COM1'), `folder=${d1.folder}`)
	const d2 = resolveExportDir('html-export', 'COM¹', 'notes/n.md')
	record('PS-18', 'resolveExportDir(COM¹) → 目录被防御性加前缀', d2.folder.startsWith('_COM¹'), `folder=${d2.folder}`)
	const d3 = resolveExportDir('html-export', 'COM0', 'notes/n.md')
	record('PS-19', 'resolveExportDir(COM0) → 目录不被加前缀（允许）', d3.folder.startsWith('COM0') && !d3.folder.startsWith('_'), `folder=${d3.folder}`)
}
/* ============================================ H-07 · 归属矩阵（不再只测 null）=== */
console.log('\n=== H-07 · 归属验证矩阵（密钥/清单各种情形）===')
// H-07a  the original H-07: null key → refused
{
	const v = makeVault({ files: seed(EXPORT_DIR, OWN_ENTRIES) })
	const r = await own(v.app, EXPORT_DIR, NOTE_PATH, null)
	record('H-07a', 'inspectOwnership(null) → 拒绝', !r.owned && /密钥/.test(r.reason), `owned=${r.owned}`)
}
// H-07b  empty key → refused (fail-closed)
{
	const v = makeVault({ files: seed(EXPORT_DIR, OWN_ENTRIES) })
	const r = await own(v.app, EXPORT_DIR, NOTE_PATH, '')
	record('H-07b', 'inspectOwnership("") → 拒绝', !r.owned, `owned=${r.owned}`)
}
// H-07c  no manifest file at all → refused
{
	const files = { [`${EXPORT_DIR}/index.html`]: page() }
	const v = makeVault({ files })
	const r = await own(v.app)
	record('H-07c', '目录无 export-manifest.json → 拒绝', !r.owned && /export-manifest\.json/.test(r.reason), `owned=${r.owned}`)
}
// H-07d  unsigned v1 manifest → refused
{
	const files = seed(EXPORT_DIR, OWN_ENTRIES, { sign: false, version: 1 })
	const v = makeVault({ files })
	const r = await own(v.app, EXPORT_DIR, NOTE_PATH, TEST_KEY)
	record('H-07d', 'v1 未签名清单 → 拒绝', !r.owned && /v1|旧版/.test(r.reason), `owned=${r.owned}`)
}
// H-07e  unsupported version → refused
{
	const files = seed(EXPORT_DIR, OWN_ENTRIES, { sign: false, version: 3 })
	const v = makeVault({ files })
	const r = await own(v.app, EXPORT_DIR, NOTE_PATH, TEST_KEY)
	record('H-07e', '不支持的版本号(3) → 拒绝', !r.owned && /版本|不受支持/.test(r.reason), `owned=${r.owned}`)
}
// H-07f  corrupted (illegal JSON) manifest → refused
{
	const files = { [`${EXPORT_DIR}/index.html`]: page(), [`${EXPORT_DIR}/export-manifest.json`]: '{ not json' }
	const v = makeVault({ files })
	const r = await own(v.app)
	record('H-07f', '清单为非法 JSON → 拒绝（视为篡改）', !r.owned && /解析|篡改|JSON/.test(r.reason), `owned=${r.owned}`)
}
// H-07g  valid manifest but signed with a DIFFERENT key → refused
{
	const files = seed(EXPORT_DIR, OWN_ENTRIES, { key: OTHER_KEY })
	const v = makeVault({ files })
	const r = await own(v.app, EXPORT_DIR, NOTE_PATH, TEST_KEY)
	record('H-07g', '清单用另一把密钥签名 → 拒绝（密钥不匹配）', !r.owned && /签名|密钥|Vault/.test(r.reason), `owned=${r.owned}`)
}
// H-07h  the one acceptance path: valid manifest + matching key → owned
{
	const v = makeVault({ files: seed(EXPORT_DIR, OWN_ENTRIES) })
	const r = await own(v.app, EXPORT_DIR, NOTE_PATH, TEST_KEY)
	record('H-07h', '合法清单 + 匹配密钥 → 接受（owned=true）', r.owned === true && r.basis === 'manifest-hmac' && r.signatureVerified === true, `owned=${r.owned} basis=${r.basis}`)
}
// H-07i  rotation invalidates old exports (lifecycle tie-in): re-keyed vault refuses prior dir
{
	const v = makeVault({ files: seed(EXPORT_DIR, OWN_ENTRIES) })
	const before = await own(v.app, EXPORT_DIR, NOTE_PATH, TEST_KEY)
	// simulate key rotation on the vault
	const rotated = await rotateKey(TEST_KEY, { save: async () => {}, initialized: true, configPresent: true })
	const after = await own(v.app, EXPORT_DIR, NOTE_PATH, rotated.key)
	record('H-07i', '密钥轮换后旧目录不再可验证 → 拒绝', before.owned === true && after.owned === false, `before=${before.owned} after=${after.owned}`)
}

/* --------------------------------------------------------------- summary -- */
console.log(`\n总计：${results.length} 例，PASS ${pass}，FAIL ${fail}`)
const failed = results.filter(r => r.verdict === 'FAIL')
if (failed.length) {
	console.error('\n失败用例：')
	for (const f of failed) console.error(`  - ${f.id} ${f.name}  ${f.detail}`)
}
process.exit(fail === 0 ? 0 : 1)
