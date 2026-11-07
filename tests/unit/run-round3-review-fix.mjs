/**
 * Round 3.1 — Independent-review fix (R3-01 / R3-02 / R3-04 / R3-05 / R3-06 / F-10)
 *
 * Every block here is an answer to one finding from the ChatGPT review of
 * Round 3, and each one drives the *real* production code: the plugin class in
 * `src/main.ts`, the settings tab in `src/settings.ts` and the pure resolvers in
 * `src/export/signing-key.ts`. Only the Obsidian host is stubbed.
 *
 *   R3-01  `readInitMarker()` must decide *presence* by `hasOwnProperty`. A
 *          marker that exists but is not one of the three valid states answers
 *          `unknown` — it must never fall through to the legacy boolean and get
 *          downgraded to `uninitialized` → `first-init`.
 *   R3-04  `migrationFailed` must be cleared by the next successful write that
 *          really persisted the marker, and must survive a re-resolve.
 *   R3-05  `rawConfig` must be refreshed by every successful write, so
 *          `ensureSigningKey()` never re-runs a finished migration.
 *   R3-02  `outputFolder` must be written before it is committed in memory.
 *   R3-06  `unknown` must not claim "config missing" when the config exists.
 *   F-10   A key-shaped error must never reach a Notice or a console line.
 *
 * ---------------------------------------------------------------------------
 * TEST TIERS. Each block header states its tier; none of this is a real-host
 * acceptance.
 *
 *   T1  pure unit        — `readInitMarker` / `resolveKeyOnLoad` / `describeKey`
 *                          / `redactKeyMaterial` called directly (IM-01..03,
 *                          IM-06..08, UN-01..03, LK-04).
 *   T2  method-level     — real `HtmlExportPlugin` with a stubbed host:
 *                          `loadSettings`, `ensureSigningKey`, `saveSettings`,
 *                          `updateOutputFolder`, `rotateSigningKey`,
 *                          `getKeyStatusLine` really run (IM-04/05/09/10,
 *                          MF-xx, RC-xx, OF-01..05, LK-01/05).
 *   T3  settings-UI sim  — `HtmlExportSettingTab.display()` + real button/text
 *                          handlers against a minimal DOM double (OF-06,
 *                          LK-02/03).
 *   T4  export pipeline  — NOT TESTED in this file; the export chain is covered
 *                          by run-round2a2-2-review-3.mjs (EX-01/02) and by the
 *                          real-Edge capture/layout suites.
 *   T5  real Obsidian    — NOT TESTED (needs a running app; see the report).
 *
 * MOCK BOUNDARY: `obsidian` (Plugin, App, Notice, Setting, PluginSettingTab) is
 * stubbed and `saveData` is an in-memory JSON file. Production source is bundled
 * unchanged. "PASS" here means the plugin's own logic behaves — it is not an
 * Obsidian acceptance.
 *
 * SCENARIO FIDELITY: the fake `saveData` stores `JSON.parse(JSON.stringify(p))`,
 * i.e. exactly what Obsidian's JSON writer persists (members whose value is
 * `undefined` disappear). That is what makes the `rawConfig` shape testable.
 *
 * Run:  node tests/unit/run-round3-review-fix.mjs
 *       AB_ROOT=<dir> node tests/unit/run-round3-review-fix.mjs   # 反向对照
 */
import { build } from 'esbuild'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { installDomGlobals } from './dom-double.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = process.env.AB_ROOT
	? path.resolve(process.env.AB_ROOT)
	: path.resolve(here, '../..')
const out = path.join(here, '.out-round3-review-fix')

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

installDomGlobals()
const pendingTimers = []
globalThis.window = {
	// The settings tab arms a 6 s "confirmation expired" timer. It is recorded
	// but never fired, so a run is deterministic and the process can exit.
	setTimeout: (fn, ms) => {
		pendingTimers.push({ fn, ms })
		return pendingTimers.length
	},
	clearTimeout: () => {},
	requestAnimationFrame: fn => setTimeout(() => fn(Date.now()), 0),
	cancelAnimationFrame: id => clearTimeout(id),
	getComputedStyle: () => ({ getPropertyValue: () => '', width: '900px', height: '700px' })
}
globalThis.requestAnimationFrame = globalThis.window.requestAnimationFrame
globalThis.cancelAnimationFrame = globalThis.window.cancelAnimationFrame
globalThis.getComputedStyle = globalThis.window.getComputedStyle
globalThis.document = {
	styleSheets: [],
	documentElement: { attributes: [], dataset: {}, className: '', getAttribute: () => null },
	body: { className: '' },
	querySelector: () => null,
	querySelectorAll: () => [],
	createElement: () => ({ style: {}, appendChild() {}, setAttribute() {} })
}

const { default: HtmlExportPlugin } = await bundle('src/main.ts', 'main')
const { HtmlExportSettingTab, RECOMMENDED_FOLDER } = await bundle('src/settings.ts', 'settings')
const signing = await bundle('src/export/signing-key.ts', 'signing-key')
const {
	readInitMarker,
	readConfigMarker,
	resolveKeyOnLoad,
	describeKey,
	redactKeyMaterial,
	extractKeyDiagnostics
} = signing
const obsidianStub = await import(
	pathToFileURL(path.join(out, 'node_modules', 'obsidian', 'index.mjs')).href
)
const Notice = obsidianStub.Notice

/* ----------------------------------------------------------- fixtures -- */
const TEST_KEY = '9f'.repeat(32)
const OTHER_KEY = 'a1'.repeat(32)
const NEW_KEY_RE = /^[0-9a-f]{64}$/i
const FOLDER = 'html-export'
const sleep = ms => new Promise(r => setTimeout(r, ms))

/** A config that is fully initialised — the "happy" baseline. */
const inited = (extra = {}) => ({
	outputFolder: FOLDER,
	signingKey: TEST_KEY,
	signingKeyInitialized: true,
	signingKeyInitState: 'initialized',
	...extra
})

/* --------------------------------------------------- plugin mock factory -- */
/**
 * A real `HtmlExportPlugin` backed by a **real filesystem** (F-01 §2.4).
 *
 * The host is stubbed, but `data.json` is a real file in a throw-away temp
 * vault: `adapter.exists()` / `adapter.read()` / `adapter.write()` hit `node:fs`
 * and the file's SHA-256 is therefore a genuine "did the bytes change?" check.
 * Simulating "no file" by passing `null` to `loadData` would reproduce exactly
 * the defect F-01 is about — the two cases would be indistinguishable again.
 *
 * `savePlan(i, payload)` decides what the i-th `saveData` call does:
 *   null            → write + resolve
 *   { throw: msg }  → reject (simulated write failure)
 *   { delay: ms }   → wait, then write
 *
 * `calls` records every attempt (including rejected ones) and `writes` only the
 * ones that landed, so a test can assert both "how many times did it even try"
 * and "what is actually on disk".
 *
 * Options:
 *   data   — value written as JSON to `data.json` (omit/`null` = no file)
 *   raw    — exact bytes written to `data.json` (wins over `data`)
 *   dir    — reuse an existing temp vault (simulated restart)
 *   fault  — 'exists-throw' | 'read-throw' force the adapter to fail
 */
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hep-r3-fix-'))
process.on('exit', () => {
	try {
		fs.rmSync(TMP_ROOT, { recursive: true, force: true })
	} catch {
		/* best effort */
	}
})
let vaultCounter = 0
/** Vault-relative path Obsidian would use for this plugin's config. */
const CONFIG_DIR = '.obsidian/plugins/test'
const CONFIG_REL = `${CONFIG_DIR}/data.json`

function makePlugin({ data = null, raw, savePlan = null, dir = null, fault = null } = {}) {
	const vaultDir = dir ?? path.join(TMP_ROOT, `vault-${++vaultCounter}`)
	fs.mkdirSync(path.join(vaultDir, CONFIG_DIR), { recursive: true })
	const abs = rel => path.join(vaultDir, String(rel).replace(/^\/+/, ''))
	const configAbs = abs(CONFIG_REL)
	if (dir == null) {
		if (raw !== undefined) fs.writeFileSync(configAbs, raw, 'utf8')
		else if (data != null) fs.writeFileSync(configAbs, JSON.stringify(data), 'utf8')
	}
	const writes = []
	const calls = []
	let attempt = 0

	const adapter = {
		getBasePath: () => vaultDir,
		async exists(rel) {
			if (fault === 'exists-throw') throw new Error('EACCES: exists failed')
			return fs.existsSync(abs(rel))
		},
		async read(rel) {
			if (fault === 'read-throw') throw new Error('EIO: read failed')
			return fs.readFileSync(abs(rel), 'utf8')
		},
		async write(rel, text) {
			fs.writeFileSync(abs(rel), text, 'utf8')
		},
		async remove(rel) {
			fs.rmSync(abs(rel), { force: true })
		}
	}
	const app = {
		workspace: {
			getLeavesOfType: () => [],
			getRightLeaf: () => null,
			getLeaf: () => ({ setViewState: async () => {} }),
			revealLeaf: () => {}
		},
		vault: { adapter, configDir: '.obsidian' }
	}
	const plugin = new HtmlExportPlugin(app, {
		id: 'test',
		name: 'test',
		version: '1.0.0',
		dir: CONFIG_DIR
	})
	// Faithful `loadData()`: Obsidian returns `null` for a missing file and for
	// unparsable JSON, which is precisely why the plugin cannot use it to decide
	// whether the file exists.
	plugin.loadData = async () => {
		try {
			if (!fs.existsSync(configAbs)) return null
			return JSON.parse(fs.readFileSync(configAbs, 'utf8'))
		} catch {
			return null
		}
	}
	plugin.saveData = async payload => {
		// Snapshot at ENTRY, serialised the way Obsidian serialises: a stale or
		// partly-undefined payload is then observable exactly as it would be.
		const snapshot = JSON.parse(JSON.stringify(payload))
		const i = attempt++
		const plan = savePlan ? savePlan(i, payload) : null
		calls.push({ i, fail: !!(plan && plan.throw) })
		if (plan && plan.delay) await sleep(plan.delay)
		if (plan && plan.throw) {
			// Allow a real Error (e.g. one carrying a Node `code`) to be thrown so
			// diagnostics tests can exercise code extraction, not just a message.
			throw plan.throw instanceof Error ? plan.throw : new Error(plan.throw)
		}
		fs.writeFileSync(configAbs, JSON.stringify(snapshot, null, '\t'), 'utf8')
		writes.push({
			i,
			key: snapshot.signingKey,
			marker: snapshot.signingKeyInitState,
			legacy: snapshot.signingKeyInitialized,
			folder: snapshot.outputFolder
		})
	}
	const readStored = () => {
		try {
			return JSON.parse(fs.readFileSync(configAbs, 'utf8'))
		} catch {
			return null
		}
	}
	return {
		plugin,
		app,
		dir: vaultDir,
		configPath: configAbs,
		writes,
		calls,
		/** Raw bytes on disk (may be invalid JSON — that is the point). */
		readRaw: () => (fs.existsSync(configAbs) ? fs.readFileSync(configAbs, 'utf8') : null),
		/** SHA-256 of the real file, or `null` when there is no file. */
		sha256: () => {
			if (!fs.existsSync(configAbs)) return null
			return crypto.createHash('sha256').update(fs.readFileSync(configAbs)).digest('hex')
		},
		/** Overwrite the real file with arbitrary bytes (fixture setup). */
		writeRaw: text => fs.writeFileSync(configAbs, text, 'utf8'),
		/** Delete the real file (fixture setup). */
		removeFile: () => fs.rmSync(configAbs, { force: true }),
		getStored: readStored,
		/** Simulated restart: a fresh instance reading the same real file. */
		restart: (extra = {}) => makePlugin({ dir: vaultDir, savePlan, fault, ...extra })
	}
}

/* -------------------------------------------------------------- runner -- */
let pass = 0
let fail = 0
let skipped = 0
const results = []
function record(id, name, ok, detail = '', tier = 'T2') {
	results.push({ id, name, tier, verdict: ok ? 'PASS' : 'FAIL', detail })
	if (ok) pass++
	else fail++
	process.stdout.write(
		`  ${ok ? 'PASS' : 'FAIL'}  ${id}  ${name}${detail ? '  — ' + detail : ''}\n`
	)
}
function notTested(id, name, why, tier = 'T4') {
	results.push({ id, name, tier, verdict: 'NOT TESTED', detail: why })
	skipped++
	process.stdout.write(`  NOT TESTED  ${id}  ${name}  — ${why}\n`)
}
/** Capture console.* so a test can prove no key material is logged. */
const realLog = console.log.bind(console)
function captureConsole() {
	const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info }
	const lines = []
	for (const k of Object.keys(orig)) {
		console[k] = (...args) => lines.push(args.map(a => String(a)).join(' '))
	}
	return {
		lines,
		text: () => lines.join('\n'),
		restore: () => {
			for (const k of Object.keys(orig)) console[k] = orig[k]
		}
	}
}
/** Does `text` contain the key, or any fragment long enough to matter? */
function leaksKey(text, key = TEST_KEY) {
	if (text.includes(key)) return true
	for (const n of [32, 24, 16]) {
		for (let i = 0; i + n <= key.length; i += 8) {
			if (text.includes(key.slice(i, i + n))) return true
		}
	}
	return false
}

/* ==================================================================== */
console.log('\n=== IM · 非法初始化标记必须 fail-closed（R3-01）· T1 + T2 ===')

// IM-01  new field absent + legacy true → the legacy value is the only evidence
{
	const marker = readInitMarker({ signingKey: TEST_KEY, signingKeyInitialized: true })
	const r = resolveKeyOnLoad(TEST_KEY, { initState: marker, configPresent: true })
	record(
		'IM-01',
		'新字段不存在 + 旧字段 true → initialized（兼容读取旧版布尔）',
		marker === 'initialized' && r.state === 'ready' && r.migration === 'none',
		`marker=${marker} state=${r.state}`,
		'T1'
	)
}
// IM-02  new field absent + legacy false → unknown, NOT first-init
//        Round 4 (F-07 #1) changed this contract on purpose: `false` is what
//        DEFAULT_SETTINGS contains, so a bare legacy `false` cannot prove the
//        vault was never initialised. The old expectation (`uninitialized` →
//        `first-init`) was the defect this round fixes; the assertion below is
//        *stronger*, not weaker — it pins the state, the reason and the
//        "not first-init" property.
{
	const marker = readInitMarker({ signingKey: '', signingKeyInitialized: false })
	const r = resolveKeyOnLoad('', { initState: marker, configPresent: true })
	record(
		'IM-02',
		'新字段不存在 + 旧字段 false → unknown（不当作首次初始化）',
		marker === 'unknown' &&
			r.state === 'unknown' &&
			r.state !== 'first-init',
		`marker=${marker} state=${r.state} migration=${r.migration}`,
		'T1'
	)
}
// IM-03  valid `unknown` + legacy false → unknown wins (no downgrade)
{
	const marker = readInitMarker({
		signingKey: '',
		signingKeyInitState: 'unknown',
		signingKeyInitialized: false
	})
	const r = resolveKeyOnLoad('', { initState: marker, configPresent: true })
	record(
		'IM-03',
		'新字段为合法 unknown + 旧字段 false → unknown（不被旧字段拉回 first-init）',
		marker === 'unknown' && r.state === 'unknown',
		`marker=${marker} state=${r.state}`,
		'T1'
	)
}
// IM-04  invalid string + legacy TRUE → unknown, NOT `lost`
//        (before the fix this fell through to the boolean and said "lost")
{
	const data = {
		outputFolder: FOLDER,
		signingKey: '',
		signingKeyInitState: 'invalid',
		signingKeyInitialized: true
	}
	const { plugin, calls } = makePlugin({ data })
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	record(
		'IM-04',
		'新字段为非法字符串 + 旧字段 true → unknown（不回退为 lost，也不写盘）',
		readInitMarker(data) === 'unknown' &&
			plugin.keyState === 'unknown' &&
			plugin.settings.signingKeyInitState === 'unknown' &&
			calls.length === 0,
		`state=${plugin.keyState} writes=${calls.length}`
	)
}
// IM-05  invalid string + legacy FALSE → unknown, NOT `first-init` (the bug)
{
	const data = {
		outputFolder: FOLDER,
		signingKey: '',
		signingKeyInitState: 'invalid',
		signingKeyInitialized: false
	}
	const { plugin } = makePlugin({ data })
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	record(
		'IM-05',
		'新字段为非法字符串 + 旧字段 false → unknown（修复前会降级为 first-init）',
		plugin.keyState === 'unknown' && plugin.keyState !== 'first-init',
		`state=${plugin.keyState}`
	)
}
// IM-06  null + legacy false
{
	const marker = readInitMarker({
		signingKey: '',
		signingKeyInitState: null,
		signingKeyInitialized: false
	})
	const r = resolveKeyOnLoad('', { initState: marker, configPresent: true })
	record(
		'IM-06',
		'新字段为 null + 旧字段 false → unknown',
		marker === 'unknown' && r.state === 'unknown',
		`marker=${marker} state=${r.state}`,
		'T1'
	)
}
// IM-07  number + legacy false
{
	const marker = readInitMarker({
		signingKey: '',
		signingKeyInitState: 1,
		signingKeyInitialized: false
	})
	const r = resolveKeyOnLoad('', { initState: marker, configPresent: true })
	record(
		'IM-07',
		'新字段为数字（1）+ 旧字段 false → unknown',
		marker === 'unknown' && r.state === 'unknown',
		`marker=${marker} state=${r.state}`,
		'T1'
	)
}
// IM-08  empty string + legacy false
{
	const marker = readInitMarker({
		signingKey: '',
		signingKeyInitState: '',
		signingKeyInitialized: false
	})
	const r = resolveKeyOnLoad('', { initState: marker, configPresent: true })
	record(
		'IM-08',
		'新字段为空字符串 + 旧字段 false → unknown',
		marker === 'unknown' && r.state === 'unknown',
		`marker=${marker} state=${r.state}`,
		'T1'
	)
}
// IM-09  invalid marker + empty key → unknown state, strict confirm, no write
{
	const data = {
		outputFolder: FOLDER,
		signingKey: '',
		signingKeyInitState: 'bogus',
		signingKeyInitialized: false
	}
	const { plugin, calls } = makePlugin({ data })
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	const status = plugin.getKeyStatusLine()
	record(
		'IM-09',
		'非法标记 + 空密钥 → state=unknown，保留二次确认，且不生成密钥、不写盘',
		plugin.keyState === 'unknown' &&
			status.confirmTwice === true &&
			status.action === 'generate' &&
			plugin.settings.signingKey === '' &&
			calls.length === 0,
		`state=${plugin.keyState} confirmTwice=${status.confirmTwice} calls=${calls.length}`
	)
}
// IM-10  valid key + invalid marker → documented policy: the key wins and the
//        marker is migrated. This is the one case where `unknown` does NOT
//        survive, and it is deliberate: a valid key proves initialisation.
{
	const data = { outputFolder: FOLDER, signingKey: TEST_KEY, signingKeyInitState: 'bogus' }
	const { plugin, getStored } = makePlugin({ data })
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	const stored = getStored()
	record(
		'IM-10',
		'合法密钥 + 非法标记 → ready；密钥优先，标记迁移为 initialized（已记录的既定策略）',
		readInitMarker(data) === 'unknown' &&
			plugin.keyState === 'ready' &&
			plugin.settings.signingKey === TEST_KEY &&
			stored.signingKey === TEST_KEY &&
			stored.signingKeyInitState === 'initialized',
		`state=${plugin.keyState} marker=${stored.signingKeyInitState} keyKept=${stored.signingKey === TEST_KEY}`
	)
}

/* ==================================================================== */
console.log('\n=== MF · migrationFailed 状态恢复（R3-04）· T2 ===')

// MF-01  first migration succeeds
{
	const { plugin, getStored } = makePlugin({ data: { outputFolder: FOLDER, signingKey: TEST_KEY } })
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	record(
		'MF-01',
		'首次迁移成功 → initStatePersisted=true，migrationFailed=false，标记已落盘',
		plugin.migrationFailed === false &&
			plugin.initStatePersisted === true &&
			getStored().signingKeyInitState === 'initialized',
		`migFailed=${plugin.migrationFailed} marker=${getStored().signingKeyInitState}`
	)
}
// MF-02  first migration fails
{
	const { plugin } = makePlugin({
		data: { outputFolder: FOLDER, signingKey: TEST_KEY },
		savePlan: () => ({ throw: 'EACCES' })
	})
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	record(
		'MF-02',
		'首次迁移失败 → migrationFailed=true，initStatePersisted=false，状态行标注迁移失败',
		plugin.migrationFailed === true &&
			plugin.initStatePersisted === false &&
			plugin.getKeyStatusLine().detail.includes('迁移失败'),
		`migFailed=${plugin.migrationFailed} detailHas=迁移失败`
	)
}
// MF-03  after a failed migration, an ordinary save succeeds → the failure is
//        resolved (before the fix it stayed `true` forever)
{
	const { plugin, getStored } = makePlugin({
		data: { outputFolder: FOLDER, signingKey: TEST_KEY },
		savePlan: i => (i === 0 ? { throw: 'EACCES' } : null)
	})
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	const wasFailed = plugin.migrationFailed
	await plugin.saveSettings()
	record(
		'MF-03',
		'迁移失败后普通设置保存成功 → migrationFailed 清零、标记落盘、状态行不再报迁移失败',
		wasFailed === true &&
			plugin.migrationFailed === false &&
			plugin.initStatePersisted === true &&
			getStored().signingKeyInitState === 'initialized' &&
			!plugin.getKeyStatusLine().detail.includes('迁移失败'),
		`before=${wasFailed} after=${plugin.migrationFailed} marker=${getStored().signingKeyInitState}`
	)
}
// MF-04  after a failed migration, a key rotation succeeds → also resolved
{
	const { plugin, getStored } = makePlugin({
		data: { outputFolder: FOLDER, signingKey: TEST_KEY },
		savePlan: i => (i === 0 ? { throw: 'EACCES' } : null)
	})
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	const result = await plugin.rotateSigningKey()
	const stored = getStored()
	record(
		'MF-04',
		'迁移失败后密钥轮换成功 → migrationFailed 清零，新密钥与 initialized 标记同时落盘',
		result.changed === true &&
			plugin.migrationFailed === false &&
			plugin.initStatePersisted === true &&
			stored.signingKey === plugin.settings.signingKey &&
			stored.signingKey !== TEST_KEY &&
			stored.signingKeyInitState === 'initialized',
		`changed=${result.changed} migFailed=${plugin.migrationFailed} keyIsNew=${stored.signingKey !== TEST_KEY}`
	)
}
// MF-05  after a failed migration, the next save fails too → still a failure
{
	const { plugin, getStored } = makePlugin({
		data: { outputFolder: FOLDER, signingKey: TEST_KEY },
		savePlan: () => ({ throw: 'EACCES' })
	})
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	const before = JSON.stringify(getStored())
	let rejected = false
	try {
		await plugin.saveSettings()
	} catch {
		rejected = true
	}
	record(
		'MF-05',
		'迁移失败后普通保存再次失败 → migrationFailed 保持 true，不假装完成，磁盘不变',
		rejected &&
			plugin.migrationFailed === true &&
			plugin.initStatePersisted === false &&
			JSON.stringify(getStored()) === before,
		`rejected=${rejected} migFailed=${plugin.migrationFailed} diskUnchanged=${JSON.stringify(getStored()) === before}`
	)
}

/* ==================================================================== */
console.log('\n=== RC · rawConfig 不得过期（R3-05）· T2 ===')

// RC-01  a successful migration refreshes rawConfig
{
	const { plugin } = makePlugin({ data: { outputFolder: FOLDER, signingKey: TEST_KEY } })
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	record(
		'RC-01',
		'迁移成功后 rawConfig 立即反映已落盘的标记（不再停留在旧快照）',
		readInitMarker(plugin.rawConfig) === 'initialized' && plugin.configPresent === true,
		`rawMarker=${readInitMarker(plugin.rawConfig)}`
	)
}
// RC-02  a failed migration must NOT advance rawConfig
{
	const original = { outputFolder: FOLDER, signingKey: TEST_KEY }
	const { plugin } = makePlugin({ data: original, savePlan: () => ({ throw: 'EACCES' }) })
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	record(
		'RC-02',
		'迁移写盘失败 → rawConfig 保持原样（不提前更新）',
		// Round 4: the shape-level assertion replaces `readInitMarker() === undefined`,
		// which stopped being meaningful once a marker-less config reads as
		// `unknown`. What matters is that the snapshot still has NO marker field —
		// that is strictly stronger than "the derived marker is undefined".
		!Object.prototype.hasOwnProperty.call(plugin.rawConfig, 'signingKeyInitState') &&
			!Object.prototype.hasOwnProperty.call(plugin.rawConfig, 'signingKeyInitialized') &&
			JSON.stringify(plugin.rawConfig) === JSON.stringify(original),
		`rawMarker=${readInitMarker(plugin.rawConfig)}`
	)
}
// RC-03  a successful folder write refreshes rawConfig
{
	const { plugin } = makePlugin({ data: inited() })
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	await plugin.updateOutputFolder('brand-new-folder')
	record(
		'RC-03',
		'updateOutputFolder 成功后 rawConfig.outputFolder 同步为新目录',
		plugin.rawConfig &&
			plugin.rawConfig.outputFolder === 'brand-new-folder' &&
			plugin.rawConfig.signingKeyInitState === 'initialized',
		`rawFolder=${plugin.rawConfig && plugin.rawConfig.outputFolder}`
	)
}
// RC-04  the full §5 scenario: legacy → migration fails → ordinary save ok →
//        rotation fails → ensureSigningKey must not migrate again
{
	const { plugin, getStored, calls, writes } = makePlugin({
		data: { outputFolder: FOLDER, signingKey: TEST_KEY },
		// 0 = load-time migration (fails), 1 = ordinary save (ok), 2 = rotation (fails)
		savePlan: i => (i === 0 ? { throw: 'EACCES' } : i === 2 ? { throw: 'EROFS' } : null)
	})
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	const afterMigration = plugin.migrationFailed
	await plugin.saveSettings()
	await plugin.rotateSigningKey()
	const callsBefore = calls.length
	await plugin.ensureSigningKey() // re-resolve, as the failure path does
	const stored = getStored()
	record(
		'RC-04',
		'旧配置迁移失败 → 普通保存成功 → 轮换失败 → 再次 ensureSigningKey：不重复迁移、不再写盘、密钥不变',
		afterMigration === true &&
			calls.length === callsBefore &&
			plugin.migrationFailed === false &&
			plugin.keyState === 'ready' &&
			plugin.settings.signingKey === TEST_KEY &&
			stored.signingKey === TEST_KEY &&
			stored.signingKeyInitState === 'initialized' &&
			writes.every(w => w.key === TEST_KEY),
		`extraCalls=${calls.length - callsBefore} migFailed=${plugin.migrationFailed} keyKept=${stored.signingKey === TEST_KEY}`
	)
}
// RC-05  a failed write must not advance rawConfig (folder)
{
	const original = inited()
	const { plugin } = makePlugin({ data: original, savePlan: () => ({ throw: 'EACCES' }) })
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	let rejected = false
	try {
		await plugin.updateOutputFolder('nope-folder')
	} catch {
		rejected = true
	}
	record(
		'RC-05',
		'目录写盘失败 → rawConfig.outputFolder 仍是旧值（失败不更新 rawConfig）',
		rejected && plugin.rawConfig.outputFolder === FOLDER,
		`rejected=${rejected} rawFolder=${plugin.rawConfig.outputFolder}`
	)
}
// RC-06  no config at all → unknown; a successful save records it, and a
//        restart still reads `unknown` (F-09 + R3-05 together)
{
	const { plugin, getStored, restart } = makePlugin({ data: null })
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	const before = plugin.keyState
	await plugin.saveSettings()
	const after = getStored()
	const next = restart()
	await next.plugin.loadSettings()
	await next.plugin.ensureSigningKey()
	record(
		'RC-06',
		'配置文件缺失 → unknown；保存后 rawConfig/configPresent 更新，重启仍为 unknown',
		before === 'unknown' &&
			plugin.configPresent === true &&
			after.signingKeyInitState === 'unknown' &&
			next.plugin.keyState === 'unknown',
		`before=${before} afterRestart=${next.plugin.keyState} marker=${after.signingKeyInitState}`
	)
}

/* ==================================================================== */
console.log('\n=== OF · 导出目录事务式更新（R3-02）· T2 + T3 ===')

// OF-01  success → memory and disk agree
{
	const { plugin, getStored, writes } = makePlugin({ data: inited() })
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	await plugin.updateOutputFolder('  new-folder  ')
	record(
		'OF-01',
		'普通保存成功 → 内存与磁盘都是新目录（输入已 trim）',
		plugin.settings.outputFolder === 'new-folder' &&
			getStored().outputFolder === 'new-folder' &&
			writes.length === 1,
		`mem=${plugin.settings.outputFolder} disk=${getStored().outputFolder}`
	)
}
// OF-02  failure → neither side moved (the old flow moved memory first)
{
	const { plugin, getStored } = makePlugin({ data: inited(), savePlan: () => ({ throw: 'EACCES' }) })
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	let rejected = false
	try {
		await plugin.updateOutputFolder('new-folder')
	} catch {
		rejected = true
	}
	record(
		'OF-02',
		'普通保存失败 → 内存与磁盘都保持旧目录（修复前内存会提前改成新值）',
		rejected &&
			plugin.settings.outputFolder === FOLDER &&
			getStored().outputFolder === FOLDER,
		`rejected=${rejected} mem=${plugin.settings.outputFolder}`
	)
}
// OF-03  two updates: first fails, second succeeds → second wins, no rollback
{
	const { plugin, getStored } = makePlugin({
		data: inited(),
		savePlan: i => (i === 0 ? { throw: 'EACCES' } : null)
	})
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	const first = plugin.updateOutputFolder('first').catch(() => 'failed')
	await sleep(5)
	const second = plugin.updateOutputFolder('second')
	await Promise.all([first, second])
	record(
		'OF-03',
		'连续两次更新（第一次失败、第二次成功）→ 最终为新值，旧回调不回滚新值',
		plugin.settings.outputFolder === 'second' && getStored().outputFolder === 'second',
		`mem=${plugin.settings.outputFolder} disk=${getStored().outputFolder}`
	)
}
// OF-04  two updates, both fail → nothing moved
{
	const { plugin, getStored } = makePlugin({ data: inited(), savePlan: () => ({ throw: 'EACCES' }) })
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	const a = plugin.updateOutputFolder('a').catch(() => 'failed')
	await sleep(5)
	const b = plugin.updateOutputFolder('b').catch(() => 'failed')
	await Promise.all([a, b])
	record(
		'OF-04',
		'连续两次更新均失败 → 内存与磁盘都保持原值',
		plugin.settings.outputFolder === FOLDER && getStored().outputFolder === FOLDER,
		`mem=${plugin.settings.outputFolder} disk=${getStored().outputFolder}`
	)
}
// OF-05  rotation during a delayed folder save → both land, neither is lost
{
	const { plugin, getStored } = makePlugin({
		data: inited(),
		savePlan: i => (i === 0 ? { delay: 40 } : null)
	})
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	const folder = plugin.updateOutputFolder('race-folder')
	await sleep(5)
	const rot = plugin.rotateSigningKey()
	await Promise.all([folder, rot])
	const stored = getStored()
	record(
		'OF-05',
		'保存期间发起密钥轮换 → 磁盘同时具备新目录与新密钥（串行，无覆盖）',
		stored.outputFolder === 'race-folder' &&
			stored.signingKey === plugin.settings.signingKey &&
			stored.signingKey !== TEST_KEY &&
			plugin.settings.outputFolder === 'race-folder',
		`folder=${stored.outputFolder} keyIsNew=${stored.signingKey !== TEST_KEY}`
	)
}
// OF-06  T3: the settings text field must go through the same transaction —
//        a failed write leaves the export-facing value untouched
{
	Notice.all.length = 0
	const { plugin, app, getStored } = makePlugin({
		data: inited(),
		savePlan: () => ({ throw: 'EACCES' })
	})
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	const tab = new HtmlExportSettingTab(app, plugin)
	tab.display()
	const folderSetting = tab.containerEl.__settings[0]
	const text = folderSetting.texts[0]
	await text.change('typed-but-not-saved')
	const notices = Notice.all.map(n => n.message)
	record(
		'OF-06',
		'设置页输入目录但写盘失败 → 内存/磁盘仍是旧目录，导出读取值为已确认配置，并给出失败提示',
		plugin.settings.outputFolder === FOLDER &&
			getStored().outputFolder === FOLDER &&
			notices.some(m => m.includes('设置保存失败') && m.includes('仍沿用')),
		`mem=${plugin.settings.outputFolder} notice=${notices.length > 0}`
	)
}

/* ==================================================================== */
console.log('\n=== UN · unknown 提示必须与真实配置状态一致（R3-06）· T1 ===')

// UN-01  explicit `unknown` marker + config present → "config recorded" wording
{
	const status = describeKey('', {
		initState: 'unknown',
		configPresent: true,
		unknownReason: 'marker-explicit-unknown'
	})
	record(
		'UN-01',
		'配置存在 + 显式 unknown 标记 → 标签说「配置已记录」，不谎称配置文件缺失',
		status.label.includes('配置已记录') &&
			!status.label.includes('配置文件缺失') &&
			status.detail.includes('配置已明确记录'),
		`label=${status.label}`,
		'T1'
	)
}
// UN-02  config absent → the "missing" wording is correct and still used
{
	const status = describeKey('', {
		initState: 'unknown',
		configPresent: false,
		unknownReason: 'config-missing'
	})
	record(
		'UN-02',
		'配置缺失 → 标签说「配置文件缺失」',
		status.label.includes('配置文件缺失') &&
			status.detail.includes('配置文件缺失'),
		`label=${status.label}`,
		'T1'
	)
}
// UN-03  the resolver's own message follows the same rule via `unknownReason`
{
	const present = resolveKeyOnLoad('', {
		initState: 'unknown',
		configShapeValid: true,
		unknownReason: 'marker-explicit-unknown'
	})
	const absent = resolveKeyOnLoad('', {
		initState: undefined,
		configShapeValid: true,
		configPresent: false,
		unknownReason: 'config-missing'
	})
	record(
		'UN-03',
		'resolveKeyOnLoad 的 message 同样按 unknownReason 区分原因',
		present.message.includes('配置已明确记录') &&
			!present.message.includes('配置文件缺失') &&
			absent.message.includes('配置文件缺失'),
		`present=${present.message.slice(0, 24)}…`,
		'T1'
	)
}
// UN-04  the generic state label is shared, and strict confirmation is intact
{
	const markerMissing = describeKey('', {
		initState: 'unknown',
		configPresent: true,
		unknownReason: 'marker-missing'
	})
	const withMigration = describeKey('', {
		initState: 'unknown',
		configPresent: true,
		unknownReason: 'marker-missing',
		migrationFailed: true
	})
	record(
		'UN-04',
		'unknown 仍是「无法确认密钥历史状态」，保留二次确认；migrationFailed 才追加迁移提示',
		markerMissing.label.startsWith('无法确认密钥历史状态') &&
			markerMissing.confirmTwice === true &&
			!markerMissing.detail.includes('迁移失败') &&
			withMigration.detail.includes('迁移失败'),
		`confirmTwice=${markerMissing.confirmTwice}`
	)
}

/* ==================================================================== */
console.log('\n=== LK · 密钥材料不得进入 Notice / 日志（F-10）· T1 + T2 + T3 ===')

// LK-01  a failing rotation whose exception embeds the key: the user sees a
//        fixed line, and the log line is redacted
{
	Notice.all.length = 0
	const cap = captureConsole()
	let sawNotice = []
	try {
		const { plugin, app } = makePlugin({
			data: inited(),
			savePlan: () => ({ throw: `Internal error: ${TEST_KEY}` })
		})
		await plugin.loadSettings()
		await plugin.ensureSigningKey()
		const tab = new HtmlExportSettingTab(app, plugin)
		tab.display()
		const keySetting = tab.containerEl.__settings.find(s => s.buttons.length > 0)
		const button = keySetting.buttons[0]
		await button.click() // arms the confirmation
		await button.click() // performs the rotation
		sawNotice = Notice.all.map(n => n.message)
	} finally {
		cap.restore()
		const logged = cap.text()
		const noticesOk =
			sawNotice.length > 0 &&
			sawNotice.every(m => !leaksKey(m)) &&
			sawNotice.some(m => m.includes('密钥未变更') || m.includes('密钥操作失败')) &&
			!sawNotice.some(m => m.includes('✅'))
		const logOk = !leaksKey(logged)
		realLog(
			`  ${noticesOk && logOk ? 'PASS' : 'FAIL'}  LK-01  轮换失败且异常里带密钥 → Notice 与日志都不含密钥，且不显示成功` +
				`  — notices=${sawNotice.length} noticeLeak=${!noticesOk} logLeak=${!logOk}`
		)
		results.push({
			id: 'LK-01',
			name: '轮换失败且异常里带密钥 → Notice 与日志都不含密钥，且不显示成功',
			tier: 'T3',
			verdict: noticesOk && logOk ? 'PASS' : 'FAIL',
			detail: `notices=${sawNotice.length}`
		})
		if (noticesOk && logOk) pass++
		else fail++
	}
}
// LK-02  a failing folder save whose exception embeds the key
{
	Notice.all.length = 0
	const { plugin, app } = makePlugin({
		data: inited(),
		savePlan: () => ({ throw: `Internal error: ${TEST_KEY}` })
	})
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	const tab = new HtmlExportSettingTab(app, plugin)
	tab.display()
	const text = tab.containerEl.__settings[0].texts[0]
	await text.change('another-folder')
	const notices = Notice.all.map(n => n.message)
	record(
		'LK-02',
		'目录保存失败且异常里带密钥 → 提示保留诊断信息但已脱敏，不含密钥',
		notices.length > 0 &&
			notices.every(m => !leaksKey(m)) &&
			notices.some(m => m.includes('设置保存失败')),
		`notices=${notices.length} leak=${notices.some(m => leaksKey(m))}`,
		'T3'
	)
}
// LK-03  success and failure notices stay mutually exclusive
{
	Notice.all.length = 0
	const ok = makePlugin({ data: inited() })
	await ok.plugin.loadSettings()
	await ok.plugin.ensureSigningKey()
	const okTab = new HtmlExportSettingTab(ok.app, ok.plugin)
	okTab.display()
	const okButton = okTab.containerEl.__settings.find(s => s.buttons.length > 0).buttons[0]
	await okButton.click()
	await okButton.click()
	const success = Notice.all.map(n => n.message)

	Notice.all.length = 0
	const bad = makePlugin({ data: inited(), savePlan: () => ({ throw: 'EACCES' }) })
	await bad.plugin.loadSettings()
	await bad.plugin.ensureSigningKey()
	const badTab = new HtmlExportSettingTab(bad.app, bad.plugin)
	badTab.display()
	const badButton = badTab.containerEl.__settings.find(s => s.buttons.length > 0).buttons[0]
	await badButton.click()
	await badButton.click()
	const failure = Notice.all.map(n => n.message)

	record(
		'LK-03',
		'成功与失败提示互斥：成功含 ✅ 且不含「未变更」，失败含「未变更」且不含 ✅',
		success.some(m => m.includes('✅') && !m.includes('未变更')) &&
			failure.some(m => m.includes('密钥未变更') && !m.includes('✅')),
		`success=${success.length} failure=${failure.length}`,
		'T3'
	)
}
// LK-04  the redactor itself
{
	const full = `boom ${TEST_KEY} tail`
	const frag32 = `boom ${TEST_KEY.slice(0, 32)} tail`
	const frag16 = `boom ${TEST_KEY.slice(0, 16)} tail`
	const shortHex = 'code deadbeef restart'
	const rFull = redactKeyMaterial(full)
	const r32 = redactKeyMaterial(frag32)
	const r16 = redactKeyMaterial(frag16)
	record(
		'LK-04',
		'redactKeyMaterial：整key / 32位片段 / 16位片段都被隐去，短的十六进制串保留',
		!rFull.includes(TEST_KEY) &&
			rFull.includes('boom') &&
			rFull.includes('tail') &&
			!r32.includes(TEST_KEY.slice(0, 32)) &&
			!r16.includes(TEST_KEY.slice(0, 16)) &&
			redactKeyMaterial(shortHex) === shortHex &&
			redactKeyMaterial(null) === '',
		`out=${rFull}`,
		'T1'
	)
}
// LK-05  a migration failure whose exception embeds the key must not log it
{
	Notice.all.length = 0
	const cap = captureConsole()
	let logged = ''
	let failed = false
	try {
		const { plugin } = makePlugin({
			data: { outputFolder: FOLDER, signingKey: TEST_KEY },
			savePlan: () => ({ throw: `Internal error: ${TEST_KEY}` })
		})
		await plugin.loadSettings()
		await plugin.ensureSigningKey()
		failed = plugin.migrationFailed
	} finally {
		cap.restore()
		logged = cap.text()
		const ok = failed && !leaksKey(logged) && logged.includes('迁移失败')
		realLog(
			`  ${ok ? 'PASS' : 'FAIL'}  LK-05  迁移失败且异常里带密钥 → 日志已脱敏，仍保留故障信息` +
				`  — migFailed=${failed} leak=${leaksKey(logged)}`
		)
		results.push({
			id: 'LK-05',
			name: '迁移失败且异常里带密钥 → 日志已脱敏，仍保留故障信息',
			tier: 'T2',
			verdict: ok ? 'PASS' : 'FAIL',
			detail: `migFailed=${failed}`
		})
		if (ok) pass++
		else fail++
	}
}

// LK-06  the defensive catch in the settings tab: the rotation method itself
//        rejects with an exception that embeds the key. MOCKED METHOD — the
//        real `rotateSigningKey` swallows write errors and returns a fixed
//        message, so this branch only exists for unexpected internal faults.
//        It is the one place where raw exception text could reach the user.
{
	Notice.all.length = 0
	const cap = captureConsole()
	let notices = []
	try {
		const { plugin, app } = makePlugin({ data: inited() })
		await plugin.loadSettings()
		await plugin.ensureSigningKey()
		// MOCKED: bypass the real rotation to simulate an unexpected throw.
		plugin.rotateSigningKey = async () => {
			throw new Error(`Internal error: ${TEST_KEY}`)
		}
		const tab = new HtmlExportSettingTab(app, plugin)
		tab.display()
		const button = tab.containerEl.__settings.find(s => s.buttons.length > 0).buttons[0]
		await button.click()
		await button.click()
		notices = Notice.all.map(n => n.message)
	} finally {
		cap.restore()
		const logged = cap.text()
		const ok =
			notices.length > 0 &&
			notices.every(m => !leaksKey(m)) &&
			notices.some(m => m.includes('密钥操作失败') && m.includes('密钥未变更')) &&
			!notices.some(m => m.includes('✅')) &&
			!leaksKey(logged) &&
			logged.includes('已脱敏')
		realLog(
			`  ${ok ? 'PASS' : 'FAIL'}  LK-06  轮换方法抛出含密钥异常（方法打桩）→ 提示为固定文案，密钥既不进 Notice 也不进日志` +
				`  — notices=${notices.length} leak=${notices.some(m => leaksKey(m))} logLeak=${leaksKey(logged)}`
		)
		results.push({
			id: 'LK-06',
			name: '轮换方法抛出含密钥异常（方法打桩）→ 提示为固定文案，密钥既不进 Notice 也不进日志',
			tier: 'T3',
			verdict: ok ? 'PASS' : 'FAIL',
			detail: `notices=${notices.length}`
		})
		if (ok) pass++
		else fail++
	}
}

/* ==================================================================== */
console.log('\n=== SR · 配置根结构异常须 fail-closed（R3.1-01）· T1 + T2 ===')

// SR-01..SR-07  readConfigMarker 对每个异常根结构的判定（T1）
{
	const cases = [
		['字符串根', 'corrupted', false, false, 'config-shape-invalid'],
		['false 根', false, false, false, 'config-shape-invalid'],
		['数字根 0', 0, false, false, 'config-shape-invalid'],
		['数组根', ['unexpected'], false, false, 'config-shape-invalid'],
		['null 根', null, false, false, undefined],
		['空对象', {}, true, false, 'marker-missing'],
		['合法缺新标记(无布尔)', { signingKey: '' }, true, false, 'marker-missing']
	]
	let allOk = true
	let bad = ''
	for (const [name, raw, shapeValid, fieldValid, reason] of cases) {
		const r = readConfigMarker(raw)
		const ok =
			r.shapeValid === shapeValid &&
			r.fieldValid === fieldValid &&
			r.unknownReason === reason &&
			// 非正常根：marker 必须是 undefined（绝不能当 first-init 的 marker 读）
			(shapeValid || r.marker === undefined)
		if (!ok) {
			allOk = false
			bad += ` ${name}:${JSON.stringify(r)}`
		}
	}
	record('SR-01..07', 'readConfigMarker：异常根结构 shapeValid=false 且不产生可用 marker', allOk, bad.slice(0, 120), 'T1')
}

// SR-08  结构异常配置 → ensureSigningKey 绝不能自动生成密钥，必须 unknown
for (const [name, data] of [
	['字符串根', 'corrupted'],
	['数组根', ['unexpected']],
	['false 根', false]
]) {
	const { plugin } = makePlugin({ data })
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	record(
		'SR-08/' + name,
		`结构异常配置(${name}) → 加载后状态 unknown，密钥仍为空（无自动生成）`,
		plugin.keyState === 'unknown' &&
			plugin.settings.signingKey === '' &&
			plugin.configShapeValid === false &&
			plugin.markerReading.shapeValid === false,
		`state=${plugin.keyState} key=${plugin.settings.signingKey || '∅'} shapeValid=${plugin.configShapeValid}`
	)
}

// SR-09  结构异常配置 → 普通 saveSettings 必须拒绝，且不覆盖原文件
{
	const { plugin, writes, getStored } = makePlugin({ data: 'corrupted' })
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	const writesBefore = writes.length
	let rejected = false
	try {
		await plugin.saveSettings()
	} catch (e) {
		rejected = e instanceof Error && e.message.includes('CONFIG_SHAPE_INVALID')
	}
	record(
		'SR-09',
		'结构异常配置 → 普通 saveSettings 被拒绝，saveData 未写盘，原文件保持原样',
		rejected &&
			writes.length === writesBefore &&
			getStored() === 'corrupted' &&
			plugin.configShapeValid === false,
		`rejected=${rejected} writesΔ=${writes.length - writesBefore} stored=${JSON.stringify(getStored()).slice(0, 20)}`
	)
}

// SR-10  结构异常配置 → 更新目录同样被拒绝（事务式路径也受同一闸门保护）
{
	const { plugin, writes, getStored } = makePlugin({ data: false })
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	const writesBefore = writes.length
	let rejected = false
	try {
		await plugin.updateOutputFolder('some-folder')
	} catch (e) {
		rejected = e instanceof Error && e.message.includes('CONFIG_SHAPE_INVALID')
	}
	record(
		'SR-10',
		'结构异常配置 → updateOutputFolder 被拒绝，原始配置未被覆盖',
		rejected &&
			writes.length === writesBefore &&
			getStored() === false,
		`rejected=${rejected} writesΔ=${writes.length - writesBefore}`
	)
}

// SR-11  结构异常配置 → 显式「重新生成」（用户二次确认）仍被允许作为恢复路径，
//        且不会在加载时静默生成密钥。这里验证：加载阶段确实没生成（SR-08 已覆盖），
//        显式轮换会写入一把干净的合法密钥并让配置恢复为合法根结构。
{
	const { plugin } = makePlugin({ data: 'corrupted' })
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	const released = await plugin.rotateSigningKey()
	record(
		'SR-11',
		'结构异常配置 + 显式轮换 → 写入合法密钥并修复根结构（非自动、非静默）',
		released.changed === true &&
			NEW_KEY_RE.test(plugin.settings.signingKey) &&
			plugin.configShapeValid === true,
		`changed=${released.changed} key=${plugin.settings.signingKey.slice(0, 8)}… shapeValid=${plugin.configShapeValid}`
	)
}

/* ==================================================================== */
console.log('\n=== UR · UnknownReason 原因模型（R3.1-02）· T1 + T2 ===')

// UR-01  config missing → reason=config-missing，标签说「配置文件缺失」
{
	const status = describeKey('', {
		initState: 'unknown',
		configPresent: false,
		unknownReason: 'config-missing'
	})
	record(
		'UR-01',
		'配置缺失 → 标签「配置文件缺失」，detail 说明缺失',
		status.label.includes('配置文件缺失') && status.detail.includes('配置文件缺失'),
		`label=${status.label}`
	)
}
// UR-02  合法对象缺新标记（无布尔）→ reason=marker-missing
{
	const status = describeKey('', {
		initState: 'unknown',
		configPresent: true,
		unknownReason: 'marker-missing'
	})
	record(
		'UR-02',
		'缺新标记 → 标签「缺少初始化标记」',
		status.label.includes('缺少初始化标记'),
		`label=${status.label}`
	)
}
// UR-03  非法 marker → reason=marker-invalid，resolveKeyOnLoad 解析为 unknown
{
	const r = resolveKeyOnLoad('', {
		initState: 'unknown',
		configShapeValid: true,
		unknownReason: 'marker-invalid'
	})
	record(
		'UR-03',
		'非法 marker → resolveKeyOnLoad 解析为 unknown，原因 marker-invalid',
		r.state === 'unknown' && r.unknownReason === 'marker-invalid',
		`state=${r.state} reason=${r.unknownReason}`
	)
}
// UR-04  合法 explicit unknown → 标签「配置已记录」，绝不谎称缺失
{
	const status = describeKey('', {
		initState: 'unknown',
		configPresent: true,
		unknownReason: 'marker-explicit-unknown'
	})
	record(
		'UR-04',
		'显式 unknown 标记 → 标签「配置已记录」，不含「配置文件缺失」',
		status.label.includes('配置已记录') && !status.label.includes('配置文件缺失'),
		`label=${status.label}`
	)
}
// UR-05  合法 marker（initialized）→ 不是 unknown，无 unknownReason
{
	const r = resolveKeyOnLoad(TEST_KEY, { initState: 'initialized', configPresent: true })
	record('UR-05', '合法 initialized 标记 → ready，unknownReason 为 undefined', r.state === 'ready' && r.unknownReason === undefined, `state=${r.state}`)
}
// UR-06  结构异常根 → resolveKeyOnLoad 返回 unknown，原因 config-shape-invalid
{
	const r = resolveKeyOnLoad('', { initState: undefined, configShapeValid: false, unknownReason: 'config-shape-invalid' })
	record(
		'UR-06',
		'结构异常根 → unknown，原因 config-shape-invalid（而非 first-init）',
		r.state === 'unknown' && r.unknownReason === 'config-shape-invalid',
		`state=${r.state} reason=${r.unknownReason}`
	)
}
// UR-07  合法密钥 + 非法标记 → ready，并迁移标记（Round 3.1 IM-10 策略保留）
{
	const data = { signingKey: TEST_KEY, signingKeyInitState: 'invalid', signingKeyInitialized: false }
	const { plugin } = makePlugin({ data })
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	record(
		'UR-07',
		'合法密钥 + 非法标记 → ready，密钥不变，标记待迁移',
		plugin.keyState === 'ready' &&
			plugin.settings.signingKey === TEST_KEY &&
			plugin.settings.signingKeyInitState === 'initialized',
		`state=${plugin.keyState} key=${plugin.settings.signingKey.slice(0, 8)}… marker=${plugin.settings.signingKeyInitState}`
	)
}
// UR-08  explicit unknown → 保存后重启仍为 unknown（F-09 + R3.1-02）
{
	const data = { signingKey: '', signingKeyInitState: 'unknown', signingKeyInitialized: false }
	const { plugin, getStored, restart } = makePlugin({ data })
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	const before = plugin.keyState
	await plugin.saveSettings()
	const after = getStored()
	const next = restart()
	await next.plugin.loadSettings()
	await next.plugin.ensureSigningKey()
	record(
		'UR-08',
		'显式 unknown → 保存后 rawConfig/configPresent 更新，重启仍为 unknown',
		before === 'unknown' &&
			plugin.configPresent === true &&
			after.signingKeyInitState === 'unknown' &&
			next.plugin.keyState === 'unknown' &&
			next.plugin.markerReading.unknownReason === 'marker-explicit-unknown',
		`before=${before} after=${after.signingKeyInitState} restart=${next.plugin.keyState}`
	)
}
// UR-09  unknown（由非法 marker 归一化）保存失败后重试 → 重试成功后真正持久化，重启仍为 unknown
{
	const data = { signingKey: '', signingKeyInitState: 'invalid', signingKeyInitialized: false }
	const { plugin, getStored, restart } = makePlugin({
		data,
		savePlan: i => (i === 0 ? { throw: 'EACCES' } : null)
	})
	await plugin.loadSettings()
	await plugin.ensureSigningKey() // 归一化为 unknown，无迁移（marker 已存在）
	const persistedBefore = plugin.initStatePersisted
	// 第一次保存写盘失败（被捕获）
	let rejected = false
	try {
		await plugin.saveSettings()
	} catch {
		rejected = true
	}
	const storedAfterFail = getStored()
	// 重试保存成功
	await plugin.saveSettings()
	const storedAfterOk = getStored()
	const next = restart()
	await next.plugin.loadSettings()
	await next.plugin.ensureSigningKey()
	record(
		'UR-09',
		'非法 marker 归一化 unknown → 保存失败被捕获且磁盘不变，重试成功落盘 unknown，重启仍为 unknown',
		persistedBefore === false &&
			rejected === true &&
			JSON.stringify(storedAfterFail) === JSON.stringify(data) &&
			storedAfterOk.signingKeyInitState === 'unknown' &&
			plugin.initStatePersisted === true &&
			next.plugin.keyState === 'unknown',
		`persisted0=${persistedBefore} rejected=${rejected} afterOk=${storedAfterOk.signingKeyInitState} restart=${next.plugin.keyState}`
	)
}
// UR-10  非法 marker 被归一化为 unknown 时，绝不能误判为「已持久化」
{
	const data = { signingKey: '', signingKeyInitState: 'invalid', signingKeyInitialized: false }
	const { plugin } = makePlugin({ data })
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	record(
		'UR-10',
		'非法 marker 归一化 unknown → initStatePersisted 必须为 false（字段本身非法）',
		plugin.initStatePersisted === false &&
			plugin.markerReading.fieldValid === false &&
			plugin.keyState === 'unknown',
		`persisted=${plugin.initStatePersisted} fieldValid=${plugin.markerReading.fieldValid}`
	)
}

/* ==================================================================== */
console.log('\n=== RD · 密钥轮换失败须保留真实诊断（R3.1-03）· T1 + T2 + T3 ===')

// RD-01  EACCES：日志含 code=EACCES 与可诊断原因，绝不含密钥；旧密钥不变、磁盘不变
{
	Notice.all.length = 0
	const cap = captureConsole()
	const { plugin, getStored } = makePlugin({
		data: inited(),
		savePlan: () => ({ throw: Object.assign(new Error(`EACCES: failed to save ${TEST_KEY}`), { code: 'EACCES' }) })
	})
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	let result
	try {
		result = await plugin.rotateSigningKey()
	} finally {
		cap.restore()
	}
	const logged = cap.text()
	record(
		'RD-01',
		'EACCES 失败 → 日志含 code=EACCES 且脱敏（无密钥），旧密钥与磁盘不变，不生成第二把密钥',
		result.changed === false &&
			plugin.settings.signingKey === TEST_KEY &&
			getStored().signingKey === TEST_KEY &&
			logged.includes('code=EACCES') &&
			!leaksKey(logged) &&
			logged.includes('持久化写入失败'),
		`changed=${result.changed} key=${plugin.settings.signingKey.slice(0, 8)}… leak=${leaksKey(logged)}`
	)
}
// RD-02  ENOSPC：同一诊断契约
{
	Notice.all.length = 0
	const cap = captureConsole()
	const { plugin, getStored } = makePlugin({
		data: inited(),
		savePlan: () => ({ throw: Object.assign(new Error(`ENOSPC: no space left on device, key=${TEST_KEY}`), { code: 'ENOSPC' }) })
	})
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	let result
	try {
		result = await plugin.rotateSigningKey()
	} finally {
		cap.restore()
	}
	const logged = cap.text()
	record(
		'RD-02',
		'ENOSPC 失败 → 日志含 code=ENOSPC 且脱敏（无密钥），旧密钥不变',
		result.changed === false &&
			plugin.settings.signingKey === TEST_KEY &&
			logged.includes('code=ENOSPC') &&
			!leaksKey(logged),
		`changed=${result.changed} leak=${leaksKey(logged)}`
	)
}
// RD-03  普通 Error，message 含密钥 → 日志脱敏，且结果仍失败
{
	Notice.all.length = 0
	const cap = captureConsole()
	const { plugin, getStored } = makePlugin({
		data: inited(),
		savePlan: () => ({ throw: `boom ${TEST_KEY} tail` })
	})
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	let result
	try {
		result = await plugin.rotateSigningKey()
	} finally {
		cap.restore()
	}
	const logged = cap.text()
	record(
		'RD-03',
		'普通 Error（message 含密钥）→ 日志已脱敏，无密钥片段，结果失败',
		result.changed === false &&
			!leaksKey(logged) &&
			plugin.settings.signingKey === TEST_KEY &&
			getStored().signingKey === TEST_KEY,
		`changed=${result.changed} leak=${leaksKey(logged)}`
	)
}
// RD-04  message 含多个密钥片段 → 全部被脱敏
{
	const cap = captureConsole()
	const { plugin } = makePlugin({
		data: inited(),
		savePlan: () => ({ throw: `a${TEST_KEY.slice(0, 32)}b${TEST_KEY.slice(32)}c` })
	})
	await plugin.loadSettings()
	await plugin.ensureSigningKey()
	try {
		await plugin.rotateSigningKey()
	} finally {
		cap.restore()
	}
	const logged = cap.text()
	record('RD-04', 'message 含多段密钥片段 → 日志全部脱敏', !leaksKey(logged), `leak=${leaksKey(logged)}`)
}
// RD-05  stack 含密钥 → 也被脱敏（T1，直接验证 extractKeyDiagnostics）
{
	const err = Object.assign(new Error('write failed'), {
		code: 'EACCES',
		stack: `Error: write failed\n    at Writer.save (/vault/${TEST_KEY}/out.js:10:5)`
	})
	const diag = extractKeyDiagnostics(err, [TEST_KEY])
	record(
		'RD-05',
		'stack 含密钥 → extractKeyDiagnostics 对 stack 也脱敏',
		diag.includes('code=EACCES') && !leaksKey(diag),
		`leak=${leaksKey(diag)}`
	)
}
// RD-06  knownSecrets 精确替换：密钥本身非纯 hex 也能被移除（T1）
{
	const secret = 'VAULT-SECRET-9f3c'
	const err = Object.assign(new Error(`denied ${secret} please retry`), { code: 'EACCES' })
	const diag = extractKeyDiagnostics(err, [secret])
	record(
		'RD-06',
		'extractKeyDiagnostics：精确替换已知密钥（非 hex 形式也可移除）',
		!diag.includes(secret) && diag.includes('code=EACCES') && diag.includes('denied'),
		`diag=${diag}`
	)
}
// RD-07  通过真实设置页按钮触发失败 → Notice 为固定文案，绝不含密钥（T3）
{
	Notice.all.length = 0
	const cap = captureConsole()
	let notices = []
	try {
		const { plugin, app } = makePlugin({
			data: inited(),
			savePlan: () => ({ throw: `EACCES: ${TEST_KEY}` })
		})
		await plugin.loadSettings()
		await plugin.ensureSigningKey()
		const tab = new HtmlExportSettingTab(app, plugin)
		tab.display()
		const button = tab.containerEl.__settings.find(s => s.buttons.length > 0).buttons[0]
		await button.click()
		await button.click()
		notices = Notice.all.map(n => n.message)
	} finally {
		cap.restore()
	}
	const logged = cap.text()
	const ok =
		notices.length > 0 &&
		notices.every(m => !leaksKey(m)) &&
		notices.some(m => m.includes('密钥未变更') || m.includes('密钥操作失败')) &&
		!notices.some(m => m.includes('✅')) &&
		!leaksKey(logged)
	record(
		'RD-07',
		'设置页按钮触发失败 → 固定失败提示（无密钥、无成功字样），日志同样脱敏',
		ok,
		`notices=${notices.length} leak=${notices.some(m => leaksKey(m))}`
	)
}

/* ==================================================================== */
notTested(
	'EX-NT',
	'导出管线 / 真实 Obsidian 宿主',
	'本轮未改动导出链路；管线覆盖见 run-round2a2-2-review-3.mjs（EX-01/02）与真实 Edge capture/layout 套件。真实宿主仍需运行中的 Obsidian',
	'T4/T5'
)

/* -------------------------------------------------------------- 汇总 -- */
const total = results.length
console.log('\n' + '─'.repeat(72))
console.log(`总计：${total} 例，PASS ${pass}，FAIL ${fail}，NOT TESTED ${skipped}`)
console.log('分层统计（T4/T5 未在本文件执行，见上）：')
for (const tier of ['T1', 'T2', 'T3']) {
	const list = results.filter(r => r.tier === tier)
	const ok = list.filter(r => r.verdict === 'PASS').length
	console.log(`  ${tier}  ${list.map(r => r.id).join(' / ')}  →  ${ok}/${list.length} PASS`)
}
if (fail > 0) {
	console.log('\nFAILED:')
	for (const r of results.filter(r => r.verdict === 'FAIL')) {
		console.log(`  ${r.id}  ${r.name}  — ${r.detail}`)
	}
	process.exitCode = 1
}
