/**
 * Border theme — "CSS rendered as body text" regression.
 *
 * Root cause (0.1.1): buildHtml() inlined collected CSS verbatim into
 * `<style>…</style>`. HTML parses `<style>` as RAWTEXT, so the first
 * `</style` ends the element even when it appears inside a CSS string.
 * Border's theme.css embeds inline SVG in `-webkit-mask-image:
 * url('data:image/svg+xml;utf8,<svg><defs><style>…</style></defs>…')` —
 * 19 such pairs — via collectCss()'s raw-text paths. Every rule after the
 * first one was then parsed as visible body text, and the remaining theme
 * rules silently stopped applying.
 *
 * Run with: node tests/unit/run-border-css-boundary.mjs
 */
import { build } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { El, parseHtml } from './dom-double.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const tmp = path.join(here, '.tmp')
fs.mkdirSync(tmp, { recursive: true })

let passed = 0
const failures = []
async function check(name, fn) {
	try {
		await fn()
		passed++
		console.log(`  ok   ${name}`)
	} catch (error) {
		failures.push({ name, message: error.message })
		console.log(`  FAIL ${name}\n       ${error.message}`)
	}
}
function assert(condition, message) {
	if (!condition) throw new Error(message)
}
function equal(a, b, label) {
	if (JSON.stringify(a) !== JSON.stringify(b)) {
		throw new Error(`${label}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)
	}
}
function assertMatch(value, re, label) {
	if (!re.test(String(value))) throw new Error(`${label}: ${re} 未匹配`)
}
function assertNoMatch(value, re, label) {
	if (re.test(String(value))) {
		throw new Error(`${label}: 不应出现 ${re}，实际 ${JSON.stringify(String(value).slice(0, 220))}`)
	}
}

async function bundle(entry, name) {
	const outfile = path.join(tmp, `${name}.mjs`)
	await build({
		entryPoints: [path.join(root, entry)],
		outfile,
		bundle: true,
		format: 'esm',
		platform: 'node',
		target: 'node18',
		logLevel: 'silent'
	})
	return import(`${pathToFileURL(outfile).href}?v=${Date.now()}`)
}

const boundary = await bundle('src/css/style-boundary.ts', 'border-style-boundary')
const exporter = await bundle('src/export/exporter.ts', 'border-exporter')
const collector = await bundle('src/css/css-collector.ts', 'border-css-collector')
const audit = await bundle('src/export/share-audit.ts', 'border-share-audit')
const { buildHtml, BODY_START, BODY_END } = exporter
const { renderCss, collectCss } = collector
const { countStyleEndTags, neutralizeStyleEndTags, assertEmbeddableCss } = boundary
const { auditShareDocument } = audit

/* ------------------------------------------------------------- fixtures -- */

const PROBE_RULE = '.he-probe { --he-probe: 1; }'

/** Border's real shape: an SVG data URI with an embedded <style> element. */
function svgMask(selector) {
	return `${selector} {
  -webkit-mask-image: url('data:image/svg+xml;utf8,<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><defs><style>.cls-1{fill:none;}</style></defs><rect class="cls-1" width="10" height="10"/></svg>');
  content: '';
}
`
}

const MINIMAL_BORDER_CSS =
	svgMask('body:not(.collapse-icon-restore) :is(.markdown-rendered, .markdown-preview-view) h1') +
	svgMask('body:not(.disable-alternative-checkboxes) li[data-task="*"]>input:checked') +
	'\nbody:not(.x) .markdown-rendered h2 { color: red; }\n' +
	'.HyperMD-header { color: blue; }\n' +
	'.markdown-rendered p { line-height: 1.5; }\n' +
	PROBE_RULE + '\n'

/** 19 `<style>…</style>` pairs, matching the real Border theme count. */
let FULL_BORDER_LIKE = ''
for (let i = 1; i <= 19; i++) {
	FULL_BORDER_LIKE += svgMask(`body:not(.rule-${i}) .markdown-rendered h${i % 6 + 1}`)
}
FULL_BORDER_LIKE += '\n.HyperMD-header { color: blue; }\n' + PROBE_RULE + '\n'

const DEFAULT_CSS =
	'.markdown-rendered h1 { color: rebeccapurple; }\n' +
	'.markdown-rendered p { line-height: 1.5; }\n' + PROBE_RULE + '\n'

const NOTE_BODY = `<p dir="auto">普通段落 Ordinary paragraph</p>
<h1 data-heading="Heading" dir="auto" id="Heading">Heading</h1>
<ul><li>one</li><li>two</li></ul>
<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>
<pre><code class="language-js">const x = 1</code></pre>
<blockquote><p>quote</p></blockquote>`

function sizerFromHtml(html) {
	const el = parseHtml(`<div class="markdown-preview-sizer">${html}</div>`).children[0]
	el.ownerDocument = { createElement: tag => new El(tag) }
	return el
}

function snapshot(bodyHtml = NOTE_BODY) {
	return {
		notePath: 'a.md',
		noteTitle: 'a',
		capturedAt: '2026-11-08T00:00:00.000Z',
		captureWidth: 900,
		root: { className: 'theme-light', style: '', data: {}, bodyClassName: '', bodyStyle: '' },
		reading: { className: 'markdown-reading-view', style: '', data: {} },
		preview: { className: 'markdown-preview-view markdown-rendered', style: '', data: {} },
		sizer: sizerFromHtml(bodyHtml),
		stats: {},
		warnings: []
	}
}

function collection(text, origin = 'inline#0') {
	return {
		chunks: [{ text, origin }],
		sheets: [],
		warnings: [],
		bytes: text.length,
		theme: { name: '', version: '', snippets: [] },
		inlineFonts: new Map(),
		fontsInlined: [],
		remoteImports: [],
		offline: false
	}
}

/**
 * HTML RAWTEXT rule: `<style>` content ends at the first `</style` (case
 * insensitive). This is what a browser parser does — the same rule the
 * Chromium DOM verification uses. Everything outside these blocks would be
 * parsed as markup / visible text.
 */
const STYLE_BLOCK_RE = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi
function styleBlocks(html) {
	return [...html.matchAll(STYLE_BLOCK_RE)].map(m => m[1])
}
function outsideStyleBlocks(html) {
	return html.replace(STYLE_BLOCK_RE, '')
}
function bodyMarkup(html) {
	const start = html.indexOf('<body')
	const end = html.indexOf('</body>')
	return start >= 0 && end > start ? html.slice(start, end) : ''
}

function render(mode, css, opts = {}) {
	const cssText = renderCss(collection(css), { comments: mode === 'preview' })
	return {
		cssText,
		html: buildHtml(snapshot(opts.body), {
			mode,
			cssText: mode === 'export' ? '' : cssText,
			layout: opts.layout
		})
	}
}

/* -------------------------------------------------------------- 1. helper -- */

console.log('\n# 1. style-boundary helper')

await check('1.1 检测 </style> / </STYLE> / 多处，安全 CSS 返回 0', () => {
	equal(countStyleEndTags('a{} </style> b{}'), 1, 'lowercase')
	equal(countStyleEndTags('a{} </STYLE > b{}'), 1, 'uppercase')
	equal(countStyleEndTags('</style></style></STYLE>'), 3, 'multiple')
	equal(countStyleEndTags(DEFAULT_CSS), 0, 'safe css')
	equal(countStyleEndTags('<\\/style>'), 0, 'already escaped')
})

await check('1.2 neutralize 转义且幂等，CSS 语义可从 \\/ 还原', () => {
	const r = neutralizeStyleEndTags(MINIMAL_BORDER_CSS)
	equal(r.count, 2, 'escaped count')
	equal(countStyleEndTags(r.text), 0, 'no breakers left')
	assert(r.text.includes('<\\/style>'), 'escape form <\\/style present')
	// `\/` is a CSS escape for `/`; decoding the escapes restores the original
	// CSS text byte-for-byte, so the SVG data URI is unchanged.
	equal(r.text.replace(/\\\//g, '/'), MINIMAL_BORDER_CSS, 'CSS value preserved')
	const again = neutralizeStyleEndTags(r.text)
	equal(again.count, 0, 'idempotent')
	equal(again.text, r.text, 'idempotent text')
})

await check('1.3 safe CSS 原样返回（默认主题零改动）', () => {
	const r = neutralizeStyleEndTags(DEFAULT_CSS)
	equal(r.count, 0, 'count')
	equal(r.text, DEFAULT_CSS, 'byte identical')
})

await check('1.4 assertEmbeddableCss 对残留序列抛错、对已转义通过', () => {
	let threw = false
	try { assertEmbeddableCss('p{} </style><script>x</script>') } catch (e) { threw = /中止生成|显示为正文/.test(e.message) }
	assert(threw, 'raw breaker must throw with a visible reason')
	assertEmbeddableCss(neutralizeStyleEndTags('</style>').text)
})

await check('1.5 成功转义是静默成功，不产生告警也不抛出', () => {
	const { text, count } = neutralizeStyleEndTags(FULL_BORDER_LIKE)
	assert(count > 0, 'fixture really carries SVG style end tags')
	equal(countStyleEndTags(text), 0, 'no residual breakers')
	assertEmbeddableCss(text) // must not throw
})

/* -------------------------------------------------- 2. HTML 结构（RAWTEXT） -- */

console.log('\n# 2. buildHtml — HTML RAWTEXT 边界（模拟浏览器解析）')

for (const [label, css, breakers] of [
	['默认主题', DEFAULT_CSS, 0],
	['Border 最小触发样本', MINIMAL_BORDER_CSS, 2],
	['Border 全量特征（19 处）', FULL_BORDER_LIKE, 19]
]) {
	for (const mode of ['preview', 'single']) {
		await check(`2.${label}/${mode}：样式块完整、正文无主题 CSS`, () => {
			const { html, cssText } = render(mode, css)
			const blocks = styleBlocks(html)
			equal(blocks.length, 2, `${label}/${mode} style block count`)
			equal((html.match(/<\/style\s*>/gi) || []).length, 2, 'exactly two style end tags')
			assertNoMatch(blocks[0], /<\/style/i, 'no raw end tag inside collected CSS')
			assert(blocks[0].includes(PROBE_RULE), 'tail rule still inside the style element')
			assert(
				blocks[0].includes(cssText.trim().slice(-60)),
				'full collected CSS reached the style element (no truncation)'
			)
			if (breakers > 0) {
				equal((blocks[0].match(/<\\\/style>/gi) || []).length, breakers, 'escaped sequences')
			} else {
				equal((blocks[0].match(/<\\\/style>/gi) || []).length, 0, 'no escapes for default theme')
			}
			// explicit: no rule collected from the theme leaks into the body
			const outside = outsideStyleBlocks(html)
			const body = bodyMarkup(html)
			for (const marker of ['body:not(', '.HyperMD-header', '-webkit-mask-image']) {
				assertNoMatch(outside, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${marker} outside style blocks`)
				assert(!body.includes(marker), `${marker} must not appear in body markup`)
			}
			// note content stays complete and in order
			assert(html.includes(BODY_START) && html.includes(BODY_END), 'body markers')
			assert(body.includes('普通段落 Ordinary paragraph'), 'paragraph')
			assert(body.includes('<h1'), 'heading')
			assert(body.includes('<li>one</li>'), 'list')
			assert(body.includes('<table'), 'table')
			assert(body.includes('<pre'), 'code block')
			assert(body.includes('<blockquote'), 'blockquote')
			assert(
				body.indexOf('普通段落') < body.indexOf('<h1') && body.indexOf('<h1') < body.indexOf('<table'),
				'content order'
			)
		})
	}
}

await check('2.7 目录导出用 <link>，CSS 文件逐字不变且不含 HTML 转义', () => {
	const { html, cssText } = render('export', FULL_BORDER_LIKE)
	assert(html.includes('<link rel="stylesheet" href="assets/export.css">'), 'linked stylesheet')
	assertNoMatch(html, /<style>\s*\/\* ==== /, 'theme CSS not inlined into HTML')
	equal(styleBlocks(html).length, 1, 'only the generated BASE_CSS block')
	equal(cssText, FULL_BORDER_LIKE, 'export.css byte-identical to collected CSS')
	equal(countStyleEndTags(cssText), 19, 'raw CSS file keeps its SVG <style> pairs (a .css file needs no escaping)')
})

/* --------------------------------------------------- 3. 特殊字符串与注入 -- */

console.log('\n# 3. CSS 特殊字符串 / HTML 样式标签边界 / 注入防护')

await check('3.1 大小写与尾随空白变体全部转义', () => {
	const css = 'a{} </STYLE> b{} </style > c{} </Style/> d{}'
	const r = neutralizeStyleEndTags(css)
	equal(r.count, 3, 'all variants detected')
	equal(countStyleEndTags(r.text), 0, 'none survive')
	equal(r.text.replace(/\\\//g, '/'), css, 'semantics preserved')
})

await check('3.2 CSS 注释内的 </style> 也被转义（注释不受 CSS 转义影响）', () => {
	const css = '/* </style> */\np { color: red; }\n' + PROBE_RULE
	const r = neutralizeStyleEndTags(css)
	equal(r.count, 1, 'detected in comment')
	const { html } = render('preview', css)
	equal(styleBlocks(html).length, 2, 'no premature style end')
	assert(styleBlocks(html)[0].includes(PROBE_RULE), 'following rule still CSS')
})

await check('3.3 data URI 中的引号 / SVG / 注释 / 特殊字符完整保留', () => {
	const css =
		`p::before { content: "a'b\\\"c"; ` +
		`background: url('data:image/svg+xml;utf8,<svg x="1"><defs><style>.x{}</style></defs><!-- c --></svg>'); }\n` +
		PROBE_RULE
	const r = neutralizeStyleEndTags(css)
	equal(r.count, 1, 'one breaker')
	equal(r.text.replace(/\\\//g, '/'), css, 'data URI + quotes + comment preserved')
	const { html } = render('single', css)
	assert(styleBlocks(html)[0].includes(PROBE_RULE), 'rule after data URI still inside CSS')
	equal(styleBlocks(html).length, 2, 'single style element for the theme')
})

await check('3.4 试图用 </style><script> 逃出样式块：不得生成脚本元素', () => {
	const css = 'p { color: red; }\n</style><script>window.__pwned = 1</script>\n' + PROBE_RULE
	const { html } = render('single', css)
	equal(styleBlocks(html).length, 2, 'style element not terminated early')
	const outside = outsideStyleBlocks(html)
	assert(!outside.includes('<script'), 'no script element in markup')
	assert(!outside.includes('__pwned'), 'no injected payload outside CSS text')
	assert(styleBlocks(html)[0].includes('<\\/style>'), 'breaker escaped inside CSS')
	const result = auditShareDocument(html)
	equal(result.executable.length, 0, 'share audit reports no executable content')
	equal(result.styleBlocks, 2, 'share audit sees exactly the two style blocks')
})

await check('3.5 多处连续 </style></style> 不互相吞掉', () => {
	const css = '</style>'.repeat(8) + '\n' + PROBE_RULE
	const r = neutralizeStyleEndTags(css)
	equal(r.count, 8, 'all 8 escaped')
	equal(countStyleEndTags(r.text), 0, 'no survivors')
	const { html } = render('preview', css)
	equal(styleBlocks(html).length, 2, 'still one collected-CSS style element')
	assert(styleBlocks(html)[0].includes(PROBE_RULE), 'tail rule intact')
})

/* -------------------------------------------------- 4. 收集器集成与降级 -- */

console.log('\n# 4. 收集器集成：静默成功 / 安全降级')

await check('4.1 cssRules 不可读时走原始文本，成功转义不产生虚假 CSS 警告', async () => {
	globalThis.CSSRule = { IMPORT_RULE: 3 }
	globalThis.document = {
		styleSheets: [
			{
				href: null,
				ownerNode: { tagName: 'STYLE', id: 'theme', textContent: MINIMAL_BORDER_CSS },
				get cssRules() { throw new Error('SecurityError') }
			}
		],
		adoptedStyleSheets: []
	}
	const css = await collectCss({})
	equal(css.sheets[0].method, 'raw', 'raw-text fallback used')
	equal(countStyleEndTags(css.chunks[0].text), 2, 'raw CSS keeps its breakers verbatim')
	// `reportSuccess()` prints warnings.length as "CSS 警告 N 条". A clean,
	// successfully escaped export must contribute zero to that count.
	const spurious = css.warnings.filter(w => w.includes('</style>') || w.includes('转义'))
	equal(spurious.length, 0, 'no false "CSS 警告" for a successful escape')
	// ...and the embedding boundary still neutralises it.
	const { html } = (() => {
		const t = renderCss(css)
		return {
			html: buildHtml(snapshot(), { mode: 'preview', cssText: t })
		}
	})()
	equal(styleBlocks(html).length, 2, 'still safe after the raw fallback')
	assert(styleBlocks(html)[0].includes(PROBE_RULE), 'all CSS still applies')
	delete globalThis.document
})

await check('4.2 @import 内联路径同样是原始文本，仍被嵌入边界覆盖', async () => {
	const imported =
		'body:not(.x) .markdown-rendered p { color: red; }\n' +
		svgMask('body:not(.y) .markdown-rendered h1') + PROBE_RULE
	globalThis.CSSRule = { IMPORT_RULE: 3 }
	globalThis.document = {
		styleSheets: [
			{
				href: 'app://vault/theme.css',
				ownerNode: { tagName: 'LINK', id: 'theme' },
				get cssRules() { throw new Error('SecurityError') }
			}
		],
		adoptedStyleSheets: []
	}
	const app = {
		vault: { adapter: { exists: async () => true, read: async () => imported } }
	}
	// readByUrl resolves app://<host>/<path> against the vault adapter.
	const css = await collectCss(app)
	assert(css.chunks[0].text.includes('body:not(.x)'), 'raw imported CSS inlined')
	const { html } = (() => {
		const t = renderCss(css)
		return { html: buildHtml(snapshot(), { mode: 'preview', cssText: t }) }
	})()
	equal(styleBlocks(html).length, 2, 'no early style end from inlined @import CSS')
	assertNoMatch(styleBlocks(html)[0], /<\/style/i, 'imported CSS neutralised')
	delete globalThis.document
})

await check('4.3 无法安全嵌入时中止而不是静默输出', () => {
	let threw = false
	try { assertEmbeddableCss('</style><script>bad()</script>') } catch (e) {
		threw = /中止生成/.test(e.message) && /显示为正文/.test(e.message)
	}
	assert(threw, 'visible refusal instead of a silently broken page')
})

/* ----------------------------------------------------------- report -- */

console.log(`\n[border-css] ${passed} passed, ${failures.length} failed`)
if (failures.length) {
	for (const f of failures) console.log(`  - ${f.name}: ${f.message}`)
	process.exit(1)
}
