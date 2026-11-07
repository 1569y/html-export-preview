/**
 * P1 — Side Notes 保真回归测试（离线）
 *
 * 锁定的缺陷：长文走离屏渲染时 Side Notes 插件不运行，导出里只剩
 * `<span class="sidenote">`；应用为了「没有空间」把阅读区标成
 * `data-sidenote-mode="hidden"`，这条属性被原样回放，于是 75 条批注
 * 在 HTML 里、却全部 display:none。视觉结果是「批注不见了」。
 *
 * 现在的口径：
 *   - 每条行内批注在导出里重建 `<span class="sidenote-number">` +
 *     `<small class="sidenote-margin">` 配对，编号按文档顺序；
 *   - 行内副本保留（不删文本），由 CSS 裁掉宽度；
 *   - 页面宽度 + 批注栏宽度，正文宽度不变；
 *   - 应用侧的 `data-sidenote-mode` / `data-sidenote-no-room` 不再回放；
 *   - 表格内的批注不强行加栏（保留行内），并如实计数。
 *
 * Run with: node tests/unit/run-p1-sidenotes.mjs
 */
import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { El, parseHtml } from './dom-double.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')

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

function assertEqual(actual, expected, label) {
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
	}
}

function assertMatch(value, regex, label) {
	if (!regex.test(String(value))) {
		throw new Error(`${label}: ${regex} 未匹配 ${JSON.stringify(String(value).slice(0, 300))}`)
	}
}

async function bundle(entry, name) {
	const outfile = path.join(here, '.tmp', `${name}.mjs`)
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

/** A detached body with a real ownerDocument (what the capture clone is). */
function body(html) {
	const parsed = parseHtml(`<div class="markdown-preview-sizer">${html}</div>`)
	const el = parsed.children[0]
	el.ownerDocument = { createElement: tag => new El(tag) }
	return el
}

const layout = await bundle('src/export/sidenote-layout.ts', 'p1-sidenote-layout')
const exporter = await bundle('src/export/exporter.ts', 'p1-exporter')

/* ------------------------------------------------------------ promotion -- */

await check('行内 span.sidenote → 重建 holder + margin 配对', () => {
	const el = body('<p>正文<span class="sidenote">批注甲</span>后半句。</p>')
	const plan = layout.layOutSidenotes(el)
	assertEqual(plan, { margin: 1, inline: 0, reused: 0, room: layout.SIDENOTE_ROOM }, 'plan')

	const holder = el.querySelector('span.sidenote-number')
	assert(holder, '必须生成 .sidenote-number')
	assertEqual(holder.getAttribute('data-sidenote-num'), '1', '编号')
	const margin = holder.querySelector('small.sidenote-margin')
	assert(margin, '必须生成 small.sidenote-margin')
	assertEqual(margin.textContent, '批注甲', '批注正文进入批注栏')
	// The inline copy stays: hide-by-CSS is recoverable, delete is not.
	const inline = holder.querySelector('span.sidenote')
	assert(inline, '行内副本必须保留')
	assertEqual(inline.textContent, '批注甲', '行内副本保留原文')
	assertEqual(el.querySelectorAll('span.sidenote').length, 1, '不重复计数行内副本')
})

await check('编号按文档顺序递增', () => {
	const el = body(
		'<p>一<span class="sidenote">甲</span></p><p>二<span class="sidenote">乙</span></p>' +
			'<p>三<span class="sidenote">丙</span></p>'
	)
	const plan = layout.layOutSidenotes(el)
	assertEqual(plan.margin, 3, '三条')
	const nums = el
		.querySelectorAll('small.sidenote-margin')
		.map(m => m.getAttribute('data-sidenote-num'))
	assertEqual(nums, ['1', '2', '3'], '编号')
})

await check('应用已生成的配对：保留结构、清除应用内的测量值', () => {
	const el = body(
		'<p><span class="sidenote-number" data-sidenote-num="34" style="--sidenote-offset: -12px">' +
			'<span class="sidenote">甲</span>' +
			'<small class="sidenote-margin" data-sidenote-num="34" style="--sidenote-line-offset: 793.95px">甲</small>' +
			'</span></p>'
	)
	const plan = layout.layOutSidenotes(el)
	assertEqual(plan, { margin: 1, inline: 0, reused: 1, room: layout.SIDENOTE_ROOM }, 'plan')
	const margin = el.querySelector('small.sidenote-margin')
	assertEqual(margin.getAttribute('style'), null, '应用的绝对定位测量必须清掉')
	const holder = el.querySelector('span.sidenote-number')
	assertEqual(holder.getAttribute('style'), null, 'holder 上的偏移变量必须清掉')
	assertEqual(margin.getAttribute('data-sidenote-num'), '1', '导出内重新编号')
	assertEqual(el.querySelectorAll('small.sidenote-margin').length, 1, '不得重复生成')
})

await check('表格内的批注不强行加栏，但计入 inline', () => {
	const el = body(
		'<table><tbody><tr><td>单元<span class="sidenote">表内批注</span></td></tr></tbody></table>' +
			'<p>正文<span class="sidenote">段内批注</span></p>'
	)
	const plan = layout.layOutSidenotes(el)
	assertEqual(plan.margin, 1, '只有段落那条进批注栏')
	assertEqual(plan.inline, 1, '表格那条记为行内')
	const spans = el.querySelectorAll('span.sidenote')
	assertEqual(spans.length, 2, '两条文本都还在')
	assertEqual(el.querySelectorAll('small.sidenote-margin').length, 1, '表格内不生成 margin')
})

await check('没有批注 → 不加栏，room 为 0', () => {
	const el = body('<p>纯正文</p>')
	const plan = layout.layOutSidenotes(el)
	assertEqual(plan, { margin: 0, inline: 0, reused: 0, room: 0 }, 'plan')
})

/* ------------------------------------------------------------- exporter -- */

function snapshot(extra = {}) {
	return {
		notePath: 'a.md',
		noteTitle: 'a',
		capturedAt: '2026-11-05T00:00:00.000Z',
		captureWidth: 900,
		root: { className: 'theme-light', style: '', data: {}, bodyClassName: '', bodyStyle: '' },
		reading: {
			className: 'markdown-reading-view',
			style: '',
			data: {
				'data-has-sidenotes': 'true',
				'data-sidenote-mode': 'hidden',
				'data-sidenote-no-room': 'true'
			}
		},
		preview: { className: 'markdown-preview-view', style: '', data: {} },
		sizer: body('<p>正文</p>'),
		stats: { images: 0, mermaid: 0, mermaidWithSvg: 0, sidenotes: 1, sidenoteLeft: 0, sidenoteRight: 1, marginNotes: 0, stylesheets: 1, bytesOfContent: 10, blocks: 1, math: 0 },
		warnings: [],
		...extra
	}
}

await check('有批注栏 → 页面宽度 += 栏宽，且写入 data-he-sidenotes', () => {
	const html = exporter.buildHtml(snapshot({ sidenotes: { margin: 3, inline: 0, reused: 0, room: layout.SIDENOTE_ROOM } }), {
		mode: 'preview',
		cssText: ''
	})
	assertMatch(html, new RegExp(`width:${900 + layout.SIDENOTE_ROOM}px`), '页面宽度')
	assertMatch(html, /data-he-sidenotes="1"/, '标记属性')
	assert(!/data-sidenote-mode=/.test(html), '应用侧 mode 不得回放')
	assert(!/data-sidenote-no-room=/.test(html), '应用侧 no-room 不得回放')
	assertMatch(html, /float: right !important/, '批注栏用浮动定位')
	assertMatch(html, new RegExp(`padding-right: ${layout.SIDENOTE_ROOM}px`), '正文让出栏位')
})

await check('无批注 → 宽度与属性完全不变（P0 几何不回归）', () => {
	const html = exporter.buildHtml(snapshot(), { mode: 'preview', cssText: '' })
	assertMatch(html, /width:900px/, '宽度仍是 captureWidth')
	assertMatch(html, /data-sidenote-mode="hidden"/, '没有批注时不改写属性')
	assert(!/data-he-sidenotes/.test(html), '不加标记')
	assert(!/float: right !important/.test(html), '不注入批注栏 CSS')
})

await check('只有表格批注 → 去掉隐藏状态，但仍保持原宽度', () => {
	const html = exporter.buildHtml(snapshot({ sidenotes: { margin: 0, inline: 2, reused: 0, room: 0 } }), {
		mode: 'preview',
		cssText: ''
	})
	assertMatch(html, /width:900px/, '宽度不变')
	assert(!/data-sidenote-mode=/.test(html), '隐藏状态必须去掉，否则文本不可见')
	assert(!/data-he-sidenotes/.test(html), '没有栏就不加标记')
})

await check('窄窗媒体查询：页面流体 + 极窄回退行内', () => {
	const room = layout.SIDENOTE_ROOM
	const html = exporter.buildHtml(snapshot({ sidenotes: { margin: 1, inline: 0, reused: 0, room } }), {
		mode: 'preview',
		cssText: ''
	})
	assertMatch(html, new RegExp(`@media \\(max-width: ${900 + room}px\\)`), '按页面宽生成断点')
	assertMatch(html, new RegExp(`@media \\(max-width: ${layout.SIDENOTE_INLINE_BELOW}px\\)`), '极窄断点')
	assertMatch(html, /\.sidenote-number > span\.sidenote \{\s*display: inline !important;/, '极窄时把行内副本放回来')
})

/* --------------------------------------------------------------------- */

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
	for (const f of failures) console.log(`FAILED: ${f.name}\n  ${f.message}`)
	process.exitCode = 1
}
