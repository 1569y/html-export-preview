/**
 * P0 — 完整性判定回归测试（离线）
 *
 * 锁定两个已证实的缺陷：
 *   1) 阅读视图对长文档只挂载视口附近的块，旧闸门拿 DOM 和自己的克隆比，
 *      所以「只导出了后半部分」仍然全绿；
 *   2) 98% 覆盖率会让「整段丢失」通过，且同一段文本可以被重复基准行反复复用。
 *
 * 现在的口径：受支持内容要求 100%，匹配游标只向前移动；标题精确匹配；
 * Mermaid / 图片 / 块级公式 / 侧注按结构计数；无法可靠验证的内容明确列为
 * 「未验证」，不并入完整保证。
 *
 * Run with: node tests/unit/run-p0-completeness.mjs
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

/**
 * Minimal stand-in for a rendered body: the text the check reads, plus the
 * structural counts its selectors ask for.
 */
function fakeBody(text, headings, counts = {}) {
	const headingEls = headings.map(h => ({
		textContent: typeof h === 'string' ? h : h.textContent
	}))
	const mermaidEls = Array.from({ length: counts.mermaid ?? 0 }, (_, i) => ({
		querySelector: sel =>
			sel === 'svg' && i < (counts.mermaidSvg ?? counts.mermaid ?? 0) ? {} : null
	}))
	const mathEls = Array.from({ length: counts.math ?? 0 }, (_, i) => ({
		querySelector: sel =>
			sel === 'mjx-container' && i < (counts.mathRendered ?? counts.math ?? 0)
				? {}
				: null
	}))
	const fill = n => Array.from({ length: n }, () => ({}))

	return {
		innerText: text,
		textContent: counts.rawText ?? text,
		querySelectorAll(selector) {
			if (selector.includes('h1')) return headingEls
			if (selector === '.mermaid') return mermaidEls
			if (selector === 'img') return fill(counts.images ?? 0)
			if (selector === '.internal-embed.is-unresolved') return fill(counts.unresolved ?? 0)
			if (selector === '.math-block') return mathEls
			if (selector === 'small.sidenote-margin') return fill(counts.sidenotes ?? 0)
			if (selector === 'span.sidenote') return fill(counts.spanSidenotes ?? 0)
			return []
		}
	}
}

async function loadModule() {
	fs.mkdirSync(tmp, { recursive: true })
	const outfile = path.join(tmp, 'note-baseline.mjs')
	await build({
		entryPoints: [path.join(root, 'src/capture/note-baseline.ts')],
		bundle: true,
		format: 'esm',
		platform: 'node',
		target: 'es2020',
		outfile,
		logLevel: 'silent'
	})
	return import(`${pathToFileURL(outfile).href}?t=${Date.now()}`)
}

const NOTE = `# 标题一

第一段正文，长度足够被纳入基线，包含一些中文内容。

## 第二节

第二段正文，同样足够长，用于验证覆盖率的计算方式。

- 列表项 alpha，长度也够
- 列表项 beta，长度也够

> 引用块内容，长度足够参与比对

| 指标 | 数值 |
| --- | --- |
| alpha | 1.5 |

\`\`\`ts
const value = 42
console.log(value)
\`\`\`

\`\`\`mermaid
flowchart LR
  A --> B
\`\`\`

> [!info] 提示标题
> callout 正文，长度足够参与比对

内联 **粗体**、[[目标笔记|别名]]、\`行内代码\` 与 $x^2$ 公式。
`

const renderedAll =
	'标题一 第一段正文，长度足够被纳入基线，包含一些中文内容。 第二节 ' +
	'第二段正文，同样足够长，用于验证覆盖率的计算方式。 列表项 alpha，长度也够 ' +
	'列表项 beta，长度也够 引用块内容，长度足够参与比对 alpha 1.5 ' +
	'const value = 42 console.log(value) 提示标题 callout 正文，长度足够参与比对 ' +
	'内联 粗体、别名、行内代码 与 公式。'
const allHeadings = [{ textContent: '标题一' }, { textContent: '第二节' }]

async function main() {
	const mod = await loadModule()
	const baseline = mod.buildBaseline(NOTE, ['标题一', '第二节'])

	console.log('P0 completeness checks')

	await check('标题与正文行被纳入基线', () => {
		assert(baseline.headings.length === 2, `headings=${baseline.headings.length}`)
		assert(baseline.lines.length >= 8, `lines=${baseline.lines.length}`)
	})

	await check('内联标记被剥离，别名链接保留显示文字', () => {
		const joined = baseline.lines.map(l => l.text).join('\n')
		assert(joined.includes('别名'), 'missing link alias text')
		assert(!joined.includes('**'), 'bold markers not stripped')
		assert(!joined.includes('[['), 'wikilink not stripped')
		assert(!joined.includes('x^2'), 'inline math not stripped')
	})

	await check('代码块保留，mermaid 源码不计入正文但计入结构', () => {
		const joined = baseline.lines.map(l => l.text).join('\n')
		assert(joined.includes('constvalue42'), 'code block lost')
		assert(!joined.includes('flowchartLR'), 'mermaid source should be skipped')
		const mermaid = baseline.structures.find(s => s.kind === 'mermaid')
		assert(mermaid && mermaid.expected === 1, `mermaid=${JSON.stringify(mermaid)}`)
		assert(!baseline.unverified.some(u => u.includes('mermaid')), 'mermaid must be verified')
	})

	await check('表格行归一化后可与渲染文本匹配', () => {
		const hasTable = baseline.lines.some(
			l => l.text.includes('alpha') && l.text.includes('15')
		)
		assert(hasTable, 'table row not normalised as expected')
	})

	await check('完整正文 + 完整结构 → 通过', () => {
		const report = mod.checkCompleteness(
			baseline,
			fakeBody(renderedAll, allHeadings, { mermaid: 1 })
		)
		assert(report.ok, `expected ok: ${report.notes.join(';')}`)
		assert(report.coverage === 1, `coverage=${report.coverage}`)
		assert(report.orderRatio === 1, `order=${report.orderRatio}`)
	})

	await check('只导出后半部分 → 明确失败', () => {
		const half =
			'引用块内容，长度足够参与比对 alpha 1.5 提示标题 callout 正文，长度足够参与比对'
		const report = mod.checkCompleteness(
			baseline,
			fakeBody(half, [{ textContent: '第二节' }], { mermaid: 1 })
		)
		assert(!report.ok, 'must not pass with the first half missing')
		assert(report.headingMatched === 1, `headingMatched=${report.headingMatched}`)
		assert(report.coverage < 0.6, `coverage=${report.coverage}`)
	})

	await check('只删一行正文 → 必须失败（100% 口径）', () => {
		const oneLineMissing = renderedAll.replace('列表项 beta，长度也够 ', '')
		const report = mod.checkCompleteness(
			baseline,
			fakeBody(oneLineMissing, allHeadings, { mermaid: 1 })
		)
		assert(!report.ok, 'a single missing line must fail')
		assert(report.coverage < 1, `coverage=${report.coverage}`)
		assert(
			report.missingSamples.some(s => s.includes('列表项beta')),
			`missingSamples=${report.missingSamples.join(' | ')}`
		)
	})

	await check('重复段落删掉一处 → 必须失败（不得复用同一段文本）', () => {
		const dupNote = `# 重复

重复段落的内容完全一致，用于验证游标匹配。
重复段落的内容完全一致，用于验证游标匹配。
`
		const dup = mod.buildBaseline(dupNote, ['重复'])
		const once = '重复 重复段落的内容完全一致，用于验证游标匹配。'
		const report = mod.checkCompleteness(dup, fakeBody(once, [{ textContent: '重复' }]))
		assert(!report.ok, 'a lost duplicate must fail')
		assert(report.lineOutOfOrder === 1, `lineOutOfOrder=${report.lineOutOfOrder}`)
		assert(report.orderRatio < 1, `orderRatio=${report.orderRatio}`)
	})

	await check('顺序打乱 → 必须失败', () => {
		const reversed =
			'内联 粗体、别名、行内代码 与 公式。 提示标题 callout 正文，长度足够参与比对 ' +
			'const value = 42 console.log(value) alpha 1.5 引用块内容，长度足够参与比对 ' +
			'列表项 beta，长度也够 列表项 alpha，长度也够 ' +
			'第二段正文，同样足够长，用于验证覆盖率的计算方式。 第二节 ' +
			'第一段正文，长度足够被纳入基线，包含一些中文内容。 标题一'
		const report = mod.checkCompleteness(
			baseline,
			fakeBody(reversed, allHeadings, { mermaid: 1 })
		)
		assert(!report.ok, 'reversed body must fail')
		assert(report.orderRatio < 0.9, `orderRatio=${report.orderRatio}`)
	})

	await check('标题缺失但正文齐全 → 仍然失败', () => {
		const report = mod.checkCompleteness(
			baseline,
			fakeBody(renderedAll, allHeadings.slice(1), { mermaid: 1 })
		)
		assert(!report.ok, 'missing heading must fail')
		assert(report.headingMissing.length === 1, `missing=${report.headingMissing.length}`)
	})

	await check('标题前缀相同的不同标题 → 不得被宽松匹配', () => {
		const note = '# 测试\n\n正文内容足够长，用于验证标题匹配。\n'
		const b = mod.buildBaseline(note, ['测试'])
		const report = mod.checkCompleteness(
			b,
			fakeBody('正文内容足够长，用于验证标题匹配。', [{ textContent: '测试结果' }])
		)
		assert(!report.ok, 'startsWith must not accept a different heading')
		assert(report.headingMissing.length === 1, 'heading must be reported missing')
	})

	await check('标题渲染差异（加粗/链接/行内代码）被规范化后匹配', () => {
		const note = '# **加粗** 与 [[目标|别名]] 与 `code`\n\n正文内容足够长，用于验证标题匹配。\n'
		const b = mod.buildBaseline(note, ['**加粗** 与 [[目标|别名]] 与 `code`'])
		const report = mod.checkCompleteness(
			b,
			fakeBody('正文内容足够长，用于验证标题匹配。', [
				{ textContent: '加粗 与 别名 与 code' }
			])
		)
		assert(report.ok, `normalised heading should match: ${report.notes.join(';')}`)
	})

	await check('少一个 Mermaid SVG → 结构验收失败', () => {
		const report = mod.checkCompleteness(
			baseline,
			fakeBody(renderedAll, allHeadings, { mermaid: 1, mermaidSvg: 0 })
		)
		assert(!report.ok, 'missing mermaid svg must fail')
		const mermaid = report.structures.find(s => s.kind === 'mermaid')
		assert(mermaid && !mermaid.ok, 'mermaid structure must be reported as failed')
		assert(
			!mod.describeCompleteness(report).includes('按图形比对'),
			'stale wording must be gone'
		)
	})

	await check('图片少一张 → 结构验收失败', () => {
		const note = '# 图\n\n正文内容足够长，用于验证图片计数。\n\n![[a.png]]\n\n![](b.jpg)\n'
		const b = mod.buildBaseline(note, ['图'])
		const text = '图 正文内容足够长，用于验证图片计数。'
		const report = mod.checkCompleteness(b, fakeBody(text, [{ textContent: '图' }], { images: 1 }))
		assert(!report.ok, 'missing image must fail')
		const image = report.structures.find(s => s.kind === 'image')
		assert(image && image.expected === 2 && image.actual === 1, JSON.stringify(image))
	})

	await check('图片齐全 → 结构验收通过', () => {
		const note = '# 图\n\n正文内容足够长，用于验证图片计数。\n\n![[a.png]]\n\n![](b.jpg)\n'
		const b = mod.buildBaseline(note, ['图'])
		const text = '图 正文内容足够长，用于验证图片计数。'
		const report = mod.checkCompleteness(b, fakeBody(text, [{ textContent: '图' }], { images: 2 }))
		assert(report.ok, report.notes.join(';'))
	})

	await check('行内 $$…$$ 也计入块级公式', () => {
		const note =
			'# 公式\n\n这里有一个行内显示公式 $$ a^2+b^2=c^2 $$ 紧跟正文。\n'
		const b = mod.buildBaseline(note, ['公式'])
		const math = b.structures.find(x => x.kind === 'math')
		assert(math && math.expected === 1, `math=${JSON.stringify(math)}`)
	})

	await check('块级公式未渲染 → 结构验收失败', () => {
		const note = '# 公式\n\n正文内容足够长，用于验证公式计数。\n\n$$\nE = mc^2\n$$\n'
		const b = mod.buildBaseline(note, ['公式'])
		const text = '公式 正文内容足够长，用于验证公式计数。'
		const report = mod.checkCompleteness(b, fakeBody(text, [{ textContent: '公式' }], { math: 0 }))
		assert(!report.ok, 'missing math must fail')
		assert(report.structures.some(s => s.kind === 'math' && !s.ok), 'math must be reported')
	})

	await check('非图片嵌入 → 明确标为未验证，不并入完整保证', () => {
		const note = '# 嵌\n\n正文内容足够长，用于验证嵌入分类。\n\n![[image-4.png]]\n\n![[other-note]]\n'
		const b = mod.buildBaseline(note, ['嵌'])
		const text = '嵌 正文内容足够长，用于验证嵌入分类。'
		const report = mod.checkCompleteness(b, fakeBody(text, [{ textContent: '嵌' }], { images: 1 }))
		assert(report.ok, report.notes.join(';'))
		assert(
			report.unverified.some(u => u.includes('other-note')),
			`unverified=${JSON.stringify(report.unverified)}`
		)
		assert(mod.describeCompleteness(report).includes('未验证'), 'manifest must say unverified')
	})

	await check('侧注插件未生效 → 文本核对通过但标为未验证', () => {
		const note = '# 侧\n\n正文内容在这里，带一个侧注。<span class="sidenote">侧注内容示例</span>\n'
		const b = mod.buildBaseline(note, ['侧'])
		const text = '侧 正文内容在这里，带一个侧注。侧注内容示例'
		const report = mod.checkCompleteness(b, fakeBody(text, [{ textContent: '侧' }], { sidenotes: 0 }))
		assert(report.ok, report.notes.join(';'))
		assert(report.unverified.some(u => u.includes('侧注')), JSON.stringify(report.unverified))
	})

	await check('侧注数量齐全 → 结构验收通过', () => {
		const note =
			'# 侧\n\n正文内容在这里，带一个侧注。<span class="sidenote">侧注内容示例</span>\n'
		const b = mod.buildBaseline(note, ['侧'])
		const text = '侧 正文内容在这里，带一个侧注。侧注内容示例'
		const report = mod.checkCompleteness(b, fakeBody(text, [{ textContent: '侧' }], { sidenotes: 1 }))
		assert(report.ok, report.notes.join(';'))
		assert(!report.unverified.some(u => u.includes('侧注')), 'verified sidenote must not be unverified')
	})

	await check('句中侧注：两种渲染形态（margin / 保留 span）均可通过', () => {
		const note = '# 句\n\n正文前面<span class="sidenote">侧注甲</span>正文后面继续写。\n'
		const b = mod.buildBaseline(note, ['句'])
		const withMargin = mod.checkCompleteness(
			b,
			fakeBody('句 正文前面侧注甲正文后面继续写。', [{ textContent: '句' }], { sidenotes: 1 })
		)
		assert(withMargin.ok, `margin mode: ${withMargin.notes.join(';')}`)
		const withSpan = mod.checkCompleteness(
			b,
			fakeBody('句 正文前面正文后面继续写。', [{ textContent: '句' }], {
				spanSidenotes: 1,
				rawText: '句 正文前面侧注甲正文后面继续写。'
			})
		)
		assert(withSpan.ok, `span mode: ${withSpan.notes.join(';')}`)
	})

	// Regression for the real 89.1% failure: the offscreen host has no Side Notes
	// transform at all, so `small.sidenote-margin` is 0 *and* the span's text stays
	// inside the paragraph's text run. Choosing the key from a selector made all
	// 33 sidenote paragraphs of the ReAct note "missing" while the words were
	// present. The line must be matched on whichever form the body uses.
	await check('离屏宿主无侧注插件：正文内联含侧注文本仍须通过', () => {
		const note = '# 离屏\n\n正文前面<span class="sidenote">侧注甲</span>正文后面继续写。\n'
		const b = mod.buildBaseline(note, ['离屏'])
		const report = mod.checkCompleteness(
			b,
			fakeBody('离屏 正文前面侧注甲正文后面继续写。', [{ textContent: '离屏' }], {
				sidenotes: 0,
				spanSidenotes: 1
			})
		)
		assert(report.ok, `offscreen inline sidenote: ${report.notes.join(';')}`)
		assert(report.lineMatched === report.lineExpected, JSON.stringify(report.missingSamples))
	})

	await check('侧注行尾丢失 → 两种形态都不通过', () => {
		const note = '# 尾巴\n\n正文前面<span class="sidenote">侧注甲</span>正文后面继续写。\n'
		const b = mod.buildBaseline(note, ['尾巴'])
		const truncated = mod.checkCompleteness(
			b,
			fakeBody('尾巴 正文前面侧注甲', [{ textContent: '尾巴' }], {
				sidenotes: 0,
				spanSidenotes: 1
			})
		)
		assert(!truncated.ok, 'line truncated after the sidenote must fail')
		assert(truncated.lineMatched === 0, JSON.stringify(truncated.missingSamples))
	})

	await check('侧注以 span.sidenote 保留 → 结构计数通过并说明未渲染为 margin', () => {
		const note =
			'# 侧\n\n正文内容在这里，带一个侧注。<span class="sidenote">侧注内容示例</span>\n'
		const b = mod.buildBaseline(note, ['侧'])
		const text = '侧 正文内容在这里，带一个侧注。侧注内容示例'
		const report = mod.checkCompleteness(
			b,
			fakeBody(text, [{ textContent: '侧' }], { spanSidenotes: 1 })
		)
		assert(report.ok, report.notes.join(';'))
		const sn = report.structures.find(s => s.kind === 'sidenote')
		assert(sn && sn.ok && sn.detail.includes('span.sidenote'), JSON.stringify(sn))
	})

	await check('侧注文本丢失 → 失败', () => {
		const note =
			'# 侧\n\n正文内容在这里，带一个侧注。<span class="sidenote">侧注内容示例</span>\n'
		const b = mod.buildBaseline(note, ['侧'])
		const text = '侧 正文内容在这里，带一个侧注。'
		const report = mod.checkCompleteness(b, fakeBody(text, [{ textContent: '侧' }], { sidenotes: 1 }))
		assert(!report.ok, 'lost sidenote text must fail')
	})

	await check('报告可读：包含标题/正文/顺序与结构数字', () => {
		const report = mod.checkCompleteness(
			baseline,
			fakeBody(renderedAll, allHeadings, { mermaid: 1 })
		)
		const line = mod.describeCompleteness(report)
		assert(line.includes('标题'), line)
		assert(line.includes('正文'), line)
		assert(line.includes('顺序'), line)
		assert(line.includes('可验证部分'), line)
	})

	console.log(`\n${passed} passed, ${failures.length} failed`)
	if (failures.length > 0) process.exit(1)
}

main().catch(error => {
	console.error(error)
	process.exit(1)
})
