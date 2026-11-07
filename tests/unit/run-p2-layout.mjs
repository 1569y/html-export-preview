/**
 * P2 — preview editor, phase 1: the global layout contract.
 *
 * These tests cover the parts that decide what ends up *inside* the exported
 * document, and nothing about the editor chrome:
 *
 *  - `normalizeLayout` must never let an unusable value through, because the
 *    value is interpolated into a `<style>` block of a file the user sends to
 *    someone else (a colour is only accepted as hex, never as raw CSS);
 *  - `responsiveCss` is the **single** source of the layout rules for the
 *    preview iframe, the directory export and the share file, so a slider move
 *    and a saved file cannot drift;
 *  - the paper-colour option has to work in both page flows, and has to restate
 *    the text palette when the capture came from a dark theme.
 *
 * Run with: node tests/unit/run-p2-layout.mjs
 */
import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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
const assert = (value, message) => {
	if (!value) throw new Error(message)
}
const equal = (a, b, label) => {
	if (JSON.stringify(a) !== JSON.stringify(b)) {
		throw new Error(`${label}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)
	}
}
const match = (value, re, label) => {
	if (!re.test(String(value))) throw new Error(`${label}: ${re} 未匹配`)
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

const settings = await bundle('src/export/layout-settings.ts', 'p2-settings')
const layoutCss = await bundle('src/export/layout-css.ts', 'p2-layout-css')

const GEOMETRY = { frameWidth: 1100, room: 0 }
const DARK = { ...GEOMETRY, theme: 'dark' }
const LIGHT = { ...GEOMETRY, theme: 'light' }

console.log('\n# P2 — 排版设置合约')

await check('默认：跟随主题背景，响应式居中，100% 缩放', () => {
	equal(settings.DEFAULT_LAYOUT, {
		pageLayout: 'adaptive-center',
		imageAlign: 'as-is',
		mermaidAlign: 'as-is',
		mermaidScale: 1,
		contentMaxWidth: 'theme',
		zoom: 1,
		background: 'theme',
		backgroundColor: '#ffffff',
		mediaOverrides: {}
	}, 'DEFAULT_LAYOUT')
})

await check('快捷档位就是需求里写的那几个值', () => {
	equal([...settings.WIDTH_PRESETS], [800, 900, 1000], '正文宽度预设')
	equal([...settings.ZOOM_PRESETS], [1, 1.25, 1.5], '内容大小预设')
	equal([settings.ZOOM_MIN, settings.ZOOM_MAX], [0.75, 1.75], '内容大小范围')
})

await check('颜色只接受 hex，其余一律丢弃', () => {
	equal(settings.normalizeColor('#ABC'), '#abc', '三位 hex')
	equal(settings.normalizeColor('  #AABBCC  '), '#aabbcc', '六位 hex + 空白')
	equal(settings.normalizeColor('red'), null, '颜色名')
	equal(settings.normalizeColor('rgb(1,2,3)'), null, 'rgb()')
	equal(settings.normalizeColor('#12345'), null, '五位 hex')
	equal(settings.normalizeColor(''), null, '空串')
	equal(settings.normalizeColor(undefined), null, 'undefined')
})

await check('自定义背景色非法时退化为白色，且保留 custom 模式', () => {
	const layout = settings.normalizeLayout({
		background: 'custom',
		backgroundColor: '#fff;}</style><script>x</script>'
	})
	equal(layout.background, 'custom', '模式')
	equal(layout.backgroundColor, '#ffffff', '颜色')
})

await check('未知枚举/越界数值回落到安全值', () => {
	const layout = settings.normalizeLayout({
		pageLayout: 'weird',
		imageAlign: 'top', // 非法枚举 → 回落（Task 1 后合法枚举为 left/center/right）
		mermaidAlign: 'up',
		zoom: 99,
		contentMaxWidth: 999999,
		background: 'rainbow'
	})
	equal(layout.pageLayout, 'adaptive-center', '页面布局')
	equal(layout.imageAlign, 'as-is', '图片对齐')
	equal(layout.mermaidAlign, 'as-is', 'Mermaid 对齐')
	equal(layout.zoom, 1.75, '缩放上限')
	equal(layout.contentMaxWidth, 4000, '宽度上限')
	equal(layout.background, 'theme', '背景')
})

await check('合法图片/Mermaid 对齐值不被回落（Task 1 新增 left/center/right）', () => {
	const layout = settings.normalizeLayout({ imageAlign: 'right', mermaidAlign: 'left' })
	equal(layout.imageAlign, 'right', '图片对齐保留')
	equal(layout.mermaidAlign, 'left', 'Mermaid 对齐保留')
})

console.log('\n# P2 — 布局 CSS')

await check('跟随主题时不写任何背景规则', () => {
	const css = layoutCss.responsiveCss(
		{ background: 'theme' },
		DARK
	)
	assert(!/background:\s*#/.test(css), '不应出现背景色')
	assert(!/--text-normal/.test(css), '不应改动文字调色')
})

await check('白色背景：html/body 上色，容器透明', () => {
	const css = layoutCss.responsiveCss({ background: 'white' }, LIGHT)
	match(css, /html,\s*body\s*\{[^}]*background:\s*#ffffff\s*!important/, '纸张颜色')
	match(css, /#he-page[\s\S]*background:\s*transparent\s*!important/, '容器透明')
})

await check('自定义颜色出现在同一条规则里', () => {
	const css = layoutCss.responsiveCss(
		{ background: 'custom', backgroundColor: '#F5F0E6' },
		LIGHT
	)
	match(css, /background:\s*#f5f0e6\s*!important/, '自定义色')
})

await check('深色主题 + 浅色纸张：重述文字调色', () => {
	const css = layoutCss.responsiveCss({ background: 'white' }, DARK)
	match(css, /--text-normal:\s*#1b1b1b/, '正文色')
	match(css, /--text-title:\s*#111111/, '标题色')
	// 不能顺手把代码块/表头的背景变量也刷成纸色。
	assert(!/--background-primary-alt/.test(css), '不得覆盖次级背景变量')
})

await check('浅色主题 + 浅色纸张：不改文字调色', () => {
	const css = layoutCss.responsiveCss({ background: 'white' }, LIGHT)
	assert(!/--text-normal/.test(css), '浅色主题无需换字色')
})

await check('背景在两种页面布局下都生效', () => {
	for (const pageLayout of ['adaptive-center', 'as-is']) {
		const css = layoutCss.responsiveCss({ pageLayout, background: 'white' }, LIGHT)
		match(css, /background:\s*#ffffff\s*!important/, `${pageLayout} 背景`)
		match(css, /--he-zoom:\s*1/, `${pageLayout} 缩放`)
	}
})

await check('缩放与正文宽度写进文档级 CSS（不是 iframe 缩放）', () => {
	const css = layoutCss.responsiveCss(
		{ zoom: 1.5, contentMaxWidth: 900 },
		LIGHT
	)
	match(css, /--he-zoom:\s*1\.5/, '缩放变量')
	match(css, /html\s*\{\s*--he-zoom:[^}]*zoom:\s*var\(--he-zoom/, 'html 上应用缩放')
	match(css, /--he-content-max-width:\s*900px/, '正文宽度变量')
})

await check('原样布局：不产出自适应容器规则（冻结抓取宽度）', () => {
	const css = layoutCss.responsiveCss({ pageLayout: 'as-is' }, LIGHT)
	assert(!/#he-page\.markdown-reading-view/.test(css), '不应出现自适应容器规则')
	assert(!/--he-frame-width/.test(css), '不应写入帧宽变量')
})

await check('themeOf 只认 theme-dark / theme-light', () => {
	equal(layoutCss.themeOf('theme-dark mod-macos'), 'dark', 'dark')
	equal(layoutCss.themeOf('theme-light'), 'light', 'light')
	equal(layoutCss.themeOf(''), 'unknown', '空')
	equal(layoutCss.themeOf(undefined), 'unknown', 'undefined')
	equal(layoutCss.themeOf('theme-darkish'), 'unknown', '不做前缀匹配')
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
