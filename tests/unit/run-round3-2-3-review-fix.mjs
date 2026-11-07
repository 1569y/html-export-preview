#!/usr/bin/env node
/**
 * Round 3.2.3 — incremental fix suite.
 *
 * Scope: the two findings that cannot be checked from the previous suites —
 *
 *   F-01  a *valid* external rewrite of `data.json` was silently overwritten by
 *         the stale in-memory settings, because the pre-write re-check only asked
 *         "is the root an object?" and never "is it still the config we synced?".
 *         F01-16 … F01-22 cover the three real cases (clean memory, dirty memory,
 *         unchanged disk), the queue-timing case, and the fingerprint policy.
 *
 *   F-02  the last unsafe error-access idiom: `instanceof Error` followed by
 *         `.message`, and raw error objects handed to `console`. A `Proxy` can
 *         satisfy `instanceof` and then throw from the getter, so the handler
 *         that exists to *report* a failure becomes the failure. ES-12 … ES-20.
 *
 * Tiers
 * ---------------------------------------------------------------------------
 *   T1  pure function (no plugin, no filesystem)
 *   T2  real plugin instance + a real `data.json` in a real temp vault
 *   T4/T5  needs a running Obsidian — NOT TESTED, never counted as PASS
 *
 * The adapter below is a thin shim over `node:fs`; it is **not** Obsidian's
 * `FileSystemAdapter`. Every claim in this file is about plugin logic, never
 * about the real host (see the NOT TESTED entries at the end).
 *
 * Run:  node tests/unit/run-round3-2-3-review-fix.mjs
 *       AB_ROOT=<dir> node tests/unit/run-round3-2-3-review-fix.mjs   # reverse control
 *       AB_ROOT=<dir> AB_OUT=<tmpdir> node …                          # and write nothing to the tree
 */
import { build } from 'esbuild'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { installDomGlobals } from './dom-double.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = process.env.AB_ROOT ? path.resolve(process.env.AB_ROOT) : path.resolve(here, '../..')
const out = process.env.AB_OUT
	? path.resolve(process.env.AB_OUT)
	: path.join(here, '.out-round3-2-3')

/* ------------------------------------------------------------- bundling -- */
function prepareStub() {
	const dir = path.join(out, 'node_modules', 'obsidian')
	fs.mkdirSync(dir, { recursive: true })
	fs.writeFileSync(
		path.join(dir, 'index.mjs'),
		`class Node { constructor() { this.children = []; this.__settings = [] }
  empty() { this.children.length = 0; this.__settings = [] }
  _mk(tag) {
    return {
      tagName: String(tag).toUpperCase(), children: [], textContent: '', cls: '',
      classList: { add() {}, remove() {}, contains() { return false } },
      createDiv() { return this._mk('div') },
      createEl(t) { const c = { tagName: String(t).toUpperCase(), children: [], textContent: '', createDiv: () => ({}), createEl: () => ({}), setText(t) { this.textContent = String(t) } }; this.children.push(c); return c },
      appendChild(c) { this.children.push(c); return c },
      setText(t) { this.textContent = String(t) },
      addClass() {}, removeClass() {}, setAttribute() {}, getAttribute() { return null },
      querySelector() { return null }, querySelectorAll() { return [] }
    }
  }
  createDiv() { return this._mk('div') }
  createEl(t) { return this._mk(t) }
  createSpan() { return this._mk('span') }
}
export class TFile { constructor(p) { this.path = p; this.name = p.split('/').pop() ?? p } }
export class TFolder {}
export class TAbstractFile {}
export class App { constructor() { this.workspace = {}; this.vault = { adapter: { getBasePath: () => '/vault' } } } }
export class Plugin { constructor(app, manifest) { this.app = app; this.manifest = manifest; this.appId = manifest && manifest.id }
  async loadData() { return null }
  async saveData(_d) {}
  addRibbonIcon() {} addCommand() {} addSettingTab() {} registerView() {} registerEvent() {} }
export class PluginSettingTab { constructor(app, plugin) { this.app = app; this.plugin = plugin; this.containerEl = new Node() } display() {} }
export class Setting { constructor(c) { this.containerEl = c; this.buttons = []; this.texts = []; if (c) { c.__settings = c.__settings || []; c.__settings.push(this) } }
  setName() { return this } setDesc() { return this } setHeading() { return this }
  addText(cb) { const t = { value: '', setPlaceholder() { return this }, setValue(v) { this.value = v; return this }, onChange(h) { this.handler = h; return this }, change(v) { this.value = v; return this.handler ? this.handler(v) : undefined } }; this.texts.push(t); cb(t); return this }
  addButton(cb) { const b = { text: '', setButtonText(t) { this.text = t; return this }, setWarning() { return this }, setCta() { return this }, setDisabled() { return this }, setTooltip() { return this }, onClick(h) { this.handler = h; return this }, click() { return this.handler ? this.handler() : undefined } }; this.buttons.push(b); cb(b); return this }
  addToggle(cb) { cb({ setValue() { return this }, onChange() { return this } }); return this } }
export class ItemView { constructor(leaf) { this.leaf = leaf; this.app = { workspace: {} } } }
export class WorkspaceLeaf {}
export class MarkdownView {}
export class Notice { static all = []; constructor(m) { this.message = String(m ?? ''); Notice.all.push(this) } hide() {} setMessage(m) { this.message = String(m) } }
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
globalThis.window = {
	setTimeout: () => 0,
	clearTimeout: () => {},
	requestAnimationFrame: fn => setTimeout(() => fn(Date.now()), 0),
	cancelAnimationFrame: () => {},
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
const signing = await bundle('src/export/signing-key.ts', 'signing-key')
const { describeErrorSafely, extractKeyDiagnostics, safeErrorText } = signing
const obsidianStub = await import(
	pathToFileURL(path.join(out, 'node_modules', 'obsidian', 'index.mjs')).href
)
const Notice = obsidianStub.Notice

/* ----------------------------------------------------------- fixtures -- */
const TEST_KEY = '9f'.repeat(32)
const OTHER_KEY = 'a1'.repeat(32)
const FOLDER = 'html-export'
const SYNCED_FOLDER = 'synced-folder'
const CONFIG_DIR = '.obsidian/plugins/test'
const CONFIG_REL = `${CONFIG_DIR}/data.json`
const sleep = ms => new Promise(r => setTimeout(r, ms))
const PLACEHOLDER = '[无法读取异常信息]'

/* -------------------------------------------------------------- runner -- */
let pass = 0
let fail = 0
let skipped = 0
const results = []
function record(id, name, ok, detail = '', tier = 'T2') {
	results.push({ id, name, tier, verdict: ok ? 'PASS' : 'FAIL', detail })
	if (ok) pass++
	else fail++
	process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${id}  ${name}${detail ? '  — ' + detail : ''}\n`)
}
function notTested(id, name, why, tier = 'T4/T5') {
	results.push({ id, name, tier, verdict: 'NOT TESTED', detail: why })
	skipped++
	process.stdout.write(`  NOT TESTED  ${id}  ${name}  — ${why}\n`)
}

/**
 * Capture console calls **with their argument types**.
 *
 * `arrity` matters for ES-20: "the raw error object must not reach a log" can
 * only be proved by looking at what was actually passed, not at the rendered
 * text — `String(obj)` and `obj` can print the same thing.
 */
function captureConsoleTyped() {
	const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info }
	const entries = []
	for (const k of Object.keys(orig)) {
		console[k] = (...args) => entries.push({ level: k, args })
	}
	return {
		entries,
		text: () => entries.map(e => e.args.map(a => String(a)).join(' ')).join('\n'),
		nonStringArgs: () => entries.flatMap(e => e.args.filter(a => typeof a !== 'string')),
		restore: () => {
			for (const k of Object.keys(orig)) console[k] = orig[k]
		}
	}
}

/** Does `text` contain the key, or any fragment long enough to matter? */
function leaksKey(text, key = TEST_KEY) {
	const s = String(text ?? '')
	if (s.includes(key)) return true
	if (s.toLowerCase().includes(key.toLowerCase())) return true
	for (const n of [32, 24, 16]) {
		for (let i = 0; i + n <= key.length; i += 8) {
			if (s.includes(key.slice(i, i + n))) return true
		}
	}
	return false
}
async function rejectionOf(fn) {
	try {
		await fn()
		return null
	} catch (error) {
		const message = error instanceof Error ? error.message : safeErrorText(error)
		return String(message)
	}
}

/**
 * Call something that is *supposed* to never throw, and turn a throw into a
 * failed assertion instead of an aborted run.
 *
 * Without this, a regression in the safe conversion would kill the process
 * before the summary line was printed — the run would look like "no results"
 * rather than "this case failed", and the reverse control could no longer tell
 * a red assertion from a crashed suite.
 */
function safeCall(fn) {
	try {
		return { ok: true, value: fn(), error: null }
	} catch (error) {
		return { ok: false, value: null, error: safeErrorText(error) }
	}
}

/* ---------------------------------------------- real-filesystem harness -- */
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hep-r323-'))
process.on('exit', () => {
	try {
		fs.rmSync(TMP_ROOT, { recursive: true, force: true })
	} catch {
		/* best effort */
	}
})
let vaultCounter = 0

/**
 * Build a plugin whose `data.json` is a **real file** in a real temp vault.
 *
 * `raw` writes exact bytes, `data` writes a JSON document. `dir` reuses an
 * existing vault so a "restart" can be simulated without losing the file.
 */
function makePlugin({ raw, data, dir = null, manifestDir = CONFIG_DIR, configDir = '.obsidian' } = {}) {
	const vaultDir = dir ?? path.join(TMP_ROOT, `vault-${++vaultCounter}`)
	fs.mkdirSync(path.join(vaultDir, CONFIG_DIR), { recursive: true })
	const abs = rel => path.join(vaultDir, String(rel).replace(/^\/+/, ''))
	const configAbs = abs(CONFIG_REL)
	if (dir == null) {
		if (raw !== undefined) fs.writeFileSync(configAbs, raw, 'utf8')
		else if (data !== undefined) fs.writeFileSync(configAbs, JSON.stringify(data, null, '\t'), 'utf8')
	}
	const calls = []
	const writes = []
	const adapter = {
		getBasePath: () => vaultDir,
		async exists(rel) {
			return fs.existsSync(abs(rel))
		},
		async read(rel) {
			return fs.readFileSync(abs(rel), 'utf8')
		},
		async write(rel, text) {
			fs.writeFileSync(abs(rel), text, 'utf8')
		},
		async remove(rel) {
			fs.rmSync(abs(rel), { force: true })
		}
	}
	const vault = { adapter }
	if (configDir !== null) vault.configDir = configDir
	const app = {
		workspace: {
			getLeavesOfType: () => [],
			getRightLeaf: () => null,
			getLeaf: () => ({ setViewState: async () => {} }),
			revealLeaf: () => {}
		},
		vault
	}
	const manifest = { id: 'test', name: 'test', version: '1.0.0' }
	if (manifestDir !== null) manifest.dir = manifestDir
	const plugin = new HtmlExportPlugin(app, manifest)
	plugin.saveData = async payload => {
		const snapshot = JSON.parse(JSON.stringify(payload))
		calls.push({ i: calls.length })
		fs.writeFileSync(configAbs, JSON.stringify(snapshot, null, '\t'), 'utf8')
		writes.push({ i: writes.length, key: snapshot.signingKey, folder: snapshot.outputFolder })
	}
	const sha256 = () => {
		if (!fs.existsSync(configAbs)) return null
		return crypto.createHash('sha256').update(fs.readFileSync(configAbs)).digest('hex')
	}
	return {
		plugin,
		app,
		dir: vaultDir,
		configPath: configAbs,
		calls,
		writes,
		sha256,
		readRaw: () => (fs.existsSync(configAbs) ? fs.readFileSync(configAbs, 'utf8') : null),
		readJson: () => (fs.existsSync(configAbs) ? JSON.parse(fs.readFileSync(configAbs, 'utf8')) : null),
		writeRaw: text => fs.writeFileSync(configAbs, text, 'utf8'),
		removeFile: () => fs.rmSync(configAbs, { force: true })
	}
}
const inited = (extra = {}) => ({
	outputFolder: FOLDER,
	signingKey: TEST_KEY,
	signingKeyInitialized: true,
	signingKeyInitState: 'initialized',
	...extra
})
const synced = () => ({
	outputFolder: SYNCED_FOLDER,
	signingKey: OTHER_KEY,
	signingKeyInitialized: true,
	signingKeyInitState: 'initialized'
})

/** Load a config the way the plugin does on start-up, with no pending writes. */
async function booted(data = inited()) {
	const h = makePlugin({ data })
	await h.plugin.loadSettings()
	await h.plugin.ensureSigningKey()
	h.calls.length = 0
	h.writes.length = 0
	Notice.all.length = 0
	return h
}

console.log('Round 3.2.3 — 增量修复测试')
console.log(`  root = ${root}`)

/* ===================================================================== F-01 */
console.log('\nF-01 — 外部合法配置更新冲突保护')

/**
 * F01-16 — external valid rewrite, no host callback, ordinary save.
 *
 * The defect: the re-check saw "root is an object" and let the write through,
 * so the stale in-memory `html-export` / `TEST_KEY` replaced the synced values.
 * Required: the file is not touched, nothing is reported as saved, and memory
 * adopts what the disk actually says.
 */
{
	const h = await booted()
	h.writeRaw(JSON.stringify(synced(), null, '\t'))
	const before = h.sha256()
	const bytes = h.readRaw()
	const message = await rejectionOf(() => h.plugin.saveSettings())
	const after = h.sha256()
	const ok =
		message === null &&
		h.calls.length === 0 &&
		before === after &&
		h.readRaw() === bytes &&
		h.plugin.settings.outputFolder === SYNCED_FOLDER &&
		h.plugin.settings.signingKey === OTHER_KEY
	record(
		'F01-16',
		'合法外部修改后直接 saveSettings（不调用回调）→ 不覆盖外部修改，内存改为采用磁盘值',
		ok,
		`threw=${message !== null} saveDataCalls=${h.calls.length} shaUnchanged=${before === after} ` +
			`memFolder=${h.plugin.settings.outputFolder} memKeyAdopted=${h.plugin.settings.signingKey === OTHER_KEY}`
	)
}

/**
 * F01-17 — external rewrite, then an explicit folder edit.
 *
 * A folder edit is an intentional single-field change, so it must still be
 * written — but only after the rest of the external config has been adopted.
 * Overwriting `signingKey` back to the stale in-memory value is the failure.
 */
{
	const h = await booted()
	h.writeRaw(JSON.stringify(synced(), null, '\t'))
	const message = await rejectionOf(() => h.plugin.updateOutputFolder('new-folder'))
	const disk = h.readJson()
	const ok =
		message === null &&
		h.writes.length === 1 &&
		disk &&
		disk.outputFolder === 'new-folder' &&
		disk.signingKey === OTHER_KEY &&
		disk.signingKeyInitState === 'initialized'
	record(
		'F01-17',
		'合法外部修改后 updateOutputFolder → 写入新目录，但不覆盖外部其他字段',
		ok,
		`threw=${message !== null} writes=${h.writes.length} diskFolder=${disk?.outputFolder} ` +
			`diskKeyIsExternal=${disk?.signingKey === OTHER_KEY}`
	)
}

/**
 * F01-18 — external rewrite concurrent with the host callback and a save.
 *
 * The user has an unsaved local edit when the file changes underneath. Neither
 * side may be discarded: the external bytes stay on disk and the local edit
 * stays in memory. (Whether the save *succeeds* is not the point — losing
 * either half would be.)
 */
{
	const h = await booted()
	h.plugin.settings.outputFolder = 'local-edit'
	h.writeRaw(JSON.stringify(synced(), null, '\t'))
	const bytes = h.readRaw()
	const cb = h.plugin.onExternalSettingsChange()
	const sv = h.plugin.saveSettings().then(
		() => null,
		e => (e instanceof Error ? e.message : String(e))
	)
	const [cbErr, svErr] = await Promise.all([cb.then(() => null, e => String(e)), sv])
	const ok =
		h.calls.length === 0 &&
		h.readRaw() === bytes &&
		h.plugin.settings.outputFolder === 'local-edit' &&
		String(svErr ?? '').includes('CONFIG_CONFLICT') &&
		cbErr === null
	record(
		'F01-18',
		'外部修改与回调、普通保存并发 → 外部字节与本地修改都不丢失',
		ok,
		`saveDataCalls=${h.calls.length} diskKeptExternal=${h.readRaw() === bytes} ` +
			`localEditKept=${h.plugin.settings.outputFolder === 'local-edit'} saveErr=${String(svErr).split(':')[0]}`
	)
}

/**
 * F01-19 — both sides changed, sequential.
 *
 * Required: an explicit conflict, no write, no silent field-level merge.
 */
{
	const h = await booted()
	h.plugin.settings.outputFolder = 'local-edit'
	h.writeRaw(JSON.stringify(synced(), null, '\t'))
	const bytes = h.readRaw()
	const message = await rejectionOf(() => h.plugin.saveSettings())
	const ok =
		message !== null &&
		message.includes('CONFIG_CONFLICT') &&
		h.calls.length === 0 &&
		h.readRaw() === bytes &&
		h.plugin.settings.outputFolder === 'local-edit' &&
		!Notice.all.some(n => /完成|已保存|成功/.test(n.message))
	record(
		'F01-19',
		'本地已修改且磁盘也被外部修改 → 明确冲突，不静默合并',
		ok,
		`rejected=${message !== null} code=${(message ?? '').split(':')[0]} saveDataCalls=${h.calls.length} ` +
			`diskUnchanged=${h.readRaw() === bytes} notices=${Notice.all.length}`
	)
}

/**
 * F01-20 — the callback already adopted the external config; a later save must
 * persist the *new* values, not resurrect the old ones.
 *
 * The save is issued twice on purpose. A successful write has to re-baseline the
 * synchronisation snapshot; if it did not, the second save would compare the
 * file against the *pre-write* snapshot, conclude "the disk changed", and report
 * a conflict with the plugin's own write.
 */
{
	const h = await booted()
	h.writeRaw(JSON.stringify(synced(), null, '\t'))
	await h.plugin.onExternalSettingsChange()
	const adopted = h.plugin.settings.outputFolder === SYNCED_FOLDER
	const message = await rejectionOf(() => h.plugin.saveSettings())
	const message2 = await rejectionOf(() => h.plugin.saveSettings())
	const disk = h.readJson()
	const ok =
		message === null &&
		message2 === null &&
		adopted &&
		h.writes.length === 2 &&
		disk &&
		disk.outputFolder === SYNCED_FOLDER &&
		disk.signingKey === OTHER_KEY
	record(
		'F01-20',
		'外部合法修改已被回调同步 → 再次保存写入最新配置，且连续保存不会与自身冲突',
		ok,
		`adopted=${adopted} writes=${h.writes.length} secondErr=${String(message2).split(':')[0]} ` +
			`diskFolder=${disk?.outputFolder} diskKeyIsExternal=${disk?.signingKey === OTHER_KEY}`
	)
}

/**
 * F01-21 — the change lands *after* the task entered the queue but before it
 * runs. The probe inside the queue is what catches it.
 *
 * `enqueueWrite` schedules the task on a microtask, so a synchronous rewrite
 * immediately after the call is genuinely "queued but not yet executed".
 */
{
	const h = await booted()
	const pending = h.plugin.saveSettings()
	h.writeRaw(JSON.stringify(synced(), null, '\t'))
	const bytes = h.readRaw()
	const message = await rejectionOf(() => pending)
	const ok =
		message === null &&
		h.calls.length === 0 &&
		h.readRaw() === bytes &&
		h.plugin.settings.outputFolder === SYNCED_FOLDER
	record(
		'F01-21',
		'外部修改发生在进入队列之后、实际写入之前 → 写入前发现并采用',
		ok,
		`threw=${message !== null} saveDataCalls=${h.calls.length} diskUnchanged=${h.readRaw() === bytes} ` +
			`memFolder=${h.plugin.settings.outputFolder}`
	)
}

/**
 * F01-22 — formatting-only external change.
 *
 * Policy (documented in `stableJson`): the fingerprint is *semantic* — parsed
 * values with sorted keys — so re-indenting or reordering `data.json` is not a
 * conflict and does not block a save. Anything that changes a value is.
 */
{
	const h = await booted()
	// Same values, different key order, different indentation, CRLF-free.
	const reformatted = JSON.stringify(
		{
			signingKeyInitState: 'initialized',
			signingKeyInitialized: true,
			signingKey: TEST_KEY,
			outputFolder: FOLDER
		},
		null,
		2
	)
	// A *byte* change that is not a *semantic* change: keys reordered, indent 2.
	h.writeRaw(reformatted)
	const bytesBefore = h.readRaw()
	const message = await rejectionOf(() => h.plugin.saveSettings())
	const disk = h.readJson()
	const ok =
		message === null &&
		h.writes.length === 1 &&
		disk &&
		disk.outputFolder === FOLDER &&
		disk.signingKey === TEST_KEY &&
		bytesBefore === reformatted
	record(
		'F01-22',
		'外部只改变 JSON 格式、不改变语义 → 按语义指纹判定为「无变化」，正常写入',
		ok,
		`threw=${message !== null} writes=${h.writes.length} diskFolder=${disk?.outputFolder} ` +
			`semanticPreserved=${disk?.signingKey === TEST_KEY}`
	)
}

/* ===================================================================== F-02 */
console.log('\nF-02 — 统一安全异常转换')

/** F01/ES helper: a Proxy whose every trap throws. */
const hostileProxy = () =>
	new Proxy(
		{},
		{
			get() {
				throw new Error('trap get exploded')
			},
			getPrototypeOf() {
				throw new Error('trap getPrototypeOf exploded')
			},
			ownKeys() {
				throw new Error('trap ownKeys exploded')
			}
		}
	)

/**
 * F01-13 style guard: `instanceof Error` must not be trusted. This Proxy passes
 * `instanceof Error` (its prototype trap reports `Error.prototype`) while the
 * `message` getter it leads to throws — the exact idiom that used to crash.
 */
const errorProxyWithThrowingMessage = () => {
	const target = new Error('boom')
	return new Proxy(target, {
		get(t, p, r) {
			if (p === 'message') throw new Error('message getter exploded')
			return Reflect.get(t, p, r)
		},
		getPrototypeOf() {
			return Error.prototype
		}
	})
}

{
	const proxy = errorProxyWithThrowingMessage()
	const passesInstanceof = (() => {
		try {
			return proxy instanceof Error
		} catch {
			return false
		}
	})()
	const call = safeCall(() => describeErrorSafely(proxy, [TEST_KEY]))
	const ok =
		passesInstanceof === true &&
		call.ok &&
		typeof call.value === 'string' &&
		call.value.length > 0 &&
		!leaksKey(call.value) &&
		call.value === PLACEHOLDER
	record(
		'ES-12',
		'Proxy 的 get trap 抛错 → 不向外抛出，返回固定占位且无密钥',
		ok,
		`instanceofError=${passesInstanceof} threw=${!call.ok} text=${call.value ?? call.error}`
	)
}

{
	// ES-13 is the regression that motivated the round: `instanceof` says yes,
	// the getter says no. The old idiom dereferenced `.message` right after.
	const proxy = errorProxyWithThrowingMessage()
	let threw = false
	let text = ''
	try {
		text = describeErrorSafely(proxy, [TEST_KEY])
	} catch {
		threw = true
	}
	const ok = !threw && typeof text === 'string' && text.length > 0 && !leaksKey(text)
	record('ES-13', 'Error Proxy 的 message getter 抛错 → 不崩、不泄露密钥', ok, `threw=${threw} text=${text}`)
}

{
	const target = new Error('stack boom')
	const proxy = new Proxy(target, {
		get(t, p, r) {
			if (p === 'stack') throw new Error('stack getter exploded')
			return Reflect.get(t, p, r)
		}
	})
	let threw = false
	let diag = ''
	try {
		diag = extractKeyDiagnostics(proxy, [TEST_KEY])
	} catch {
		threw = true
	}
	const ok =
		!threw && typeof diag === 'string' && diag.includes('message=') && !leaksKey(diag)
	record('ES-14', 'Error Proxy 的 stack getter 抛错 → 诊断不崩，message 仍脱敏输出', ok, `threw=${threw} diag=${diag}`)
}

{
	const hostile = {
		toString() {
			throw new Error('toString exploded')
		}
	}
	let threw = false
	let text = ''
	try {
		text = describeErrorSafely(hostile, [TEST_KEY])
	} catch {
		threw = true
	}
	const ok = !threw && text === PLACEHOLDER
	record('ES-15', 'toString 抛错 → 固定占位，不向外抛出', ok, `threw=${threw} text=${text}`)
}

{
	const hostile = {
		[Symbol.toPrimitive]() {
			throw new Error('toPrimitive exploded')
		}
	}
	let threw = false
	let text = ''
	try {
		text = describeErrorSafely(hostile, [TEST_KEY])
	} catch {
		threw = true
	}
	const ok = !threw && text === PLACEHOLDER
	record('ES-16', 'Symbol.toPrimitive 抛错 → 固定占位，不向外抛出', ok, `threw=${threw} text=${text}`)
}

{
	const call = safeCall(() => describeErrorSafely(new Error('EACCES: write failed'), [TEST_KEY]))
	const ok = call.ok && call.value === 'EACCES: write failed'
	record('ES-17', '正常 Error → 原样给出可诊断的 message', ok, `threw=${!call.ok} text=${call.value ?? call.error}`)
}

{
	const call = safeCall(() =>
		describeErrorSafely(new Error(`save failed for key ${TEST_KEY}`), [TEST_KEY])
	)
	const ok = call.ok && !leaksKey(call.value) && String(call.value).includes('[密钥已隐去]')
	record('ES-18', '包含真实密钥的错误字符串 → 仍然脱敏', ok, `threw=${!call.ok} text=${call.value ?? call.error}`)
}

/**
 * ES-19 — the *main-program* failure path, not the helper in isolation.
 *
 * `reportFailure` is reached for any non-Capture/Export error. It must survive
 * a Proxy whose `getPrototypeOf` trap makes even `instanceof` throw.
 */
{
	const h = await booted()
	const cap = captureConsoleTyped()
	let threw = false
	try {
		h.plugin.reportFailure(hostileProxy())
	} catch {
		threw = true
	}
	const text = cap.text()
	cap.restore()
	const notices = Notice.all.map(n => n.message).join('\n')
	const ok =
		!threw &&
		Notice.all.length === 1 &&
		notices.includes('HTML 导出失败') &&
		!leaksKey(notices) &&
		!leaksKey(text)
	record(
		'ES-19',
		'main.ts 普通错误处理路径遇异常 Proxy → 不向外抛出、Notice 无密钥',
		ok,
		`threw=${threw} notices=${Notice.all.length} noticeHasKey=${leaksKey(notices)} logHasKey=${leaksKey(text)}`
	)
}

/**
 * ES-20 — nothing but strings may reach the console, and no key may be in it.
 *
 * `console.error('...', error)` prints whatever the object exposes. Passing the
 * raw value is therefore both a leak channel and a crash channel (the console
 * itself inspects the object).
 */
{
	const h = await booted()
	const cap = captureConsoleTyped()
	let threw = false
	try {
		h.plugin.reportFailure(new Error(`export blew up with ${TEST_KEY}`))
	} catch {
		threw = true
	}
	const nonString = cap.nonStringArgs().length
	const text = cap.text()
	cap.restore()
	const notices = Notice.all.map(n => n.message).join('\n')
	const ok =
		!threw &&
		nonString === 0 &&
		cap.entries.length > 0 &&
		!leaksKey(text) &&
		!leaksKey(notices)
	record(
		'ES-20',
		'console 日志只接收字符串参数，且不含原始密钥',
		ok,
		`threw=${threw} logCalls=${cap.entries.length} nonStringArgs=${nonString} logHasKey=${leaksKey(text)}`
	)
}

/* ------------------------------------------------------------ not tested -- */
notTested(
	'EX-NT-4',
	'真实 Obsidian 宿主在同步客户端写入后调用 onExternalSettingsChange 的时延',
	'需要运行中的 Obsidian（≥1.5.7）。本套件直接调用该钩子，只能证明行为正确，不能证明宿主何时调用它'
)
notTested(
	'EX-NT-5',
	'写前探测与 saveData 之间被外部写入抢占（TOCTOU 窗口）',
	'adapter 无原子 compare-and-swap；Node fs 适配器无法在单进程内稳定复现该竞态'
)

/* ------------------------------------------------------------------ end -- */
const total = results.length
console.log('\n' + '─'.repeat(72))
console.log(`总计：${total} 例，PASS ${pass}，FAIL ${fail}，NOT TESTED ${skipped}`)
for (const tier of ['T1', 'T2']) {
	const list = results.filter(r => r.tier === tier)
	if (list.length === 0) continue
	const ok = list.filter(r => r.verdict === 'PASS').length
	console.log(`  ${tier}  ${list.map(r => r.id).join(' / ')}  →  ${ok}/${list.length} PASS`)
}
if (fail > 0) {
	console.log('\nFAILED:')
	for (const r of results.filter(r => r.verdict === 'FAIL')) {
		console.log(`  ${r.id}  ${r.name}  —  ${r.detail}`)
	}
	process.exitCode = 1
}
