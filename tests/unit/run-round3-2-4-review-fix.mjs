#!/usr/bin/env node
/**
 * Round 3.2.4 — incremental fix suite (P1 key-lock bypass + P2 metadata leak).
 *
 * IMPORTANT — scope of the host double
 * ---------------------------------------------------------------------------
 * These are **offline Node tests with an isolated host double**, NOT real
 * Obsidian E2E. `node:fs` backs the vault adapter; esbuild replaces the capture,
 * CSS, audit, exporter and writer modules with tiny stand-ins so that
 * `runCaptureAndExport()` can be driven through to `writeExport()` and held
 * there deterministically. The stand-in writer records the `signingKey` it is
 * actually handed.
 *
 * Nothing here proves that Obsidian ≥1.5.7 calls `onExternalSettingsChange` at
 * a particular time, nor that the real FileSystemAdapter behaves identically.
 * Those are `EX-NT-6` (NOT TESTED) and are never counted as PASS.
 *
 * Cases
 * ---------------------------------------------------------------------------
 *   LCK-01  export holds keyLock; external key swap; saveSettings       (A)
 *   LCK-02  export holds keyLock; external key swap; updateOutputFolder  (B)
 *   LCK-03  export holds keyLock; external callback + save concurrent    (C)
 *   LCK-04  export holds keyLock; rotation + save concurrent             (D)
 *   LCK-05  a failing operation must release the lock; next export works  (E)
 *   MD-01..05  ExportError.stage / .tmpDir are validated and redacted
 *
 * Run:  node tests/unit/run-round3-2-4-review-fix.mjs
 *       AB_ROOT=<dir> node ...    # reverse control: bundle the mutated src
 *       AB_ROOT=<dir> AB_OUT=<tmpdir> node ...   # and write nothing to the tree
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
	: path.join(here, '.out-round3-2-4')

/* --------------------------------------------------- obsidian host double -- */
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
		JSON.stringify({ name: 'obsidian', version: '0.0.0-stub', type: 'module', main: 'index.mjs', exports: './index.mjs' })
	)
}

/* ------------------------------------------- capture/export stand-ins ----- */
/**
 * Only the modules that `runCaptureAndExport()` walks through are replaced.
 * `settings.ts` and `export/signing-key.ts` stay REAL, so the key lifecycle,
 * normalisation and the config-conflict logic under test are the shipping code.
 */
const STUBS = {
	'./export/writer': [
		'export class ExportError extends Error {',
		'  constructor(message, stage, tmpDir, checks = []) {',
		'    super(message)',
		"    this.name = 'ExportError'",
		'    this.stage = stage',
		'    this.tmpDir = tmpDir',
		'    this.checks = checks',
		'  }',
		'}',
		'globalThis.__r324ExportError = ExportError',
		'export async function writeExport(app, snapshot, html, css, assets, folder, extra, signingKey) {',
		'  const calls = globalThis.__r324WriterCalls || (globalThis.__r324WriterCalls = [])',
		'  calls.push({ signingKey: signingKey, folder: folder })',
		'  if (typeof globalThis.__r324WriterEntered === "function") globalThis.__r324WriterEntered()',
		'  const gate = globalThis.__r324ExportGate',
		'  if (gate) await gate',
		'  if (globalThis.__r324ThrowFromWriter) throw globalThis.__r324ThrowFromWriter',
		'  return globalThis.__r324ExportReport',
		'}',
		''
	].join('\n'),
	'./capture/dom-capture': [
		'export async function captureReadingView() {',
		"  return { noteTitle: 'note', captureWidth: 900, stats: { math: 0 } }",
		'}',
		''
	].join('\n'),
	'./capture/dom-resolver': [
		'export class CaptureError extends Error {',
		'  constructor(message) { super(message); this.name = "CaptureError" }',
		'}',
		''
	].join('\n'),
	'./capture/runtime-audit': [
		'export async function buildRuntimeAudit() { return {} }',
		''
	].join('\n'),
	'./css/css-collector': [
		'export async function collectCss() { return { sheets: [], warnings: [] } }',
		"export function renderCss() { return '' }",
		''
	].join('\n'),
	'./assets/resource-manager': [
		'export class AssetCollector { constructor(app) { this.app = app } }',
		''
	].join('\n'),
	'./export/exporter': [
		"export function buildHtml() { return '<html></html>' }",
		''
	].join('\n'),
	'./view/preview-view': [
		'export const VIEW_TYPE_HTML_EXPORT_PREVIEW = "html-export-preview"',
		'export class PreviewView { constructor() {} setHtml() {} }',
		''
	].join('\n')
}

const stubPlugin = {
	name: 'r324-host-double',
	setup(b) {
		b.onResolve(
			{
				filter:
					/^\.\/(?:export\/writer|capture\/dom-capture|capture\/dom-resolver|capture\/runtime-audit|css\/css-collector|assets\/resource-manager|export\/exporter|view\/preview-view)$/
			},
			args => ({ path: args.path, namespace: 'r324-stub' })
		)
		b.onLoad({ filter: /.*/, namespace: 'r324-stub' }, args => ({
			contents: STUBS[args.path],
			loader: 'js'
		}))
	}
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
		plugins: [stubPlugin],
		logLevel: 'error'
	})
	return import(`${pathToFileURL(outfile).href}?v=${Date.now()}-${Math.random()}`)
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
const obsidianStub = await import(
	pathToFileURL(path.join(out, 'node_modules', 'obsidian', 'index.mjs')).href
)
const Notice = obsidianStub.Notice
const ExportError = globalThis.__r324ExportError
if (!ExportError) throw new Error('writer stand-in did not export ExportError')

/* -------------------------------------------------------------- fixtures -- */
const OLD_KEY = '9f'.repeat(32)
const NEW_KEY = 'a1'.repeat(32)
const FOLDER = 'html-export'
const CONFIG_DIR = '.obsidian/plugins/test'
const CONFIG_REL = `${CONFIG_DIR}/data.json`
const sleep = ms => new Promise(r => setTimeout(r, ms))

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hep-r324-'))
process.on('exit', () => {
	try {
		fs.rmSync(TMP_ROOT, { recursive: true, force: true })
	} catch {
		/* best effort */
	}
})
let vaultCounter = 0

function inited(extra = {}) {
	return {
		outputFolder: FOLDER,
		signingKey: OLD_KEY,
		signingKeyInitialized: true,
		signingKeyInitState: 'initialized',
		...extra
	}
}
/** A valid external rewrite that only changes the signing key. */
const external = () => inited({ signingKey: NEW_KEY })

function makePlugin({ data, dir = null } = {}) {
	const vaultDir = dir ?? path.join(TMP_ROOT, `vault-${++vaultCounter}`)
	fs.mkdirSync(path.join(vaultDir, CONFIG_DIR), { recursive: true })
	const abs = rel => path.join(vaultDir, String(rel).replace(/^\/+/, ''))
	const configAbs = abs(CONFIG_REL)
	if (dir == null && data !== undefined) {
		fs.writeFileSync(configAbs, JSON.stringify(data, null, '\t'), 'utf8')
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
	const app = {
		workspace: {
			// A leaf whose view is NOT a PreviewView instance: `openPreview()`
			// then leaves `previewView` null and the optional `setHtml` is a no-op.
			getLeavesOfType: () => [{ view: { setHtml() {} } }],
			getRightLeaf: () => null,
			getLeaf: () => ({ setViewState: async () => {} }),
			revealLeaf: () => {}
		},
		vault: { adapter, configDir: '.obsidian' }
	}
	const manifest = { id: 'test', name: 'test', version: '1.0.0', dir: CONFIG_DIR }
	const plugin = new HtmlExportPlugin(app, manifest)
	plugin.saveData = async payload => {
		const snapshot = JSON.parse(JSON.stringify(payload))
		calls.push({ i: calls.length })
		fs.writeFileSync(configAbs, JSON.stringify(snapshot, null, '\t'), 'utf8')
		writes.push({ key: snapshot.signingKey, folder: snapshot.outputFolder })
	}
	return {
		plugin,
		app,
		calls,
		writes,
		readRaw: () => (fs.existsSync(configAbs) ? fs.readFileSync(configAbs, 'utf8') : null),
		readJson: () => (fs.existsSync(configAbs) ? JSON.parse(fs.readFileSync(configAbs, 'utf8')) : null),
		writeRaw: text => fs.writeFileSync(configAbs, text, 'utf8'),
		sha256: () =>
			fs.existsSync(configAbs)
				? crypto.createHash('sha256').update(fs.readFileSync(configAbs)).digest('hex')
				: null
	}
}

async function booted(data = inited()) {
	const h = makePlugin({ data })
	await h.plugin.loadSettings()
	await h.plugin.ensureSigningKey()
	h.calls.length = 0
	h.writes.length = 0
	Notice.all.length = 0
	return h
}

/* ------------------------------------------------------------- runner ---- */
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
const safeText = value => {
	try {
		return String(value?.message ?? value)
	} catch {
		return '[unprintable]'
	}
}

/* ------------------------------------------------------ export gating ---- */
function deferred() {
	let resolve
	let reject
	const promise = new Promise((res, rej) => {
		resolve = res
		reject = rej
	})
	return { promise, resolve, reject }
}
function withTimeout(promise, ms, label) {
	let timer
	return Promise.race([
		promise,
		new Promise((_, rej) => {
			timer = setTimeout(() => rej(new Error(label)), ms)
		})
	]).finally(() => clearTimeout(timer))
}
function defaultReport() {
	return {
		dir: 'html-export/export-1',
		status: 'ok',
		assets: { written: 0, entries: [], missing: [], external: [] },
		verified: { checks: [] },
		leftoverBackup: null
	}
}
function resetExportGlobals() {
	globalThis.__r324WriterCalls = []
	globalThis.__r324WriterEntered = null
	globalThis.__r324ExportGate = null
	globalThis.__r324ThrowFromWriter = null
	globalThis.__r324ExportReport = defaultReport()
	Notice.all.length = 0
}
/**
 * Drive the REAL `runCaptureAndExport()` until the stand-in writer has been
 * handed the signing key, then hold it there: the export owns `keyLock` until
 * `release()` is called. This is the state ChatGPT reproduced.
 */
async function exportSession(h) {
	resetExportGlobals()
	const entered = deferred()
	const gate = deferred()
	globalThis.__r324WriterEntered = entered.resolve
	globalThis.__r324ExportGate = gate.promise
	const task = h.plugin.runCaptureAndExport()
	await withTimeout(entered.promise, 6000, 'writeExport 未被调用（导出路径未走通）')
	return {
		calls: globalThis.__r324WriterCalls,
		gate,
		task,
		async release() {
			gate.resolve()
			await withTimeout(task, 6000, '导出未结束（疑似 keyLock 未释放）')
		}
	}
}
/** Always release a held export, and always emit exactly one result line. */
async function guarded(id, name, fn) {
	let session = null
	try {
		const detail = await fn(s => {
			session = s
		})
		record(id, name, detail.ok, detail.text)
	} catch (error) {
		if (session) {
			try {
				session.gate.resolve()
				await withTimeout(session.task, 6000, 'cleanup timeout')
			} catch {
				/* recorded below */
			}
		}
		record(id, name, false, `THREW: ${safeText(error)}`)
	}
}

/* ----------------------------------------------- console / key helpers --- */
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
function leaksKey(text, key = OLD_KEY) {
	const s = String(text ?? '')
	if (s.includes(key) || s.toLowerCase().includes(key.toLowerCase())) return true
	for (const n of [32, 24, 16]) {
		for (let i = 0; i + n <= key.length; i += 8) {
			if (s.includes(key.slice(i, i + n))) return true
		}
	}
	return false
}
function captureReport(h, error) {
	Notice.all.length = 0
	const cap = captureConsoleTyped()
	let threw = false
	try {
		h.plugin.reportFailure(error)
	} catch {
		threw = true
	}
	const notices = Notice.all.map(n => n.message).join('\n')
	const text = cap.text()
	const nonString = cap.nonStringArgs().length
	cap.restore()
	return { threw, notices, text, nonString }
}
const settle = task =>
	task.then(
		v => ({ settled: true, value: v }),
		e => ({ settled: true, value: null, error: safeText(e) })
	)

console.log('Round 3.2.4 — 增量修复测试（隔离宿主替身，非真实 Obsidian E2E）')
console.log(`  root = ${root}`)

/* ==================================================== P1 · keyLock ======= */
console.log('\nP1 — 导出持锁期间不得改变内存签名密钥')

/** A — export holds the lock, external key swap, then an ordinary save. */
await guarded('LCK-01', 'A. 导出持锁 + 外部换密钥 + saveSettings → Writer 仍用旧密钥，锁释放后才采用外部值', async setSession => {
	const h = await booted()
	const s = await exportSession(h)
	setSession(s)
	const writerKey = s.calls[0].signingKey
	h.writeRaw(JSON.stringify(external(), null, '\t'))
	const bytes = h.readRaw()
	let settled = false
	const saveTask = h.plugin.saveSettings().then(
		v => {
			settled = true
			return v
		},
		e => {
			settled = true
			return `ERR:${safeText(e)}`
		}
	)
	await sleep(140)
	const during = {
		settled,
		memKey: h.plugin.settings.signingKey,
		diskKept: h.readRaw() === bytes,
		writes: h.calls.length
	}
	await s.release()
	const saveResult = await saveTask
	const disk = h.readJson()
	const ok =
		writerKey === OLD_KEY &&
		during.settled === false &&
		during.memKey === OLD_KEY &&
		during.diskKept === true &&
		during.writes === 0 &&
		h.calls.length === 0 &&
		disk?.signingKey === NEW_KEY &&
		h.plugin.settings.signingKey === NEW_KEY &&
		saveResult === undefined &&
		h.plugin.running === false
	return {
		ok,
		text:
			`writerOld=${writerKey === OLD_KEY} duringSettled=${during.settled} ` +
			`duringMemOld=${during.memKey === OLD_KEY} writes=${h.calls.length} ` +
			`diskKept=${during.diskKept} adopted=${h.plugin.settings.signingKey === NEW_KEY} ` +
			`running=${h.plugin.running}`
	}
})

/** B — same, but the ordinary write is an explicit output-folder edit. */
await guarded('LCK-02', 'B. 导出持锁 + 外部换密钥 + updateOutputFolder → 不覆盖外部密钥，目录仍被持久化', async setSession => {
	const h = await booted()
	const s = await exportSession(h)
	setSession(s)
	const writerKey = s.calls[0].signingKey
	h.writeRaw(JSON.stringify(external(), null, '\t'))
	const bytes = h.readRaw()
	let settled = false
	const editTask = h.plugin.updateOutputFolder('new-folder').then(
		v => {
			settled = true
			return v
		},
		e => {
			settled = true
			return `ERR:${safeText(e)}`
		}
	)
	await sleep(140)
	const during = {
		settled,
		memKey: h.plugin.settings.signingKey,
		diskKept: h.readRaw() === bytes,
		writes: h.calls.length
	}
	await s.release()
	const editResult = await editTask
	const disk = h.readJson()
	const ok =
		writerKey === OLD_KEY &&
		during.settled === false &&
		during.memKey === OLD_KEY &&
		during.diskKept === true &&
		during.writes === 0 &&
		h.calls.length === 1 &&
		disk?.outputFolder === 'new-folder' &&
		disk?.signingKey === NEW_KEY &&
		h.plugin.settings.signingKey === NEW_KEY &&
		editResult === undefined &&
		h.plugin.running === false
	return {
		ok,
		text:
			`writerOld=${writerKey === OLD_KEY} duringSettled=${during.settled} ` +
			`duringMemOld=${during.memKey === OLD_KEY} writesDuring=${during.writes} ` +
			`writesAfter=${h.calls.length} diskFolder=${disk?.outputFolder} ` +
			`diskExternalKey=${disk?.signingKey === NEW_KEY} adopted=${h.plugin.settings.signingKey === NEW_KEY}`
	}
})

/** C — external-change hook and an ordinary save race while the export holds the lock. */
await guarded('LCK-03', 'C. 导出持锁 + 外部更新回调与普通保存并发 → 两者都等锁，外部配置最终被采用', async setSession => {
	const h = await booted()
	const s = await exportSession(h)
	setSession(s)
	const writerKey = s.calls[0].signingKey
	h.writeRaw(JSON.stringify(external(), null, '\t'))
	const bytes = h.readRaw()
	const cb = settle(h.plugin.onExternalSettingsChange())
	const sv = settle(h.plugin.saveSettings())
	await sleep(140)
	const during = {
		cbSettled: (await Promise.race([cb.then(() => true), sleep(0).then(() => false)])) === true,
		memKey: h.plugin.settings.signingKey,
		diskKept: h.readRaw() === bytes,
		writes: h.calls.length
	}
	await s.release()
	const [cbResult, svResult] = await Promise.all([cb, sv])
	const disk = h.readJson()
	const ok =
		writerKey === OLD_KEY &&
		during.cbSettled === false &&
		during.memKey === OLD_KEY &&
		during.diskKept === true &&
		during.writes === 0 &&
		cbResult.error === undefined &&
		svResult.error === undefined &&
		disk?.signingKey === NEW_KEY &&
		h.plugin.settings.signingKey === NEW_KEY &&
		h.plugin.running === false
	return {
		ok,
		text:
			`writerOld=${writerKey === OLD_KEY} cbEarly=${during.cbSettled} ` +
			`duringMemOld=${during.memKey === OLD_KEY} writesDuring=${during.writes} ` +
			`cbErr=${cbResult.error ?? 'none'} saveErr=${svResult.error ?? 'none'} ` +
			`diskExternalKey=${disk?.signingKey === NEW_KEY} adopted=${h.plugin.settings.signingKey === NEW_KEY}`
	}
})

/** D — rotation and an ordinary save race while the export holds the lock. */
await guarded('LCK-04', 'D. 导出持锁 + 密钥轮换与普通保存并发 → 轮换不提前落地，最终磁盘/内存密钥一致', async setSession => {
	const h = await booted()
	const s = await exportSession(h)
	setSession(s)
	const writerKey = s.calls[0].signingKey
	const rot = settle(h.plugin.rotateSigningKey())
	const sv = settle(h.plugin.saveSettings())
	await sleep(140)
	const during = {
		memKey: h.plugin.settings.signingKey,
		writes: h.calls.length
	}
	await s.release()
	const [rotResult, svResult] = await Promise.all([rot, sv])
	const disk = h.readJson()
	const finalKey = h.plugin.settings.signingKey
	const ok =
		writerKey === OLD_KEY &&
		during.memKey === OLD_KEY &&
		during.writes === 0 &&
		rotResult.value?.changed === true &&
		svResult.error === undefined &&
		finalKey !== OLD_KEY &&
		finalKey === rotResult.value?.key &&
		disk?.signingKey === finalKey &&
		h.plugin.running === false
	return {
		ok,
		text:
			`writerOld=${writerKey === OLD_KEY} duringMemOld=${during.memKey === OLD_KEY} ` +
			`writesDuring=${during.writes} rotated=${rotResult.value?.changed === true} ` +
			`saveErr=${svResult.error ?? 'none'} diskMatchesMemory=${disk?.signingKey === finalKey}`
	}
})

/** E — a failing operation must release the mutex; the next export still runs. */
await guarded('LCK-05', 'E. 失败操作释放锁后，后续导出仍可正常执行且 Writer 收到正确密钥', async setSession => {
	const h = await booted()
	h.writeRaw('null') // present but not a config object → ordinary write is refused
	let failed = false
	try {
		await h.plugin.saveSettings()
	} catch {
		failed = true
	}
	h.writeRaw(JSON.stringify(inited(), null, '\t'))
	const s = await exportSession(h)
	setSession(s)
	await s.release()
	const ok =
		failed === true &&
		s.calls.length === 1 &&
		s.calls[0].signingKey === OLD_KEY &&
		h.plugin.running === false
	return {
		ok,
		text:
			`saveFailed=${failed} writerCalls=${s.calls.length} ` +
			`writerOld=${s.calls[0]?.signingKey === OLD_KEY} running=${h.plugin.running}`
	}
})

/* ================================================ P2 · metadata ======== */
console.log('\nP2 — ExportError 元数据脱敏')

/** 1 — tmpDir carries the full signing key. */
{
	const h = await booted()
	const err = new ExportError('发布失败', 'publish', `html-export/.tmp-${OLD_KEY}`)
	const r = captureReport(h, err)
	const ok =
		!r.threw &&
		!leaksKey(r.notices) &&
		!leaksKey(r.text) &&
		r.notices.includes('[密钥已隐去]') &&
		r.nonString === 0
	record('MD-01', 'ExportError.tmpDir 含完整密钥 → Notice 与 console 均不泄露', ok,
		`threw=${r.threw} noticeLeak=${leaksKey(r.notices)} logLeak=${leaksKey(r.text)} redacted=${r.notices.includes('[密钥已隐去]')} nonStringArgs=${r.nonString}`)
}

/** 2 — stage carries the full signing key. */
{
	const h = await booted()
	const err = new ExportError('发布失败', `publish-${OLD_KEY}`, 'html-export/.tmp-abc')
	const r = captureReport(h, err)
	const ok =
		!r.threw &&
		!leaksKey(r.notices) &&
		!leaksKey(r.text) &&
		r.notices.includes('[密钥已隐去]') &&
		r.nonString === 0
	record('MD-02', 'ExportError.stage 含完整密钥 → 阶段文案被脱敏', ok,
		`threw=${r.threw} noticeLeak=${leaksKey(r.notices)} logLeak=${leaksKey(r.text)} redacted=${r.notices.includes('[密钥已隐去]')} nonStringArgs=${r.nonString}`)
}

/** 3 — hostile getters must not abort the failure handler. */
{
	const h = await booted()
	const base = new ExportError('boom', 'publish', `html-export/.tmp-${OLD_KEY}`)
	const hostile = new Proxy(base, {
		get(t, k, recv) {
			if (k === 'stage' || k === 'tmpDir' || k === 'message' || k === 'stack' || k === 'name' || k === 'code') {
				throw new Error('getter boom')
			}
			return Reflect.get(t, k, recv)
		}
	})
	const r = captureReport(h, hostile)
	const ok =
		!r.threw &&
		!leaksKey(r.notices) &&
		!leaksKey(r.text) &&
		r.notices.includes('unknown') &&
		r.nonString === 0
	record('MD-03', 'stage/tmpDir/message getter 抛异常 → 不向外抛出，阶段回退 unknown，无泄露', ok,
		`instanceofExportError=${hostile instanceof ExportError} threw=${r.threw} noticeLeak=${leaksKey(r.notices)} logLeak=${leaksKey(r.text)} nonStringArgs=${r.nonString}`)
}

/** 4 — a normal ExportError keeps its useful stage and path hints. */
{
	const h = await booted()
	const err = new ExportError('发布失败：目标目录不可验证', 'publish', 'html-export/.tmp-abc')
	const r = captureReport(h, err)
	const ok =
		!r.threw &&
		r.notices.includes('publish') &&
		r.notices.includes('.tmp-abc') &&
		r.notices.includes('本次生成的内容已完整保留在') &&
		r.text.includes('stage=publish') &&
		r.text.includes('tmpDir=') &&
		!leaksKey(r.notices)
	record('MD-04', '正常 ExportError 仍保留阶段与临时目录提示（含 publish 专用文案）', ok,
		`stageKept=${r.notices.includes('publish')} pathKept=${r.notices.includes('.tmp-abc')} consoleStage=${r.text.includes('stage=publish')} threw=${r.threw}`)
}

/** 5 — combined: every shape is checked for both Notice and console. */
{
	const h = await booted()
	const shapes = [
		new ExportError('a', 'publish', `x/${OLD_KEY}`),
		new ExportError('b', `stage-${OLD_KEY}`, 'x/.tmp-1'),
		new ExportError(`c-${OLD_KEY}`, 'verify', 'x/.tmp-2'),
		new Proxy(new ExportError('d', 'publish', `x/${OLD_KEY}`), {
			get(t, k, recv) {
				if (k === 'stage' || k === 'tmpDir') throw new Error('boom')
				return Reflect.get(t, k, recv)
			}
		})
	]
	let clean = true
	let threw = false
	let nonString = 0
	for (const shape of shapes) {
		const r = captureReport(h, shape)
		if (r.threw) threw = true
		if (leaksKey(r.notices) || leaksKey(r.text)) clean = false
		nonString += r.nonString
	}
	record('MD-05', '四种异常形态汇总：Notice 与 console 均无密钥、无原始异常对象', !threw && clean && nonString === 0,
		`shapes=${shapes.length} threw=${threw} clean=${clean} nonStringArgs=${nonString}`)
}

/* ------------------------------------------------------------ not tested -- */
notTested(
	'EX-NT-6',
	'真实 Obsidian 宿主 E2E：导出进程中同步客户端改写 data.json 的时序与 keyLock 表现',
	'本套件使用隔离宿主替身（Node fs adapter + esbuild 模块替身）驱动 runCaptureAndExport；不是运行中的 Obsidian，也不覆盖真实 FileSystemAdapter 的并发语义'
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
