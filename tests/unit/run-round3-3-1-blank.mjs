/**
 * Round 3.3.1 — blank-page root-cause reproduction (offline, Node host double).
 *
 * NOT a real Obsidian E2E: it bundles the actual `buildHtml` and `auditCssVisibility`
 * from source with esbuild and drives them with a fake snapshot. It exists to prove
 * two things deterministically:
 *
 *   1. buildHtml EMBEDS the captured body between the <!--he-body-start--> /
 *      <!--he-body-end--> markers and wraps it in the reading-view chain. This
 *      rules OUT the "capture/buildHtml produced an empty body" branch (the A in
 *      the §3.2 decision tree) and points the blank-page cause at CSS.
 *
 *   2. auditCssVisibility flags exactly the CSS rules that would hide the body
 *      chain (display:none / visibility:hidden / opacity:0) and does NOT raise
 *      false positives on unrelated selectors.
 *
 * Real-browser visual verification stays NOT TESTED (headless agent sandbox);
 * the audit is an advisory static guardrail, not a render.
 */
import { build } from 'esbuild'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import { writeFileSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')

const entry = resolve(root, 'tests/unit/.r331-entry.mjs')
writeFileSync(
	entry,
	`export { buildHtml } from ${JSON.stringify(resolve(root, 'src/export/exporter.ts'))}\n` +
		`export { auditCssVisibility } from ${JSON.stringify(resolve(root, 'src/css/visibility-audit.ts'))}\n`
)

const bundle = resolve(root, 'tests/unit/.r331-bundle.mjs')
await build({
	entryPoints: [entry],
	bundle: true,
	format: 'esm',
	platform: 'node',
	outfile: bundle,
	logLevel: 'warning'
})

const { buildHtml, auditCssVisibility } = await import(pathToFileURL(bundle).href)

let pass = 0
let fail = 0
const fails = []
function check(name, cond, detail = '') {
	if (cond) {
		pass++
		console.log(`  PASS  ${name}`)
	} else {
		fail++
		fails.push(name)
		console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`)
	}
}

/** A fake capture snapshot: sizer.cloneNode returns a node whose outerHTML is
 *  the realistic content. buildHtml only reads `.outerHTML` off the clone. */
function fakeSnapshot(bodyHtml) {
	const sizer = {
		cloneNode: () => ({ outerHTML: `<div class="markdown-preview-sizer" data-sn-x="1">${bodyHtml}</div>` })
	}
	return {
		notePath: 'docs/demo.md',
		noteTitle: 'demo',
		capturedAt: new Date().toISOString(),
		captureWidth: 900,
		root: { className: 'theme-light', style: '', data: {}, bodyClassName: '' },
		reading: {
			className: 'markdown-reading-view',
			style: 'width: 100%; height: 100%;',
			data: {}
		},
		preview: { className: 'markdown-preview-view', style: '', data: {} },
		resolution: { candidates: [], reason: '', ambiguity: false, error: null },
		previewMetrics: {},
		sizer,
		stats: { blocks: 3, images: 1, mermaid: 0, sidenotes: 0, bytesOfContent: 100, math: 0 }
	}
}

console.log('\n# Round 3.3.1 blank-page reproduction — buildHtml content embedding (rules out capture/buildHtml cause)')
{
	const body = '<h1>真实标题</h1><p>正文段落内容可见。</p><img src="app://obsidian.md/cs/a.png">'
	const html = buildHtml(fakeSnapshot(body), { mode: 'export', cssText: '', assets: undefined })

	check('HTML 含正文起始标记', html.includes('<!--he-body-start-->'))
	check('HTML 含正文结束标记', html.includes('<!--he-body-end-->'))
	check('正文标题进入 index.html', html.includes('真实标题'))
	check('正文段落进入 index.html', html.includes('正文段落内容可见。'))
	check('媒体引用进入 index.html（证明 body 确有内容）', html.includes('app://obsidian.md/cs/a.png'))
	check('正文位于标记之间', (() => {
		const s = html.indexOf('<!--he-body-start-->')
		const e = html.indexOf('<!--he-body-end-->')
		return s > 0 && e > s && html.slice(s, e).includes('真实标题')
	})(), '')
	const chain = html.indexOf('markdown-reading-view')
	const view = html.indexOf('markdown-preview-view', chain)
	const sizer = html.indexOf('markdown-preview-sizer', view)
	check('包装链 reading>preview>sizer 顺序正确', chain > 0 && view > chain && sizer > view)
	check('导出模式使用 <link> 引用 assets/export.css', html.includes('assets/export.css'))
}

console.log('\n# Round 3.3.1 — auditCssVisibility flags hiding CSS')
{
	const good = `.markdown-preview-view { color: var(--text-normal); padding: 1em; }\nbody { background: #fff; }`
	const r1 = auditCssVisibility(good)
	check('正常 CSS：blankRisk=false', r1.blankRisk === false, JSON.stringify(r1.warnings))

	const displayNone = `.markdown-preview-view { display: none; }`
	const r2 = auditCssVisibility(displayNone)
	check('display:none 于正文容器：blankRisk=true', r2.blankRisk === true)
	check('  → 命中 property=display', r2.warnings.some(w => w.property === 'display'))

	const visHidden = `.markdown-preview-sizer { visibility: hidden; }`
	const r3 = auditCssVisibility(visHidden)
	check('visibility:hidden 于正文容器：blankRisk=true', r3.blankRisk === true)
	check('  → 命中 property=visibility', r3.warnings.some(w => w.property === 'visibility'))

	const opacity0 = `html, body { opacity: 0; }`
	const r4 = auditCssVisibility(opacity0)
	check('opacity:0 于 body：blankRisk=true', r4.blankRisk === true)
	check('  → 命中 property=opacity', r4.warnings.some(w => w.property === 'opacity'))

	const notBody = `.some-other-class { display: none; }\n.foo-markdown-preview-view { color: red; }`
	const r5 = auditCssVisibility(notBody)
	check('非正文容器/非目标类：blankRisk=false（无误报）', r5.blankRisk === false, JSON.stringify(r5.warnings))

	const linkHover = `a:hover { opacity: 0.5; }`
	const r6 = auditCssVisibility(linkHover)
	check('a:hover { opacity:0.5 } 不误报（选择器非正文链 & 非 0）', r6.blankRisk === false, JSON.stringify(r6.warnings))

	const combined = displayNone + '\n' + visHidden
	const r7 = auditCssVisibility(combined)
	check('多条隐藏规则：warnings 数量=2', r7.warnings.length === 2, `got ${r7.warnings.length}`)

	// P0 follow-up: noise from selectors that never apply to a static export page
	// must not be reported — a wall of false "content hidden" warnings is what
	// hides the one real failure.
	const mobile = `.is-mobile .markdown-preview-view { display: none; }`
	const r8 = auditCssVisibility(mobile)
	check('.is-mobile 规则不误报', r8.blankRisk === false, JSON.stringify(r8.warnings))
	check('  → 记为 ignored', r8.ignored === 1, `ignored=${r8.ignored}`)

	const phone = `.is-phone .markdown-preview-sizer { visibility: hidden; }`
	const r9 = auditCssVisibility(phone)
	check('.is-phone 规则不误报', r9.blankRisk === false, JSON.stringify(r9.warnings))

	const printClass = `.print .markdown-preview-view { display: none; }`
	const r10 = auditCssVisibility(printClass)
	check('.print 类规则不误报', r10.blankRisk === false, JSON.stringify(r10.warnings))

	const printMedia = `@media print {\n  .markdown-preview-view { display: none; }\n}\n.markdown-preview-view { color: #222; }`
	const r11 = auditCssVisibility(printMedia)
	check('@media print 块不误报', r11.blankRisk === false, JSON.stringify(r11.warnings))

	const mixed = `@media print { .markdown-preview-view { display: none } }\n.is-mobile .markdown-preview-view { display: none }\n.markdown-preview-sizer { display: none }`
	const r12 = auditCssVisibility(mixed)
	check('噪音与真问题混合：只报真问题', r12.warnings.length === 1, `got ${r12.warnings.length}`)
	check('  → 命中 sizer 那条', /markdown-preview-sizer/.test(r12.warnings[0]?.selector ?? ''), JSON.stringify(r12.warnings))
}

console.log(`\n总计：PASS ${pass} / FAIL ${fail}`)
if (fail > 0) {
	console.log('失败项：' + fails.join('；'))
	process.exit(1)
}
console.log('OK')
