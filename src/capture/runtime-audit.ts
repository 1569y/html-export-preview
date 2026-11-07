import type { App } from 'obsidian'
import { summarizeResolution } from './dom-resolver'
import type { CaptureSnapshot } from './types'

/**
 * Runtime evidence for the open questions from the static audit
 * (HTML_EXPORT_COMPATIBILITY_AUDIT.md §15, U1–U5), plus the measurements that
 * review round 1 (R4) found missing.
 *
 * This runs against the *live* reading view, not the clone, so the numbers are
 * what the user actually sees. Everything here is read-only.
 *
 * What "evidence" means for this file (R4):
 *  - a **computed value**, not just the inline declaration — a variable that is
 *    only declared on `:root` still has an effect, and inline-only reporting
 *    would call that "unset";
 *  - the **inheritance chain** per variable: every ancestor, what it computed
 *    to there, and therefore which node actually declared it;
 *  - the **effective side** per sidenote, through the full override chain, next
 *    to what the capture rule would conclude — so a disagreement is visible
 *    instead of silently baked into the export;
 *  - **anchor geometry**: the rect of the block the marker lives in, the rect of
 *    the margin box, the delta between them, and any overlap between
 *    consecutive margins on the same side;
 *  - **generated content** (`::before` / `::after`) for both the marker and the
 *    margin box — the number itself is drawn by `content: attr(...)`, so if
 *    that rule is lost the export silently loses every number.
 */
export interface RuntimeAudit {
	generatedAt: string
	notePath: string
	captureWidth: number
	U1_sidenoteStructure: unknown
	U2_imageEmbed: unknown
	U3_marginComputedStyle: unknown
	U4_variableHosts: unknown
	U5_sidenoteSides: unknown
	/** R4: where the marker sits relative to its anchor, and whether margins collide. */
	U6_anchorGeometry: unknown
	/** R4: `::before` / `::after` computed content for marker and margin box. */
	U7_pseudoContent: unknown
	/** R4: font-size / line-height inheritance chain, which drives every offset. */
	U8_typographyChain: unknown
	/** S1: which container was chosen, and why — the same verdict capture used. */
	resolution: Record<string, unknown>
	stylesheets: unknown
	snippets: unknown
	summary: Record<string, number | string | boolean>
}

/** Custom properties that carry Side Notes' layout state. */
const SN_VARS = [
	'--sidenote-offset',
	'--sidenote-offset-left',
	'--sidenote-offset-right',
	'--sidenote-width',
	'--sidenote-scale',
	'--sidenote-line-offset',
	'--sidenote-shift',
	'--sn-text-color',
	'--sn-font-size',
	'--sn-number-color',
	'--sn-margin-width',
	'--sn-max-width'
]

export async function buildRuntimeAudit(
	app: App,
	snap: CaptureSnapshot
): Promise<RuntimeAudit> {
	// S1: audit the *same* element capture chose. Re-querying here is how the
	// two used to disagree — audit happily reported on the decoy shell while
	// capture reported on nothing at all.
	const root = snap.resolution.readingRoot
	const sizer = snap.resolution.sizer

	const sides = auditSides(sizer, root)
	const geometry = auditGeometry(sizer, root)
	const pseudo = auditPseudoContent(sizer)

	return {
		generatedAt: new Date().toISOString(),
		notePath: snap.notePath,
		captureWidth: snap.captureWidth,
		U1_sidenoteStructure: auditStructure(sizer),
		U2_imageEmbed: auditImageEmbed(sizer),
		U3_marginComputedStyle: auditMarginStyle(sizer),
		U4_variableHosts: auditVariableHosts(sizer),
		U5_sidenoteSides: sides,
		U6_anchorGeometry: geometry,
		U7_pseudoContent: pseudo,
		U8_typographyChain: auditTypography(sizer),
		resolution: summarizeResolution(snap.resolution),
		stylesheets: auditStylesheets(),
		snippets: await auditSnippets(app),
		summary: {
			notePath: snap.notePath,
			captureWidth: snap.captureWidth,
			sidenotes: snap.stats.sidenotes,
			left: snap.stats.sidenoteLeft,
			right: snap.stats.sidenoteRight,
			marginNotes: snap.stats.marginNotes,
			mermaid: snap.stats.mermaid,
			mermaidWithSvg: snap.stats.mermaidWithSvg,
			images: snap.stats.images,
			stylesheets: snap.stats.stylesheets,
			// R4 headline numbers, so a reviewer does not have to read the blobs.
			sideRuleMismatch: (sides as { mismatch?: boolean }).mismatch ?? false,
			overlappingMargins:
				(geometry as { overlapCount?: number }).overlapCount ?? 0,
			sidenoteNumberRendered:
				(pseudo as { numberRendered?: boolean }).numberRendered ?? false
		}
	}
}

/* ------------------------------------------------------------------ U1 ---- */

function auditStructure(sizer: HTMLElement | null): unknown {
	if (!sizer) return { error: 'no sizer' }
	const markers = Array.from(
		sizer.querySelectorAll<HTMLElement>('span.sidenote-number')
	)
	const samples = markers.slice(0, 3).map(el => {
		const margin = el.querySelector<HTMLElement>('small.sidenote-margin')
		const anchorBlock = el.closest('p, li, h1, h2, h3, h4, h5, h6')
		return {
			wrapperClass: el.className,
			wrapperAttrs: attrMap(el),
			marginExists: Boolean(margin),
			marginTag: margin?.tagName ?? null,
			marginClass: margin?.className ?? null,
			marginAttrs: margin ? attrMap(margin) : null,
			marginInlineStyle: margin?.getAttribute('style') ?? null,
			anchorBlockTag: anchorBlock?.tagName ?? null,
			richChildren: margin
				? Array.from(margin.children).map(c => c.tagName).slice(0, 12)
				: [],
			outerHtmlPreview: el.outerHTML.slice(0, 700)
		}
	})

	const legacy = sizer.querySelectorAll('span.sidenote').length
	return {
		wrapperSelectorHits: markers.length,
		rawSidenoteSpans: legacy,
		// A marker with no margin box means the plugin recognised the syntax but
		// never produced a note — the export would keep an invisible number.
		markersWithoutMargin: markers.filter(
			el => !el.querySelector('small.sidenote-margin')
		).length,
		// Margins that are not inside a marker are orphans: nothing positions them.
		orphanMargins: Array.from(
			sizer.querySelectorAll<HTMLElement>('small.sidenote-margin')
		).filter(m => !m.closest('.sidenote-number')).length,
		samples
	}
}

/* ------------------------------------------------------------------ U2 ---- */

function auditImageEmbed(sizer: HTMLElement | null): unknown {
	if (!sizer) return { error: 'no sizer' }
	const images = Array.from(sizer.querySelectorAll('img'))
	return {
		total: images.length,
		byProtocol: countBy(images.map(img => protocolOf(img.getAttribute('src')))),
		broken: images.filter(img => img.complete && img.naturalWidth === 0).length,
		samples: images.slice(0, 3).map(img => {
			const parent = img.parentElement
			return {
				src: img.getAttribute('src'),
				srcProtocol: protocolOf(img.getAttribute('src')),
				srcDecoded: safeDecode(img.getAttribute('src')),
				width: img.getAttribute('width'),
				alt: img.getAttribute('alt'),
				naturalWidth: img.naturalWidth,
				naturalHeight: img.naturalHeight,
				complete: img.complete,
				parentTag: parent?.tagName ?? null,
				parentClass: parent?.className ?? null,
				parentAttrs: parent ? attrMap(parent) : null
			}
		})
	}
}

/* ------------------------------------------------------------------ U3 ---- */

function auditMarginStyle(sizer: HTMLElement | null): unknown {
	const margin = sizer?.querySelector<HTMLElement>('small.sidenote-margin')
	if (!margin) return { error: 'no margin' }
	const cs = getComputedStyle(margin)
	const wrapper = margin.closest<HTMLElement>('.sidenote-number')
	const anchor = wrapper?.closest<HTMLElement>('p, li, h1, h2, h3, h4, h5, h6')

	const props = [
		'display',
		'position',
		'width',
		'max-width',
		'min-width',
		'font-size',
		'line-height',
		'font-family',
		'color',
		'text-align',
		'top',
		'left',
		'right',
		'bottom',
		'transform',
		'margin-top',
		'padding-left',
		'padding-right',
		'white-space',
		'word-break',
		'overflow-wrap'
	]

	const computed: Record<string, string> = {}
	for (const prop of props) computed[prop] = cs.getPropertyValue(prop)

	return {
		computed,
		// The two declarations that decide *where* the note lands vertically.
		lineOffsetVar: cs.getPropertyValue('--sidenote-line-offset').trim() || null,
		shiftVar: cs.getPropertyValue('--sidenote-shift').trim() || null,
		anchorLineHeight: anchor
			? getComputedStyle(anchor).getPropertyValue('line-height')
			: null,
		anchorFontSize: anchor
			? getComputedStyle(anchor).getPropertyValue('font-size')
			: null,
		wrapperPosition: wrapper
			? getComputedStyle(wrapper).getPropertyValue('position')
			: null,
		dataSidenoteNum: margin.dataset.sidenoteNum ?? null,
		dataSidenoteSide: margin.dataset.sidenoteSide ?? null,
		inlineStyle: margin.getAttribute('style') ?? null
	}
}

/* ------------------------------------------------------------------ U4 ---- */

function auditVariableHosts(sizer: HTMLElement | null): unknown {
	const margin = sizer?.querySelector<HTMLElement>('small.sidenote-margin')
	if (!margin) return { error: 'no margin' }

	const hosts: Record<string, unknown> = {}
	for (const prop of SN_VARS) hosts[prop] = variableChain(margin, prop)

	const htmlStyle = document.documentElement.getAttribute('style') ?? ''
	const htmlDeclared = SN_VARS.filter(p =>
		htmlStyle.includes(`${p}:`) || htmlStyle.includes(`${p} :`)
	)

	return {
		// Whether the root snapshot in the capture is even necessary: if Side
		// Notes declares nothing on <html>, `snap.root.style` is empty and the
		// clone does not need it.
		htmlInlineStyleLength: htmlStyle.length,
		htmlInlineStylePreview: htmlStyle.slice(0, 600),
		htmlDeclaredVars: htmlDeclared,
		htmlDataset: dataMap(document.documentElement),
		hosts
	}
}

/**
 * Resolve one custom property the way the browser does: walk from the element
 * up to `<html>`, and find the innermost node where the computed value changes.
 * That node is the declaration the element actually inherits from.
 */
function variableChain(el: HTMLElement, prop: string): unknown {
	const nodes: HTMLElement[] = []
	let node: HTMLElement | null = el
	while (node) {
		nodes.push(node)
		node = node.parentElement
	}
	if (!nodes.includes(document.documentElement)) {
		nodes.push(document.documentElement)
	}

	const chain: Array<{
		node: string
		computed: string | null
		inline: string | null
		changedHere: boolean
	}> = []

	let previous: string | null = null
	for (const current of nodes) {
		const computed =
			getComputedStyle(current).getPropertyValue(prop).trim() || null
		const inline = current.style?.getPropertyValue(prop)?.trim() || null
		chain.push({
			node: describe(current),
			computed,
			inline,
			changedHere: computed !== previous
		})
		previous = computed
	}

	// Innermost node whose computed value differs from its parent is the one
	// that declared it.
	const declaring = chain
		.filter(entry => entry.changedHere && entry.computed !== null)
		.map(entry => entry.node)

	return {
		resolved: chain[0]?.computed ?? null,
		declaredAt: declaring,
		inherited: declaring.length === 0,
		chain: chain.slice(0, 6)
	}
}

/* ------------------------------------------------------------------ U5 ---- */

function auditSides(
	sizer: HTMLElement | null,
	root: HTMLElement | null
): unknown {
	if (!sizer) return { error: 'no sizer' }
	const margins = Array.from(
		sizer.querySelectorAll<HTMLElement>('small.sidenote-margin')
	)

	const bySide: Record<string, number> = { left: 0, right: 0, unspecified: 0 }
	const byCaptureRule: Record<string, number> = {
		left: 0,
		right: 0,
		unspecified: 0
	}
	const detail: Array<Record<string, unknown>> = []

	for (const m of margins) {
		const effective = effectiveSide(m, root)
		bySide[effective]++

		const ruleSide = captureRuleSide(m, root)
		byCaptureRule[ruleSide]++

		if (detail.length < 8) {
			detail.push({
				num: m.dataset.sidenoteNum ?? null,
				marginSide: m.dataset.sidenoteSide ?? null,
				wrapperSide:
					m.closest<HTMLElement>('.sidenote-number')?.dataset.sidenoteSide ??
					null,
				readingSide: root?.getAttribute('data-sidenote-position') ?? null,
				htmlSide:
					document.documentElement.getAttribute('data-sidenote-position') ??
					null,
				effective,
				captureRuleSide: ruleSide
			})
		}
	}

	const mismatch =
		bySide.left !== byCaptureRule.left ||
		bySide.right !== byCaptureRule.right

	return {
		globalPosition: root?.getAttribute('data-sidenote-position') ?? null,
		htmlGlobalPosition:
			document.documentElement.getAttribute('data-sidenote-position') ?? null,
		rootAttrs: root ? attrMap(root) : null,
		counts: bySide,
		countsByCaptureRule: byCaptureRule,
		/** true means the capture stats disagree with the full override chain. */
		mismatch,
		total: margins.length,
		sampleNums: margins.slice(0, 8).map(m => m.dataset.sidenoteNum ?? ''),
		detail
	}
}

/** Full override chain: margin → wrapper → reading root → `<html>` → right. */
function effectiveSide(
	m: HTMLElement,
	root: HTMLElement | null
): 'left' | 'right' | 'unspecified' {
	const candidates = [
		m.dataset.sidenoteSide,
		m.closest<HTMLElement>('.sidenote-number')?.dataset.sidenoteSide,
		root?.getAttribute('data-sidenote-position') ?? undefined,
		document.documentElement.getAttribute('data-sidenote-position') ?? undefined
	]
	for (const value of candidates) {
		if (value === 'left' || value === 'right') return value
	}
	return 'unspecified'
}

/**
 * The narrower rule dom-capture/countSidenotes uses today. Kept separately so
 * a disagreement shows up in this report instead of only in the export.
 */
function captureRuleSide(
	m: HTMLElement,
	root: HTMLElement | null
): 'left' | 'right' {
	const override = m.dataset.sidenoteSide
	if (override === 'left' || override === 'right') return override
	const global = root?.getAttribute('data-sidenote-position')
	return global === 'left' ? 'left' : 'right'
}

/* ------------------------------------------------------------------ U6 ---- */

function auditGeometry(
	sizer: HTMLElement | null,
	root: HTMLElement | null
): unknown {
	if (!sizer) return { error: 'no sizer' }
	const margins = Array.from(
		sizer.querySelectorAll<HTMLElement>('small.sidenote-margin')
	)

	const rows = margins.map(m => {
		const wrapper = m.closest<HTMLElement>('.sidenote-number')
		const anchor =
			wrapper?.closest<HTMLElement>('p, li, h1, h2, h3, h4, h5, h6') ?? null
		const mr = m.getBoundingClientRect()
		const ar = anchor?.getBoundingClientRect() ?? null
		const wr = wrapper?.getBoundingClientRect() ?? null
		const cs = getComputedStyle(m)

		return {
			num: m.dataset.sidenoteNum ?? null,
			side: effectiveSide(m, root),
			anchorTag: anchor?.tagName ?? null,
			anchorTop: ar ? round(ar.top) : null,
			anchorBottom: ar ? round(ar.bottom) : null,
			markerTop: wr ? round(wr.top) : null,
			marginTop: round(mr.top),
			marginBottom: round(mr.bottom),
			marginHeight: round(mr.height),
			marginLeft: round(mr.left),
			marginWidth: round(mr.width),
			/** How far below the anchor's top edge the note starts. */
			deltaFromAnchor: ar ? round(mr.top - ar.top) : null,
			lineOffsetVar: cs.getPropertyValue('--sidenote-line-offset').trim() || null,
			shiftVar: cs.getPropertyValue('--sidenote-shift').trim() || null,
			topComputed: cs.top,
			transformComputed: cs.transform,
			visibleInViewport: mr.bottom > 0 && mr.top < window.innerHeight
		}
	})

	// Margins on the same side must not sit on top of each other. If they do,
	// the bake is already wrong in the source view and the export will inherit
	// the collision verbatim.
	const overlaps: Array<Record<string, unknown>> = []
	for (const side of ['left', 'right'] as const) {
		const list = rows
			.filter(r => r.side === side)
			.sort((a, b) => a.marginTop - b.marginTop)
		for (let i = 1; i < list.length; i++) {
			const prev = list[i - 1]
			const cur = list[i]
			const overlap = prev.marginBottom - cur.marginTop
			if (overlap > 0.5) {
				overlaps.push({
					side,
					a: prev.num,
					b: cur.num,
					overlapPx: round(overlap)
				})
			}
		}
	}

	return {
		count: rows.length,
		overlapCount: overlaps.length,
		overlaps: overlaps.slice(0, 12),
		// Geometry of the outermost containers, so the export can match them.
		readingRect: root ? rectOf(root) : null,
		sizerRect: rectOf(sizer),
		samples: rows.slice(0, 8)
	}
}

/* ------------------------------------------------------------------ U7 ---- */

function auditPseudoContent(sizer: HTMLElement | null): unknown {
	if (!sizer) return { error: 'no sizer' }
	const wrapper = sizer.querySelector<HTMLElement>('.sidenote-number')
	const margin = sizer.querySelector<HTMLElement>('small.sidenote-margin')
	if (!wrapper || !margin) return { error: 'no marker or margin' }

	const before = pseudoOf(wrapper, '::before')
	const after = pseudoOf(wrapper, '::after')
	const marginBefore = pseudoOf(margin, '::before')
	const marginAfter = pseudoOf(margin, '::after')

	// The number is drawn by `content: attr(data-sidenote-num)` on one of these.
	// If none of them produces a non-empty content value, every number in the
	// export will be blank — that is worth flagging loudly.
	const numberRendered = [before, after, marginBefore, marginAfter].some(
		p => p !== null && p.content !== 'none' && p.content !== 'normal' && p.content !== '""'
	)

	return {
		numberRendered,
		dataSidenoteNum: margin.dataset.sidenoteNum ?? null,
		wrapperBefore: before,
		wrapperAfter: after,
		marginBefore,
		marginAfter
	}
}

function pseudoOf(
	el: Element,
	pseudo: '::before' | '::after'
): {
	content: string
	display: string
	position: string
	fontSize: string
	fontVariantNumeric: string
	color: string
	top: string
	left: string
	right: string
	width: string
} | null {
	try {
		const cs = getComputedStyle(el, pseudo)
		return {
			content: cs.content,
			display: cs.display,
			position: cs.position,
			fontSize: cs.fontSize,
			fontVariantNumeric: cs.fontVariantNumeric,
			color: cs.color,
			top: cs.top,
			left: cs.left,
			right: cs.right,
			width: cs.width
		}
	} catch {
		return null
	}
}

/* ------------------------------------------------------------------ U8 ---- */

function auditTypography(sizer: HTMLElement | null): unknown {
	const margin = sizer?.querySelector<HTMLElement>('small.sidenote-margin')
	if (!margin) return { error: 'no margin' }
	const anchor =
		margin
			.closest<HTMLElement>('.sidenote-number')
			?.closest<HTMLElement>('p, li, h1, h2, h3, h4, h5, h6') ?? null

	const chainOf = (prop: string): Array<Record<string, string | null>> => {
		const nodes: HTMLElement[] = []
		let node: HTMLElement | null = margin
		while (node) {
			nodes.push(node)
			node = node.parentElement
		}
		return nodes.slice(0, 6).map(n => ({
			node: describe(n),
			value: getComputedStyle(n).getPropertyValue(prop).trim() || null
		}))
	}

	return {
		htmlFontSize: getComputedStyle(document.documentElement).fontSize,
		bodyFontSize: getComputedStyle(document.body).fontSize,
		bodyLineHeight: getComputedStyle(document.body).lineHeight,
		bodyFontFamily: getComputedStyle(document.body).fontFamily,
		anchorFontSize: anchor
			? getComputedStyle(anchor).getPropertyValue('font-size')
			: null,
		anchorLineHeight: anchor
			? getComputedStyle(anchor).getPropertyValue('line-height')
			: null,
		marginFontSize: getComputedStyle(margin).getPropertyValue('font-size'),
		marginLineHeight: getComputedStyle(margin).getPropertyValue('line-height'),
		fontSizeChain: chainOf('font-size'),
		lineHeightChain: chainOf('line-height')
	}
}

/* ------------------------------------------------------------ stylesheets -- */

function auditStylesheets(): unknown {
	const sheets = Array.from(document.styleSheets)
	return sheets.map((sheet, index) => {
		let ruleCount = -1
		let error: string | null = null
		try {
			ruleCount = sheet.cssRules.length
		} catch (e) {
			error = e instanceof Error ? e.name : 'unknown'
		}
		const owner = sheet.ownerNode as HTMLElement | null
		return {
			index,
			href: sheet.href,
			ownerTag: owner?.tagName ?? null,
			ownerId: owner?.id ?? null,
			ownerClass: owner?.className ?? null,
			ownerAttrs: owner ? attrMap(owner) : null,
			ruleCount,
			error,
			/** Cross-origin sheets cannot be read through the CSSOM. */
			readable: ruleCount >= 0
		}
	})
}

async function auditSnippets(app: App): Promise<unknown> {
	const configDir = app.vault.configDir
	const result: Record<string, unknown> = { enabled: [], missing: [], files: [] }
	try {
		const raw = await app.vault.adapter.read(`${configDir}/appearance.json`)
		const appearance = JSON.parse(raw) as { enabledCssSnippets?: string[] }
		const enabled = appearance.enabledCssSnippets ?? []
		result.enabled = enabled

		const listed = await app.vault.adapter.list(`${configDir}/snippets`)
		const files = listed.files.map(f => f.split('/').pop() ?? f)
		result.files = files
		result.missing = enabled.filter(
			name => !files.includes(`${name}.css`) && !files.includes(name)
		)
	} catch (e) {
		result.error = e instanceof Error ? e.message : String(e)
	}
	return result
}

/* ---------------------------------------------------------------- helpers -- */

function attrMap(el: Element): Record<string, string> {
	const out: Record<string, string> = {}
	for (const attr of Array.from(el.attributes)) {
		if (attr.name === 'style') continue
		out[attr.name] = attr.value.length > 120 ? `${attr.value.slice(0, 120)}…` : attr.value
	}
	return out
}

function dataMap(el: Element): Record<string, string> {
	const out: Record<string, string> = {}
	for (const attr of Array.from(el.attributes)) {
		if (attr.name.startsWith('data-')) out[attr.name] = attr.value
	}
	return out
}

function describe(el: HTMLElement): string {
	const cls = el.className ? `.${String(el.className).split(/\s+/).join('.')}` : ''
	const id = el.id ? `#${el.id}` : ''
	return `${el.tagName.toLowerCase()}${id}${cls}`
}

function protocolOf(src: string | null): string {
	if (!src) return '(none)'
	const index = src.indexOf(':')
	return index > 0 ? src.slice(0, index) : '(relative)'
}

function safeDecode(value: string | null): string | null {
	if (!value) return null
	try {
		return decodeURIComponent(value)
	} catch {
		return null
	}
}

function countBy(values: string[]): Record<string, number> {
	const out: Record<string, number> = {}
	for (const value of values) out[value] = (out[value] ?? 0) + 1
	return out
}

function round(value: number): number {
	return Math.round(value * 100) / 100
}

function rectOf(el: Element): Record<string, number> {
	const r = el.getBoundingClientRect()
	return {
		top: round(r.top),
		left: round(r.left),
		width: round(r.width),
		height: round(r.height)
	}
}
