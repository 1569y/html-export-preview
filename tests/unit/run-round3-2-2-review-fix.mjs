/**
 * Round 3.2.2 — Review Findings Fix (F-01 / F-02)
 *
 *   F-01  A `data.json` edited outside Obsidian was invisible to the plugin: the
 *         write guards consulted the state cached by `loadSettings()`, so an
 *         ordinary save could overwrite a file that had since become `null`,
 *         unparsable, an array, unreadable — or had been deleted entirely.
 *         Fixed by (a) implementing the real host hook
 *         `onExternalSettingsChange()`, (b) re-probing the file *inside* the
 *         write queue right before every ordinary write, and (c) remembering
 *         that a file has been seen, so a later deletion is not read as a
 *         first install.
 *
 *   F-02  `String(error)` was called unprotected. An exception whose
 *         `toString` / `Symbol.toPrimitive` throws — or a `Proxy` whose `get`
 *         trap throws — made `extractKeyDiagnostics()` throw *while reporting a
 *         failure*, which in `rotateKey` would have skipped the "nothing was
 *         adopted, the old key stays" path.
 *
 * ---------------------------------------------------------------------------
 * MOCK BOUNDARY — read this before quoting any result
 *
 * Only the Obsidian *classes* are stubbed. `HtmlExportPlugin`,
 * `HtmlExportSettingTab` and the resolvers are the bundled production sources,
 * unmodified. The vault adapter is a **thin Node-`fs` shim** over a throw-away
 * temp directory: real bytes, real `JSON.parse`, real SHA-256.
 *
 * This is NOT a real-Obsidian-host test. It cannot prove that the app *calls*
 * `onExternalSettingsChange()` at the right moment, nor what `manifest.dir`
 * really contains — see the NOT TESTED entry at the bottom.
 *
 * TIERS
 *   T1  pure unit     — `extractKeyDiagnostics` / `redactKeyMaterial` called
 *                       directly (ES-xx)
 *   T2  method-level  — real plugin against a real temp file (F01-xx, ES-10)
 *   T3  settings-UI   — not executed here (covered by run-round3-review-fix.mjs)
 *   T4/T5             — NOT TESTED (needs a running Obsidian)
 *
 * Run:  node tests/unit/run-round3-2-2-review-fix.mjs
 *       AB_ROOT=<dir> node tests/unit/run-round3-2-2-review-fix.mjs   # 反向对照
 *       AB_ROOT=<dir> AB_OUT=<tmpdir> node …                          # 且不写项目树
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
	: path.join(here, '.out-round3-2-2')

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
const { extractKeyDiagnostics, redactKeyMaterial, safeErrorText } = signing
const obsidianStub = await import(
	pathToFileURL(path.join(out, 'node_modules', 'obsidian', 'index.mjs')).href
)
const Notice = obsidianStub.Notice

/* ----------------------------------------------------------- fixtures -- */
const TEST_KEY = '9f'.repeat(32)
const OTHER_KEY = 'a1'.repeat(32)
const FOLDER = 'html-export'
const CONFIG_DIR = '.obsidian/plugins/test'
const CONFIG_REL = `${CONFIG_DIR}/data.json`
const sleep = ms => new Promise(r => setTimeout(r, ms))

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
async function rejects(fn) {
	try {
		await fn()
		return false
	} catch {
		return true
	}
}
async function rejectionOf(fn) {
	try {
		await fn()
		return null
	} catch (error) {
		return error instanceof Error ? error.message : String(error)
	}
}

/* ---------------------------------------------- real-filesystem harness -- */
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hep-r322-'))
process.on('exit', () => {
	try {
		fs.rmSync(TMP_ROOT, { recursive: true, force: true })
	} catch {
		/* best effort */
	}
})
let vaultCounter = 0

/**
 * Build a plugin whose `data.json` is a **real file** in a temp vault.
 *
 * `raw` writes exact bytes. `manifestDir: null` simulates a manifest without
 * `dir`; `configDir: null` simulates a vault that does not report `configDir` —
 * together they are the "we cannot even locate the file" case.
 *
 * `setFault()` makes `exists`/`read` throw *after* the load has already
 * succeeded, which is how an I/O failure that appears mid-session is modelled.
 */
function makePlugin({
	raw,
	data,
	dir = null,
	manifestDir = CONFIG_DIR,
	configDir = '.obsidian',
	plan = null
} = {}) {
	const vaultDir = dir ?? path.join(TMP_ROOT, `vault-${++vaultCounter}`)
	fs.mkdirSync(path.join(vaultDir, CONFIG_DIR), { recursive: true })
	const abs = rel => path.join(vaultDir, String(rel).replace(/^\/+/, ''))
	const configAbs = abs(CONFIG_REL)
	if (dir == null) {
		if (raw !== undefined) fs.writeFileSync(configAbs, raw, 'utf8')
		else if (data !== undefined) fs.writeFileSync(configAbs, JSON.stringify(data, null, '\t'), 'utf8')
	}
	const state = { fault: null, plan }
	const writes = []
	const calls = []
	let attempt = 0
	const adapter = {
		getBasePath: () => vaultDir,
		async exists(rel) {
			if (state.fault === 'exists-throw') throw new Error('EACCES: exists failed')
			return fs.existsSync(abs(rel))
		},
		async read(rel) {
			if (state.fault === 'read-throw') throw new Error('EIO: read failed')
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
		const i = attempt++
		const p = state.plan ? state.plan(i, payload) : null
		calls.push({ i, fail: !!(p && p.throw) })
		if (p && p.delay) await sleep(p.delay)
		if (p && p.throw) throw p.throw instanceof Error ? p.throw : new Error(p.throw)
		fs.writeFileSync(configAbs, JSON.stringify(snapshot, null, '\t'), 'utf8')
		writes.push({ i, key: snapshot.signingKey, marker: snapshot.signingKeyInitState })
	}
	const sha256 = () => {
		if (!fs.existsSync(configAbs)) return null
		return crypto.createHash('sha256').update(fs.readFileSync(configAbs)).digest('hex')
	}
	const sha = sha256()
	return {
		plugin,
		app,
		dir: vaultDir,
		configPath: configAbs,
		calls,
		writes,
		sha256,
		/** Hash of the file as the test found it, before anything ran. */
		initialSha: sha,
		readRaw: () => (fs.existsSync(configAbs) ? fs.readFileSync(configAbs, 'utf8') : null),
		writeRaw: text => fs.writeFileSync(configAbs, text, 'utf8'),
		removeFile: () => fs.rmSync(configAbs, { force: true }),
		setFault: name => {
			state.fault = name
		},
		setPlan: fn => {
			state.plan = fn
		},
		restart: () => makePlugin({ dir: vaultDir, manifestDir, configDir, plan: state.plan })
	}
}
const inited = (extra = {}) => ({
	outputFolder: FOLDER,
	signingKey: TEST_KEY,
	signingKeyInitialized: true,
	signingKeyInitState: 'initialized',
	...extra
})

/**
 * Load a *valid* config, then let something else rewrite the file, then try an
 * ordinary save.
 *
 * The assertions are about the disk, not about wording: `saveData` must not be
 * called, the bytes must be untouched, and no Notice may claim success.
 */
async function externalChangeCase(id, name, mutate, expectCode) {
	const h = makePlugin({ data: inited() })
	await h.plugin.loadSettings()
	await h.plugin.ensureSigningKey()
	const cachedState = h.plugin.configFileState
	Notice.all.length = 0
	mutate(h)
	const before = h.sha256()
	const bytes = h.readRaw()
	const message = await rejectionOf(() => h.plugin.saveSettings())
	const after = h.sha256()
	const ok =
		message !== null &&
		message.includes(expectCode) &&
		h.calls.length === 0 &&
		before === after &&
		h.readRaw() === bytes &&
		!Notice.all.some(n => /完成|成功/.test(n.message))
	record(
		id,
		name,
		ok,
		`cachedBefore=${cachedState} rejected=${message !== null} code=${(message ?? '').split(':')[0]} ` +
			`saveCalls=${h.calls.length} shaUnchanged=${before === after} notices=${Notice.all.length}`
	)
	return { h, message }
}

/* ==================================================================== */
console.log('\n=== F01 · 外部修改后必须重新探测磁盘（F-01 §3.1–§3.3）· T2 ===')

// F01-01  valid → externally rewritten as literal `null`
await externalChangeCase(
	'F01-01',
	'合法配置启动，外部改成 null → 普通保存被拒，saveData 未调用，磁盘字节不变',
	h => h.writeRaw('null'),
	'CONFIG_SHAPE_INVALID'
)

// F01-02  valid → unparsable JSON
await externalChangeCase(
	'F01-02',
	'外部改成非法 JSON → 普通保存被拒，磁盘字节不变',
	h => h.writeRaw('{"outputFolder": "html-export", "signingKey": '),
	'CONFIG_SHAPE_INVALID'
)

// F01-03  valid → array root
await externalChangeCase(
	'F01-03',
	'外部改成数组 → 普通保存被拒，磁盘字节不变',
	h => h.writeRaw('["unexpected"]'),
	'CONFIG_SHAPE_INVALID'
)

// F01-04  exists() starts throwing mid-session
await externalChangeCase(
	'F01-04',
	'exists() 抛错（加载成功后发生）→ fail-closed，拒绝写入',
	h => h.setFault('exists-throw'),
	'CONFIG_SHAPE_INVALID'
)

// F01-05  read() starts throwing mid-session
await externalChangeCase(
	'F01-05',
	'read() 抛错（文件确实存在）→ fail-closed，拒绝写入',
	h => h.setFault('read-throw'),
	'CONFIG_SHAPE_INVALID'
)

// F01-06  the file is deleted behind the plugin's back
{
	const h = makePlugin({ data: inited() })
	await h.plugin.loadSettings()
	await h.plugin.ensureSigningKey()
	Notice.all.length = 0
	h.removeFile()
	const message = await rejectionOf(() => h.plugin.saveSettings())
	const recreated = h.sha256() !== null
	const folderMessage = await rejectionOf(() => h.plugin.updateOutputFolder('elsewhere'))
	record(
		'F01-06',
		'外部删除原有配置 → 普通保存被拒（不当作首次安装），文件未被重建',
		message !== null &&
			message.includes('CONFIG_MISSING_AFTER_DELETE') &&
			!recreated &&
			h.calls.length === 0 &&
			folderMessage !== null &&
			h.sha256() === null,
		`rejected=${message !== null} code=${(message ?? '').split(':')[0]} recreated=${recreated} calls=${h.calls.length}`
	)
}

// F01-07  the one state that may create the file: it never existed
{
	const h = makePlugin({})
	await h.plugin.loadSettings()
	await h.plugin.ensureSigningKey()
	const before = h.sha256()
	const saved = !(await rejects(() => h.plugin.saveSettings()))
	const created = h.sha256() !== null && h.sha256() !== before
	record(
		'F01-07',
		'初始确实不存在 → 首次保存仍允许并创建文件（不被 §3.3 的保护误伤）',
		before === null && saved && created && h.calls.length === 1,
		`saved=${saved} created=${created} calls=${h.calls.length}`
	)
}

// F01-08  the cache says "valid" but the disk says otherwise: real disk wins
{
	const h = makePlugin({ data: inited() })
	await h.plugin.loadSettings()
	await h.plugin.ensureSigningKey()
	const cachedValid = h.plugin.configShapeValid === true && h.plugin.configFileState === 'object'
	h.writeRaw('null')
	const message = await rejectionOf(() => h.plugin.saveSettings())
	record(
		'F01-08',
		'缓存仍判为合法、磁盘已变 → saveSettings 依真实磁盘拒绝（证明不是读内存）',
		cachedValid && message !== null && message.includes('CONFIG_SHAPE_INVALID') && h.calls.length === 0,
		`cachedValid=${cachedValid} rejected=${message !== null} calls=${h.calls.length}`
	)
}

// F01-09  updateOutputFolder is an ordinary write too
{
	const h = makePlugin({ data: inited() })
	await h.plugin.loadSettings()
	await h.plugin.ensureSigningKey()
	h.writeRaw('null')
	const before = h.sha256()
	const message = await rejectionOf(() => h.plugin.updateOutputFolder('elsewhere'))
	const ok =
		message !== null &&
		message.includes('CONFIG_SHAPE_INVALID') &&
		h.calls.length === 0 &&
		h.sha256() === before &&
		h.plugin.settings.outputFolder === FOLDER
	record(
		'F01-09',
		'外部修改后 updateOutputFolder → 拒绝写入，磁盘与内存目录均未变',
		ok,
		`rejected=${message !== null} calls=${h.calls.length} mem=${h.plugin.settings.outputFolder}`
	)
}

// F01-10  the file changes while a write is already waiting in the queue
{
	const h = makePlugin({ data: inited() })
	await h.plugin.loadSettings()
	await h.plugin.ensureSigningKey()
	// First write holds the queue and then fails, so it leaves the file alone.
	h.setPlan(() => ({ delay: 60, throw: 'EACCES' }))
	const first = h.plugin.saveSettings().catch(() => 'first-failed')
	await sleep(10)
	h.writeRaw('null') // an external writer lands mid-queue
	h.setPlan(() => null) // the second attempt would succeed on its own
	const second = await h.plugin.saveSettings().then(() => 'ok', () => 'second-failed')
	await first
	record(
		'F01-10',
		'排队等待期间文件被改 → 队列执行时重新探测并拒绝（第二次写入未落盘）',
		second === 'second-failed' && h.calls.length === 1 && h.readRaw() === 'null',
		`first=${await first} second=${second} saveDataCalls=${h.calls.length} disk=${JSON.stringify(h.readRaw())}`
	)
}

// F01-11  valid external change: adopt it, write nothing
{
	const h = makePlugin({ data: inited() })
	await h.plugin.loadSettings()
	await h.plugin.ensureSigningKey()
	h.writeRaw(
		JSON.stringify(
			{
				outputFolder: 'synced-folder',
				signingKey: OTHER_KEY,
				signingKeyInitialized: true,
				signingKeyInitState: 'initialized'
			},
			null,
			'\t'
		)
	)
	// Hash the file *after* the external edit: a hook that wrote anything would
	// change it, and a hook that did nothing must leave these exact bytes.
	const before = h.sha256()
	await h.plugin.onExternalSettingsChange()
	record(
		'F01-11',
		'外部合法更新 → 设置与密钥状态同步，且不产生任何写盘 / 自动迁移',
		h.plugin.settings.outputFolder === 'synced-folder' &&
			h.plugin.settings.signingKey === OTHER_KEY &&
			h.plugin.keyState === 'ready' &&
			h.plugin.configFileState === 'object' &&
			h.calls.length === 0 &&
			h.sha256() === before,
		`folder=${h.plugin.settings.outputFolder} state=${h.plugin.keyState} writes=${h.calls.length}`
	)
}

// F01-12  manifest.dir missing → configDir + plugins + manifest.id fallback
{
	const h = makePlugin({ data: inited(), manifestDir: null })
	await h.plugin.loadSettings()
	await h.plugin.ensureSigningKey()
	const saved = !(await rejects(() => h.plugin.saveSettings()))
	record(
		'F01-12',
		'manifest.dir 缺失 → 回退为 configDir/plugins/manifest.id 定位，读写均正常',
		h.plugin.configFileState === 'object' &&
			h.plugin.configShapeValid === true &&
			saved &&
			h.calls.length === 1 &&
			h.readRaw().includes(FOLDER),
		`state=${h.plugin.configFileState} saved=${saved} calls=${h.calls.length}`
	)
}

// F01-13  cannot determine the path at all → fail closed
{
	const h = makePlugin({ data: inited(), manifestDir: null, configDir: null })
	await h.plugin.loadSettings()
	await h.plugin.ensureSigningKey()
	const before = h.sha256()
	const message = await rejectionOf(() => h.plugin.saveSettings())
	record(
		'F01-13',
		'无法确定配置文件路径 → fail-closed：unknown，拒绝普通写入，磁盘不变',
		message !== null &&
			message.includes('CONFIG_SHAPE_INVALID') &&
			h.plugin.configFileState === 'exists-check-failed' &&
			h.plugin.configShapeValid === false &&
			h.calls.length === 0 &&
			h.sha256() === before,
		`state=${h.plugin.configFileState} rejected=${message !== null} calls=${h.calls.length}`
	)
}

// F01-14  an anomalous config must still allow the explicit key recovery
{
	const h = makePlugin({ data: inited() })
	await h.plugin.loadSettings()
	await h.plugin.ensureSigningKey()
	h.writeRaw('null')
	const blocked = await rejectionOf(() => h.plugin.saveSettings())
	const result = await h.plugin.rotateSigningKey()
	const after = h.readRaw()
	record(
		'F01-14',
		'外部损坏后：普通保存被拒，但「显式重新生成密钥」恢复流程仍可写入并恢复合法配置',
		blocked !== null &&
			result.changed === true &&
			h.plugin.keyState === 'ready' &&
			h.plugin.configShapeValid === true &&
			after !== null &&
			JSON.parse(after).signingKeyInitState === 'initialized',
		`blocked=${blocked !== null} changed=${result.changed} state=${h.plugin.keyState}`
	)
}

// F01-15  anomalous external change through the host hook keeps memory intact
{
	const h = makePlugin({ data: inited() })
	await h.plugin.loadSettings()
	await h.plugin.ensureSigningKey()
	const keyBefore = h.plugin.settings.signingKey
	const folderBefore = h.plugin.settings.outputFolder
	h.writeRaw('"corrupted"')
	await h.plugin.onExternalSettingsChange()
	const message = await rejectionOf(() => h.plugin.saveSettings())
	record(
		'F01-15',
		'外部改成异常配置 → 保留最后已知内存设置，仅标记不可写并拒绝写入（不重建默认值）',
		h.plugin.settings.signingKey === keyBefore &&
			h.plugin.settings.outputFolder === folderBefore &&
			h.plugin.configShapeValid === false &&
			h.plugin.keyState === 'unknown' &&
			message !== null &&
			h.calls.length === 0,
		`keyKept=${h.plugin.settings.signingKey === keyBefore} folder=${h.plugin.settings.outputFolder} ` +
			`state=${h.plugin.keyState} rejected=${message !== null}`
	)
}

/* ==================================================================== */
console.log('\n=== ES · 异常对象的安全字符串转换（F-02）· T1 + T2 ===')

/** Run a diagnostics call and report whether it threw. */
function diagOf(input, secrets = []) {
	try {
		return { ok: true, text: extractKeyDiagnostics(input, secrets) }
	} catch (error) {
		return { ok: false, text: `THREW ${error && error.message}` }
	}
}

// ES-01  toString throws
{
	const d = diagOf({ toString() { throw new Error(`boom ${TEST_KEY}`) } })
	record(
		'ES-01',
		'toString 抛错 → 不向外抛出，返回占位文本且无密钥',
		d.ok && !leaksKey(d.text),
		`ok=${d.ok} diag=${d.text}`
	)
}

// ES-02  Symbol.toPrimitive throws
{
	const d = diagOf({ [Symbol.toPrimitive]() { throw new Error(`primitive ${TEST_KEY}`) } })
	record(
		'ES-02',
		'Symbol.toPrimitive 抛错 → 不向外抛出，返回占位文本且无密钥',
		d.ok && !leaksKey(d.text),
		`ok=${d.ok} diag=${d.text}`
	)
}

// ES-03  message getter throws
{
	const e = {
		get message() {
			throw new Error(`message getter ${TEST_KEY}`)
		},
		name: 'Error'
	}
	const d = diagOf(e)
	record(
		'ES-03',
		'message getter 抛错 → 回退到安全字符串，不崩、无密钥',
		d.ok && d.text.includes('type=Error') && !leaksKey(d.text),
		`ok=${d.ok} diag=${d.text}`
	)
}

// ES-04  stack getter throws
{
	const e = new Error(`有消息 ${TEST_KEY}`)
	Object.defineProperty(e, 'stack', {
		get() {
			throw new Error('stack getter exploded')
		}
	})
	const d = diagOf(e)
	record(
		'ES-04',
		'stack getter 抛错 → 不崩，message 仍脱敏输出',
		d.ok && d.text.includes('message=') && !leaksKey(d.text),
		`ok=${d.ok} diag=${d.text.slice(0, 90)}`
	)
}

// ES-05  Proxy whose get trap throws on everything
{
	const proxy = new Proxy(new Error('x'), {
		get() {
			throw new Error(`trap ${TEST_KEY}`)
		}
	})
	const d = diagOf(proxy)
	record(
		'ES-05',
		'Proxy get trap 抛错 → 不向外抛出，输出固定占位',
		d.ok && d.text.includes('type=Error') && d.text.includes('无法读取异常信息') && !leaksKey(d.text),
		`ok=${d.ok} diag=${d.text}`
	)
}

// ES-06  an ordinary error must still be diagnosable
{
	const e = new Error('write failed')
	e.code = 'EACCES'
	const d = diagOf(e)
	record(
		'ES-06',
		'正常 Error（EACCES）→ 仍能给出 code/type/message（安全化未削弱诊断）',
		d.ok && d.text.includes('code=EACCES') && d.text.includes('type=Error') && d.text.includes('write failed'),
		`ok=${d.ok} diag=${d.text}`
	)
}

// ES-07  an error *string* carrying a real key is still redacted
{
	const d = diagOf(new Error(`save failed for key ${TEST_KEY} and ${OTHER_KEY}`), [TEST_KEY])
	record(
		'ES-07',
		'异常字符串含真实密钥 → 仍然脱敏（安全化不得绕过 redactKeyMaterial）',
		d.ok && !leaksKey(d.text, TEST_KEY) && !leaksKey(d.text, OTHER_KEY),
		`ok=${d.ok} diag=${d.text.slice(0, 100)}`
	)
}

// ES-08  Symbol / null / plain object → stable results, never throws
{
	const inputs = [Symbol('k'), null, undefined, 0, false, {}, []]
	const bad = []
	for (const input of inputs) {
		const d = diagOf(input)
		if (!d.ok || typeof d.text !== 'string' || d.text.length === 0) bad.push(String(input))
	}
	record(
		'ES-08',
		'Symbol / null / undefined / 0 / false / 普通对象 / 数组 → 均有稳定结果且不抛错',
		bad.length === 0,
		bad.length ? `bad: ${bad.join(',')}` : `${inputs.length} 种输入全部稳定`
	)
}

// ES-09  redactKeyMaterial survives a throwing coercion
{
	let out
	let threw = false
	try {
		out = redactKeyMaterial({ toString() { throw new Error('nope') } })
	} catch {
		threw = true
	}
	record(
		'ES-09',
		'redactKeyMaterial 的 String() 也受保护（抛错 toString → 占位而非崩溃）',
		!threw && typeof out === 'string' && out.length > 0,
		`threw=${threw} out=${out}`,
		'T1'
	)
}

// ES-10  rotateKey end-to-end with a hostile error object
{
	const cap = captureConsole()
	let result
	let h
	let threw = false
	try {
		h = makePlugin({
			data: inited(),
			plan: () => {
				const e = new Error(`disk full ${TEST_KEY}`)
				e.code = 'ENOSPC'
				e.toString = () => {
					throw new Error(`toString ${TEST_KEY}`)
				}
				return { throw: e }
			}
		})
		await h.plugin.loadSettings()
		await h.plugin.ensureSigningKey()
		result = await h.plugin.rotateSigningKey()
	} catch {
		threw = true
	} finally {
		cap.restore()
	}
	const text = cap.text()
	record(
		'ES-10',
		'rotateKey 遇到 toString 抛错的异常 → 不崩、changed=false、旧密钥保留、日志无密钥',
		!threw &&
			result &&
			result.changed === false &&
			result.key === TEST_KEY &&
			h.plugin.settings.signingKey === TEST_KEY &&
			!leaksKey(text),
		`threw=${threw} changed=${result && result.changed} leak=${leaksKey(text)}`
	)
}

// ES-11  safeErrorText's own contract
{
	// Wrapped: with a broken `safeErrorText` this call throws, and an uncaught
	// throw would kill the whole suite — turning one red test into "no results
	// at all", which is a worse signal than a red line.
	let placeholder = '<threw>'
	let plain = '<threw>'
	let symbol = '<threw>'
	try {
		placeholder = safeErrorText({ toString() { throw new Error('x') } })
		plain = safeErrorText('hello')
		symbol = safeErrorText(Symbol('s'))
	} catch {
		/* leave the markers in place — the assertion below turns this red */
	}
	record(
		'ES-11',
		'safeErrorText：抛错对象 → 固定占位；字符串/ Symbol 原样可用',
		placeholder === '[无法读取异常信息]' && plain === 'hello' && symbol === 'Symbol(s)',
		`placeholder=${placeholder} plain=${plain} symbol=${symbol}`,
		'T1'
	)
}

/* ==================================================================== */
notTested(
	'EX-NT-1',
	'真实 Obsidian 宿主：onExternalSettingsChange 的实际调用时机',
	'需要运行中的 Obsidian（≥1.5.7）。本套件直接调用该 hook，只能证明行为正确，不能证明宿主何时调用它',
	'T5'
)
notTested(
	'EX-NT-2',
	'真实 host 下 manifest.dir 的取值与 adapter 的真实失败码',
	'Node fs 适配器不等于 Obsidian 的 FileSystemAdapter；真实错误码/权限失败未覆盖',
	'T5'
)
notTested(
	'EX-NT-3',
	'并发外部写入与写盘之间的 TOCTOU 窗口',
	'adapter 没有原子 compare-and-swap，无法在单进程测试里稳定复现；已作为残余风险记录',
	'T4'
)

/* -------------------------------------------------------------- 汇总 -- */
const total = results.length
console.log('\n' + '─'.repeat(72))
console.log(`总计：${total} 例，PASS ${pass}，FAIL ${fail}，NOT TESTED ${skipped}`)
for (const tier of ['T1', 'T2']) {
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
