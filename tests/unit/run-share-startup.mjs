/**
 * "Does the share command slow down Obsidian's start?"
 *
 * A plugin's onload is not where this feature lives — the share command is a
 * callback — but the *module* is evaluated when the plugin loads, and a new
 * `require('fs')` at the top of a file would run there on every start. So this
 * measures the two things that actually matter:
 *
 *   1. the cost of evaluating the bundle, against the previous build (the
 *      commit before this round), so the delta is attributable;
 *   2. that loading the bundle touches no filesystem module at all — the
 *      publisher resolves `node:fs` lazily, only when a share is written.
 *
 * Run with: node tests/unit/run-share-startup.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import Module from 'node:module'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '../..')
const tmp = path.join(here, '.tmp', 'startup')
fs.rmSync(tmp, { recursive: true, force: true })
fs.mkdirSync(path.join(tmp, 'node_modules', 'obsidian'), { recursive: true })

/**
 * A CommonJS stub: the built plugin is CJS and `require("obsidian")`s.
 *
 * Only what the bundle touches *at evaluation time* matters here — the classes
 * it `extends` (`Plugin`, `ItemView`, `PluginSettingTab`) must exist, everything
 * else is instantiated later.
 */
fs.writeFileSync(
	path.join(tmp, 'node_modules', 'obsidian', 'index.js'),
	`
class TFile { constructor(p, size = 1) { this.path = p; this.name = String(p).split('/').pop(); this.basename = this.name.replace(/\\.[^.]+$/, ''); this.stat = { size } } }
class TFolder {}
class App {}
class Component { constructor() {} onload() {} onunload() {} registerEvent() {} registerDomEvent() {} registerInterval() {} addChild(c) { return c } }
class Plugin extends Component { constructor(app, manifest) { super(); this.app = app; this.manifest = manifest } addCommand() {} addSettingTab() {} loadData() { return Promise.resolve(null) } saveData() { return Promise.resolve() } }
class ItemView extends Component { constructor(leaf) { super(); this.leaf = leaf; this.containerEl = { children: [null, { empty() {}, addClass() {} }] } } }
class MarkdownView extends ItemView {}
class WorkspaceLeaf {}
class Notice { constructor() {} setMessage() {} hide() {} }
class PluginSettingTab { constructor(app, plugin) { this.app = app; this.plugin = plugin; this.containerEl = {} } }
class Setting { constructor() {} setName() { return this } setDesc() { return this } addText() { return this } addButton() { return this } addToggle() { return this } }
class Modal { constructor() {} }
class Menu { constructor() {} }
function normalizePath(p) { return String(p).replace(/\\\\/g, '/').replace(/\\/{2,}/g, '/').replace(/^\\/+/, '').replace(/\\/+$/, '') }
module.exports = { TFile, TFolder, App, Component, Plugin, ItemView, MarkdownView, WorkspaceLeaf, Notice, PluginSettingTab, Setting, Modal, Menu, normalizePath }
`
)
fs.writeFileSync(
	path.join(tmp, 'node_modules', 'obsidian', 'package.json'),
	JSON.stringify({ name: 'obsidian', version: '0.0.0', main: 'index.js' }, null, 2)
)

/**
 * Baseline build to compare against.
 *
 * `main.js` is a build artefact and is not committed, so there is no "previous
 * build" in git. The honest baseline is therefore the build Obsidian is
 * *actually* loading today: the plugin installed in the live vault. Set
 * `HE_BASELINE_MAIN` to compare against any other file.
 */
const baselineCandidates = [
	process.env.HE_BASELINE_MAIN
].filter(Boolean)

const baselineSource = baselineCandidates.find(candidate => {
	try {
		return fs.statSync(candidate).isFile()
	} catch {
		return false
	}
})
const previousPath = baselineSource ? path.join(tmp, 'baseline.cjs') : null
if (baselineSource) fs.copyFileSync(baselineSource, previousPath)

const currentPath = path.join(tmp, 'current.cjs')
// The project is `"type": "module"`, which makes Node treat `main.js` as ESM and
// refuse its `module.exports`. Copy it next to the stub as `.cjs` so `require`
// loads it exactly the way Obsidian does (as CommonJS).
fs.copyFileSync(path.join(repo, 'main.js'), currentPath)

let passed = 0
const failures = []
function check(name, fn) {
	try {
		fn()
		passed++
		console.log(`  ok   ${name}`)
	} catch (error) {
		failures.push({ name, message: error.message })
		console.log(`  FAIL ${name}`)
		console.log(`       ${error.message}`)
	}
}

/** Load a CJS file once and return { ms, modules }. */
function load(file) {
	const resolved = require.resolve(file)
	delete require.cache[resolved]

	const requested = []
	const original = Module._load
	Module._load = function patched(request, parent, isMain) {
		requested.push(request)
		return original.call(this, request, parent, isMain)
	}
	const started = process.hrtime.bigint()
	try {
		require(file)
	} finally {
		Module._load = original
	}
	const ms = Number(process.hrtime.bigint() - started) / 1e6
	delete require.cache[resolved]
	return { ms, modules: requested }
}

function median(values) {
	const sorted = [...values].sort((a, b) => a - b)
	return sorted[Math.floor(sorted.length / 2)]
}

console.log('\n启动开销（模块求值）')

// Warm-up: the first load pays for reading the file from disk in both cases.
load(currentPath)
if (previousPath) load(previousPath)

const after = []
for (let i = 0; i < 7; i++) after.push(load(currentPath).ms)
const nextMedian = median(after)

if (previousPath) {
	const before = []
	for (let i = 0; i < 7; i++) before.push(load(previousPath).ms)
	const prevMedian = median(before)
	const delta = nextMedian - prevMedian
	check(
		`模块求值耗时（中位数 7 次）：基线 ${prevMedian.toFixed(2)} ms → 本次 ${nextMedian.toFixed(
			2
		)} ms（Δ ${delta >= 0 ? '+' : ''}${delta.toFixed(2)} ms，基线 ${baselineSource}）`,
		() => {
			if (nextMedian > prevMedian * 3 + 5) {
				throw new Error(
					`求值耗时增长过多：${prevMedian.toFixed(2)} → ${nextMedian.toFixed(2)} ms`
				)
			}
		}
	)
} else {
	console.log(
		`  ..   跳过对比（找不到基线构建；本次 ${nextMedian.toFixed(2)} ms）`
	)
}

const loadInfo = load(currentPath)
check('加载时不请求任何文件系统模块（node:fs / fs）', () => {
	const fsRequests = loadInfo.modules.filter(
		name => name === 'fs' || name === 'node:fs' || name === 'node:fs/promises'
	)
	if (fsRequests.length > 0) {
		throw new Error(`加载期间请求了：${fsRequests.join(', ')}`)
	}
})

check('加载期间只请求 obsidian 与内置模块，没有额外第三方依赖', () => {
	const external = loadInfo.modules.filter(
		name =>
			!name.startsWith('node:') &&
			name !== 'obsidian' &&
			// The bundle itself is required by this script; it is not a dependency.
			name !== currentPath &&
			name !== previousPath
	)
	if (external.length > 0) {
		throw new Error(`出现额外依赖：${[...new Set(external)].join(', ')}`)
	}
})

check('加载期间没有访问 DOM / 网络', () => {
	// Node has no `document`: a top-level DOM access would throw during
	// `require`, so a successful load already proves there is none. The network
	// half needs a counter, because `fetch` exists in Node.
	if (typeof globalThis.document !== 'undefined') {
		throw new Error('测试环境意外存在 document，这条断言失去意义')
	}
	const originalFetch = globalThis.fetch
	let calls = 0
	globalThis.fetch = () => {
		calls++
		throw new Error('加载期间不应发起网络请求')
	}
	try {
		load(currentPath)
	} finally {
		globalThis.fetch = originalFetch
	}
	if (calls > 0) throw new Error(`加载期间发起了 ${calls} 次网络请求`)
})

console.log(
	`\n${failures.length === 0 ? '✓' : '✗'} ${passed} 项通过${
		failures.length ? `，${failures.length} 项失败` : ''
	}`
)
if (failures.length) {
	for (const failure of failures) console.log(`  · ${failure.name}: ${failure.message}`)
	process.exit(1)
}
