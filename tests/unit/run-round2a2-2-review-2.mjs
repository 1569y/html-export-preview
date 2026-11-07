/**
 * Round 2A.2.2 Review Fix Round 2 — Plugin lifecycle & concurrency integration
 *
 * Targets the ChatGPT independent-source-review findings this round:
 *
 *   S1  Key init / loss state   — first-init vs lost vs unknown, independent of
 *                                the key's emptiness; `unknown` when the whole
 *                                config is absent (never impersonates first-init).
 *   S2  Persistence ordering    — persist BEFORE in-memory update; save failure
 *                                preserves the original key (incl. corrupted);
 *                                rotation and export are mutually exclusive via a
 *                                key mutex; export signs with a stable snapshot.
 *   S3  Real plugin lifecycle    — actually executes `loadSettings()`,
 *                                `ensureSigningKey()`, `rotateSigningKey()` on a
 *                                real `HtmlExportPlugin` instance, plus
 *                                `snapshotSigningKey()` for the export snapshot.
 *
 * MOCK BOUNDARY (per the review's instruction): the Obsidian `Plugin` base class,
 * `App`, `Notice`, `Setting`, etc. are STUBS, not a real Obsidian host. The
 * production source (`main.ts`, `signing-key.ts`, `settings.ts`, `writer.ts`,
 * `manifest-signing.ts`, `path-safety.ts`) is bundled *unchanged* — only the host
 * surface is faked, exactly like run-round2a2-2.mjs. This exercises the real
 * lifecycle logic and its side effects (loadData/saveData, in-memory state) but
 * is NOT a "real Obsidian host acceptance"; the DOM/UI two-step click is verified
 * by the `confirmTwice` flag it drives, not by simulating button clicks.
 *
 * Run:  node tests/unit/run-round2a2-2-review-2.mjs
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
const out = path.join(here, '.out-round2a2-2-review-2')

/* ------------------------------------------------------------- bundling -- */
function prepareStub() {
	const dir = path.join(out, 'node_modules', 'obsidian')
	fs.mkdirSync(dir, { recursive: true })
	// Minimal Obsidian surface — STUB, not a real host (see header).
	fs.writeFileSync(
		path.join(dir, 'index.mjs'),
		`export class TFile { constructor(p, size = 1) { this.path = p; this.name = p.split('/').pop() ?? p; this.basename = this.name.replace(/\\.[^.]+$/, ''); this.stat = { size: typeof size === 'number' ? size : String(size).length }; this.parent = { path: p.split('/').slice(0, -1).join('/') || '.' } } }
export class TFolder {}
export class TAbstractFile {}
export class App { constructor() { this.workspace = { getLeavesOfType: () => [], getRightLeaf: () => ({}), getLeaf: () => ({ setViewState: async () => {} }), revealLeaf: () => {} }; this.vault = { adapter: { getBasePath: () => '/vault' } } } }
export class Plugin { constructor(app, manifest) { this.app = app; this.manifest = manifest; this.appId = manifest && manifest.id }
  async loadData() { return null }
  async saveData(_d) {}
  addRibbonIcon() {} addCommand() {} addSettingTab() {} registerView() {} registerEvent() {} }
export class PluginSettingTab { constructor(app, plugin) { this.app = app; this.plugin = plugin; this.containerEl = { empty() {}, createDiv: () => ({ createEl: () => ({}) }), createEl: () => ({ cls: '' }) } } display() {} }
export class Setting { constructor(c) { this.containerEl = c } setName() { return this } setDesc() { return this } addText() { return this } addButton(b) { this._btn = b; return this } }
export class ItemView { constructor(leaf) { this.leaf = leaf; this.app = { workspace: {} } } }
export class WorkspaceLeaf {}
export class MarkdownView {}
export class Notice { constructor() {} hide() {} }
export function normalizePath(p) { return String(p).replace(/\\\\/g, '/').replace(/\\/{2,}/g, '/').replace(/^\\/+/, '').replace(/\\/+$/, '') }
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

const { default: HtmlExportPlugin } = await bundle('src/main.ts', 'main')
const { inspectOwnership } = await bundle('src/export/writer.ts', 'writer')
const signing = await bundle('src/export/manifest-signing.ts', 'manifest-signing')
const { signingPayload } = signing
const { identitySuffix } = await bundle('src/export/path-safety.ts', 'path-safety')

/* ----------------------------------------------------------- fixtures -- */
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
		Array.isArray(cfg.renameFailAt)
			? cfg.renameFailAt
			: cfg.renameFailAt
				? [cfg.renameFailAt]
				: []
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
			for (const k of [...files.keys()]) if (k === p || k.startsWith(`${p}/`)) files.delete(k)
			for (const d of [...dirs]) if (d === p || d.startsWith(`${p}/`)) dirs.delete(d)
		},
		async remove(p) {
			if (!files.has(p)) return
			files.delete(p)
		}
	}
	return { app: { vault: { adapter } }, files, dirs, log }
}

/* -------------------------------------------------------------- helpers -- */
const page = (body = '<p>正文内容</p>') =>
	'<!doctype html>\n<html>\n<head><title>t</title></head>\n<body>\n' +
	`<!--he-body-start-->\n${body}\n<!--he-body-end-->\n</body>\n</html>\n`
const sha256hex = s => createHash('sha256').update(String(s), 'utf8').digest('hex')
const bytesOf = s => Buffer.byteLength(String(s), 'utf8')
const NOTE_PATH = 'notes/note.md'
const TITLE = '笔记'
const SUFFIX = identitySuffix(NOTE_PATH)
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
	{ notePath = NOTE_PATH, version = 2, assetsEntries, sign = true, key = TEST_KEY } = {}
) {
	const manifest = {
		manifestVersion: version,
		generatedAt: 'x',
		notePath,
		noteTitle: TITLE,
		identitySuffix: SUFFIX,
		outputFolder: `note-${SUFFIX}`,
		status: 'ok',
		assets: { written: 0, attempted: 0, entries: assetsEntries ?? [], failed: [] },
		files: recordsFrom(entries)
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
const EXPORT_DIR = `html-export/note-${SUFFIX}`
const own = (app, dir = EXPORT_DIR, notePath = NOTE_PATH, key = TEST_KEY) =>
	inspectOwnership(app, dir, notePath, key)

/* --------------------------------------------------- plugin mock factory -- */
function makePlugin({ data = null, saveFails = false } = {}) {
	let stored = data
	let present = data !== null
	const app = {
		workspace: { getLeavesOfType: () => [] },
		vault: { adapter: { getBasePath: () => '/vault' } }
	}
	const plugin = new HtmlExportPlugin(app, { id: 'test', name: 'test', version: '1.0.0' })
	plugin.loadData = async () => (present ? structuredClone(stored) : null)
	plugin.saveData = async d => {
		if (saveFails) throw new Error('simulated save failure')
		stored = structuredClone(d)
		present = true
	}
	return { plugin, getStored: () => stored, app }
}

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

/* ============================================ PL · 插件生命周期（S3）=== */
console.log('\n=== PL · 插件生命周期（loadSettings / ensureSigningKey / rotateSigningKey 真实调用）===')

// PL-01  first onload with NO config file → configPresent=false → unknown (S1 #4)
{
	const { plugin } = makePlugin({ data: null })
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	record('PL-01', '首次 onload（无配置文件）→ configPresent=false → unknown', plugin.keyState === 'unknown' && plugin.configPresent === false)
}
// PL-02  normal restart with a valid key → ready
{
	const { plugin } = makePlugin({ data: { outputFolder: 'html-export', signingKey: TEST_KEY, signingKeyInitialized: true } })
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	record('PL-02', '正常重启（合法密钥+已初始化）→ ready，密钥保留', plugin.keyState === 'ready' && plugin.settings.signingKey === TEST_KEY)
}
// PL-03  existing key lost: initialized true but key missing → lost (S1 #2/#3)
{
	const { plugin } = makePlugin({ data: { outputFolder: 'html-export', signingKey: '', signingKeyInitialized: true } })
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	record('PL-03', '已有密钥丢失（initialized=true 但密钥缺失）→ lost', plugin.keyState === 'lost')
}
// PL-04  config present but no marker at all → unknown (Round 4: NOT first-init)
//        A missing marker is not evidence of a first install; only an explicit,
//        self-consistent `uninitialized` + `false` pair is.
{
	const { plugin } = makePlugin({ data: { outputFolder: 'html-export' } })
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	record(
		'PL-04',
		'配置存在但两个标记都缺失 → unknown（不再冒充 first-init）',
		plugin.keyState === 'unknown' &&
			plugin.keyState !== 'first-init' &&
			plugin.configPresent === true &&
			plugin.getKeyStatusLine().confirmTwice === true,
		`state=${plugin.keyState} confirm=${plugin.getKeyStatusLine().confirmTwice}`
	)
}
// PL-05  key format corrupted → corrupted, original value kept
{
	const { plugin } = makePlugin({ data: { outputFolder: 'html-export', signingKey: 'zzz-bad', signingKeyInitialized: true } })
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	record('PL-05', '密钥格式损坏 → corrupted，原损坏值保留在内存', plugin.keyState === 'corrupted' && plugin.settings.signingKey === 'zzz-bad')
}
// PL-06  user-initiated generation from first-init → ready, persisted, flag set
{
	const { plugin, getStored } = makePlugin({ data: { outputFolder: 'html-export', signingKey: '', signingKeyInitialized: false } })
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	const r = await plugin.rotateSigningKey()
	record('PL-06', '用户主动初始化 → ready，changed=true，已持久化且标记 initialized', r.state === 'ready' && r.changed && assertValidHex(plugin.settings.signingKey) && getStored().signingKeyInitialized === true, `state=${r.state}`)
}
// PL-07  user-initiated rotation replaces a valid key
{
	const { plugin, getStored } = makePlugin({ data: { outputFolder: 'html-export', signingKey: TEST_KEY, signingKeyInitialized: true } })
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	const r = await plugin.rotateSigningKey()
	record('PL-07', '用户主动轮换 → ready，新密钥≠旧密钥，已持久化', r.state === 'ready' && r.changed && plugin.settings.signingKey !== TEST_KEY && getStored().signingKey === plugin.settings.signingKey)
}
// PL-08  two-step confirmation logic via getKeyStatusLine (S1 #6)
{
	const lost = makePlugin({ data: { outputFolder: 'html-export', signingKey: '', signingKeyInitialized: true } })
	await lost.plugin.loadSettings(); await lost.plugin.ensureSigningKey()
	const lostStatus = lost.plugin.getKeyStatusLine()
	const unk = makePlugin({ data: null })
	await unk.plugin.loadSettings(); await unk.plugin.ensureSigningKey()
	const unkStatus = unk.plugin.getKeyStatusLine()
	// Round 4: `first-init` needs BOTH markers, consistent. A bare legacy
	// `false` is not enough (it may be a merged default), so that config now
	// lands in `unknown` and keeps the strict confirmation.
	const first = makePlugin({
		data: { outputFolder: 'html-export', signingKey: '', signingKeyInitialized: false, signingKeyInitState: 'uninitialized' }
	})
	await first.plugin.loadSettings(); await first.plugin.ensureSigningKey()
	const firstStatus = first.plugin.getKeyStatusLine()
	const legacyFalse = makePlugin({ data: { outputFolder: 'html-export', signingKey: '', signingKeyInitialized: false } })
	await legacyFalse.plugin.loadSettings(); await legacyFalse.plugin.ensureSigningKey()
	const legacyStatus = legacyFalse.plugin.getKeyStatusLine()
	record(
		'PL-08',
		'lost/unknown → 严格二次确认；显式 first-init → 无需；仅有旧版 false → 仍需确认',
		lostStatus.confirmTwice === true &&
			unkStatus.confirmTwice === true &&
			firstStatus.confirmTwice === false &&
			legacyStatus.confirmTwice === true,
		`lost=${lostStatus.confirmTwice} unk=${unkStatus.confirmTwice} first=${firstStatus.confirmTwice} legacyFalse=${legacyStatus.confirmTwice}`
	)
}
// PL-09  saveData failure → original key preserved, not overwritten (S2 #3/#6)
{
	const { plugin } = makePlugin({ data: { outputFolder: 'html-export', signingKey: TEST_KEY, signingKeyInitialized: true }, saveFails: true })
	await plugin.loadSettings(); await plugin.ensureSigningKey()
	const r = await plugin.rotateSigningKey()
	record('PL-09', 'saveData 失败 → changed=false，原合法密钥保留（未被覆盖）', r.changed === false && plugin.settings.signingKey === TEST_KEY && plugin.keyState === 'ready', `state=${plugin.keyState}`)
}
// PL-10  corrupted key + save failure → corrupted value preserved (S2 #3)
{
	const { plugin } = makePlugin({ data: { outputFolder: 'html-export', signingKey: 'zzz-bad', signingKeyInitialized: true }, saveFails: true })
	await plugin.loadSettings(); await plugin.ensureSigningKey()
	const r = await plugin.rotateSigningKey()
	record('PL-10', '损坏密钥 + 保存失败 → 保留损坏值（corrupted），未采纳新密钥', r.changed === false && plugin.settings.signingKey === 'zzz-bad' && plugin.keyState === 'corrupted', `state=${plugin.keyState}`)
}
// PL-11  after rotation, old export is unverifiable under the new key (lifecycle tie-in)
{
	const { plugin } = makePlugin({ data: { outputFolder: 'html-export', signingKey: TEST_KEY, signingKeyInitialized: true } })
	await plugin.loadSettings(); await plugin.ensureSigningKey()
	const v = makeVault({ files: seed(EXPORT_DIR, OWN_ENTRIES) })
	const before = await own(v.app, EXPORT_DIR, NOTE_PATH, TEST_KEY)
	const r = await plugin.rotateSigningKey()
	const after = await own(v.app, EXPORT_DIR, NOTE_PATH, plugin.settings.signingKey)
	const oldKeyStillVerifies = (await own(v.app, EXPORT_DIR, NOTE_PATH, TEST_KEY)).owned
	record('PL-11', '轮换后旧导出在新密钥下不可验证；旧密钥材料仍可验证', before.owned === true && r.changed === true && after.owned === false && oldKeyStillVerifies === true)
}

/* ============================================ CX · 轮换/导出 并发（S2）=== */
console.log('\n=== CX · 密钥轮换与导出并发（互斥锁 + 稳定快照 + 持久化时序）===')

// CX-01  during a delayed save, the in-memory key is NOT updated early; snapshot is stable
{
	const { plugin } = makePlugin({ data: { outputFolder: 'html-export', signingKey: TEST_KEY, signingKeyInitialized: true } })
	await plugin.loadSettings(); await plugin.ensureSigningKey()
	// Make saveData slow so rotation is mid-flight while we observe.
	plugin.saveData = async d => { await new Promise(r => setTimeout(r, 70)); plugin.__stored = d }
	const rot = plugin.rotateSigningKey() // not awaited
	const duringMem = plugin.settings.signingKey // synchronous read right after kickoff → still OLD
	const snap = await plugin.snapshotSigningKey() // waits for rotation → NEW
	await rot
	const afterMem = plugin.settings.signingKey
	record('CX-01', '保存延迟期间内存旧密钥未提前覆盖；快照/最终均为 newKey', duringMem === TEST_KEY && snap !== TEST_KEY && afterMem === snap && snap === plugin.settings.signingKey, `during=${duringMem.slice(0, 6)} after=${afterMem.slice(0, 6)}`)
}
// CX-02  save success → old export still verifiable under the OLD key material
{
	const { plugin } = makePlugin({ data: { outputFolder: 'html-export', signingKey: TEST_KEY, signingKeyInitialized: true } })
	await plugin.loadSettings(); await plugin.ensureSigningKey()
	const v = makeVault({ files: seed(EXPORT_DIR, OWN_ENTRIES) })
	const before = await own(v.app, EXPORT_DIR, NOTE_PATH, TEST_KEY)
	const r = await plugin.rotateSigningKey()
	const after = await own(v.app, EXPORT_DIR, NOTE_PATH, plugin.settings.signingKey)
	const oldStillOwned = (await own(v.app, EXPORT_DIR, NOTE_PATH, TEST_KEY)).owned
	record('CX-02', '保存成功后旧导出用旧密钥仍可验证；新密钥下不可验证', before.owned === true && r.changed === true && after.owned === false && oldStillOwned === true)
}
// CX-03  save failure → old export remains verifiable (old key preserved)
{
	const { plugin } = makePlugin({ data: { outputFolder: 'html-export', signingKey: TEST_KEY, signingKeyInitialized: true }, saveFails: true })
	await plugin.loadSettings(); await plugin.ensureSigningKey()
	const v = makeVault({ files: seed(EXPORT_DIR, OWN_ENTRIES) })
	const before = await own(v.app, EXPORT_DIR, NOTE_PATH, TEST_KEY)
	const r = await plugin.rotateSigningKey()
	const stillOwned = (await own(v.app, EXPORT_DIR, NOTE_PATH, TEST_KEY)).owned
	record('CX-03', '保存失败后旧导出仍可用旧密钥验证（旧密钥保留）', before.owned === true && r.changed === false && plugin.settings.signingKey === TEST_KEY && stillOwned === true)
}
// CX-04  corrupted key + rotation failure → corrupted state preserved, export stays refused
{
	const { plugin } = makePlugin({ data: { outputFolder: 'html-export', signingKey: 'zzz-bad', signingKeyInitialized: true }, saveFails: true })
	await plugin.loadSettings(); await plugin.ensureSigningKey()
	const v = makeVault({ files: seed(EXPORT_DIR, OWN_ENTRIES) })
	const r = await plugin.rotateSigningKey()
	const verdict = await own(v.app, EXPORT_DIR, NOTE_PATH, 'zzz-bad')
	record('CX-04', '损坏密钥+保存失败 → 损坏值保留(corrupted)，旧导出仍被拒绝', r.changed === false && plugin.settings.signingKey === 'zzz-bad' && plugin.keyState === 'corrupted' && verdict.owned === false)
}
// CX-05  an export kicked off during rotation captures a stable key and verifies consistently
{
	const { plugin } = makePlugin({ data: { outputFolder: 'html-export', signingKey: TEST_KEY, signingKeyInitialized: true } })
	await plugin.loadSettings(); await plugin.ensureSigningKey()
	plugin.saveData = async d => { await new Promise(r => setTimeout(r, 70)); plugin.__stored = d }
	const rot = plugin.rotateSigningKey()
	// Export "starts" during rotation: it captures a stable snapshot (waits for the
	// rotation to commit), then signs with it.
	const k = await plugin.snapshotSigningKey()
	await rot
	const v = makeVault({ files: seed(EXPORT_DIR, OWN_ENTRIES, { key: k }) })
	const verdict = await own(v.app, EXPORT_DIR, NOTE_PATH, k)
	record('CX-05', '轮换期间导出捕获稳定密钥并成功签署验证', verdict.owned === true)
}

/* --------------------------------------------------------------- summary -- */
console.log(`\n总计：${results.length} 例，PASS ${pass}，FAIL ${fail}`)
const failed = results.filter(r => r.verdict === 'FAIL')
if (failed.length) {
	console.error('\n失败用例：')
	for (const f of failed) console.error(`  - ${f.id} ${f.name}  ${f.detail}`)
}
process.exit(fail === 0 ? 0 : 1)
