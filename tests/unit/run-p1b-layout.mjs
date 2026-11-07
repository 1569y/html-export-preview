/**
 * P1 visual fidelity — responsive layout, MathJax font inlining, root state.
 *
 * Findings these tests lock down (real daily export, 2026-11-05 15:16):
 *
 *  1. MathJax CHTML fonts were replaced by `url("data:,")` because they live
 *     in app.asar. `document.fonts` reported `error` for every MJX-* family:
 *     a *font* failure, not a render or overflow failure (29 complete
 *     `mjx-container`s, computed overflow `visible`, 0 clipped).
 *  2. Theme/snippet `!important` rules with (0,7,0) specificity beat the
 *     exporter's `[data-he-sidenotes]` rules: the sizer was 1233px inside a
 *     1585px page with 320px of dead space. Fix = id-scoped geometry.
 *  3. `body[data-ch-*]` attributes gate community-plugin CSS. Only the class
 *     list was replayed, so the wrong branch of those rules matched.
 *
 * Run with: node tests/unit/run-p1b-layout.mjs
 */
import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { El, parseHtml } from './dom-double.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')

let passed = 0
const failures = []
const check = async (name, fn) => {
	try {
		await fn()
		passed++
		console.log(`  ok   ${name}`)
	} catch (error) {
		failures.push({ name, message: error.message })
		console.log(`  FAIL ${name}\n       ${error.message}`)
	}
}
const assert = (v, m) => { if (!v) throw new Error(m) }
const equal = (a, b, label) => {
	if (JSON.stringify(a) !== JSON.stringify(b)) {
		throw new Error(`${label}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)
	}
}
const match = (v, re, label) => {
	if (!re.test(String(v))) throw new Error(`${label}: ${re} 未匹配`)
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

const settings = await bundle('src/export/layout-settings.ts', 'p1b-settings')
const layoutCss = await bundle('src/export/layout-css.ts', 'p1b-layout-css')
const cssCollector = await bundle('src/css/css-collector.ts', 'p1b-css-collector')
const exporter = await bundle('src/export/exporter.ts', 'p1b-exporter')

function body(html) {
	const el = parseHtml(`<div class="markdown-preview-sizer">${html}</div>`).children[0]
	el.ownerDocument = { createElement: tag => new El(tag) }
	return el
}

function snapshot(extra = {}) {
	return {
		notePath: 'a.md',
		noteTitle: 'a',
		capturedAt: '2026-11-05T00:00:00.000Z',
		captureWidth: 900,
		root: { className: 'theme-light', style: '', data: {}, bodyClassName: '', bodyStyle: '' },
		reading: { className: 'markdown-reading-view', style: '', data: {} },
		preview: { className: 'markdown-preview-view', style: '', data: {} },
		sizer: body('<p>正文</p>'),
		stats: {},
		warnings: [],
		...extra
	}
}

console.log('\n# P1b — layout settings contract')

await check('默认：自适应居中、原样对齐、100% 缩放', () => {
	equal(settings.DEFAULT_LAYOUT, {
		pageLayout: 'adaptive-center',
		imageAlign: 'as-is',
		mermaidAlign: 'as-is',
		mermaidScale: 1,
		contentMaxWidth: 'theme',
		zoom: 1,
		// P2 预览编辑器新增：纸张颜色跟随实际主题
		background: 'theme',
		backgroundColor: '#ffffff',
		// P2 单元素编辑：默认没有任何单图 / 单图表的覆盖
		mediaOverrides: {}
	}, 'DEFAULT_LAYOUT')
})

await check('缩放被夹在 75%–175%，Mermaid 倍率夹在 0.5–2', () => {
	equal(settings.normalizeLayout({ zoom: 9, mermaidScale: -3 }).zoom, 1.75, 'zoom 上限')
	equal(settings.normalizeLayout({ zoom: 0.1 }).zoom, 0.75, 'zoom 下限')
	equal(settings.normalizeLayout({ mermaidScale: 99 }).mermaidScale, 2, 'mermaid 上限')
	equal(settings.normalizeLayout({ mermaidScale: 0 }).mermaidScale, 0.5, 'mermaid 下限')
	equal(settings.normalizeLayout(null).zoom, 1, '空配置回退默认值')
})

console.log('\n# P1b — responsive CSS')

const GEO = { frameWidth: 1180, room: 280 }

await check('自适应：页面跟随可用宽度 + 中屏两档断点', () => {
	const css = layoutCss.responsiveCss(settings.DEFAULT_LAYOUT, GEO)
	match(css, /width: 100% !important/, '页面跟随预览面板/窗口实际宽度')
	match(css, /max-width: none !important/, '不再用捕获宽度冻结页面')
	match(css, /margin-inline: auto !important/, '页面整体居中')
	match(css, /#he-page\.markdown-reading-view/, 'id 作用域（压过主题 !important）')
	match(css, /--he-frame-width: 1180px/, '捕获宽度只保留为回退/断点变量')
	match(css, /@media \(max-width: 1200px\)/, '中屏断点 1')
	match(css, /@media \(max-width: 900px\)/, '中屏断点 2')
	match(css, /@media \(max-width: 620px\)/, '窄屏回退')
	match(css, /padding-right: 0 !important/, '窄屏取消批注预留')
	match(css, /display: inline !important/, '窄屏行内副本恢复')
})

await check('不隐藏公式溢出，不让容器裁切（禁止 overflow:hidden 了事）', () => {
	const css = layoutCss.responsiveCss(settings.DEFAULT_LAYOUT, GEO)
	match(css, /mjx-container\[jax="CHTML"\]/, '只作用于 CHTML')
	match(css, /overflow: auto !important/, '两轴可滚动查看完整公式')
	assert(!/#he-page[^\n]*overflow: hidden/.test(css), '不得用 hidden 隐藏公式')
})

await check('图片与 Mermaid 跟随容器、保持宽高比', () => {
	const css = layoutCss.responsiveCss(settings.DEFAULT_LAYOUT, GEO)
	match(css, /max-width: 100% !important/, '图片/图表限宽')
	match(css, /height: auto !important/, '高度自适应')
	match(css, /object-fit: contain/, '不拉伸')
	assert(!/transform:\s*scale\(/.test(css), '不得整体 transform:scale()')
})

await check('缩放写入 CSS 文档本身（不是仅预览显示比例）', () => {
	const css = layoutCss.responsiveCss({ zoom: 1.5 }, GEO)
	match(css, /--he-zoom: 1\.5/, 'zoom 值')
	match(css, /zoom: var\(--he-zoom, 1\)/, 'html zoom 声明')
})

await check('pageLayout=as-is 不覆盖容器几何，但缩放仍写入', () => {
	const css = layoutCss.responsiveCss({ pageLayout: 'as-is', zoom: 0.75 }, GEO)
	assert(!/#he-page\.markdown-reading-view/.test(css), '不注入自适应宽度')
	assert(!/--he-room/.test(css), '不注入批注变量')
	match(css, /--he-zoom: 0\.75/, '缩放仍生效')
})

await check('图片居中/ Mermaid 对齐与大小是独立选项', () => {
	const css = layoutCss.responsiveCss({
		imageAlign: 'center',
		mermaidAlign: 'center',
		mermaidScale: 0.8
	}, GEO)
	// 整块移动（Task 1 修复点）：必须覆盖 .image-embed 包裹层，而只动内部 <img> 是不会
	// 让图片真正平移的——旧实现就是把 <img> 居中，但包裹它的 inline-block 仍钉在左缘。
	match(css, /\.image-embed:not\(\.inline\)\s*\{[^}]*display:\s*block !important/, '图片整块变为块级')
	match(css, /\.image-embed:not\(\.inline\)\s*\{[^}]*width:\s*fit-content !important/, '图片整块按内容宽度（保留比例、随窄容器缩放）')
	match(css, /\.image-embed:not\(\.inline\)\s*\{[^}]*margin-left:\s*auto !important[^}]*margin-right:\s*auto !important/, '图片居中：整块左右 auto')
	// Mermaid 同样整块移动，不再依赖 justify-content 在满宽容器里空转（旧实现也只动了没用的那一项）
	match(css, /\.mermaid\s*\{[^}]*display:\s*block !important/, 'Mermaid 整块变为块级')
	match(css, /\.mermaid\s*\{[^}]*width:\s*fit-content !important/, 'Mermaid 整块按内容宽度')
	match(css, /\.mermaid\s*\{[^}]*margin-left:\s*auto !important[^}]*margin-right:\s*auto !important/, 'Mermaid 居中：整块左右 auto')
	match(css, /max-width: min\(100%, 80%\)/, 'Mermaid 倍率')
	assert(!/justify-content:\s*center/.test(css), 'Mermaid 不再用 justify-content 在满宽容器里空转')
	assert(!/#he-page\.markdown-reading-view \{[^}]*text-align/.test(css), '页面居中不得连带把正文文本居中')
})

await check('图片/Mermaid 左、中、右三档产生不同 margin', () => {
	const cssFor = align => layoutCss.responsiveCss({ imageAlign: align, mermaidAlign: 'as-is' }, GEO)
	const imgBlock = name => {
		const c = cssFor(name)
		const m = c.match(/\.image-embed:not\(\.inline\)\s*\{([^}]*)\}/)
		return m ? m[1] : ''
	}
	assert(/margin-left:\s*0 !important[^}]*margin-right:\s*auto !important/.test(imgBlock('left')), '左对齐')
	assert(/margin-left:\s*auto !important[^}]*margin-right:\s*auto !important/.test(imgBlock('center')), '居中')
	assert(/margin-left:\s*auto !important[^}]*margin-right:\s*0 !important/.test(imgBlock('right')), '右对齐')
})

await check('无批注时不注入批注栏变量规则', () => {
	const css = layoutCss.responsiveCss(settings.DEFAULT_LAYOUT, { frameWidth: 900, room: 0 })
	assert(!/padding-right: var\(--he-room\)/.test(css), '无栏不应预留')
	match(css, /width: min\(100%/, '页面仍自适应')
})

console.log('\n# P1b — buildHtml 接线')

await check('HTML 带 he-page id、缩放标记与响应式规则', () => {
	const html = exporter.buildHtml(snapshot(), { mode: 'preview', cssText: '', layout: { zoom: 1.25 } })
	match(html, /id="he-page"/, 'id')
	match(html, /data-he-zoom="1\.25"/, '缩放标记写入 HTML')
	match(html, /data-he-layout="adaptive-center"/, '布局标记')
	match(html, /--he-zoom: 1\.25/, 'CSS 中也写入 zoom')
	match(html, /width: 100% !important/, '响应式规则进入 HTML')
})

await check('body data-* 属性按真实状态回放（高亮/主题规则分支）', () => {
	const snap = snapshot({
		root: {
			className: 'theme-light', style: '', data: {}, bodyClassName: 'theme-light',
			bodyStyle: '', bodyData: { 'data-ch-highlight-style': 'rounded', 'data-he-internal': 'skip' }
		}
	})
	const html = exporter.buildHtml(snap, { mode: 'preview', cssText: '' })
	match(html, /data-ch-highlight-style="rounded"/, '插件状态回放')
	assert(!/data-he-internal/.test(html), '自有标记不回放')
})

await check('body 无 data-* 时标签保持原样（不产生空属性）', () => {
	const html = exporter.buildHtml(snapshot(), { mode: 'preview', cssText: '' })
	match(html, /<body class="[^"]*">/, 'body 标签')
})

await check('正文内容一字不丢，且容器层级仍为三层', () => {
	const snap = snapshot({ sidenotes: { margin: 2, inline: 0, reused: 0, room: 280 } })
	const html = exporter.buildHtml(snap, { mode: 'preview', cssText: '' })
	const inner = html.split(exporter.BODY_START)[1].split(exporter.BODY_END)[0]
	match(inner, /<p>正文<\/p>/, '正文保留')
	equal((html.match(/markdown-preview-sizer/g) ?? []).length >= 1, true, 'sizer 存在')
	const bodyPart = html.slice(html.indexOf('<body'))
	assert(bodyPart.indexOf('markdown-reading-view') < bodyPart.indexOf('markdown-preview-view'), '层级顺序')
	assert(bodyPart.indexOf('markdown-preview-view') < bodyPart.indexOf('markdown-preview-sizer'), '层级顺序')
})

console.log('\n# P1b — MathJax 字体内联')

const FONT_CSS = `@font-face { font-family: MJX-TEX-N; src: url("/lib/mathjax/output/chtml/fonts/woff-v2/mjx-tex-n.woff2") format("woff2"); }
@font-face { font-family: MJX-TEX-I; src: url("app://obsidian.md/lib/mathjax/mjx-tex-i.woff2") format("woff2"); }
.icon { background: url(/lib/mathjax/icon.png); }`

await check('@font-face 内的应用字体被 fetch 并内联为 data URL', async () => {
	const bytes = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 1, 2, 3, 4]) // wOF2
	const urls = []
	const fetchImpl = async url => {
		urls.push(url)
		return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer }
	}
	const warnings = []
	const map = await cssCollector.inlineBundledFonts(
		[{ text: FONT_CSS, origin: 'inline#65' }],
		warnings,
		{ fetchImpl, baseURI: 'app://obsidian.md/index.html' }
	)
	equal(map.size, 2, '内联字体数')
	equal(warnings.length, 0, '不应有警告')
	equal(urls[0], 'app://obsidian.md/lib/mathjax/output/chtml/fonts/woff-v2/mjx-tex-n.woff2', '根相对 URL 解析')
	match(map.get('/lib/mathjax/output/chtml/fonts/woff-v2/mjx-tex-n.woff2'), /^data:font\/woff2;base64,/, 'woff2 MIME')
	match(map.get('app://obsidian.md/lib/mathjax/mjx-tex-i.woff2'), /^data:font\/woff2;base64,/, 'app:// URL')
	assert(![...map.keys()].some(k => k.includes('icon.png')), '非 @font-face 资源不内联')
})

await check('内联字体优先于 asset 回退，未内联的仍走原策略', () => {
	const map = new Map([
		['/lib/mathjax/output/chtml/fonts/woff-v2/mjx-tex-n.woff2', 'data:font/woff2;base64,AAA=']
	])
	const col = {
		chunks: [{ text: FONT_CSS, origin: 'inline#65' }],
		sheets: [], warnings: [], bytes: 0,
		theme: { name: '', version: '', snippets: [] },
		inlineFonts: map, fontsInlined: [...map.keys()]
	}
	const assets = { resolve: () => null }
	const out = cssCollector.renderCss(col, { assets, prefix: 'media/' })
	match(out, /url\("data:font\/woff2;base64,AAA="\)/, '内联字体进入 CSS')
	match(out, /MJX-TEX-I; src: url\("data:,"\)/, '未内联字体保持原回退')
	match(out, /background: url\("data:,"\)/, '非字体资源仍由 asset 收集器处理')
})

await check('fetch 失败时只记警告、不抛错、不内联', async () => {
	const warnings = []
	const map = await cssCollector.inlineBundledFonts(
		[{ text: FONT_CSS, origin: 'inline#65' }],
		warnings,
		{ fetchImpl: async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }), baseURI: 'app://obsidian.md/index.html' }
	)
	equal(map.size, 0, '不内联')
	equal(warnings.length, 2, '每个失败都有警告')
})

await check('无 document.baseURI 的测试宿主静默跳过，不产生伪警告', async () => {
	const warnings = []
	const map = await cssCollector.inlineBundledFonts(
		[{ text: FONT_CSS, origin: 'inline#65' }], warnings,
		{ fetchImpl: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }) }
	)
	equal(map.size, 0, '跳过')
	equal(warnings.length, 0, '无警告')
})

console.log('\n# P1c — 正文宽度与根状态收敛')

await check('默认不硬编码正文宽度，恢复主题 --file-line-width 约束', () => {
	equal(settings.DEFAULT_LAYOUT.contentMaxWidth, 'theme', '默认跟随主题')
	const css = layoutCss.responsiveCss(settings.DEFAULT_LAYOUT, GEO)
	match(css, /max-width: var\(--he-content-max-width, var\(--file-line-width, 700px\)\) !important/, '主题行宽变量')
	// Only the *sizer* rule matters here; the inline sidenote copy still needs
	// its own `max-width: none` to become visible on narrow screens.
	const sizerRule = css.match(/#he-page \.markdown-preview-sizer \{[^}]*\}/)?.[0] ?? ''
	assert(!/max-width: none/.test(sizerRule), 'sizer 不再覆盖主题宽度约束')
	assert(!/--he-content-max-width:\s*\d+px/.test(css), '默认不注入固定像素宽度')
	match(css, /is-readable-line-width/, '仅在主题启用可读行宽时约束')
	match(css, /margin-inline: auto !important/, '正文块在页面内居中')
})

await check('给定上限时只覆盖一个 CSS 变量，且被夹在安全范围', () => {
	const css = layoutCss.responsiveCss({ contentMaxWidth: 900 }, GEO)
	match(css, /--he-content-max-width: 900px/, '用户上限写入 HTML')
	match(css, /calc\(var\(--he-content-max-width\) \+ var\(--he-room\)\)/, '侧注栏单独补足')
	// 用户选的像素上限必须在关闭「可读行宽」的主题上同样生效；旧实现把它
	// 限定在 .is-readable-line-width，导致正文最大宽度控件在真实预览里无效。
	const plain = layoutCss.responsiveCss({ contentMaxWidth: 900 }, { frameWidth: 1180, room: 0 })
	assert(!/is-readable-line-width/.test(plain), '数值上限不依赖主题的可读行宽开关')
	match(plain, /#he-page \.markdown-preview-sizer \{\s*max-width: var\(--he-content-max-width\) !important/, '数值上限直接作用于 sizer')
	equal(settings.normalizeLayout({ contentMaxWidth: 99999 }).contentMaxWidth, 4000, '上限')
	equal(settings.normalizeLayout({ contentMaxWidth: 10 }).contentMaxWidth, 320, '下限')
	equal(settings.normalizeLayout({ contentMaxWidth: 'theme' }).contentMaxWidth, 'theme', '非法值回退主题')
})

await check('pageLayout=as-is 不注入正文宽度规则（原样模式不干预主题）', () => {
	const css = layoutCss.responsiveCss({ pageLayout: 'as-is' }, GEO)
	assert(!/is-readable-line-width/.test(css), '原样模式保持主题自身规则')
})

await check('根 data-* 只回放 CSS 引用过的属性，剔除无关/敏感状态', () => {
	const allow = cssCollector.referencedDataAttributes([
		{ text: 'body[data-ch-highlight-style="rounded"] mark { color: red }', origin: 'a' },
		{ text: 'html[data-sn-show-numbers] .sidenote { color: blue }', origin: 'b' }
	])
	equal(allow.has('data-ch-highlight-style'), true, '高亮状态被 CSS 引用')
	equal(allow.has('data-sn-show-numbers'), true, '侧注状态被 CSS 引用')
	const snap = snapshot({
		root: {
			className: 'theme-light', style: '',
			data: {
				'data-sn-show-numbers': 'true',
				'data-vault-id': 'sensitive',
				'data-sidenote-mode': 'hidden',
				'data-he-internal': 'skip'
			},
			bodyClassName: 'theme-light', bodyStyle: '',
			bodyData: { 'data-ch-highlight-style': 'rounded', 'data-user-token': 'secret' }
		}
	})
	const html = exporter.buildHtml(snap, { mode: 'preview', cssText: '', rootDataAllow: allow })
	match(html, /data-sn-show-numbers="true"/, '样式所需的 html 状态保留')
	match(html, /data-ch-highlight-style="rounded"/, '样式所需的 body 状态保留')
	assert(!/data-vault-id/.test(html), '无关 html 状态剔除')
	assert(!/data-user-token/.test(html), '敏感 body 状态剔除')
	assert(!/data-sidenote-mode/.test(html), '应用侧 pane 状态剔除')
	assert(!/data-he-internal/.test(html), '自有标记剔除')
})

await check('未提供 allow 时兼容旧调用，仅剔除自有标记与 pane 状态', () => {
	const snap = snapshot({
		root: {
			className: '', style: '', data: { 'data-plugin-state': 'on' },
			bodyClassName: '', bodyStyle: '', bodyData: {}
		}
	})
	const html = exporter.buildHtml(snap, { mode: 'preview', cssText: '' })
	match(html, /data-plugin-state="on"/, '兼容旧调用')
})

console.log(`\n${failures.length === 0 ? '✓' : '✗'} ${passed} 项通过${failures.length ? `，${failures.length} 项失败` : ''}`)
if (failures.length) {
	for (const f of failures) console.log(`  - ${f.name}: ${f.message}`)
	process.exit(1)
}
