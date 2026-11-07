/**
 * P2 Task 2 — per-element image / Mermaid editing.
 *
 * The unit contract, in four parts:
 *
 *  1. **Stable identity.** `data-he-media-id` is derived from the resource /
 *     diagram content, not from a DOM index, so inserting another picture does
 *     not move an existing override onto a different image; replacing a
 *     picture changes its id (the old override stops applying rather than
 *     jumping).
 *  2. **Selection scope.** Only block images and rendered Mermaid containers
 *     are selectable. Inline images, sidenote copies and an SVG-less `.mermaid`
 *     are not.
 *  3. **Safe overrides.** The values are interpolated into a `<style>` block, so
 *     ids and numbers are validated/clamped; unknown ids are dropped.
 *  4. **Same CSS in every product.** The override rules are emitted by
 *     `responsiveCss`, which `buildHtml` uses for preview, single-file share
 *     and package — so the exported files keep what the preview showed.
 *
 * Run with: node tests/unit/run-p2-media.mjs
 */
import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseHtml } from './dom-double.mjs'

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
		external: ['obsidian'],
		logLevel: 'silent'
	})
	return import(`${pathToFileURL(outfile).href}?v=${Date.now()}`)
}

const identity = await bundle('src/export/media-identity.ts', 'p2-media-id')
const settings = await bundle('src/export/layout-settings.ts', 'p2-media-settings')
const layoutCss = await bundle('src/export/layout-css.ts', 'p2-media-css')
const exporter = await bundle('src/export/exporter.ts', 'p2-media-exporter')

/* ------------------------------------------------------------- fixtures -- */

const IMG = (src, alt = '') =>
	`<span class="internal-embed media-embed image-embed is-loaded"><img src="${src}" alt="${alt}"></span>`
const MERMAID = text =>
	`<div class="mermaid"><svg viewBox="0 0 100 50"><text>${text}</text></svg></div>`

function sizer(inner) {
	const el = parseHtml(`<div class="markdown-preview-sizer">${inner}</div>`).children[0]
	return el
}

function idsBySrc(el) {
	const out = {}
	for (const block of el.querySelectorAll('.image-embed')) {
		const img = block.querySelector('img')
		out[img?.getAttribute('src')] = block.getAttribute('data-he-media-id')
	}
	return out
}

/* -------------------------------------------------- 1. stable identities -- */

await check('块级图片与 Mermaid 获得稳定 id，装饰/内联/侧注不参与', () => {
	const el = sizer(`
		${IMG('app://vault/media/a.png', 'A')}
		${IMG('app://vault/media/b.png', 'B')}
		${MERMAID('flow A')}
		<span class="internal-embed image-embed inline"><img src="app://vault/media/inline.png"></span>
		<span class="sidenote"><img src="app://vault/media/note.png"></span>
		<div class="mermaid"></div>
	`)
	const report = identity.assignMediaIds(el)
	equal(report.images, 2, '两张块级图片')
	equal(report.mermaid, 1, '一张有 SVG 的 Mermaid')
	const blocks = el.querySelectorAll('.image-embed')
	equal(blocks.length, 3, '块级 + inline 共 3 个 wrapper')
	assert(!!blocks[0].getAttribute('data-he-media-id'), '第一张图片有 id')
	assert(!!blocks[1].getAttribute('data-he-media-id'), '第二张图片有 id')
	assert(!blocks[2].getAttribute('data-he-media-id'), 'inline 图片不参与')
	assert(
		!el.querySelector('.sidenote img').getAttribute('data-he-media-id'),
		'侧注里的图片不参与'
	)
	const mermaidBoxes = el.querySelectorAll('.mermaid')
	assert(!!mermaidBoxes[0].getAttribute('data-he-media-id'), '有 SVG 的 Mermaid 有 id')
	assert(!mermaidBoxes[1].getAttribute('data-he-media-id'), '没有 SVG 的 Mermaid 不参与')
})

await check('在前方插入另一张图片后，原有图片的 id 不变', () => {
	const before = sizer(`${IMG('app://vault/media/a.png')}${IMG('app://vault/media/b.png')}`)
	identity.assignMediaIds(before)
	const beforeIds = idsBySrc(before)

	const after = sizer(
		`${IMG('app://vault/media/new.png')}${IMG('app://vault/media/a.png')}${IMG('app://vault/media/b.png')}`
	)
	identity.assignMediaIds(after)
	const afterIds = idsBySrc(after)

	equal(afterIds['app://vault/media/a.png'], beforeIds['app://vault/media/a.png'], 'a.png 的 id')
	equal(afterIds['app://vault/media/b.png'], beforeIds['app://vault/media/b.png'], 'b.png 的 id')
	assert(
		afterIds['app://vault/media/new.png'] !== beforeIds['app://vault/media/a.png'],
		'新图片获得自己的 id'
	)
})

await check('源内容变化（换图）时 id 随之变化，旧设置不会错误套到别的图', () => {
	const one = sizer(IMG('app://vault/media/a.png'))
	identity.assignMediaIds(one)
	const idA = one.querySelector('.image-embed').getAttribute('data-he-media-id')
	const two = sizer(IMG('app://vault/media/z.png'))
	identity.assignMediaIds(two)
	const idZ = two.querySelector('.image-embed').getAttribute('data-he-media-id')
	assert(idA !== idZ, '不同资源必须得到不同 id')
})

await check('同一张图重复出现时按出现次序区分，且不泄露路径', () => {
	const el = sizer(`${IMG('app://vault/media/a.png')}${IMG('app://vault/media/a.png')}`)
	identity.assignMediaIds(el)
	const blocks = el.querySelectorAll('.image-embed')
	const first = blocks[0].getAttribute('data-he-media-id')
	const second = blocks[1].getAttribute('data-he-media-id')
	assert(first !== second, '重复图片得到不同 id')
	match(first, /^m[a-z0-9]+-\d+$/, 'id 形状')
	assert(!first.includes('media'), 'id 不含资源路径片段')
	assert(!first.includes('vault'), 'id 不含 vault 标识')
})

await check('Mermaid 重新渲染后 id 不变：随机 style id 不参与键', () => {
	// The real DOM from the sandbox: every render writes a `<style>` block whose
	// selectors are keyed by a freshly generated id, so the same diagram has a
	// different `textContent` each time. Keying on it dropped the user's width
	// on refresh (measured `m12o09id-0` → `meazdkf-0`).
	const render = (text, renderId, viewBox = '0 0 502 246') =>
		sizer(
			`<div class="mermaid"><svg viewBox="${viewBox}" aria-roledescription="flowchart-v2" id="${renderId}">` +
				`<style>#${renderId}{font-family:var(--font-mermaid);font-size:16px;fill:#333;}</style>` +
				`<g><path d="M0 0 L10 10 Z"/><path d="M20 20 L30 30 Z"/></g>` +
				`<foreignObject><div>${text}</div></foreignObject></svg></div>`
		)
	const first = render('开始 → 结束', 'm2ad4a3d062ce6f65')
	identity.assignMediaIds(first)
	const second = render('开始 → 结束', 'm44fa3caeec0d2558')
	identity.assignMediaIds(second)
	equal(
		second.querySelector('.mermaid').getAttribute('data-he-media-id'),
		first.querySelector('.mermaid').getAttribute('data-he-media-id'),
		'同一个图换一个渲染 id 后仍得到同一个 data-he-media-id'
	)

	const renamed = render('开始 → 另一条路', 'm44fa3caeec0d2558')
	identity.assignMediaIds(renamed)
	assert(
		renamed.querySelector('.mermaid').getAttribute('data-he-media-id') !==
			first.querySelector('.mermaid').getAttribute('data-he-media-id'),
		'换了文字就是另一张图，旧设置不会错误套上去'
	)

	const reshaped = render('开始 → 结束', 'm44fa3caeec0d2558', '0 0 900 400')
	identity.assignMediaIds(reshaped)
	assert(
		reshaped.querySelector('.mermaid').getAttribute('data-he-media-id') !==
			first.querySelector('.mermaid').getAttribute('data-he-media-id'),
		'坐标盒变了也视为另一张图'
	)
})

/* ------------------------------------------------ 2. override validation -- */
await check('覆盖设置只接受合法 id / 合法数值 / 合法对齐', () => {
	const normalized = settings.normalizeMediaOverrides({
		'mabc123-0': { width: { value: 50, unit: 'pct' }, align: 'center' },
		'mabc123-1': { width: { value: 99999, unit: 'px' } },
		'mabc123-2': { width: { value: 2, unit: 'pct' } },
		'bad id': { width: { value: 50, unit: 'pct' } },
		'mabc123-3': { align: 'as-is' },
		'mabc123-4': {}
	})
	equal(normalized['mabc123-0'], { width: { value: 50, unit: 'pct' }, align: 'center' }, '正常值')
	equal(normalized['mabc123-1'].width.value, settings.MEDIA_WIDTH_PX_MAX, 'px 上限夹取')
	equal(normalized['mabc123-2'].width.value, settings.MEDIA_WIDTH_PCT_MIN, '百分比下限夹取')
	assert(!normalized['bad id'], '非法 id 被丢弃')
	assert(!normalized['mabc123-3'], 'as-is 不是合法单元素对齐')
	assert(!normalized['mabc123-4'], '空覆盖被丢弃')
})

await check('normalizeLayout 始终返回一份新的覆盖表', () => {
	const a = settings.normalizeLayout(undefined)
	const b = settings.normalizeLayout({ mediaOverrides: { 'mabc123-0': { align: 'right' } } })
	equal(a.mediaOverrides, {}, '默认无覆盖')
	assert(a.mediaOverrides !== b.mediaOverrides, '每次都是新对象')
	assert(settings.DEFAULT_LAYOUT.mediaOverrides !== a.mediaOverrides, '默认值不被共享引用')
})

/* ------------------------------------------------------ 3. generated CSS -- */

const GEOMETRY = { frameWidth: 900, room: 0, theme: 'light' }

await check('没有单元素设置时不产生任何 data-he-media-id 规则（旧 CSS 不变）', () => {
	const css = layoutCss.responsiveCss(settings.DEFAULT_LAYOUT, GEOMETRY)
	assert(!css.includes('data-he-media-id'), '默认 CSS 不应包含单元素规则')
})

await check('单元素宽度 / 对齐写成高特异性规则，并始终 max-width:100%', () => {
	const layout = settings.normalizeLayout({
		imageAlign: 'right',
		mediaOverrides: { 'mabc123-0': { width: { value: 50, unit: 'pct' }, align: 'center' } }
	})
	const css = layoutCss.responsiveCss(layout, GEOMETRY)
	match(css, /\.image-embed\[data-he-media-id="mabc123-0"\]/, '重复块类以提高优先级')
	match(css, /\.mermaid\[data-he-media-id="mabc123-0"\]/, 'Mermaid 变体')
	match(css, /width:\s*50%\s*!important/, '百分比宽度')
	match(css, /max-width:\s*100%\s*!important/, '不突破正文列')
	match(css, /margin-left:\s*auto\s*!important/, '居中：左 auto')
	match(css, /margin-right:\s*auto\s*!important/, '居中：右 auto')
	match(css, /height:\s*auto\s*!important/, '保持宽高比')
})

await check('px 宽度与左右对齐分别落到正确的 margin', () => {
	const layout = settings.normalizeLayout({
		mediaOverrides: { 'mabc123-0': { width: { value: 320, unit: 'px' }, align: 'left' } }
	})
	const css = layoutCss.responsiveCss(layout, GEOMETRY)
	match(css, /width:\s*320px\s*!important/, 'px 宽度')
	match(css, /margin-left:\s*0\s*!important/, '左对齐：左 0')
	match(css, /margin-right:\s*auto\s*!important/, '左对齐：右 auto')
})

/* --------------------------------------------------- 4. all three products -- */

function makeSnapshot(sizerEl) {
	return {
		sizer: sizerEl,
		captureWidth: 700,
		noteTitle: 'media-note',
		notePath: 'docs/media-note.md',
		capturedAt: '2026-11-06T00:00:00.000Z',
		root: {
			className: 'theme-light',
			style: '',
			data: {},
			bodyClassName: 'theme-light',
			bodyStyle: '',
			bodyData: {}
		},
		reading: { className: 'markdown-reading-view', style: '', data: {} },
		preview: { className: 'markdown-preview-view', style: '', data: {} },
		sidenotes: { margin: 0, inline: 0, room: 0 },
		stats: { math: 0, images: 2, mermaid: 1, sidenotes: 0, blocks: 5 }
	}
}

function mediaSnapshot() {
	return makeSnapshot(
		sizer(`${IMG('app://vault/media/a.png')}${IMG('app://vault/media/b.png')}${MERMAID('flow A')}`)
	)
}

for (const mode of ['preview', 'single', 'export']) {
	await check(`${mode}：每个图块带 data-he-media-id，且覆盖规则进入产物`, () => {
		const snap = mediaSnapshot()
		// Learn the real ids first (they are content hashes).
		const probe = mediaSnapshot()
		const ids = []
		const probeBlocks = probe.sizer.querySelectorAll('.image-embed')
		identity.assignMediaIds(probe.sizer)
		for (const block of probeBlocks) ids.push(block.getAttribute('data-he-media-id'))

		const layout = settings.normalizeLayout({
			mediaOverrides: {
				[ids[0]]: { width: { value: 40, unit: 'pct' }, align: 'center' }
			}
		})
		const html = exporter.buildHtml(snap, { mode, cssText: '', layout })
		const count = (html.match(/data-he-media-id="/g) ?? []).length
		assert(count >= 3, `至少 3 个图块带 id，实际 ${count}`)
		match(html, new RegExp(`data-he-media-id="${ids[0]}"`), '第一张图片的 id 在产物中')
		match(html, /width:\s*40%\s*!important/, '单元素宽度规则在产物中')
	})
}

await check('导出不会把“选中高亮”写进最终 HTML（选中只存在于预览）', () => {
	const html = exporter.buildHtml(mediaSnapshot(), { mode: 'single', cssText: '' })
	assert(!html.includes('data-he-media-selected'), '不含选中标记')
	assert(!html.includes('outline-offset'), '不含选中边框样式')
	assert(
		!/data-he-media-id="[^"]+"\][^{]*\{[^}]*outline/.test(html),
		'单元素规则里不含 outline'
	)
})

/* ------------------------------------------------------------- 5. tables -- */

const TABLE = (head, first, third = '第三行') =>
	`<table><thead><tr><th>${head}</th><th>维度</th></tr></thead><tbody>` +
	`<tr><td>${first}</td><td>固定值</td></tr>` +
	`<tr><td>${third}</td><td>另一个值</td></tr></tbody></table>`

function tableIds(el) {
	return Array.from(el.querySelectorAll('table')).map(t => t.getAttribute('data-he-media-id'))
}

await check('整张外层表格获得 t… id；嵌套表格 / 侧注表格不参与', () => {
	const el = sizer(`
		${TABLE('对比维度', '主要目标')}
		<table><tbody><tr><td>外层单元格<table><tbody><tr><td>内层表</td></tr></tbody></table></td></tr></tbody></table>
		<div class="sidenote">${TABLE('侧注表', '不参与')}</div>
	`)
	const report = identity.assignMediaIds(el)
	equal(report.tables, 2, '两张最外层正文表格可选')
	const ids = tableIds(el)
	assert(/^t[a-z0-9]+-\d+$/.test(ids[0]), `表格 id 形状：${ids[0]}`)
	assert(/^t[a-z0-9]+-\d+$/.test(ids[1]), `外层表格 id 形状：${ids[1]}`)
	assert(!ids[2], '嵌套在外层表格里的内层表格不获得独立 id')
	assert(!ids[3], '侧注里的表格不参与')
	assert(el.querySelectorAll('table')[0].getAttribute('data-he-media-kind') === 'table', '带 kind 标记')
})

await check('表格 id 稳定：改正文单元格不变，改行数 / 表头或重复表会区分', () => {
	const a = sizer(TABLE('对比维度', '主要目标'))
	identity.assignMediaIds(a)
	const idA = tableIds(a)[0]

	const edited = sizer(TABLE('对比维度', '主要目标', '改了这个单元格'))
	identity.assignMediaIds(edited)
	equal(tableIds(edited)[0], idA, '改正文单元格文本不改 id')

	const reshaped = sizer(TABLE('对比维度', '主要目标').replace('</tbody>', '<tr><td>新增行</td><td>值</td></tr></tbody>'))
	identity.assignMediaIds(reshaped)
	assert(tableIds(reshaped)[0] !== idA, '增加一行视为另一张表')

	const renamed = sizer(TABLE('另一张表', '主要目标'))
	identity.assignMediaIds(renamed)
	assert(tableIds(renamed)[0] !== idA, '表头变化视为另一张表')

	const twice = sizer(`${TABLE('对比维度', '主要目标')}${TABLE('对比维度', '主要目标')}`)
	identity.assignMediaIds(twice)
	const [t1, t2] = tableIds(twice)
	assert(t1 !== t2, '两张相同表格按出现次序区分')
})

await check('t… id 通过覆盖校验；其它前缀仍被拒绝', () => {
	const out = settings.normalizeMediaOverrides({
		'tabc123-0': { width: { value: 50, unit: 'pct' }, align: 'center' },
		'xabc123-0': { width: { value: 50, unit: 'pct' } },
		'mabc123-0': { align: 'right' }
	})
	assert(out['tabc123-0'], '表格 id 被接受')
	assert(!out['xabc123-0'], '未知前缀被丢弃')
	assert(out['mabc123-0'], '图片 id 仍被接受')
	equal(settings.isTableMediaId('tabc123-0'), true, 'isTableMediaId 识别表格')
	equal(settings.isTableMediaId('mabc123-0'), false, 'isTableMediaId 不误判图片')
})

const tableRule = css => {
	const m = css.match(/#[^\n{}]*table\[data-he-media-id="t[^"]+"\][^{]*\{([\s\S]*?)\}/)
	return m ? m[1] : ''
}

await check('表格单元素规则保留 display:table：不写 display / height / table-layout / 内层 svg', () => {
	const layout = settings.normalizeLayout({
		mediaOverrides: { 'tabc123-0': { width: { value: 50, unit: 'pct' }, align: 'center' } }
	})
	const css = layoutCss.responsiveCss(layout, GEOMETRY)
	const body = tableRule(css)
	assert(body, '生成了表格专属规则')
	match(body, /width:\s*50%\s*!important/, '百分比宽度')
	match(body, /margin-left:\s*auto\s*!important/, '居中')
	match(body, /overflow:\s*visible\s*!important/, '宽表不裁切，可横向滚动')
	assert(!/display\s*:/.test(body), '不改 display（保留主题的 display: table）')
	assert(!/height\s*:/.test(body), '不压缩表格高度')
	assert(!/table-layout\s*:/.test(body), '不改 table-layout')
	assert(!css.includes('[data-he-media-id="tabc123-0"] img'), '不给表格里的 img/svg 加 100% 规则')
	assert(!css.includes('.image-embed[data-he-media-id="tabc123-0"]'), '图片选择器不套到表格上')
})

await check('px 宽度的表格不被 max-width 夹回正文列', () => {
	const layout = settings.normalizeLayout({
		mediaOverrides: { 'tabc123-1': { width: { value: 1200, unit: 'px' } } }
	})
	const body = tableRule(layoutCss.responsiveCss(layout, GEOMETRY))
	match(body, /width:\s*1200px\s*!important/, 'px 宽度原样写出')
	match(body, /max-width:\s*none\s*!important/, '不夹回 100%')
})

await check('三种产物都带表格 id，且同一份表格规则进入单文件 / 资源包 HTML', () => {
	const snap = makeSnapshot(
		sizer(`${TABLE('对比维度', '主要目标')}${IMG('app://vault/media/a.png')}`)
	)
	const probe = makeSnapshot(
		sizer(`${TABLE('对比维度', '主要目标')}${IMG('app://vault/media/a.png')}`)
	)
	identity.assignMediaIds(probe.sizer)
	const tid = tableIds(probe.sizer)[0]
	const iid = probe.sizer.querySelector('.image-embed').getAttribute('data-he-media-id')
	const layout = settings.normalizeLayout({
		mediaOverrides: {
			[tid]: { width: { value: 60, unit: 'pct' }, align: 'right' },
			[iid]: { width: { value: 40, unit: 'pct' } }
		}
	})
	for (const mode of ['preview', 'single', 'export']) {
		const html = exporter.buildHtml(snap, { mode, cssText: '', layout })
		match(html, new RegExp(`data-he-media-id="${tid}"`), `${mode} 含表格 id`)
		match(html, /table\[data-he-media-id="t[^"]+"\]/, `${mode} 含表格专属规则`)
		match(html, /width:\s*60%\s*!important/, `${mode} 含表格宽度`)
		assert(
			!html.includes(`[data-he-media-id="${tid}"] img`),
			`${mode} 不给表格内层图片加规则`
		)
		match(html, /width:\s*40%\s*!important/, `${mode} 图片设置仍在`)
	}
})

console.log(`\n总计：PASS ${passed} / FAIL ${failures.length}`)
if (failures.length) {
	for (const f of failures) console.log(`  - ${f.name}: ${f.message}`)
	process.exit(1)
}
console.log('OK')
