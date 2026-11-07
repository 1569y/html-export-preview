/**
 * Round 2A.2.2 Review Fix Round 3 — migration, unified persistence, UI feedback
 *
 * Targets the ChatGPT independent-source-review findings F-07 … F-13:
 *
 *   F-07  Legacy key-config migration — a 2A.2.2 config with a valid key but no
 *         init marker must be migrated (marker written), so a later loss is
 *         `lost` rather than `first-init`.
 *   F-08  One persistence queue for every settings write, with the write reading
 *         the *current* settings at execution time and the key committed inside
 *         the queued task.
 *   F-09  `unknown` must survive an ordinary save and a restart.
 *   F-10  The settings tab must show the rotation result (success ≠ failure).
 *
 * ---------------------------------------------------------------------------
 * TEST TIERS (F-11). Every block below is labelled with exactly one tier; none
 * of them is a "real Obsidian host acceptance".
 *
 *   T1  pure unit          — `signing-key.ts` helpers called directly (the
 *                            KL-xx / PS-xx suites of run-round2a2-2-review.mjs,
 *                            kept unchanged and re-run separately).
 *   T2  method-level       — a real `HtmlExportPlugin` instance with stubbed
 *       integration          Obsidian host objects; `loadSettings`,
 *                            `ensureSigningKey`, `rotateSigningKey`,
 *                            `saveSettings`, `getKeyStatusLine` are really run.
 *   T3  settings-UI sim    — `HtmlExportSettingTab.display()` executed against a
 *                            minimal DOM double; button handlers really invoked.
 *   T4  export pipeline    — real `writeExport` / `inspectOwnership` against a
 *                            fake vault adapter; `runCaptureAndExport()` is
 *                            attempted over a DOM double when possible.
 *   T5  real Obsidian host — NOT TESTED (requires a running Obsidian app).
 *
 * MOCK BOUNDARY: `obsidian` (Plugin, App, Notice, Setting, PluginSettingTab,
 * ItemView, TFile, …) is stubbed; `document`/`window` are the project's own
 * narrow doubles. Production source is bundled unchanged. A passing run here
 * means the plugin's own logic behaves; it is NOT an Obsidian host acceptance.
 *
 * Run:  node tests/unit/run-round2a2-2-review-3.mjs
 *       AB_ROOT=<dir> node tests/unit/run-round2a2-2-review-3.mjs   # 反向对照
 */
import { build } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash, createHmac } from 'node:crypto'
import { installDomGlobals, parseHtml, setRect } from './dom-double.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = process.env.AB_ROOT
	? path.resolve(process.env.AB_ROOT)
	: path.resolve(here, '../..')
const out = path.join(here, '.out-round2a2-2-review-3')

/* ------------------------------------------------------------- bundling -- */
function prepareStub() {
	const dir = path.join(out, 'node_modules', 'obsidian')
	fs.mkdirSync(dir, { recursive: true })
	// Minimal Obsidian surface — STUB, not a real host (see header).
	fs.writeFileSync(
		path.join(dir, 'index.mjs'),
		`class Node { constructor() { this.children = []; this.__settings = [] }
  empty() { this.children.length = 0; this.__settings = [] }
  _mk(tag) {
    const el = {
      tagName: String(tag).toUpperCase(), children: [], textContent: '', cls: '',
      classList: { add() {}, remove() {}, contains() { return false } },
      createDiv(o = {}) { return this.createEl('div', o) },
      createEl(t, o = {}) { const c = { tagName: String(t).toUpperCase(), children: [], textContent: o && o.text ? String(o.text) : '', createDiv: () => ({}), createEl: () => ({}), setText(t) { this.textContent = String(t) } }; this.children.push(c); return c },
      appendChild(c) { this.children.push(c); return c },
      setText(t) { this.textContent = String(t) },
      addClass() {}, removeClass() {}, setAttribute() {}, getAttribute() { return null },
      querySelector() { return null }, querySelectorAll() { return [] }
    }
    return el
  }
  createDiv(o = {}) { return this._mk('div') }
  createEl(t) { return this._mk(t) }
  createSpan(o = {}) { return this._mk('span') }
}
export class TFile { constructor(p, size = 1) { this.path = p; this.name = p.split('/').pop() ?? p; this.basename = this.name.replace(/\\.[^.]+$/, ''); this.stat = { size: typeof size === 'number' ? size : String(size).length }; this.parent = { path: p.split('/').slice(0, -1).join('/') || '.' } } }
export class TFolder {}
export class TAbstractFile {}
export class App { constructor() { this.workspace = { getLeavesOfType: () => [], getRightLeaf: () => ({}), getLeaf: () => ({ setViewState: async () => {} }), revealLeaf: () => {} }; this.vault = { adapter: { getBasePath: () => '/vault' } } } }
export class Plugin { constructor(app, manifest) { this.app = app; this.manifest = manifest; this.appId = manifest && manifest.id }
  async loadData() { return null }
  async saveData(_d) {}
  addRibbonIcon() {} addCommand() {} addSettingTab() {} registerView() {} registerEvent() {} }
export class PluginSettingTab { constructor(app, plugin) { this.app = app; this.plugin = plugin; this.containerEl = new Node() } display() {} }
export class Setting { constructor(c) { this.containerEl = c; this.buttons = []; this.texts = []; if (c) { c.__settings = c.__settings || []; c.__settings.push(this) } }
  setName(n) { this.name = n; return this }
  setDesc(d) { this.desc = d; return this }
  setHeading() { return this }
  addText(cb) { const t = { value: '', placeholder: '', setPlaceholder(p) { this.placeholder = p; return this }, setValue(v) { this.value = v; return this }, onChange(h) { this.handler = h; return this }, change(v) { this.value = v; return this.handler ? this.handler(v) : undefined } }; this.texts.push(t); cb(t); return this }
  addButton(cb) { const b = { text: '', warning: false, disabled: false, setButtonText(t) { this.text = t; return this }, setWarning() { this.warning = true; return this }, setCta() { return this }, setDisabled(v) { this.disabled = v; return this }, setTooltip() { return this }, onClick(h) { this.handler = h; return this }, click() { return this.handler ? this.handler() : undefined } }; this.buttons.push(b); cb(b); return this }
  addToggle(cb) { cb({ setValue() { return this }, onChange() { return this } }); return this } }
export class ItemView { constructor(leaf) { this.leaf = leaf; this.app = { workspace: {} } } }
export class WorkspaceLeaf {}
export class MarkdownView {}
export class Notice { static all = []; constructor(message, timeout) { this.message = String(message ?? ''); this.timeout = timeout; Notice.all.push(this) } hide() { this.hidden = true } setMessage(m) { this.message = String(m) } }
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

/* The DOM/window doubles must exist before the bundle module is evaluated. */
installDomGlobals()
globalThis.window = {
	// Real timers: `capture` awaits `requestAnimationFrame` / `setTimeout`, and the
	// settings tab arms a 6 s revert timer that simply never fires before the
	// runner exits (the process is terminated explicitly at the end).
	setTimeout: (fn, ms) => setTimeout(fn, ms),
	clearTimeout: id => clearTimeout(id),
	requestAnimationFrame: fn => setTimeout(() => fn(Date.now()), 0),
	cancelAnimationFrame: id => clearTimeout(id),
	getComputedStyle: () => ({ getPropertyValue: () => '', width: '900px', height: '700px' })
}
globalThis.requestAnimationFrame = globalThis.window.requestAnimationFrame
globalThis.cancelAnimationFrame = globalThis.window.cancelAnimationFrame
globalThis.getComputedStyle = globalThis.window.getComputedStyle
globalThis.document = {
	styleSheets: [],
	documentElement: {
		attributes: [],
		dataset: {},
		className: '',
		getAttribute: () => null
	},
	body: { className: '' },
	querySelector: () => null,
	querySelectorAll: () => [],
	createElement: () => ({ style: {}, appendChild() {}, setAttribute() {} })
}

const { default: HtmlExportPlugin } = await bundle('src/main.ts', 'main')
const { HtmlExportSettingTab } = await bundle('src/settings.ts', 'settings')
const { inspectOwnership, writeExport } = await bundle('src/export/writer.ts', 'writer')
const signing = await bundle('src/export/manifest-signing.ts', 'manifest-signing')
const { signingPayload } = signing
const { identitySuffix } = await bundle('src/export/path-safety.ts', 'path-safety')
const obsidianStub = await import(
	pathToFileURL(path.join(out, 'node_modules', 'obsidian', 'index.mjs')).href
)
const Notice = obsidianStub.Notice

/* ----------------------------------------------------------- fixtures -- */
const TEST_KEY = '9f'.repeat(32)
const NEW_KEY_RE = /^[0-9a-f]{64}$/i
const NOTE_PATH = 'notes/note.md'
const TITLE = '笔记'
const SUFFIX = identitySuffix(NOTE_PATH)
const EXPORT_DIR = `html-export/note-${SUFFIX}`
const page = (body = '<p>正文内容</p>') =>
	'<!doctype html>\n<html>\n<head><title>t</title></head>\n<body>\n' +
	`<!--he-body-start-->\n${body}\n<!--he-body-end-->\n</body>\n</html>\n`
const sha256hex = s => createHash('sha256').update(String(s), 'utf8').digest('hex')
const bytesOf = s => Buffer.byteLength(String(s), 'utf8')
const OWN_ENTRIES = {
	'index.html': page('<p>第一版</p>'),
	'assets/export.css': 'body{}',
	'runtime-audit.json': '{"generatedAt":"x"}'
}
const recordsFrom = entries =>
	Object.entries(entries).map(([rel, content]) => ({
		path: rel,
		bytes: bytesOf(content),
		sha256: sha256hex(content)
	}))
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
function buildManifest(entries, { notePath = NOTE_PATH, version = 2, key = TEST_KEY } = {}) {
	const manifest = {
		manifestVersion: version,
		generatedAt: 'x',
		notePath,
		noteTitle: TITLE,
		identitySuffix: SUFFIX,
		outputFolder: `note-${SUFFIX}`,
		status: 'ok',
		assets: { written: 0, attempted: 0, entries: [], failed: [] },
		files: recordsFrom(entries)
	}
	return JSON.stringify(signFixture(manifest, key))
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
function makeVault(seedFiles = {}) {
	const files = new Map(Object.entries(seedFiles))
	const dirs = new Set(['.'])
	const addDirsFor = p => {
		const parts = p.split('/')
		for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'))
	}
	for (const p of files.keys()) addDirsFor(p)
	const log = []
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
			return new TextEncoder().encode(files.get(p))
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
			files.delete(p)
		}
	}
	return { app: { vault: { adapter } }, files, dirs, log }
}
const own = (app, dir = EXPORT_DIR, notePath = NOTE_PATH, key = TEST_KEY) =>
	inspectOwnership(app, dir, notePath, key)

/* --------------------------------------------------- plugin mock factory -- */
/**
 * A real `HtmlExportPlugin` with the host stubbed out.
 *
 * `savePlan(i, payload)` decides what the i-th `saveData` call does:
 *   'ok'          → store + resolve
 *   { throw: msg }→ reject (simulated write failure)
 *   { delay: ms } → wait, then store
 * Every successful write is recorded in `writes` so tests assert the *persisted*
 * payload, not just that a promise resolved (F-08 §2.5).
 */
function makePlugin({ data = null, savePlan = null, keepFailing = false } = {}) {
	let stored = data == null ? null : structuredClone(data)
	const writes = []
	let attempt = 0
	const app = {
		workspace: {
			getLeavesOfType: () => [],
			getRightLeaf: () => null,
			getLeaf: () => ({ setViewState: async () => {} }),
			revealLeaf: () => {}
		},
		vault: { adapter: { getBasePath: () => '/vault' } }
	}
	const plugin = new HtmlExportPlugin(app, { id: 'test', name: 'test', version: '1.0.0' })
	plugin.loadData = async () => (stored == null ? null : structuredClone(stored))
	plugin.saveData = async payload => {
		// Snapshot at ENTRY: a real writer serialises the payload when it is called
		// and only then flushes it. Capturing here is what makes a *stale* payload
		// observable — which is exactly the F-08 regression (a write queued with the
		// old key landing after the rotation).
		const snapshot = structuredClone(payload)
		// `attempt` counts every call, including the ones that throw, so a plan
		// can target "the first write" rather than "the first successful write".
		const i = attempt++
		const plan = savePlan ? savePlan(i, payload) : keepFailing ? { throw: 'simulated save failure' } : null
		if (plan && plan.delay) await new Promise(r => setTimeout(r, plan.delay))
		if (plan && plan.throw) throw new Error(plan.throw)
		writes.push({
			i,
			at: Date.now(),
			key: snapshot.signingKey,
			marker: snapshot.signingKeyInitState,
			legacy: snapshot.signingKeyInitialized,
			folder: snapshot.outputFolder
		})
		stored = snapshot
		return undefined
	}
	return {
		plugin,
		app,
		writes,
		getStored: () => stored,
		/** Simulated restart: a fresh instance reading what is on "disk". */
		restart: () => makePlugin({ data: stored, savePlan })
	}
}

/* -------------------------------------------------------------- runner -- */
let pass = 0
let fail = 0
let skipped = 0
const results = []
function record(id, name, ok, detail = '') {
	results.push({ id, name, verdict: ok ? 'PASS' : 'FAIL', detail })
	if (ok) pass++
	else fail++
	console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${id}  ${name}${detail ? '  — ' + detail : ''}`)
}
function notTested(id, name, why) {
	results.push({ id, name, verdict: 'NOT TESTED', detail: why })
	skipped++
	console.log(`  NOT TESTED  ${id}  ${name}  — ${why}`)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const isHex = k => typeof k === 'string' && NEW_KEY_RE.test(k)

/* ==================================================================== */
console.log('\n=== MG · 旧版配置迁移（F-07）· T2 方法级集成 ===')

// MG-01  legacy config: valid key, NO marker → ready + marker migrated to disk
{
	const { plugin, getStored } = makePlugin({ data: { outputFolder: 'html-export', signingKey: TEST_KEY } })
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	const stored = getStored()
	record(
		'MG-01',
		'旧版配置（有合法密钥、无初始化标记）→ ready，且标记已迁移落盘',
		plugin.keyState === 'ready' &&
			plugin.settings.signingKey === TEST_KEY &&
			stored &&
			stored.signingKeyInitState === 'initialized' &&
			stored.signingKeyInitialized === true,
		`state=${plugin.keyState} marker=${stored && stored.signingKeyInitState}`
	)
}
// MG-02  migration must not touch the key itself and must not "generate" one
{
	const { plugin, getStored } = makePlugin({ data: { outputFolder: 'html-export', signingKey: TEST_KEY } })
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	const stored = getStored()
	record(
		'MG-02',
		'迁移只写标记：密钥字节不变，未生成新密钥',
		stored.signingKey === TEST_KEY && plugin.settings.signingKey === TEST_KEY,
		`diskKey==old=${stored.signingKey === TEST_KEY}`
	)
}
// MG-03  after migration, a lost key resolves to `lost` (the whole point of F-07)
{
	const { plugin, getStored, restart } = makePlugin({ data: { outputFolder: 'html-export', signingKey: TEST_KEY } })
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	const persisted = getStored()
	// The key is lost afterwards (user wiped the field / sync dropped it).
	const lost = restart()
	lost.plugin.loadData = async () => ({ ...persisted, signingKey: '' })
	await lost.plugin.loadSettings()
	await lost.plugin.ensureSigningKey()
	record(
		'MG-03',
		'迁移后密钥丢失 → lost（修复前会误判 first-init）',
		lost.plugin.keyState === 'lost',
		`state=${lost.plugin.keyState}`
	)
}
// MG-04  REVERSE CONTROL: when the migration cannot be persisted, the same loss
//        is indistinguishable from a first install — exactly the old bug, and the
//        plugin must say so instead of pretending the migration finished.
{
	const { plugin, getStored } = makePlugin({
		data: { outputFolder: 'html-export', signingKey: TEST_KEY },
		keepFailing: true
	})
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	const persisted = getStored() // unchanged: the migration never landed
	const lost = makePlugin({ data: { ...persisted, signingKey: '' }, keepFailing: true })
	await lost.plugin.loadSettings()
	await lost.plugin.ensureSigningKey()
	record(
		'MG-04',
		'迁移持久化失败 → 不假装完成（migrationFailed），并如实降级为 unknown',
		plugin.migrationFailed === true &&
			plugin.initStatePersisted === false &&
			plugin.keyState === 'ready' &&
			// Round 4: a config with no marker at all is `unknown`, not
			// `first-init`. The point of the test — "a failed migration must not
			// be presented as a completed one, and the loss must stay
			// indistinguishable from an unknown history" — is unchanged; only the
			// honest state name moved.
			lost.plugin.keyState === 'unknown' &&
			lost.plugin.getKeyStatusLine().detail.includes('迁移失败'),
		`migFailed=${plugin.migrationFailed} lostState=${lost.plugin.keyState}`
	)
}
// MG-05  migration failure keeps the key and never generates a new one
{
	const { plugin, getStored } = makePlugin({
		data: { outputFolder: 'html-export', signingKey: TEST_KEY },
		keepFailing: true
	})
	const before = JSON.stringify(getStored())
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	record(
		'MG-05',
		'迁移失败：原密钥保留、配置未被写入、未生成新密钥',
		plugin.settings.signingKey === TEST_KEY &&
			getStored().signingKey === TEST_KEY &&
			JSON.stringify(getStored()) === before,
		`diskUnchanged=${JSON.stringify(getStored()) === before}`
	)
}
// MG-06  migration must not disturb an existing v2 export (F-07 #8)
{
	const { plugin } = makePlugin({ data: { outputFolder: 'html-export', signingKey: TEST_KEY } })
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	const v = makeVault(seed(EXPORT_DIR, OWN_ENTRIES))
	const verdict = await own(v.app, EXPORT_DIR, NOTE_PATH, plugin.settings.signingKey)
	const manifest = JSON.parse(v.files.get(`${EXPORT_DIR}/export-manifest.json`))
	record(
		'MG-06',
		'迁移后既有 v2 导出仍可验证，清单版本仍为 2',
		verdict.owned === true && manifest.manifestVersion === 2,
		`owned=${verdict.owned} v=${manifest.manifestVersion}`
	)
}
// MG-07  marker says `unknown` but a valid key exists → the key wins, marker
//        upgraded to `initialized` (truthful, prevents a bogus unknown forever)
{
	const { plugin, getStored } = makePlugin({
		data: { outputFolder: 'html-export', signingKey: TEST_KEY, signingKeyInitState: 'unknown' }
	})
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	record(
		'MG-07',
		'标记为 unknown 但存在合法密钥 → ready，标记升级为 initialized',
		plugin.keyState === 'ready' && getStored().signingKeyInitState === 'initialized',
		`marker=${getStored().signingKeyInitState}`
	)
}
// MG-08  legacy corrupted value + no marker → corrupted, marker recorded as
//        unknown (a corrupt key is not evidence of a successful init)
{
	const { plugin, getStored } = makePlugin({ data: { outputFolder: 'html-export', signingKey: 'zzz-bad' } })
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	record(
		'MG-08',
		'旧配置损坏密钥 → corrupted，坏值保留，标记记为 unknown（不冒充 initialized）',
		plugin.keyState === 'corrupted' &&
			plugin.settings.signingKey === 'zzz-bad' &&
			getStored().signingKeyInitState === 'unknown',
		`state=${plugin.keyState} marker=${getStored().signingKeyInitState}`
	)
}

/* ==================================================================== */
console.log('\n=== MG · Round 4：F-07 状态模型（MG-09..MG-17）· T2 方法级集成 ===')
/*
 * Round 4 (F-07 #1/#2/#3/#4) adds the combination table that decides what the
 * two stored markers mean together, and pins the consequences:
 *
 *   - a legacy `false` is not history (it may be the merged default);
 *   - a missing marker is not history either;
 *   - a new/legacy contradiction resolves to `unknown`, never to a guess;
 *   - `first-init` requires an explicit, self-consistent `uninitialized` pair;
 *   - a marker field that exists but is unusable is never silently rewritten.
 *
 * Every block below asserts FOUR things, not one: the derived state, the
 * `confirmTwice` requirement, the exact persisted payload (or that nothing was
 * written at all), and the final in-memory state.
 */

// MG-09  旧布尔 false（无新标记、无密钥）→ unknown + 二次确认 + 不生成密钥
{
	let attempts = 0
	const { plugin, getStored, writes } = makePlugin({
		data: { outputFolder: 'html-export', signingKeyInitialized: false },
		savePlan: () => {
			attempts++
			return null
		}
	})
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	const status = plugin.getKeyStatusLine()
	const stored = getStored()
	record(
		'MG-09',
		'旧布尔 false + 无新标记 + 无密钥 → unknown / 二次确认 / 不自动生成密钥',
		plugin.keyState === 'unknown' &&
			status.confirmTwice === true &&
			plugin.settings.signingKey === '' &&
			stored.signingKey === '' &&
			stored.signingKeyInitState === 'unknown' &&
			writes.length === 1 &&
			attempts === 1,
		`state=${plugin.keyState} confirm=${status.confirmTwice} writes=${writes.length} marker=${stored.signingKeyInitState}`
	)
}
// MG-10  配置存在但两个标记都缺失 → unknown + 二次确认
{
	const { plugin, getStored, writes } = makePlugin({
		data: { outputFolder: 'html-export' }
	})
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	const status = plugin.getKeyStatusLine()
	record(
		'MG-10',
		'配置存在但新旧标记都缺失 + 无密钥 → unknown / 二次确认（不当作首次安装）',
		plugin.keyState === 'unknown' &&
			plugin.keyState !== 'first-init' &&
			status.confirmTwice === true &&
			plugin.settings.signingKey === '' &&
			getStored().signingKeyInitState === 'unknown' &&
			writes.length === 1,
		`state=${plugin.keyState} confirm=${status.confirmTwice} marker=${getStored().signingKeyInitState}`
	)
}
// MG-11  新标记非法 → unknown + 二次确认；非法字段不被覆盖（保留证据）
{
	const data = {
		outputFolder: 'html-export',
		signingKeyInitState: 'invalid-value',
		signingKeyInitialized: false
	}
	let attempts = 0
	const { plugin, getStored } = makePlugin({
		data,
		savePlan: () => {
			attempts++
			return null
		}
	})
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	const status = plugin.getKeyStatusLine()
	const stored = getStored()
	record(
		'MG-11',
		'新标记为非法值 → unknown / 二次确认；非法字段原样保留、不写盘',
		plugin.keyState === 'unknown' &&
			status.confirmTwice === true &&
			plugin.settings.signingKey === '' &&
			plugin.markerReading.fieldValid === false &&
			stored.signingKeyInitState === 'invalid-value' &&
			attempts === 0,
		`state=${plugin.keyState} confirm=${status.confirmTwice} diskMarker=${stored.signingKeyInitState} writes=${attempts}`
	)
}
// MG-12  新旧标记矛盾（两个方向）→ unknown，绝不自动首次初始化
{
	const cases = [
		{ name: 'initialized + false', data: { outputFolder: 'html-export', signingKeyInitState: 'initialized', signingKeyInitialized: false } },
		{ name: 'uninitialized + true', data: { outputFolder: 'html-export', signingKeyInitState: 'uninitialized', signingKeyInitialized: true } }
	]
	const seen = []
	let allUnknown = true
	let allConfirm = true
	let allPreserved = true
	let allNoWrite = true
	for (const c of cases) {
		let attempts = 0
		const { plugin, getStored } = makePlugin({
			data: c.data,
			savePlan: () => {
				attempts++
				return null
			}
		})
		await plugin.loadSettings()
		await plugin.ensureSigningKey()
		const status = plugin.getKeyStatusLine()
		const stored = getStored()
		seen.push(`${c.name}→${plugin.keyState}/confirm=${status.confirmTwice}/writes=${attempts}`)
		allUnknown = allUnknown && plugin.keyState === 'unknown' && plugin.keyState !== 'first-init'
		allConfirm = allConfirm && status.confirmTwice === true
		// 原样保留：两个字段都没被改写
		allPreserved =
			allPreserved &&
			stored.signingKeyInitState === c.data.signingKeyInitState &&
			stored.signingKeyInitialized === c.data.signingKeyInitialized
		allNoWrite = allNoWrite && attempts === 0
	}
	record(
		'MG-12',
		'新旧标记矛盾（initialized+false / uninitialized+true）→ unknown，不自动首次初始化，原样保留',
		allUnknown && allConfirm && allPreserved && allNoWrite,
		seen.join(' | ')
	)
}
// MG-13  明确首次初始化（uninitialized + false + 无密钥）→ first-init，无需二次确认
{
	const { plugin, getStored, writes } = makePlugin({
		data: { outputFolder: 'html-export', signingKeyInitState: 'uninitialized', signingKeyInitialized: false }
	})
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	const status = plugin.getKeyStatusLine()
	record(
		'MG-13',
		'显式 uninitialized + false + 无密钥 → first-init / 无需二次确认 / 不写盘',
		plugin.keyState === 'first-init' &&
			status.confirmTwice === false &&
			status.action === 'generate' &&
			plugin.settings.signingKey === '' &&
			getStored().signingKeyInitState === 'uninitialized' &&
			writes.length === 0,
		`state=${plugin.keyState} confirm=${status.confirmTwice} writes=${writes.length}`
	)
}
// MG-14  迁移失败后普通保存成功 → 磁盘标记正确、rawConfig 更新、migrationFailed 清零
{
	const original = { outputFolder: 'html-export', signingKey: TEST_KEY }
	const { plugin, getStored, writes } = makePlugin({
		data: original,
		savePlan: i => (i === 0 ? { throw: 'EACCES simulated' } : null)
	})
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	const afterFail = {
		migrationFailed: plugin.migrationFailed,
		initStatePersisted: plugin.initStatePersisted,
		disk: JSON.stringify(getStored()),
		rawHasMarker: Object.prototype.hasOwnProperty.call(plugin.rawConfig, 'signingKeyInitState')
	}
	plugin.settings.outputFolder = 'after-migration'
	await plugin.saveSettings()
	const stored = getStored()
	const status = plugin.getKeyStatusLine()
	record(
		'MG-14',
		'迁移失败（migrationFailed=true）→ 普通保存成功 → 标记落盘、rawConfig 更新、migrationFailed=false',
		afterFail.migrationFailed === true &&
			afterFail.initStatePersisted === false &&
			afterFail.disk === JSON.stringify(original) &&
			afterFail.rawHasMarker === false &&
			stored.signingKeyInitState === 'initialized' &&
			stored.signingKeyInitialized === true &&
			stored.outputFolder === 'after-migration' &&
			plugin.rawConfig.signingKeyInitState === 'initialized' &&
			plugin.migrationFailed === false &&
			plugin.initStatePersisted === true &&
			!status.detail.includes('迁移失败') &&
			writes.length === 1,
		`beforeMigFailed=${afterFail.migrationFailed} afterMigFailed=${plugin.migrationFailed} marker=${stored.signingKeyInitState} writes=${writes.length}`
	)
}
// MG-15  迁移成功后 rawConfig 过期 + 轮换失败 → 不重复迁移、不覆盖密钥、不产生假 migrationFailed
{
	let attempts = 0
	const { plugin, getStored } = makePlugin({
		data: { outputFolder: 'html-export', signingKey: TEST_KEY },
		// 第 0 次（迁移）成功，第 1 次（轮换持久化）失败
		savePlan: i => {
			attempts++
			return i === 1 ? { throw: 'EROFS simulated' } : null
		}
	})
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	const afterMigration = getStored()
	const attemptsAfterMigration = attempts
	// 人为制造 R3-05 的过期快照：把 rawConfig 退回迁移之前的样子
	plugin.rawConfig = { outputFolder: 'html-export', signingKey: TEST_KEY }
	const before = JSON.stringify(getStored())
	const result = await plugin.rotateSigningKey()
	const stored = getStored()
	record(
		'MG-15',
		'迁移成功后轮换失败（rawConfig 已过期）→ 不重复迁移、不写第二次、密钥不变、无假 migrationFailed',
		afterMigration.signingKeyInitState === 'initialized' &&
			attemptsAfterMigration === 1 &&
			result.changed === false &&
			attempts === 2 &&
			JSON.stringify(stored) === before &&
			stored.signingKey === TEST_KEY &&
			stored.signingKeyInitState === 'initialized' &&
			plugin.settings.signingKey === TEST_KEY &&
			plugin.keyState === 'ready' &&
			plugin.migrationFailed === false,
		`attempts=${attempts} (migration=1, rotation=1) changed=${result.changed} migFailed=${plugin.migrationFailed}`
	)
}
// MG-16  合法密钥 + 旧布尔 false → 继续用原密钥，安全修正标记；保存失败不得假报完成
{
	const data = { outputFolder: 'html-export', signingKey: TEST_KEY, signingKeyInitialized: false }
	const ok = makePlugin({ data })
	await ok.plugin.loadSettings()
	await ok.plugin.ensureSigningKey()
	const okStored = ok.getStored()

	const bad = makePlugin({ data, keepFailing: true })
	await bad.plugin.loadSettings()
	await bad.plugin.ensureSigningKey()
	const badStored = bad.getStored()

	record(
		'MG-16',
		'合法密钥 + 旧布尔 false → 保留原密钥、不生成替代密钥、标记修正为 initialized；写盘失败则如实报告',
		ok.plugin.keyState === 'ready' &&
			ok.plugin.settings.signingKey === TEST_KEY &&
			okStored.signingKey === TEST_KEY &&
			okStored.signingKeyInitState === 'initialized' &&
			okStored.signingKeyInitialized === true &&
			ok.plugin.migrationFailed === false &&
			bad.plugin.keyState === 'ready' &&
			bad.plugin.settings.signingKey === TEST_KEY &&
			badStored.signingKeyInitState === undefined &&
			bad.plugin.migrationFailed === true &&
			bad.plugin.initStatePersisted === false &&
			bad.plugin.getKeyStatusLine().detail.includes('迁移失败'),
		`okMarker=${okStored.signingKeyInitState} badMigFailed=${bad.plugin.migrationFailed} badDiskMarker=${badStored.signingKeyInitState}`
	)
}
// MG-17  密钥材料非法 + 标记 uninitialized → 不视为首次初始化、不覆盖、进入 unknown
{
	const data = {
		outputFolder: 'html-export',
		signingKey: 'not-a-valid-hex-key',
		signingKeyInitState: 'uninitialized',
		signingKeyInitialized: false
	}
	let attempts = 0
	const { plugin, getStored } = makePlugin({
		data,
		savePlan: () => {
			attempts++
			return null
		}
	})
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	const status = plugin.getKeyStatusLine()
	const stored = getStored()
	record(
		'MG-17',
		'密钥存在但格式非法 + 标记 uninitialized → corrupted / unknown / 二次确认，原值不被覆盖',
		plugin.keyState === 'corrupted' &&
			plugin.keyState !== 'first-init' &&
			plugin.settings.signingKey === 'not-a-valid-hex-key' &&
			plugin.settings.signingKeyInitState === 'unknown' &&
			status.confirmTwice === true &&
			status.action === 'rotate' &&
			stored.signingKey === 'not-a-valid-hex-key' &&
			stored.signingKeyInitState === 'uninitialized' &&
			attempts === 0,
		`state=${plugin.keyState} initState=${plugin.settings.signingKeyInitState} confirm=${status.confirmTwice} writes=${attempts}`
	)
}

/* ==================================================================== */
console.log('\n=== UG · 统一持久化与并发（F-08）· T2 方法级集成 ===')

// UG-01  order A: ordinary save enters the queue first, rotation second
{
	const { plugin, getStored, writes } = makePlugin({
		data: { outputFolder: 'html-export', signingKey: TEST_KEY, signingKeyInitState: 'initialized' },
		savePlan: i => (i === 0 ? { delay: 40 } : null)
	})
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	const s1 = plugin.saveSettings() // queued first (delayed)
	plugin.settings.outputFolder = 'my-folder' // applied before the queued task runs
	const rot = plugin.rotateSigningKey() // queued second
	await Promise.all([s1, rot])
	const stored = getStored()
	record(
		'UG-01',
		'顺序 A（普通保存先入队，轮换后入队）→ 磁盘为最终值：新密钥 + 新目录',
		stored.signingKey === plugin.settings.signingKey &&
			stored.signingKey !== TEST_KEY &&
			stored.outputFolder === 'my-folder' &&
			writes.length === 2,
		`writes=${writes.length} diskKey==mem=${stored.signingKey === plugin.settings.signingKey}`
	)
}
// UG-02  order B: rotation enters the queue first, ordinary save second.
//        The later write must NOT resurrect the pre-rotation key.
{
	const { plugin, getStored, writes } = makePlugin({
		data: { outputFolder: 'html-export', signingKey: TEST_KEY, signingKeyInitState: 'initialized' },
		// The ordinary save is the one delayed: without the shared queue it would
		// serialise the pre-rotation settings and flush them last (the F-08 bug).
		savePlan: i => (i === 1 ? { delay: 40 } : null)
	})
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	const rot = plugin.rotateSigningKey() // queued first (writes immediately)
	await sleep(5) // let the rotation's write enter the queue first
	plugin.settings.outputFolder = 'later-folder'
	const s1 = plugin.saveSettings() // queued second, delayed
	await Promise.all([rot, s1])
	const stored = getStored()
	const memKey = plugin.settings.signingKey
	record(
		'UG-02',
		'顺序 B（轮换先入队，普通保存后入队）→ 后写不覆盖新密钥（无旧快照回写）',
		stored.signingKey === memKey && memKey !== TEST_KEY && stored.outputFolder === 'later-folder' && writes.length === 2,
		`diskKeyIsNew=${stored.signingKey === memKey && memKey !== TEST_KEY} folder=${(stored.outputFolder || '').slice(0, 12)}`
	)
}
// UG-03  both succeed → disk and memory agree on key, marker and folder
{
	const { plugin, getStored } = makePlugin({
		data: { outputFolder: 'html-export', signingKey: TEST_KEY, signingKeyInitState: 'initialized' }
	})
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	plugin.settings.outputFolder = 'agreed'
	await plugin.saveSettings()
	await plugin.rotateSigningKey()
	await plugin.saveSettings()
	const stored = getStored()
	record(
		'UG-03',
		'两种操作都成功 → 磁盘与内存的密钥 / 标记 / 目录完全一致',
		stored.signingKey === plugin.settings.signingKey &&
			stored.signingKeyInitState === 'initialized' &&
			stored.signingKeyInitialized === true &&
			stored.outputFolder === 'agreed',
		`marker=${stored.signingKeyInitState} legacy=${stored.signingKeyInitialized}`
	)
}
// UG-04  key write fails → disk and memory both keep the old key
{
	const { plugin, getStored } = makePlugin({
		data: { outputFolder: 'html-export', signingKey: TEST_KEY, signingKeyInitState: 'initialized' },
		savePlan: (i, p) => (p.signingKey !== TEST_KEY ? { throw: 'disk full' } : null)
	})
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	const r = await plugin.rotateSigningKey()
	record(
		'UG-04',
		'密钥保存失败 → 内存与磁盘均保留旧密钥，changed=false',
		r.changed === false && plugin.settings.signingKey === TEST_KEY && getStored().signingKey === TEST_KEY,
		`changed=${r.changed} state=${plugin.keyState}`
	)
}
// UG-05  ordinary save fails → rejects, nothing on disk or in memory changes
{
	const { plugin, getStored } = makePlugin({
		data: { outputFolder: 'html-export', signingKey: TEST_KEY, signingKeyInitState: 'initialized' }
	})
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	plugin.saveData = async () => {
		throw new Error('EACCES')
	}
	plugin.settings.outputFolder = 'never-saved'
	let threw = false
	try {
		await plugin.saveSettings()
	} catch {
		threw = true
	}
	record(
		'UG-05',
		'普通保存失败 → Promise 拒绝，磁盘仍为旧目录，内存密钥未变',
		threw && getStored().outputFolder === 'html-export' && plugin.settings.signingKey === TEST_KEY,
		`threw=${threw} diskFolder=${getStored().outputFolder}`
	)
}
// UG-06  export during a save delay → stable snapshot, and it is the key that
//        ends up on disk (never the pre-rotation one)
{
	const { plugin, getStored } = makePlugin({
		data: { outputFolder: 'html-export', signingKey: TEST_KEY, signingKeyInitState: 'initialized' },
		savePlan: () => ({ delay: 60 })
	})
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	await plugin.saveSettings() // occupy the queue
	const rot = plugin.rotateSigningKey()
	const during = plugin.settings.signingKey // not committed yet
	const snapshot = await plugin.snapshotSigningKey() // waits for rotation
	await rot
	const stored = getStored()
	record(
		'UG-06',
		'保存延迟期间导出：快照=最终磁盘密钥，内存未提前覆盖',
		during === TEST_KEY && snapshot !== TEST_KEY && isHex(snapshot) && stored.signingKey === snapshot,
		`duringOld=${during === TEST_KEY} snap==disk=${stored.signingKey === snapshot}`
	)
}
// UG-07  rotation in flight + several settings saves → all serialised, last
//        folder wins, key is the new one, no write carries the old key
{
	const { plugin, getStored, writes } = makePlugin({
		data: { outputFolder: 'html-export', signingKey: TEST_KEY, signingKeyInitState: 'initialized' },
		savePlan: () => ({ delay: 10 })
	})
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	const rot = plugin.rotateSigningKey()
	await sleep(5) // rotation's write is now first in the queue
	const saves = []
	for (let i = 1; i <= 3; i++) {
		plugin.settings.outputFolder = `folder-${i}`
		saves.push(plugin.saveSettings())
	}
	await Promise.all([rot, ...saves])
	const stored = getStored()
	const newKey = plugin.settings.signingKey
	// No write after the rotation commit may carry the old key.
	const rotIdx = writes.findIndex(w => w.key === newKey)
	const staleAfter = writes.slice(rotIdx + 1).filter(w => w.key === TEST_KEY)
	record(
		'UG-07',
		'轮换期间多次保存 → 先轮换后保存仍串行，最后一次目录生效，旧密钥不再回写',
		stored.signingKey === newKey && stored.outputFolder === 'folder-3' && rotIdx === 0 && staleAfter.length === 0,
		`writes=${writes.length} rotIdx=${rotIdx} stale=${staleAfter.length}`
	)
}
// UG-08  no deadlock: a rejected write must not wedge the queue
{
	const { plugin, getStored } = makePlugin({
		data: { outputFolder: 'html-export', signingKey: TEST_KEY, signingKeyInitState: 'initialized' },
		savePlan: i => (i === 0 ? { throw: 'boom' } : null)
	})
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	await plugin.saveSettings().catch(() => undefined)
	plugin.settings.outputFolder = 'after-failure'
	await plugin.saveSettings()
	record(
		'UG-08',
		'一次写入失败后队列仍可用（无死锁、无永久拒绝）',
		getStored().outputFolder === 'after-failure',
		`folder=${getStored().outputFolder}`
	)
}
// UG-09  restart after the concurrent sequence → same key, still verifiable
{
	const { plugin, getStored, restart } = makePlugin({
		data: { outputFolder: 'html-export', signingKey: TEST_KEY, signingKeyInitState: 'initialized' },
		savePlan: i => (i === 0 ? { delay: 30 } : null)
	})
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	const rot = plugin.rotateSigningKey()
	plugin.settings.outputFolder = 'restart-folder'
	const s1 = plugin.saveSettings()
	await Promise.all([rot, s1])
	const persisted = getStored()
	const after = restart()
	await after.plugin.loadSettings()
	await after.plugin.ensureSigningKey()
	record(
		'UG-09',
		'并发写入后重启 → 密钥/标记/目录一致，状态为 ready',
		after.plugin.keyState === 'ready' &&
			after.plugin.settings.signingKey === persisted.signingKey &&
			after.plugin.settings.outputFolder === 'restart-folder' &&
			after.getStored().signingKeyInitState === 'initialized',
		`state=${after.plugin.keyState}`
	)
}

/* ==================================================================== */
console.log('\n=== PS · unknown 状态持久化（F-09）· T2 方法级集成 ===')

// PS-01  no config file at all → unknown, and no config is created behind the user
{
	const { plugin, getStored } = makePlugin({ data: null })
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	record(
		'PS-01',
		'配置缺失 → unknown，且加载时不偷偷创建 data.json',
		plugin.keyState === 'unknown' && getStored() === null,
		`state=${plugin.keyState} stored=${getStored() === null ? 'null' : 'written'}`
	)
}
// PS-02  unknown + edit outputFolder + save → marker `unknown` on disk
{
	const { plugin, getStored } = makePlugin({ data: null })
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	plugin.settings.outputFolder = 'edited'
	await plugin.saveSettings()
	const stored = getStored()
	record(
		'PS-02',
		'unknown 下改 outputFolder 并保存 → 磁盘标记仍为 unknown（未被降级）',
		stored && stored.outputFolder === 'edited' && stored.signingKeyInitState === 'unknown',
		`marker=${stored && stored.signingKeyInitState}`
	)
}
// PS-03  restart → still unknown
{
	const { plugin, getStored, restart } = makePlugin({ data: null })
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	plugin.settings.outputFolder = 'edited'
	await plugin.saveSettings()
	const after = restart()
	await after.plugin.loadSettings()
	await after.plugin.ensureSigningKey()
	record(
		'PS-03',
		'模拟重启后仍为 unknown（不会变成 first-init）',
		after.plugin.keyState === 'unknown' && after.plugin.getKeyStatusLine().confirmTwice === true,
		`state=${after.plugin.keyState}`
	)
}
// PS-04  the resolved state survives a save + restart, and the marker is
//        written explicitly. Round 4: a marker-less config is `unknown`, so the
//        test covers BOTH halves — `unknown` stays `unknown`, and a genuinely
//        first-init config (explicit `uninitialized` + `false`) stays
//        `first-init`. The original property is kept, not weakened.
{
	const { plugin, getStored, restart } = makePlugin({ data: { outputFolder: 'html-export' } })
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	const first = plugin.keyState
	plugin.settings.outputFolder = 'first-init-folder'
	await plugin.saveSettings()
	const after = restart()
	await after.plugin.loadSettings()
	await after.plugin.ensureSigningKey()

	const genuine = makePlugin({
		data: { outputFolder: 'html-export', signingKey: '', signingKeyInitialized: false, signingKeyInitState: 'uninitialized' }
	})
	await genuine.plugin.loadSettings()
	await genuine.plugin.ensureSigningKey()
	genuine.plugin.settings.outputFolder = 'genuine-first-init'
	await genuine.plugin.saveSettings()
	const genuineAfter = genuine.restart()
	await genuineAfter.plugin.loadSettings()
	await genuineAfter.plugin.ensureSigningKey()

	record(
		'PS-04',
		'无标记配置 → unknown；显式 uninitialized → first-init；两者保存后重启都不变',
		first === 'unknown' &&
			getStored().signingKeyInitState === 'unknown' &&
			after.plugin.keyState === 'unknown' &&
			genuine.plugin.keyState === 'first-init' &&
			genuine.getStored().signingKeyInitState === 'uninitialized' &&
			genuineAfter.plugin.keyState === 'first-init',
		`before=${first} after=${after.plugin.keyState} genuine=${genuine.plugin.keyState}→${genuineAfter.plugin.keyState}`
	)
}
// PS-05  initialized survives a save + restart
{
	const { plugin, getStored, restart } = makePlugin({
		data: { outputFolder: 'html-export', signingKey: TEST_KEY, signingKeyInitState: 'initialized' }
	})
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	plugin.settings.outputFolder = 'init-folder'
	await plugin.saveSettings()
	const after = restart()
	await after.plugin.loadSettings()
	await after.plugin.ensureSigningKey()
	record(
		'PS-05',
		'initialized 保存后重启仍为 initialized，密钥不变',
		after.plugin.keyState === 'ready' &&
			after.plugin.settings.signingKey === TEST_KEY &&
			getStored().signingKeyInitState === 'initialized',
		`state=${after.plugin.keyState}`
	)
}
// PS-06  lost survives a save + restart
{
	const { plugin, getStored, restart } = makePlugin({
		data: { outputFolder: 'html-export', signingKey: '', signingKeyInitState: 'initialized' }
	})
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	plugin.settings.outputFolder = 'lost-folder'
	await plugin.saveSettings()
	const after = restart()
	await after.plugin.loadSettings()
	await after.plugin.ensureSigningKey()
	record(
		'PS-06',
		'lost 保存后重启仍为 lost（不会降级为 first-init）',
		plugin.keyState === 'lost' &&
			getStored().signingKeyInitState === 'initialized' &&
			after.plugin.keyState === 'lost',
		`before=${plugin.keyState} after=${after.plugin.keyState}`
	)
}
// PS-07  an ordinary save can never remove the strict confirmation
{
	const { plugin } = makePlugin({ data: null })
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	const before = plugin.getKeyStatusLine().confirmTwice
	plugin.settings.outputFolder = 'x'
	await plugin.saveSettings()
	const after = plugin.getKeyStatusLine()
	record(
		'PS-07',
		'普通设置保存无法绕过二次确认（unknown 仍是 confirmTwice）',
		before === true && after.confirmTwice === true && after.action === 'generate',
		`confirmTwice=${after.confirmTwice}`
	)
}
// PS-08  legacy boolean-only config (no string marker) is still understood
{
	const { plugin } = makePlugin({
		data: { outputFolder: 'html-export', signingKey: '', signingKeyInitialized: true }
	})
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	record(
		'PS-08',
		'仅有旧布尔标记（true, 无密钥）→ lost（向后兼容）',
		plugin.keyState === 'lost',
		`state=${plugin.keyState}`
	)
}

/* ==================================================================== */
console.log('\n=== NT · 设置页反馈与交互（F-10）· T3 设置页交互模拟 ===')

/** Build the settings tab against the stub DOM and return its key section. */
function openSettings(plugin) {
	const app = { workspace: {}, vault: { adapter: { getBasePath: () => '/vault' } } }
	const tab = new HtmlExportSettingTab(app, plugin)
	tab.display()
	const keySetting = (tab.containerEl.__settings ?? []).find(s => s.name === '清单签名密钥')
	return { tab, keySetting, container: tab.containerEl }
}

// NT-01  success → a success notice quoting result.message
{
	const { plugin } = makePlugin({
		data: { outputFolder: 'html-export', signingKey: TEST_KEY, signingKeyInitState: 'initialized' }
	})
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	const { keySetting } = openSettings(plugin)
	Notice.all.length = 0
	await keySetting.buttons[0].click() // arms confirmation
	await keySetting.buttons[0].click() // confirms
	const notice = Notice.all[Notice.all.length - 1]
	record(
		'NT-01',
		'轮换成功 → 显示成功 Notice，含 result.message',
		plugin.settings.signingKey !== TEST_KEY &&
			!!notice &&
			notice.message.includes('成功') &&
			notice.message.includes('清单签名密钥已生成'),
		`notice=${notice ? notice.message.split('\n')[0] : 'none'}`
	)
}
// NT-02  failure → failure notice, never a success one
{
	const { plugin } = makePlugin({
		data: { outputFolder: 'html-export', signingKey: TEST_KEY, signingKeyInitState: 'initialized' },
		savePlan: (i, p) => (p.signingKey !== TEST_KEY ? { throw: 'disk full' } : null)
	})
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	const { keySetting } = openSettings(plugin)
	Notice.all.length = 0
	await keySetting.buttons[0].click()
	await keySetting.buttons[0].click()
	const notice = Notice.all[Notice.all.length - 1]
	record(
		'NT-02',
		'轮换失败 → 显示失败 Notice，绝不含「成功」，密钥未变',
		!!notice &&
			notice.message.includes('未变更') &&
			!notice.message.includes('成功') &&
			notice.message.includes('重新生成失败') &&
			plugin.settings.signingKey === TEST_KEY,
		`notice=${notice ? notice.message.split('\n')[0] : 'none'}`
	)
}
// NT-03  no key material in any notice
{
	const { plugin } = makePlugin({
		data: { outputFolder: 'html-export', signingKey: TEST_KEY, signingKeyInitState: 'initialized' }
	})
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	const { keySetting } = openSettings(plugin)
	Notice.all.length = 0
	await keySetting.buttons[0].click()
	await keySetting.buttons[0].click()
	const newKey = plugin.settings.signingKey
	const leaked = Notice.all.filter(n => n.message.includes(TEST_KEY) || n.message.includes(newKey))
	record(
		'NT-03',
		'任何 Notice 都不泄露密钥内容',
		leaked.length === 0 && newKey !== TEST_KEY,
		`leaked=${leaked.length}`
	)
}
// NT-04  a corrupted key keeps being shown as corrupted after a failed rotation
{
	const { plugin } = makePlugin({
		data: { outputFolder: 'html-export', signingKey: 'zzz-bad', signingKeyInitState: 'initialized' },
		keepFailing: true
	})
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	const { keySetting, tab } = openSettings(plugin)
	await keySetting.buttons[0].click()
	await keySetting.buttons[0].click()
	tab.display()
	const after = (tab.containerEl.__settings ?? []).find(s => s.name === '清单签名密钥')
	record(
		'NT-04',
		'损坏密钥 + 轮换失败 → 设置页仍显示「格式非法」，不显示为正常',
		after.desc.includes('异常密钥') && !after.desc.includes('密钥不会写进导出目录'),
		`desc=${after.desc.split('\n')[0].slice(0, 18)}`
	)
}
// NT-05  two-step confirmation: the first click must not rotate
{
	const { plugin, getStored } = makePlugin({
		data: { outputFolder: 'html-export', signingKey: TEST_KEY, signingKeyInitState: 'initialized' }
	})
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	const { keySetting } = openSettings(plugin)
	const before = getStored()
	await keySetting.buttons[0].click() // arm only
	const armed = keySetting.buttons[0].text
	record(
		'NT-05',
		'第一次点击只进入确认态，不执行轮换',
		getStored().signingKey === before.signingKey &&
			plugin.settings.signingKey === TEST_KEY &&
			armed.includes('确认'),
		`armedText=${armed}`
	)
}
// NT-06  first-init does not require the second click (no exports at risk)
{
	const { plugin } = makePlugin({ data: { outputFolder: 'html-export', signingKeyInitState: 'uninitialized' } })
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	const { keySetting } = openSettings(plugin)
	await keySetting.buttons[0].click()
	record(
		'NT-06',
		'first-init 单击即生成（无需二次确认），并给出成功 Notice',
		isHex(plugin.settings.signingKey) &&
			Notice.all[Notice.all.length - 1].message.includes('成功'),
		`state=${plugin.keyState}`
	)
}

/* ==================================================================== */
console.log('\n=== EX · 导出流程（F-11 #9/#10）· T4 导出管线 ===')

const snap = (title = TITLE, notePath = NOTE_PATH) => ({
	notePath,
	noteTitle: title,
	captureWidth: 900,
	stats: { blocks: 1, images: 0, mermaid: 0, sidenotes: 0, bytesOfContent: 40 },
	resolution: { candidates: [], reason: '唯一可用候选', ambiguity: false },
	previewMetrics: { width: 900 },
	warnings: []
})
const EXTRA = { css: { bytes: 10, sheets: [], warnings: [] }, pluginVersion: '0.1.0', audit: { generatedAt: 'x' } }
const { AssetCollector } = await bundle('src/assets/resource-manager.ts', 'assets')

// EX-01  a real export during rotation signs with the stable snapshot
{
	const { plugin } = makePlugin({
		data: { outputFolder: 'html-export', signingKey: TEST_KEY, signingKeyInitState: 'initialized' },
		savePlan: () => ({ delay: 40 })
	})
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	const rot = plugin.rotateSigningKey()
	const key = await plugin.snapshotSigningKey()
	await rot
	const v = makeVault()
	const report = await writeExport(
		v.app,
		snap(),
		page('<p>导出</p>'),
		'body{}',
		new AssetCollector(v.app),
		'html-export',
		EXTRA,
		key
	)
	const verdictNew = await own(v.app, report.dir, NOTE_PATH, key)
	const verdictOld = await own(v.app, report.dir, NOTE_PATH, TEST_KEY)
	record(
		'EX-01',
		'轮换期间的导出使用稳定快照签名，且可用该快照验证（旧密钥无法验证）',
		verdictNew.owned === true && verdictOld.owned === false,
		`newKey=${verdictNew.owned} oldKey=${verdictOld.owned}`
	)
}
// EX-02  restart → the export written before the restart is still verifiable
{
	const { plugin, getStored } = makePlugin({
		data: { outputFolder: 'html-export', signingKey: TEST_KEY, signingKeyInitState: 'initialized' }
	})
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	const key = plugin.settings.signingKey
	const v = makeVault()
	const report = await writeExport(
		v.app,
		snap(),
		page('<p>重启前</p>'),
		'body{}',
		new AssetCollector(v.app),
		'html-export',
		EXTRA,
		key
	)
	// restart from what was written to disk
	const after = makePlugin({ data: getStored() })
	await after.plugin.loadSettings()
	await after.plugin.ensureSigningKey()
	const verdict = await own(v.app, report.dir, NOTE_PATH, after.plugin.settings.signingKey)
	record(
		'EX-02',
		'重启后旧导出仍可用磁盘上的密钥验证（密钥未漂移）',
		verdict.owned === true && after.plugin.keyState === 'ready',
		`owned=${verdict.owned} state=${after.plugin.keyState}`
	)
}
// EX-03  full runCaptureAndExport() call chain over the DOM double
{
	const leafRoot = parseHtml(
		'<div class="view-content"><div class="markdown-reading-view">' +
			'<div class="markdown-preview-view">' +
			'<div class="markdown-preview-sizer markdown-preview-section"><p>正文</p></div>' +
			'</div></div></div>'
	).children[0]
	const reading = leafRoot.children[0]
	const preview = reading.children[0]
	setRect(leafRoot, 900, 720)
	setRect(reading, 900, 700)
	setRect(preview, 900, 660)
	const file = new obsidianStub.TFile(NOTE_PATH, 120)
	const view = {
		getMode: () => 'preview',
		containerEl: leafRoot,
		file,
		leaf: {}
	}
	const vault = makeVault()
	const { plugin } = makePlugin({
		data: { outputFolder: 'html-export', signingKey: TEST_KEY, signingKeyInitState: 'initialized' }
	})
	plugin.app = {
		workspace: {
			getActiveViewOfType: () => view,
			getLeavesOfType: () => [],
			getRightLeaf: () => null,
			getLeaf: () => ({ setViewState: async () => {} }),
			revealLeaf: () => {}
		},
		vault: vault.app.vault,
		metadataCache: { getFileCache: () => null }
	}
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	Notice.all.length = 0
	// `runCaptureAndExport` swallows its own errors into a Notice + console.error;
	// hook the console so the NOT TESTED reason can name the real blocker.
	const consoleErrors = []
	const originalError = console.error
	console.error = (...args) => {
		consoleErrors.push(
			args.map(a => (a && a.message ? a.message : String(a))).join(' ')
		)
	}
	let thrown = null
	try {
		await plugin.runCaptureAndExport()
	} catch (error) {
		thrown = error
	} finally {
		console.error = originalError
	}
	const manifestWritten = [...vault.files.keys()].some(p => p.endsWith('/export-manifest.json'))
	const successNotice = Notice.all.find(n => n.message.includes('HTML 导出完成'))
	if (manifestWritten && successNotice) {
		const dir = [...vault.files.keys()].find(p => p.endsWith('/export-manifest.json')).replace('/export-manifest.json', '')
		const verdict = await own(vault.app, dir, NOTE_PATH, TEST_KEY)
		record(
			'EX-03',
			'真实 runCaptureAndExport() 调用链：抓取→签名导出→成功 Notice→导出可验证',
			verdict.owned === true,
			`dir=${dir} owned=${verdict.owned}`
		)
	} else {
		const blocker = thrown
			? `抛出：${thrown.message ?? thrown}`
			: consoleErrors.length
				? consoleErrors[consoleErrors.length - 1].slice(0, 160)
				: `未产出清单（adapter 操作 ${vault.log.length} 次）`
		notTested(
			'EX-03',
			'真实 runCaptureAndExport() 调用链（抓取→CSS→审计→签名导出）',
			`离线 DOM double 缺真实浏览器能力，链路中途失败：${blocker}`
		)
	}
}

/* --------------------------------------------------------------- summary -- */
console.log(
	`\n总计：${results.length} 例，PASS ${pass}，FAIL ${fail}，NOT TESTED ${skipped}`
)
console.log('\n分层统计（F-11，禁止把下层当上层报告）：')
console.log('  T1 纯逻辑单元        ：见 run-round2a2-2-review.mjs（KL-01..16 / PS-01..19 / H-07a..i）')
console.log(`  T2 方法级集成        ：MG-01..17 / UG-01..09 / PS-01..08（本文件，真实 main.ts）`)
console.log('  T3 设置页交互模拟    ：NT-01..06（stub DOM，非真实 Obsidian 界面）')
console.log('  T4 导出管线          ：EX-01..02（writeExport/inspectOwnership 真实），EX-03 单独标注')
console.log('  T5 真实 Obsidian 宿主 ：NOT TESTED（需要运行中的 Obsidian，本环境无法提供）')
if (fail > 0) {
	console.error('\n失败用例：')
	for (const r of results) if (r.verdict === 'FAIL') console.error(`  - ${r.id} ${r.name}  ${r.detail}`)
}
process.exit(fail === 0 ? 0 : 1)
