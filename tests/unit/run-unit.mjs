/**
 * Offline unit tests for the three review findings that can be checked without
 * a running Obsidian:
 *
 *   R1 — the exported DOM must contain exactly one `.markdown-preview-sizer`,
 *        nested as reading-view > preview-view > sizer. The bug was the
 *        exporter wrapping an already-cloned sizer in a second one, which
 *        doubles the layout box and breaks every `--sidenote-*` offset that
 *        was measured against the original.
 *   R2 — `renderCss` must rewrite relative references through the asset
 *        collector, leave `data:`/`http(s):` alone, and emit an inert
 *        placeholder (never a dead path) when a reference cannot be resolved.
 *   R3 — `AssetCollector.resolve` must refuse `blob:`, `file://` and relative
 *        references explicitly, never guess between ambiguous candidates, and
 *        report every refusal instead of silently dropping it.
 *
 * Run with: npm run test:unit
 */
import { build } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const tmp = path.join(here, '.tmp')

/* --------------------------------------------------------------- harness -- */

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
	const a = JSON.stringify(actual)
	const e = JSON.stringify(expected)
	if (a !== e) throw new Error(`${label}: expected ${e}, got ${a}`)
}

function assertMatch(value, regex, label) {
	if (!regex.test(value)) throw new Error(`${label}: ${regex} did not match ${JSON.stringify(String(value).slice(0, 300))}`)
}

/* ---------------------------------------------------------- bundling glue -- */

/**
 * The tested modules import `obsidian` for `TFile` / `normalizePath`. We keep
 * that import *external* and drop a tiny module into `.tmp/node_modules`, so
 * Node resolves it normally and the test and the bundle share one copy of the
 * `TFile` class (otherwise `instanceof` would fail across bundle boundaries).
 */
function prepareObsidianStub() {
	const dir = path.join(tmp, 'node_modules', 'obsidian')
	fs.mkdirSync(dir, { recursive: true })
	fs.copyFileSync(
		path.join(here, 'obsidian-stub.mjs'),
		path.join(dir, 'index.mjs')
	)
	fs.writeFileSync(
		path.join(dir, 'package.json'),
		JSON.stringify(
			{
				name: 'obsidian',
				version: '0.0.0-stub',
				type: 'module',
				main: 'index.mjs',
				exports: './index.mjs'
			},
			null,
			2
		)
	)
	return pathToFileURL(path.join(dir, 'index.mjs')).href
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
		external: ['obsidian'],
		logLevel: 'silent'
	})
	return import(`${pathToFileURL(outfile).href}?v=${Date.now()}`)
}

/* ------------------------------------------------------------- DOM double -- */

/**
 * The exporter only touches `cloneNode`, `outerHTML`, `querySelectorAll` and
 * `setAttribute` on the cloned sizer. A real DOM is not needed to assert the
 * element chain, and keeping the double honest (it records every mutation)
 * makes a second wrapper impossible to hide.
 */
class FakeElement {
	constructor(html) {
		this.outerHTML = html
		this.attrs = {}
		this.queried = []
	}

	cloneNode() {
		const copy = new FakeElement(this.outerHTML)
		copy.attrs = { ...this.attrs }
		return copy
	}

	querySelectorAll(selector) {
		this.queried.push(selector)
		return []
	}

	setAttribute(name, value) {
		this.attrs[name] = value
	}

	getAttribute(name) {
		return this.attrs[name] ?? null
	}
}

const SIZER_HTML =
	'<div class="markdown-preview-sizer markdown-preview-sizer--x" style="min-height:900px">' +
	'<p>正文<span class="sidenote-number" data-sidenote-num="1">' +
	'<small class="sidenote-margin" data-sidenote-num="1">第一条批注</small>' +
	'</span></p></div>'

function makeSnapshot(overrides = {}) {
	return {
		notePath: 'html-export-test/left-side.md',
		noteTitle: 'left-side',
		capturedAt: '2025-01-01T00:00:00.000Z',
		captureWidth: 900,
		root: {
			className: 'theme-dark is-mobile',
			style: '--sn-font-size:14px; --sn-text-color:#bbb',
			data: { 'data-sn-layout': 'bake' },
			bodyClassName: 'is-mobile'
		},
		reading: { className: 'markdown-reading-view', style: '', data: {} },
		preview: {
			className: 'markdown-preview-view',
			style: 'padding:0 16px',
			data: {}
		},
		sizer: new FakeElement(SIZER_HTML),
		stats: {
			images: 0,
			mermaid: 0,
			mermaidWithSvg: 0,
			sidenotes: 1,
			sidenoteLeft: 0,
			sidenoteRight: 1,
			marginNotes: 0,
			stylesheets: 3,
			bytesOfContent: SIZER_HTML.length
		},
		warnings: [],
		...overrides
	}
}

/* ------------------------------------------------------------------ tests -- */

async function main() {
	fs.mkdirSync(tmp, { recursive: true })
	const stubUrl = prepareObsidianStub()
	const { TFile } = await import(stubUrl)

	console.log('\nR1 — 导出 DOM 层级')
	const { buildHtml, sanitizeReadingStyle } = await bundle(
		'src/export/exporter.ts',
		'exporter'
	)

	const sizerClassMatches = html =>
		html.match(/class="[^"]*\bmarkdown-preview-sizer\b[^"]*"/g) ?? []

	await check('导出结果只有一个 .markdown-preview-sizer', () => {
		const html = buildHtml(makeSnapshot(), { mode: 'preview', cssText: '' })
		const hits = sizerClassMatches(html)
		assertEqual(hits.length, 1, '.markdown-preview-sizer 出现次数')
	})

	await check('层级顺序为 reading-view > preview-view > sizer', () => {
		const html = buildHtml(makeSnapshot(), { mode: 'preview', cssText: '' })
		// Scope to <body>: BASE_CSS also mentions these class names, and an
		// `indexOf` over the whole document would pass on the stylesheet alone.
		const body = html.slice(html.indexOf('<body'))
		const reading = body.indexOf('markdown-reading-view')
		const preview = body.indexOf('markdown-preview-view')
		const sizer = body.indexOf('markdown-preview-sizer')
		assert(reading >= 0 && preview >= 0 && sizer >= 0, '三层容器都必须存在')
		assert(reading < preview, 'reading-view 必须在 preview-view 之前')
		assert(preview < sizer, 'preview-view 必须在 sizer 之前')
	})

	await check('不存在嵌套的第二层 sizer', () => {
		const html = buildHtml(makeSnapshot(), { mode: 'preview', cssText: '' })
		assert(
			!/markdown-preview-sizer[^>]*>\s*<div[^>]*markdown-preview-sizer/.test(html),
			'发现 sizer 内部又包了一层 sizer'
		)
	})

	await check('sizer 的原始 class 与内联样式被完整保留', () => {
		const html = buildHtml(makeSnapshot(), { mode: 'preview', cssText: '' })
		assertMatch(html, /class="markdown-preview-sizer markdown-preview-sizer--x"/, 'sizer class')
		assertMatch(html, /style="min-height:900px"/, 'sizer 内联样式')
	})

	await check('<html> 的 class / style / data-* 被回放', () => {
		const html = buildHtml(makeSnapshot(), { mode: 'preview', cssText: '' })
		assertMatch(html, /<html class="theme-dark is-mobile"/, 'html class')
		assertMatch(html, /style="--sn-font-size:14px; --sn-text-color:#bbb"/, 'html style')
		assertMatch(html, /data-sn-layout="bake"/, 'html data-*')
	})

	await check('captureWidth 应用到 reading-view 容器', () => {
		const html = buildHtml(makeSnapshot(), { mode: 'preview', cssText: '' })
		assertMatch(html, /width:900px/, 'reading-view 宽度')
	})

	await check('导出模式改用外链样式表，不再内联 CSS', () => {
		const html = buildHtml(makeSnapshot(), {
			mode: 'export',
			cssText: 'body{color:red}',
			assets: { resolve: () => null }
		})
		assertMatch(html, /<link rel="stylesheet" href="assets\/export\.css">/, '外链样式表')
		assert(!html.includes('body{color:red}'), '导出模式不应内联 CSS')
	})

	// Negative control: the assertion must actually catch the original bug.
	await check('反向对照：多包一层 sizer 会被断言抓到', () => {
		const html = buildHtml(makeSnapshot(), { mode: 'preview', cssText: '' })
		const regressed = html.replace(
			/(<div class="[^"]*markdown-preview-view[^"]*"[^>]*>)/,
			'$1<div class="markdown-preview-sizer">'
		)
		assert(
			sizerClassMatches(regressed).length === 2,
			'注入回归后应检测到 2 个 sizer，断言才有效'
		)
	})

	console.log('\nR1-3 / R1-4 — 容器几何与样式顺序')

	await check('R1-3 容器宽度不被 max-width:100% 压缩', () => {
		const html = buildHtml(makeSnapshot(), { mode: 'preview', cssText: '' })
		const style =
			html.match(/class="markdown-reading-view"[^>]*style="([^"]*)"/)?.[1] ?? ''
		assertMatch(style, /width:900px/, '必须显式设定 captureWidth')
		assertMatch(style, /min-width:900px/, '必须有 min-width 防止被视口压缩')
		assert(
			!/max-width:\s*100%/.test(style),
			'不得再出现 max-width:100%（会把 900 压到视口宽）'
		)
	})

	await check('R1-3 回放样式里的容器几何被剥离，其余声明保留', () => {
		const out = sanitizeReadingStyle(
			'width:100%; height:100%; overflow:hidden; max-width:100%; ' +
				'--sn-font-size:14px; padding:0 8px'
		)
		assert(!/width:100%/.test(out), 'width 应被剥离')
		assert(!/overflow/.test(out), 'overflow 应被剥离')
		assert(!/height:100%/.test(out), 'height 应被剥离')
		assertMatch(out, /--sn-font-size:14px/, '自定义属性必须保留')
		assertMatch(out, /padding:0 8px/, '无关声明必须保留')
	})

	await check('R1-4 导出版 BASE_CSS 排在样式表之后且带 !important', () => {
		const html = buildHtml(makeSnapshot(), {
			mode: 'export',
			cssText: '',
			assets: { resolve: () => null }
		})
		const linkAt = html.indexOf('<link rel="stylesheet"')
		const baseAt = html.indexOf('.markdown-preview-view {')
		assert(linkAt >= 0, '导出版必须外链样式表')
		assert(baseAt > linkAt, 'BASE_CSS 必须排在外链样式表之后（同特异性后者胜）')
		const block = html.slice(baseAt, baseAt + 400)
		assertMatch(block, /overflow: visible !important/, 'overflow 必须 !important')
		assertMatch(block, /height: auto !important/, 'height 必须 !important')
		assertMatch(block, /max-height: none !important/, 'max-height 必须 !important')
	})

	// Reverse control: an empty body must be caught, not silently exported.
	// This is the exporter-side half of the capture fix — if the sizer is empty,
	// `verifyExport` has to see `hasContent === false` and refuse to publish.
	await check('反向对照：空正文的导出页被判定为无内容', async () => {
		const { measureBody } = await bundle('src/export/writer.ts', 'writer')
		const empty = makeSnapshot({
			sizer: new FakeElement('<div class="markdown-preview-sizer"></div>')
		})
		const html = buildHtml(empty, { mode: 'preview', cssText: '' })
		const measured = measureBody(html)
		assert(measured !== null, '正文标记必须存在')
		assertEqual(measured.hasContent, false, '空 sizer 必须被判为无内容')
	})

	console.log('\nR2 — CSS 渲染与 URL 重写')
	const { renderCss, collectCss } = await bundle(
		'src/css/css-collector.ts',
		'css'
	)

	const collection = {
		chunks: [
			{
				origin: 'app://vault/.obsidian/themes/ExampleTheme/theme.css',
				text: [
					'.a{background:url("app://vault/media/pic.png")}',
					'.b{background:url(data:image/png;base64,AA)}',
					'.c{background:url(https://cdn.example.com/x.png)}',
					'.d{background:url(../missing/gone.png)}',
					'.e{background:url(#frag)}'
				].join('\n')
			}
		],
		sheets: [],
		warnings: [],
		bytes: 0
	}

	await check('可解析的资源被改写为相对路径', () => {
		const calls = []
		const out = renderCss(collection, {
			prefix: 'media/',
			assets: {
				resolve: (ref, prefix, source) => {
					calls.push({ ref, prefix, source })
					return ref.includes('pic.png') ? `${prefix}abc12345-pic.png` : null
				}
			}
		})
		assertMatch(out, /url\("media\/abc12345-pic\.png"\)/, '重写后的相对路径')
		assert(
			calls.some(c => c.ref === 'app://vault/media/pic.png' && c.prefix === 'media/'),
			'必须以 media/ 前缀解析，且传入来源样式表'
		)
		assert(
			calls.some(c => c.source === 'app://vault/.obsidian/themes/ExampleTheme/theme.css'),
			'解析时必须携带来源，便于 manifest 归因'
		)
	})

	await check('data: / http(s): / #fragment 不被改写', () => {
		const out = renderCss(collection, {
			assets: { resolve: () => 'media/should-not-be-used.png' }
		})
		assertMatch(out, /url\(data:image\/png;base64,AA\)/, 'data: 保持原样')
		assertMatch(out, /url\(https:\/\/cdn\.example\.com\/x\.png\)/, 'http(s): 保持原样')
		assertMatch(out, /url\(#frag\)/, '片段引用保持原样')
	})

	await check('无法解析的引用变成惰性占位，不留下死路径', () => {
		const out = renderCss(collection, { assets: { resolve: () => null } })
		assertMatch(out, /url\("data:,"\)/, '未解析引用占位')
		assert(!out.includes('../missing/gone.png'), '不应保留无法解析的相对路径')
	})

	await check('未传 assets 时保留绝对 URL（供应用内预览使用）', () => {
		const out = renderCss(collection)
		assertMatch(out, /url\("app:\/\/vault\/media\/pic\.png"\)/, '预览模式保留 app:// URL')
	})

	await check('每个样式表来源都以注释标注，便于追查', () => {
		const out = renderCss(collection)
		assertMatch(out, /\/\* ==== app:\/\/vault\/\.obsidian\/themes\/ExampleTheme\/theme\.css ==== \*\//, '来源注释')
	})

	// --- collectCss: @import 内联与环判定 -------------------------------------
	//
	// `collectCss` reads `document.styleSheets`, so the test installs a minimal
	// stand-in. `CSSRule.IMPORT_RULE` does not exist in Node either; without it
	// `serializeRules` would throw before reaching the import branch.
	globalThis.CSSRule = { IMPORT_RULE: 3 }

	const cssFiles = {
		'.obsidian/themes/T/shared.css': '.shared{font-family:X}',
		'.obsidian/themes/T/theme.css': '.theme{color:red}',
		'.obsidian/snippets/snip.css': '.snip{color:blue}'
	}

	function makeCssApp() {
		return {
			vault: {
				adapter: {
					exists: async p => p in cssFiles,
					read: async p => cssFiles[p]
				}
			}
		}
	}

	function importRule(href) {
		return { type: 3, href, media: { mediaText: '' } }
	}

	function styleRule(cssText) {
		return { type: 1, cssText }
	}

	function installSheets(sheets) {
		globalThis.document = { styleSheets: sheets }
	}

	await check('两个样式表 @import 同一文件时，两份都要内联', async () => {
		installSheets([
			{
				href: 'app://vault/.obsidian/themes/T/theme.css',
				ownerNode: null,
				cssRules: [
					importRule('app://vault/.obsidian/themes/T/shared.css'),
					styleRule('.theme{color:red}')
				]
			},
			{
				href: 'app://vault/.obsidian/snippets/snip.css',
				ownerNode: null,
				cssRules: [
					importRule('app://vault/.obsidian/themes/T/shared.css'),
					styleRule('.snip{color:blue}')
				]
			}
		])

		const col = await collectCss(makeCssApp())
		assertEqual(col.chunks.length, 2, '样式表数量')
		for (const chunk of col.chunks) {
			assert(
				chunk.text.includes('.shared{font-family:X}'),
				`${chunk.origin} 缺少被 @import 的共享样式`
			)
			assert(
				!chunk.text.includes('cycle skipped'),
				`${chunk.origin} 把重复 @import 误判为环`
			)
		}
	})

	await check('自引用 @import 被判为环，不死循环', async () => {
		installSheets([
			{
				href: 'app://vault/.obsidian/themes/T/theme.css',
				ownerNode: null,
				cssRules: [
					importRule('app://vault/.obsidian/themes/T/theme.css'),
					styleRule('.theme{color:red}')
				]
			}
		])

		const col = await collectCss(makeCssApp())
		assertMatch(col.chunks[0].text, /cycle skipped/, '应留下环注释')
	})

	await check('无法读取的 @import 留注释 + warning，不静默', async () => {
		installSheets([
			{
				href: 'app://vault/.obsidian/themes/T/theme.css',
				ownerNode: null,
				cssRules: [
					importRule('app://vault/.obsidian/themes/T/missing.css'),
					styleRule('.theme{color:red}')
				]
			}
		])

		const col = await collectCss(makeCssApp())
		assertMatch(col.chunks[0].text, /@import unreadable/, '应留下不可读注释')
		assert(
			col.warnings.some(w => w.includes('无法读取')),
			'应记录一条 warning'
		)
	})

	await check('@import 的 media 限定被保留为 @media 包裹', async () => {
		installSheets([
			{
				href: 'app://vault/.obsidian/themes/T/theme.css',
				ownerNode: null,
				cssRules: [
					{
						type: 3,
						href: 'app://vault/.obsidian/themes/T/shared.css',
						media: { mediaText: 'print' }
					}
				]
			}
		])

		const col = await collectCss(makeCssApp())
		assertMatch(col.chunks[0].text, /@media print\s*\{/, '应包裹 @media print')
		assertMatch(col.chunks[0].text, /\.shared\{font-family:X\}/, '被导入内容应存在')
	})

	console.log('\nR3 — 资源解析安全性')
	const { AssetCollector } = await bundle('src/assets/resource-manager.ts', 'assets')

	const vaultFiles = [
		new TFile('media/pic.png'),
		new TFile('attachments/图 1.png'),
		new TFile('deep/x/only.png'),
		// `a/b/c.png` suffix-matches both `b/c.png` and `c.png` — the ambiguity
		// case the resolver must refuse instead of picking one.
		new TFile('b/c.png'),
		new TFile('c.png')
	]

	function makeApp() {
		const writes = []
		return {
			writes,
			vault: {
				getAbstractFileByPath: p =>
					vaultFiles.find(f => f.path === p) ?? null,
				getFiles: () => vaultFiles,
				adapter: {
					readBinary: async p => new Uint8Array([p.length]),
					writeBinary: async (p, data) => {
						writes.push({ path: p, bytes: data.length })
					}
				}
			}
		}
	}

	await check('app:// 正常路径解析为带哈希的相对路径', () => {
		const app = makeApp()
		const assets = new AssetCollector(app)
		const out = assets.resolve('app://vault/media/pic.png', 'assets/media/')
		assertMatch(out, /^assets\/media\/[0-9a-f]{8}-pic\.png$/, '解析结果')
	})

	await check('app:// 的百分号编码被还原（空格 / 中文）', () => {
		const app = makeApp()
		const assets = new AssetCollector(app)
		const out = assets.resolve(
			'app://vault/attachments/%E5%9B%BE%201.png',
			'assets/media/'
		)
		assert(out !== null, '百分号编码的路径必须能解析')
		assertMatch(out, /图_1\.png$/, '解码后的文件名')
	})

	await check('blob: 被显式拒绝并记录原因', () => {
		const app = makeApp()
		const assets = new AssetCollector(app)
		const out = assets.resolve('blob:app://vault/abc', 'assets/media/')
		assertEqual(out, null, 'blob 解析结果')
		assert(assets.missing.length === 1, '应记录一条 missing')
		assertMatch(assets.missing[0].reason, /blob/, '原因应说明是 blob')
	})

	await check('file:// 被显式拒绝', () => {
		const app = makeApp()
		const assets = new AssetCollector(app)
		const out = assets.resolve('file:///C:/example/x/pic.png', 'assets/media/')
		assertEqual(out, null, 'file:// 解析结果')
		assertMatch(assets.missing[0].reason, /知识库之外/, '原因应说明在知识库之外')
	})

	await check('相对路径没有被静默放过', () => {
		const app = makeApp()
		const assets = new AssetCollector(app)
		const out = assets.resolve('./pic.png', 'assets/media/')
		assertEqual(out, null, '相对路径解析结果')
		assertMatch(assets.missing[0].reason, /相对路径/, '原因应说明缺少基准 URL')
	})

	await check('http(s) 保持远程并单独归类', () => {
		const app = makeApp()
		const assets = new AssetCollector(app)
		assertEqual(
			assets.resolve('https://cdn.example.com/x.png', 'assets/media/'),
			'https://cdn.example.com/x.png',
			'远程 URL'
		)
		assertEqual(
			assets.resolve('//cdn.example.com/y.png', 'assets/media/'),
			'https://cdn.example.com/y.png',
			'协议相对 URL'
		)
		assertEqual(assets.remote.length, 2, '远程条目数')
		assertEqual(assets.missing.length, 0, '远程不应计入 missing')
	})

	await check('data: 原样返回', () => {
		const app = makeApp()
		const assets = new AssetCollector(app)
		const url = 'data:image/png;base64,AA'
		assertEqual(assets.resolve(url, 'assets/media/'), url, 'data URL')
	})

	await check('多候选后缀匹配被拒绝，不猜测', () => {
		const app = makeApp()
		const assets = new AssetCollector(app)
		const out = assets.resolve('app://vault/a/b/c.png', 'assets/media/')
		assertEqual(out, null, '歧义路径解析结果')
		assertMatch(assets.missing[0].reason, /拒绝猜测/, '原因应说明拒绝猜测')
		assertMatch(assets.missing[0].reason, /c\.png/, '原因应列出候选')
	})

	await check('唯一后缀匹配可用，但必须留下 warning', () => {
		const app = makeApp()
		const assets = new AssetCollector(app)
		const out = assets.resolve(
			'app://vault/some-vault/deep/x/only.png',
			'assets/media/'
		)
		assert(out !== null, '唯一后缀匹配应成功')
		assertEqual(assets.warnings.length, 1, '必须记录一条 warning')
		assertMatch(assets.warnings[0], /后缀匹配/, 'warning 应说明用了后缀匹配')
	})

	await check('同一文件多次引用只复制一次', () => {
		const app = makeApp()
		const assets = new AssetCollector(app)
		const a = assets.resolve('app://vault/media/pic.png', 'assets/media/')
		const b = assets.resolve('app://vault/media/pic.png', 'assets/media/')
		assertEqual(a, b, '两次解析必须得到同一文件名')
	})

	await check('flush 写出全部条目并去重 missing', async () => {
		const app = makeApp()
		const assets = new AssetCollector(app)
		assets.resolve('app://vault/media/pic.png', 'assets/media/')
		assets.resolve('blob:x', 'assets/media/')
		assets.resolve('blob:x', 'assets/media/')
		const report = await assets.flush('out/assets/media')
		assertEqual(report.written, 1, '写出条目数')
		assertEqual(report.missing.length, 1, 'missing 应去重')
		assertEqual(app.writes.length, 1, '实际写盘次数')
	})

	/* ------------------------------------------------------------- report -- */

	console.log('')
	if (failures.length) {
		console.log(`✗ ${failures.length} 项失败，${passed} 项通过\n`)
		for (const failure of failures) console.log(`  - ${failure.name}`)
		process.exit(1)
	}
	console.log(`✓ 全部 ${passed} 项通过\n`)
}

main().catch(error => {
	console.error(error)
	process.exit(1)
})
