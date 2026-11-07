/**
 * Round 3.3.3 — 主题保真回归测试（离线）
 *
 * 复现并锁定一个已证实的缺陷：Obsidian 把用户的外观设置写成 `<body>` 的
 * **行内自定义属性**（`setAccentColor` → `--accent-h/s/l`、`--text-on-accent`），
 * 而 `--color-accent: hsl(var(--accent-h), var(--accent-s), var(--accent-l))`
 * 是链接、标签、Callout 底色的唯一来源。旧实现只搬 `body.className`，
 * 于是导出的主题"看起来没生效"：底色来自主题，强调色却退回默认紫色。
 *
 * 同时锁住两条边界：
 *   - 只搬运 `--*`，绝不把 `height/overflow/contain` 带回静态页（EI-01）；
 *   - `document.adoptedStyleSheets` 也要收集（`document.styleSheets` 看不到）。
 *
 * Run with: node tests/unit/run-theme-fidelity.mjs
 */
import { build } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const tmp = path.join(here, '.tmp')

let passed = 0
const failures = []

async function check(name, fn) {
	try {
		await fn()
		passed++
		console.log(`  ok   ${name}`)
	} catch (error) {
		failures.push({ name, message: error.message })
		console.log(`  FAIL ${name}`)
		console.log(`       ${error.message}`)
	}
}

function assert(condition, message) {
	if (!condition) throw new Error(message)
}

function assertMatch(value, regex, label) {
	if (!regex.test(String(value))) {
		throw new Error(`${label}: ${regex} 未匹配 ${JSON.stringify(String(value).slice(0, 300))}`)
	}
}

function assertNotMatch(value, regex, label) {
	if (regex.test(String(value))) {
		throw new Error(`${label}: 不应出现 ${regex}，实际 ${JSON.stringify(String(value).slice(0, 300))}`)
	}
}

/* --------------------------------------------------------------- loading -- */

async function loadModules() {
	fs.mkdirSync(tmp, { recursive: true })
	const entry = path.join(tmp, 'entry-theme.mjs')
	fs.writeFileSync(
		entry,
		`export { pickCustomProperties, snapshotRoot } from '${path
			.join(root, 'src/capture/root-vars.ts')
			.replace(/\\/g, '/')}'
		 export { buildHtml } from '${path
			.join(root, 'src/export/exporter.ts')
			.replace(/\\/g, '/')}'
		 export { collectCss, renderCss } from '${path
			.join(root, 'src/css/css-collector.ts')
			.replace(/\\/g, '/')}'
		`
	)
	const outfile = path.join(tmp, 'bundle-theme.mjs')
	await build({
		entryPoints: [entry],
		outfile,
		bundle: true,
		format: 'esm',
		platform: 'node',
		target: 'node18',
		external: ['obsidian'],
		logLevel: 'silent'
	})
	return import(`${pathToFileURL(outfile).href}?v=${Date.now()}`)
}

/** Minimal sizer stand-in: the exporter only needs cloneNode/outerHTML. */
class FakeSizer {
	constructor(html) {
		this._html = html
	}
	cloneNode() {
		return { outerHTML: this._html }
	}
}

let HE

/* ------------------------------------------------------------ stubs: DOM -- */

function installFakeDom({ htmlStyle = '', htmlAttrs = {}, bodyStyle = '', bodyClass = 'theme-light' } = {}) {
	const htmlAttrsMap = new Map(Object.entries(htmlAttrs))
	if (htmlStyle) htmlAttrsMap.set('style', htmlStyle)
	const bodyAttrsMap = new Map([['class', bodyClass]])
	if (bodyStyle) bodyAttrsMap.set('style', bodyStyle)

	const html = {
		className: htmlAttrsMap.get('class') ?? '',
		getAttribute: name => (htmlAttrsMap.has(name) ? htmlAttrsMap.get(name) : null),
		get attributes() {
			return [...htmlAttrsMap].map(([name, value]) => ({ name, value }))
		},
		get dataset() {
			const out = {}
			for (const [name, value] of htmlAttrsMap) {
				if (!name.startsWith('data-')) continue
				out[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value
			}
			return out
		}
	}

	const body = {
		className: bodyClass,
		getAttribute: name => (bodyAttrsMap.has(name) ? bodyAttrsMap.get(name) : null)
	}

	globalThis.document = { documentElement: html, body, styleSheets: [] }
	return { html, body }
}

/* ------------------------------------------------------------------ run -- */

HE = await loadModules()

console.log('\n[theme] 1. body 行内自定义属性')

await check('T1-1 只保留 --* 声明，丢弃布局属性', () => {
	const out = HE.pickCustomProperties(
		'--accent-h: 347; height: 100%; --accent-s: 66%; overflow: clip; --accent-l: 41%'
	)
	assertMatch(out, /--accent-h:\s*347/, 'accent-h 应该保留')
	assertMatch(out, /--accent-s:\s*66%/, 'accent-s 应该保留')
	assertMatch(out, /--accent-l:\s*41%/, 'accent-l 应该保留')
	assertNotMatch(out, /height/i, 'height 必须被丢弃（否则 EI-01 的滚动锁复活）')
	assertNotMatch(out, /overflow/i, 'overflow 必须被丢弃')
})

await check('T1-2 data URL 里的分号不会切断声明', () => {
	const out = HE.pickCustomProperties(
		'--bg: url(data:image/png;base64,AA;BB); --accent-h: 12; top: 0'
	)
	assertMatch(out, /--bg:\s*url\(data:image\/png;base64,AA;BB\)/, 'data URL 必须完整')
	assertMatch(out, /--accent-h:\s*12/, '后续声明仍要保留')
	assertNotMatch(out, /top:/, 'top 必须被丢弃')
})

await check('T1-3 空值与空字符串安全', () => {
	assert(HE.pickCustomProperties('') === '', '空字符串应返回空字符串')
	assert(HE.pickCustomProperties('height:100%') === '', '纯布局声明应返回空字符串')
	assert(HE.pickCustomProperties('--x:') === '', '空值声明应被丢弃')
})

await check('T2-1 snapshotRoot 捕获 body 的行内强调色', () => {
	installFakeDom({
		htmlStyle: '--sn-text-color: #333',
		htmlAttrs: { class: '', 'data-sn-show-numbers': 'true' },
		bodyStyle: '--accent-h: 347; --accent-s: 66%; --accent-l: 41%; height: 100%',
		bodyClass: 'theme-light obsidian-app'
	})
	const snap = HE.snapshotRoot()
	assertMatch(snap.bodyStyle, /--accent-h:\s*347/, 'bodyStyle 必须含强调色')
	assertNotMatch(snap.bodyStyle, /height/, 'bodyStyle 不得含布局属性')
	assert(snap.bodyClassName.includes('theme-light'), 'body 类名仍需保留')
	assertMatch(snap.style, /--sn-text-color/, 'html 行内变量仍要捕获')
})

await check('T2-2 没有行内样式时 bodyStyle 为空而不是 "undefined"', () => {
	installFakeDom({ bodyClass: 'theme-dark' })
	const snap = HE.snapshotRoot()
	assert(snap.bodyStyle === '', `期望空字符串，实际 ${JSON.stringify(snap.bodyStyle)}`)
})

console.log('\n[theme] 2. 导出 HTML 回放')

await check('T3-1 <body> 带上行内强调色', () => {
	installFakeDom({ bodyStyle: '--accent-h: 347; --accent-s: 66%; --accent-l: 41%' })
	const snap = HE.snapshotRoot()
	const snapshot = {
		notePath: 'docs/doc-01-basic.md',
		noteTitle: 'doc-01-basic',
		capturedAt: '2026-11-04T00:00:00.000Z',
		captureWidth: 890,
		root: snap,
		reading: { className: 'markdown-reading-view', style: '', data: {} },
		preview: { className: 'markdown-preview-view', style: '', data: {} },
		resolution: { sizer: null, readingRoot: null, previewRoot: null, candidates: [], reason: 'test', ambiguity: false, error: null },
		previewMetrics: { width: 890, paddingLeft: 0, paddingRight: 0, readableLineWidth: true, fileLineWidth: null },
		sizer: new FakeSizer('<div class="markdown-preview-sizer"></div>'),
		stats: {},
		warnings: []
	}
	const html = HE.buildHtml(snapshot, { mode: 'preview', cssText: '' })
	assertMatch(html, /<body[^>]*style="[^"]*--accent-h:\s*347/, 'body 标签必须带强调色')
	assertNotMatch(html.split('<body')[1].split('>')[0], /height/, 'body 行内样式不得含 height')
})

await check('T3-2 未设置行内变量时不输出空 style 属性', () => {
	installFakeDom({})
	const snap = HE.snapshotRoot()
	const snapshot = {
		notePath: 'a.md', noteTitle: 'a', capturedAt: '2026-11-04T00:00:00.000Z', captureWidth: 800,
		root: snap,
		reading: { className: 'markdown-reading-view', style: '', data: {} },
		preview: { className: 'markdown-preview-view', style: '', data: {} },
		resolution: { sizer: null, readingRoot: null, previewRoot: null, candidates: [], reason: 'test', ambiguity: false, error: null },
		previewMetrics: { width: 800, paddingLeft: 0, paddingRight: 0, readableLineWidth: true, fileLineWidth: null },
		sizer: new FakeSizer('<div class="markdown-preview-sizer"></div>'),
		stats: {}, warnings: []
	}
	const html = HE.buildHtml(snapshot, { mode: 'preview', cssText: '' })
	assertMatch(html, /<body class="[^"]*">/, '空样式时应保持原样')
})

console.log('\n[theme] 3. 样式表收集完整性')

await check('T4-1 adoptedStyleSheets 也被收集，且排在文档样式之后', async () => {
	globalThis.CSSRule = { IMPORT_RULE: 3 }
	installFakeDom({})
	globalThis.document.styleSheets = [
		{ href: null, ownerNode: { tagName: 'STYLE', id: 'appearance' }, cssRules: [{ type: 1, cssText: 'body{--a:1}' }] }
	]
	globalThis.document.adoptedStyleSheets = [
		{ href: null, ownerNode: null, cssRules: [{ type: 1, cssText: 'body{--b:2}' }] }
	]
	const css = await HE.collectCss({})
	assert(css.sheets.length === 2, `应收集 2 个样式表，实际 ${css.sheets.length}`)
	assert(css.chunks[0].origin === 'inline#0', `第 1 个来源应为 inline#0，实际 ${css.chunks[0].origin}`)
	assert(css.chunks[1].origin === 'adopted#0', `第 2 个来源应为 adopted#0，实际 ${css.chunks[1].origin}`)
	const text = HE.renderCss(css)
	assertMatch(text, /--a:1/, '文档样式必须在导出内')
	assertMatch(text, /--b:2/, 'adopted 样式必须在导出内')
	assert(text.indexOf('--a:1') < text.indexOf('--b:2'), 'adopted 必须排在文档样式之后以保持层叠顺序')
})

await check('T4-2 记录启用的主题与 snippets', async () => {
	globalThis.CSSRule = { IMPORT_RULE: 3 }
	installFakeDom({})
	globalThis.document.styleSheets = [
		{ href: null, ownerNode: { tagName: 'STYLE', id: 'theme' }, cssRules: [{ type: 1, cssText: 'body{--c:3}' }] }
	]
	globalThis.document.adoptedStyleSheets = []
	const css = await HE.collectCss({
		customCss: {
			theme: 'Primary',
			themes: { Primary: { version: '2.10.0' } },
			enabledSnippets: new Set(['a', 'b'])
		}
	})
	assert(css.theme.name === 'Primary', `主题名应为 Primary，实际 ${css.theme.name}`)
	assert(css.theme.version === '2.10.0', `主题版本应为 2.10.0，实际 ${css.theme.version}`)
	assert(css.theme.snippets.join(',') === 'a,b', `snippets 应为 a,b，实际 ${css.theme.snippets.join(',')}`)
})

await check('T4-3 没有 customCss 时不抛异常（旧版/移动端兜底）', async () => {
	globalThis.CSSRule = { IMPORT_RULE: 3 }
	installFakeDom({})
	globalThis.document.styleSheets = []
	globalThis.document.adoptedStyleSheets = []
	const css = await HE.collectCss({})
	assert(css.theme.name === '', '主题名应为空字符串')
	assert(Array.isArray(css.theme.snippets) && css.theme.snippets.length === 0, 'snippets 应为空数组')
})

/* ---------------------------------------------------------------- report -- */

console.log(`\n[theme] ${passed} passed, ${failures.length} failed`)
if (failures.length) {
	for (const f of failures) console.log(`  - ${f.name}: ${f.message}`)
	process.exit(1)
}
