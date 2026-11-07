/**
 * Round 3.2.1 — Review Findings Fix (F-01 / F-02)
 *
 * Answers the two source findings from the ChatGPT review of Round 3.2:
 *
 *   F-01  `loadData() !== null` cannot tell a *missing* `data.json` from one
 *         whose literal content is `null` (or a string / array / `false` / `0`,
 *         or unparsable JSON). An ordinary settings save could therefore
 *         overwrite a real, anomalous config file. Fixed by probing the file
 *         through the vault adapter (`exists` + `read`) and failing closed on
 *         every state except a confirmed-absent file.
 *
 *   F-02  `error.name` / `error.code` were echoed after only a shape regex
 *         (`/^[A-Z][A-Z0-9]*$/`), which an upper-case hex key satisfies. Both
 *         fields are now gated by explicit allow-lists.
 *
 * ---------------------------------------------------------------------------
 * Why this file exists next to `run-round3-review-fix.mjs`
 *
 * The F-01 cases need a *real* filesystem: simulating "no file" by handing
 * `null` to `loadData` reproduces the exact ambiguity being fixed, so the test
 * would be unable to distinguish PASS from the bug. Every case below creates a
 * real `data.json` in a throw-away temp vault and compares its SHA-256 before
 * and after the attempted write.
 *
 * MOCK BOUNDARY: only the Obsidian *classes* are stubbed. `HtmlExportPlugin`,
 * `HtmlExportSettingTab` and the resolvers are the bundled production sources,
 * unmodified.
 *
 * TIERS
 *   T1  pure unit     — `classifyConfigFile` / `extractKeyDiagnostics` called directly
 *   T2  method-level  — real plugin against a real temp file (`loadSettings`,
 *                       `ensureSigningKey`, `saveSettings`, `updateOutputFolder`,
 *                       `rotateSigningKey`)
 *   T3  settings-UI   — real button handler, Notice + console capture (KL-09)
 *   T4/T5             — not executed here (see the NOT TESTED entry)
 *
 * Run:  node tests/unit/run-round3-2-1-review-fix.mjs
 *       AB_ROOT=<dir> node tests/unit/run-round3-2-1-review-fix.mjs   # 反向对照
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
	: path.join(here, '.out-round3-2-1')

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
const { HtmlExportSettingTab } = await bundle('src/settings.ts', 'settings')
const signing = await bundle('src/export/signing-key.ts', 'signing-key')
const { classifyConfigFile, extractKeyDiagnostics, redactKeyMaterial } = signing
const obsidianStub = await import(
	pathToFileURL(path.join(out, 'node_modules', 'obsidian', 'index.mjs')).href
)
const Notice = obsidianStub.Notice

/* ----------------------------------------------------------- fixtures -- */
const TEST_KEY = '9f'.repeat(32)
const OTHER_KEY = 'a1'.repeat(32)
/**
 * A 64-hex key that *starts with a letter*, upper-cased.
 *
 * This is the shape the old gate `/^[A-Z][A-Z0-9]*$/` accepted: an upper-case
 * hex string whose first character is `A`–`F`. A key starting with a digit
 * (`9f9f…`) would be rejected by that regex for the wrong reason, which would
 * make the KL-03 assertion prove nothing.
 */
const HEX_KEY_UPPER = 'AF'.repeat(32)
const FOLDER = 'html-export'
const CONFIG_DIR = '.obsidian/plugins/test'
const CONFIG_REL = `${CONFIG_DIR}/data.json`

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
function notTested(id, name, why, tier = 'T4') {
	results.push({ id, name, tier, verdict: 'NOT TESTED', detail: why })
	skipped++
	process.stdout.write(`  NOT TESTED  ${id}  ${name}  — ${why}\n`)
}
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

/* ---------------------------------------------- real-filesystem harness -- */
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hep-r321-'))
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
 * `raw` writes exact bytes (so `null`, `"x"`, `[1]`, `false`, `0` and truncated
 * JSON are all representable). `fault` makes the adapter's `exists`/`read`
 * throw, which is a different fact from "the file is absent".
 */
function makePlugin({ raw, data, fault = null, dir = null, savePlan = null } = {}) {
	const vaultDir = dir ?? path.join(TMP_ROOT, `vault-${++vaultCounter}`)
	fs.mkdirSync(path.join(vaultDir, CONFIG_DIR), { recursive: true })
	const abs = rel => path.join(vaultDir, String(rel).replace(/^\/+/, ''))
	const configAbs = abs(CONFIG_REL)
	if (dir == null) {
		if (raw !== undefined) fs.writeFileSync(configAbs, raw, 'utf8')
		else if (data !== undefined) fs.writeFileSync(configAbs, JSON.stringify(data), 'utf8')
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
	// Faithful `loadData()`: `null` for a missing file AND for unparsable JSON —
	// the exact ambiguity F-01 is about.
	plugin.loadData = async () => {
		try {
			if (!fs.existsSync(configAbs)) return null
			return JSON.parse(fs.readFileSync(configAbs, 'utf8'))
		} catch {
			return null
		}
	}
	plugin.saveData = async payload => {
		const snapshot = JSON.parse(JSON.stringify(payload))
		const i = attempt++
		const plan = savePlan ? savePlan(i, payload) : null
		calls.push({ i, fail: !!(plan && plan.throw) })
		if (plan && plan.throw) {
			throw plan.throw instanceof Error ? plan.throw : new Error(plan.throw)
		}
		fs.writeFileSync(configAbs, JSON.stringify(snapshot, null, '\t'), 'utf8')
		writes.push({ i, key: snapshot.signingKey, marker: snapshot.signingKeyInitState })
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
		writeRaw: text => fs.writeFileSync(configAbs, text, 'utf8'),
		removeFile: () => fs.rmSync(configAbs, { force: true }),
		restart: () => makePlugin({ dir: vaultDir, fault, savePlan })
	}
}

/* ==================================================================== */
console.log('\n=== CF · data.json 存在性必须区分「缺失」与「存在但异常」（F-01）· T2 ===')

/**
 * One anomalous file state, exercised end to end.
 *
 * Every assertion is about the *disk*: `saveData` must not be called, the real
 * file's SHA-256 must be unchanged, the key state must be `unknown` (never
 * `first-init`), and a restart must still say `unknown` without writing.
 *
 * The restart reuses the same vault directory *and the same adapter fault*, so
 * the second instance really re-observes the broken state instead of silently
 * testing a healthy one.
 */
async function anomalousCase(id, name, opts = {}) {
	const h = makePlugin(opts)
	const before = h.sha256()
	const p = h.plugin
	await p.loadSettings()
	await p.ensureSigningKey()
	const stateAfterLoad = p.keyState
	const reason = p.markerReading.unknownReason
	const loadCalls = h.calls.length
	const saveRejected = await rejects(() => p.saveSettings())
	const folderRejected = await rejects(() => p.updateOutputFolder('elsewhere'))
	const after = h.sha256()
	const restarted = h.restart()
	await restarted.plugin.loadSettings()
	await restarted.plugin.ensureSigningKey()
	const ok =
		loadCalls === 0 &&
		saveRejected &&
		folderRejected &&
		h.calls.length === 0 &&
		before === after &&
		stateAfterLoad === 'unknown' &&
		stateAfterLoad !== 'first-init' &&
		reason === opts.expectedReason &&
		restarted.plugin.keyState === 'unknown' &&
		restarted.calls.length === 0
	record(
		id,
		name,
		ok,
		`state=${stateAfterLoad} reason=${reason}(expect=${opts.expectedReason}) ` +
			`saveRejected=${saveRejected} folderRejected=${folderRejected} ` +
			`saveCalls=${h.calls.length} shaUnchanged=${before === after} ` +
			`restart=${restarted.plugin.keyState}/${restarted.calls.length}`
	)
}

// CF-01  the ONLY state that may create the file on first save
{
	const h = makePlugin({})
	const before = h.sha256()
	const p = h.plugin
	await p.loadSettings()
	await p.ensureSigningKey()
	const loadCalls = h.calls.length
	const stateAfterLoad = p.keyState
	const saved = !(await rejects(() => p.saveSettings()))
	const created = h.sha256() !== null && h.sha256() !== before
	const restarted = h.restart()
	await restarted.plugin.loadSettings()
	await restarted.plugin.ensureSigningKey()
	record(
		'CF-01',
		'文件不存在 → 允许首次保存创建文件；密钥状态仍为 unknown（不谎称 first-init），load 阶段不写盘',
		loadCalls === 0 &&
			stateAfterLoad === 'unknown' &&
			saved &&
			created &&
			restarted.plugin.keyState === 'unknown',
		`state=${stateAfterLoad} loadCalls=${loadCalls} saved=${saved} created=${created} restart=${restarted.plugin.keyState}`
	)
}
// CF-02  literal `null`
await anomalousCase('CF-02', '文件存在、内容为 null → unknown，普通保存与 outputFolder 均被拒绝，磁盘不变', {
	raw: 'null',
	expectedReason: 'config-shape-invalid'
})
// CF-03  string root
await anomalousCase('CF-03', '文件存在、内容为字符串 → unknown，拒绝写盘，磁盘不变', {
	raw: '"corrupted"',
	expectedReason: 'config-shape-invalid'
})
// CF-04  array root
await anomalousCase('CF-04', '文件存在、内容为数组 → unknown，拒绝写盘，磁盘不变', {
	raw: '["unexpected"]',
	expectedReason: 'config-shape-invalid'
})
// CF-05  false root
await anomalousCase('CF-05', '文件存在、内容为 false → unknown，拒绝写盘，磁盘不变', {
	raw: 'false',
	expectedReason: 'config-shape-invalid'
})
// CF-06  0 root
await anomalousCase('CF-06', '文件存在、内容为 0 → unknown，拒绝写盘，磁盘不变', {
	raw: '0',
	expectedReason: 'config-shape-invalid'
})
// CF-07  unparsable JSON
await anomalousCase('CF-07', '文件存在但 JSON 损坏 → unknown，拒绝写盘，磁盘不变', {
	raw: '{"outputFolder": "html-export", "signingKey": ',
	expectedReason: 'config-shape-invalid'
})
// CF-08  exists() throws
await anomalousCase('CF-08', '存在性检查抛错 → unknown（fail-closed），拒绝写盘', {
	data: { outputFolder: FOLDER },
	fault: 'exists-throw',
	expectedReason: 'config-exists-check-failed'
})
// CF-09  read() throws (the file really exists)
await anomalousCase('CF-09', '文件读取抛错（文件确实存在）→ unknown（fail-closed），拒绝写盘', {
	data: { outputFolder: FOLDER },
	fault: 'read-throw',
	expectedReason: 'config-read-failed'
})

// CF-10  classifyConfigFile 的纯函数契约（T1）
{
	const cases = [
		[{ exists: false, parseOk: false }, 'missing', false, false, 'config-missing'],
		[{ exists: null, parseOk: false }, 'exists-check-failed', true, false, 'config-exists-check-failed'],
		[{ exists: true, parseOk: false }, 'read-failed', true, false, 'config-read-failed'],
		[{ exists: true, text: '{', parseOk: false }, 'invalid-json', true, false, 'config-shape-invalid'],
		[{ exists: true, text: 'null', parsed: null, parseOk: true }, 'null-content', true, false, 'config-shape-invalid'],
		[{ exists: true, text: '"s"', parsed: 's', parseOk: true }, 'non-object', true, false, 'config-shape-invalid'],
		[{ exists: true, text: '[]', parsed: [], parseOk: true }, 'non-object', true, false, 'config-shape-invalid'],
		[{ exists: true, text: '{"a":1}', parsed: { a: 1 }, parseOk: true }, 'object', true, true, undefined]
	]
	const bad = []
	for (const [probe, state, present, shapeValid, reason] of cases) {
		const c = classifyConfigFile(probe)
		if (c.state !== state || c.present !== present || c.shapeValid !== shapeValid || c.unknownReason !== reason) {
			bad.push(`${state}→${c.state}/${c.present}/${c.shapeValid}/${c.unknownReason}`)
		}
	}
	record(
		'CF-10',
		'classifyConfigFile：仅 missing 允许首建；7 种异常一律 present=true/shapeValid=false',
		bad.length === 0,
		bad.length ? bad.join(' | ') : '8 组输入全部符合预期',
		'T1'
	)
}

// CF-11  异常配置不得被内存默认值"洗白"
{
	const h = makePlugin({})
	h.writeRaw('"corrupted"')
	const p = h.plugin
	await p.loadSettings()
	await p.ensureSigningKey()
	record(
		'CF-11',
		'异常配置 → 内存设置回退为默认值（不为空对象残留），但仍判定为不可写',
		p.settings.signingKey === '' &&
			p.settings.outputFolder === FOLDER &&
			p.configShapeValid === false &&
			p.configPresent === true &&
			h.calls.length === 0,
		`key="${p.settings.signingKey}" present=${p.configPresent} shapeValid=${p.configShapeValid}`
	)
}

// CF-12  显式恢复路径仍然可用（用户主动轮换密钥 = 明确确认）
{
	const h = makePlugin({})
	h.writeRaw('null')
	const p = h.plugin
	await p.loadSettings()
	await p.ensureSigningKey()
	const blocked = await rejects(() => p.saveSettings())
	const result = await p.rotateSigningKey()
	const after = h.readRaw()
	record(
		'CF-12',
		'异常配置下：普通保存被拒，但「重新生成密钥」这一显式恢复路径仍可写入并恢复为合法配置',
		blocked &&
			result.changed === true &&
			p.keyState === 'ready' &&
			p.configShapeValid === true &&
			after !== null &&
			JSON.parse(after).signingKeyInitState === 'initialized',
		`blocked=${blocked} changed=${result.changed} state=${p.keyState}`
	)
}

/* ==================================================================== */
console.log('\n=== KL · 异常元数据不得泄露密钥（F-02）· T1 + T2 + T3 ===')

const hostile = () => {
	const e = new Error('写入失败')
	e.code = 'EACCES'
	return e
}

// KL-01  error.name carries the full key
{
	const e = hostile()
	e.name = TEST_KEY
	const diag = extractKeyDiagnostics(e, [])
	record(
		'KL-01',
		'error.name = 完整密钥 → 白名单外类型降级为 type=Error，输出无密钥',
		diag.includes('type=Error') && !leaksKey(diag),
		`diag=${diag}`
	)
}
// KL-02  error.code carries the full key
{
	const e = hostile()
	e.code = TEST_KEY
	const diag = extractKeyDiagnostics(e, [])
	record(
		'KL-02',
		'error.code = 完整密钥 → 不输出 code=，输出无密钥',
		!diag.includes('code=') && !leaksKey(diag),
		`diag=${diag}`
	)
}
// KL-03  error.code = UPPER-CASE hex key (the case the old regex let through)
{
	const e = hostile()
	e.code = HEX_KEY_UPPER
	const diag = extractKeyDiagnostics(e, [])
	record(
		'KL-03',
		'error.code = 大写十六进制密钥 → 白名单拒绝（旧的 /^[A-Z][A-Z0-9]*$/ 会放行）',
		!diag.includes('code=') && !leaksKey(diag),
		`diag=${diag.slice(0, 80)}`
	)
}
// KL-04  absurdly long / non-builtin name
{
	const e = hostile()
	e.name = 'X'.repeat(5000) + TEST_KEY
	const diag = extractKeyDiagnostics(e, [])
	record(
		'KL-04',
		'error.name = 超长异常字符串（含密钥）→ type=Error，无密钥、无超长回显',
		diag.includes('type=Error') && !leaksKey(diag) && diag.length < 500,
		`len=${diag.length}`
	)
}
// KL-05  non-string / throwing metadata
{
	const e = hostile()
	e.code = { toString: () => TEST_KEY }
	Object.defineProperty(e, 'name', {
		get() {
			throw new Error('getter exploded ' + TEST_KEY)
		}
	})
	const diag = extractKeyDiagnostics(e, [])
	record(
		'KL-05',
		'error.code 为非字符串对象 + error.name 为抛错 getter → 均不输出，且不崩',
		diag.includes('type=Error') && !diag.includes('code=') && !leaksKey(diag),
		`diag=${diag}`
	)
}
// KL-06  message and stack both carry several keys
{
	const e = hostile()
	e.message = `失败 ${TEST_KEY} 与 ${OTHER_KEY}`
	e.stack = `Error: ${TEST_KEY}\n    at x (${OTHER_KEY})`
	const diag = extractKeyDiagnostics(e, [])
	record(
		'KL-06',
		'message 与 stack 同时含多个密钥 → 两处均脱敏',
		!leaksKey(diag, TEST_KEY) && !leaksKey(diag, OTHER_KEY),
		`diag=${diag.slice(0, 120)}`
	)
}
// KL-07  real codes must still be diagnosable
{
	const okCodes = ['EACCES', 'EPERM', 'ENOENT', 'EEXIST', 'ENOSPC', 'EIO']
	const bad = okCodes.filter(code => {
		const e = hostile()
		e.code = code
		return !extractKeyDiagnostics(e, []).includes(`code=${code}`)
	})
	record(
		'KL-07',
		'白名单内的 6 个真实错误码仍完整输出（诊断能力未被削弱）',
		bad.length === 0,
		bad.length ? `missing: ${bad.join(',')}` : okCodes.join('/')
	)
}
// KL-08  rotateKey end-to-end with hostile metadata
{
	const cap = captureConsole()
	let result
	let h
	try {
		h = makePlugin({
			data: {
				outputFolder: FOLDER,
				signingKey: TEST_KEY,
				signingKeyInitialized: true,
				signingKeyInitState: 'initialized'
			},
			savePlan: () => {
				const e = new Error(`disk full ${TEST_KEY}`)
				e.name = TEST_KEY
				e.code = HEX_KEY_UPPER
				return { throw: e }
			}
		})
		await h.plugin.loadSettings()
		await h.plugin.ensureSigningKey()
		result = await h.plugin.rotateSigningKey()
	} finally {
		cap.restore()
	}
	const text = cap.text()
	record(
		'KL-08',
		'rotateKey 失败且 name/code 均为密钥 → 日志无密钥、changed=false、旧密钥保留、未采纳新密钥',
		result.changed === false &&
			result.key === TEST_KEY &&
			h.plugin.settings.signingKey === TEST_KEY &&
			result.state === 'ready' &&
			!leaksKey(text),
		`changed=${result.changed} state=${result.state} leak=${leaksKey(text)}`
	)
}
// KL-09  settings-tab button path: Notice + console
{
	const cap = captureConsole()
	let notices = []
	let ok = false
	let counts = ''
	try {
		const h = makePlugin({
			data: {
				outputFolder: FOLDER,
				signingKey: TEST_KEY,
				signingKeyInitialized: true,
				signingKeyInitState: 'initialized'
			},
			savePlan: () => {
				const e = new Error(`denied ${TEST_KEY}`)
				e.name = `Bad ${TEST_KEY}`
				e.code = TEST_KEY
				return { throw: e }
			}
		})
		await h.plugin.loadSettings()
		await h.plugin.ensureSigningKey()
		Notice.all.length = 0
		const tab = new HtmlExportSettingTab(h.app, h.plugin)
		tab.display()
		const rows = tab.containerEl.__settings ?? []
		const buttons = rows.flatMap(s => s.buttons ?? [])
		counts = `rows=${rows.length} buttons=${buttons.map(b => b.text).join('/')}`
		// First click arms the double confirmation, second click performs it.
		const btn = buttons.find(b => /生成|重新生成/.test(b.text))
		if (btn) {
			await btn.click()
			await btn.click()
		}
		notices = Notice.all.map(n => n.message)
		const text = cap.text()
		ok =
			!!btn &&
			notices.length > 0 &&
			!notices.some(m => leaksKey(m)) &&
			!leaksKey(text) &&
			!notices.some(m => m.includes('✅'))
	} finally {
		cap.restore()
	}
	record(
		'KL-09',
		'设置页按钮触发同一失败 → Notice 与 console 均无密钥、无成功字样',
		ok,
		`${counts} notices=${notices.length} leak=${notices.some(m => leaksKey(m))}`,
		'T3'
	)
}
// KL-10  redactKeyMaterial is not weakened by the whitelist change
{
	const text = redactKeyMaterial(`a ${TEST_KEY} b ${OTHER_KEY}`)
	record(
		'KL-10',
		'redactKeyMaterial 精确替换仍然生效（白名单改动不影响文本脱敏）',
		!leaksKey(text, TEST_KEY) && !leaksKey(text, OTHER_KEY),
		`out=${text}`,
		'T1'
	)
}

/* ==================================================================== */
notTested(
	'EX-NT',
	'导出管线 / 真实 Obsidian 宿主',
	'本轮未改动导出链路；管线覆盖见 run-round3-review-fix.mjs 与真实 Edge capture/layout 套件。真实宿主仍需运行中的 Obsidian',
	'T4/T5'
)

/* -------------------------------------------------------------- 汇总 -- */
const total = results.length
console.log('\n' + '─'.repeat(72))
console.log(`总计：${total} 例，PASS ${pass}，FAIL ${fail}，NOT TESTED ${skipped}`)
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
