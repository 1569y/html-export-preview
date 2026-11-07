/**
 * DOM Resolver — the single source of truth for "which element is the body?".
 *
 * Review round 2 (S1) root cause: `obsidian-react-components` injects a decoy
 * into `.markdown-preview-view` **before** the real body:
 *
 *   <div class="reactHeaderComponent markdown-preview-sizer markdown-preview-section"></div>
 *
 * `querySelector('.markdown-preview-sizer')` returns the first match in
 * document order, so capture grabbed the decoy, produced a 0-byte body and
 * still reported success. Capture and the runtime audit each re-ran that same
 * query, so both were wrong in the same way and neither noticed.
 *
 * This module replaces the query with a **deterministic ranking** over every
 * candidate, and it is the only place allowed to decide. Capture, audit and
 * the manifest all consume the same `SizerResolution`.
 *
 * Ranking rules (in order, none of them positional):
 *   1. Hard exclusions — a candidate carrying a known shell marker can never
 *      be the body, regardless of where it sits.
 *   2. Validity — a body must actually hold something (blocks, media, Mermaid,
 *      sidenotes or text). An empty candidate is not a body.
 *   3. Structural rank — Obsidian puts the body directly under
 *      `.markdown-preview-view`; deeper nesting is a fallback, not a tie.
 *   4. Rendered size — a body that laid out to zero height is suspect.
 *   5. Content weight — the richest candidate wins.
 * If 1–5 still leave two candidates indistinguishable, resolution **fails with
 * an ambiguity report** instead of silently picking one.
 */

import type {
	PreviewMetrics,
	SizerCandidateInfo,
	SizerResolution
} from './types'

/** Class the React-components plugin puts on its injected header shell. */
export const SHELL_CLASS = 'reactHeaderComponent'

/** Known decoy markers. Extend here, never with a positional rule. */
const SHELL_MARKERS = [SHELL_CLASS]

const BLOCK_SELECTOR =
	'p, li, h1, h2, h3, h4, h5, h6, blockquote, pre, table, hr, dt, dd'
const MEDIA_SELECTOR =
	'img, video, audio, iframe, embed, canvas, .internal-embed, .callout, .image-embed'
const MERMAID_SELECTOR = '.mermaid'
const SIDENOTE_SELECTOR = 'span.sidenote-number, small.sidenote-margin'
const MATH_SELECTOR = 'mjx-container, .math, .MathJax, span.math'

export type CaptureErrorCode =
	| 'no-view'
	| 'not-reading'
	| 'no-candidate'
	| 'empty'
	| 'ambiguous'
	| 'unstable'
	/** EI-01: the clone holds fewer content nodes than the live reading view. */
	| 'incomplete'

/**
 * A capture failure the user must see verbatim. Carries the resolver report so
 * the Notice can explain *which* candidates existed and why none was usable.
 */
export class CaptureError extends Error {
	constructor(
		message: string,
		readonly code: CaptureErrorCode,
		readonly details?: SizerResolution
	) {
		super(message)
		this.name = 'CaptureError'
	}
}

/** Counts used to rank candidates and to decide "is there a body here?". */
export interface Metrics {
	blocks: number
	media: number
	mermaid: number
	sidenotes: number
	math: number
	textLength: number
	width: number
	height: number
	weight: number
}

function countAll(el: HTMLElement, selector: string): number {
	try {
		return el.querySelectorAll(selector).length
	} catch {
		return 0
	}
}

function textLengthOf(el: HTMLElement): number {
	const raw = el.textContent ?? ''
	return raw.replace(/\s+/g, ' ').trim().length
}

function rectOf(el: HTMLElement): { width: number; height: number } {
	try {
		const rect = el.getBoundingClientRect()
		return { width: rect.width || 0, height: rect.height || 0 }
	} catch {
		return { width: 0, height: 0 }
	}
}

/**
 * Structural rank: how closely the candidate matches Obsidian's real layout.
 *
 *   3 — direct child of `.markdown-preview-view` (the canonical position)
 *   2 — somewhere inside `.markdown-preview-view`
 *   1 — outside it (should not happen, kept for diagnostics)
 *
 * This is a *structural* fact, not an ordering one: it stays correct whether a
 * plugin inserts its decoy before or after the real body.
 */
function structuralRank(el: HTMLElement, previewRoot: HTMLElement | null): number {
	if (!previewRoot) return 1
	let node: HTMLElement | null = el
	let depth = 0
	while (node) {
		if (node === previewRoot) {
			// `depth === 1` means the candidate IS the preview root's child.
			return depth === 1 ? 3 : 2
		}
		node = node.parentElement
		depth++
		if (depth > 64) break
	}
	return 1
}

function shellMarkerOf(el: HTMLElement): string | null {
	const className = el.getAttribute('class') ?? ''
	if (!className) return null
	const classes = className.split(/\s+/).filter(Boolean)
	for (const marker of SHELL_MARKERS) {
		if (classes.includes(marker)) return marker
	}
	return null
}

function measure(el: HTMLElement): Metrics {
	const blocks = countAll(el, BLOCK_SELECTOR)
	const media = countAll(el, MEDIA_SELECTOR)
	const mermaid = countAll(el, MERMAID_SELECTOR)
	const sidenotes = countAll(el, SIDENOTE_SELECTOR)
	const math = countAll(el, MATH_SELECTOR)
	const textLength = textLengthOf(el)
	const { width, height } = rectOf(el)

	// Media counts double: a note that is only images must outrank a candidate
	// that merely has a stray paragraph.
	const weight = blocks + media * 2 + mermaid * 2 + sidenotes * 2 + math

	return { blocks, media, mermaid, sidenotes, math, textLength, width, height, weight }
}

/** A candidate can only be the body if it holds anything at all. */
function hasContent(metrics: Metrics): boolean {
	return (
		metrics.blocks > 0 ||
		metrics.media > 0 ||
		metrics.mermaid > 0 ||
		metrics.sidenotes > 0 ||
		metrics.math > 0 ||
		metrics.textLength > 0
	)
}

function describeCandidate(info: SizerCandidateInfo): string {
	if (info.excluded) {
		return `#${info.index} .${info.className.replace(/\s+/g, '.')} — 已排除：${info.excluded}`
	}
	return (
		`#${info.index} .${info.className.replace(/\s+/g, '.')} — ` +
		`内容块 ${info.blocks}、媒体 ${info.media}、Mermaid ${info.mermaid}、` +
		`批注 ${info.sidenotes}、文本 ${info.textLength} 字、` +
		`尺寸 ${Math.round(info.width)}×${Math.round(info.height)}`
	)
}

function reportBody(res: SizerResolution): string {
	if (res.candidates.length === 0) return '阅读视图内没有任何 .markdown-preview-sizer 候选。'
	return res.candidates.map(describeCandidate).join('\n')
}

/**
 * Resolve the real body container inside one reading view.
 *
 * Never throws: returns a resolution with `sizer === null` plus an `error` code
 * and a full candidate report. `assertResolved()` turns that into a
 * user-facing `CaptureError`.
 */
export function resolveSizer(readingRoot: HTMLElement): SizerResolution {
	const previewRoot =
		(readingRoot.querySelector<HTMLElement>('.markdown-preview-view') as
			| HTMLElement
			| null) ?? null

	const found = Array.from(
		readingRoot.querySelectorAll<HTMLElement>('.markdown-preview-sizer')
	)

	const base: SizerResolution = {
		sizer: null,
		readingRoot,
		previewRoot,
		candidates: [],
		reason: '',
		ambiguity: false,
		error: null
	}

	if (found.length === 0) {
		return { ...base, error: 'no-candidate', reason: reportBody(base) }
	}

	const candidates: SizerCandidateInfo[] = found.map((el, index) => {
		const metrics = measure(el)
		const marker = shellMarkerOf(el)
		const excluded = marker
			? `插件注入的空壳（类名 ${marker}）`
			: el.isConnected === false
				? '节点已从文档中移除'
				: null
		return {
			index,
			className: el.getAttribute('class') ?? '',
			parentClassName: el.parentElement?.getAttribute('class') ?? '',
			structuralRank: structuralRank(el, previewRoot),
			excluded,
			blocks: metrics.blocks,
			media: metrics.media,
			mermaid: metrics.mermaid,
			sidenotes: metrics.sidenotes,
			math: metrics.math,
			textLength: metrics.textLength,
			width: metrics.width,
			height: metrics.height,
			weight: metrics.weight,
			selected: false
		}
	})

	const usable = candidates.filter(c => !c.excluded && hasContent(c))

	if (usable.length === 0) {
		const res: SizerResolution = {
			...base,
			candidates,
			error: 'empty',
			reason: '没有候选容器包含正文内容'
		}
		return { ...res, reason: `${res.reason}\n${reportBody(res)}` }
	}

	// Rank by (structure, rendered, weight) — never by DOM order.
	const ranked = [...usable].sort((a, b) => {
		if (b.structuralRank !== a.structuralRank) return b.structuralRank - a.structuralRank
		const aRendered = a.height > 0 ? 1 : 0
		const bRendered = b.height > 0 ? 1 : 0
		if (bRendered !== aRendered) return bRendered - aRendered
		if (b.weight !== a.weight) return b.weight - a.weight
		return 0
	})

	const top = ranked[0]
	const second = ranked[1]

	const tied =
		second !== undefined &&
		second.structuralRank === top.structuralRank &&
		(second.height > 0 ? 1 : 0) === (top.height > 0 ? 1 : 0) &&
		second.weight === top.weight

	if (tied) {
		const res: SizerResolution = {
			...base,
			candidates,
			error: 'ambiguous',
			ambiguity: true,
			reason: '存在两个内容量相同的候选容器，无法确定哪个是真实正文'
		}
		return { ...res, reason: `${res.reason}\n${reportBody(res)}` }
	}

	top.selected = true
	const chosen = found[top.index]
	const reason =
		`选中 #${top.index}（结构层级 ${top.structuralRank}、` +
		`内容块 ${top.blocks}、媒体 ${top.media}、Mermaid ${top.mermaid}、` +
		`批注 ${top.sidenotes}、权重 ${top.weight}）` +
		(usable.length > 1 ? `，共 ${usable.length} 个可用候选` : '，唯一可用候选')

	return {
		...base,
		sizer: chosen,
		candidates,
		reason
	}
}

/** Turn a failed resolution into a `CaptureError` with the candidate report. */
export function assertResolved(res: SizerResolution): asserts res is SizerResolution & {
	sizer: HTMLElement
} {
	if (res.sizer && res.error === null) return

	const header =
		res.error === 'no-candidate'
			? '找不到正文容器：阅读视图内没有 .markdown-preview-sizer'
			: res.error === 'ambiguous'
				? '正文容器存在歧义，已停止导出（不会猜测）'
				: '抓取到的正文为空，可能是选择器命中了错误容器'

	throw new CaptureError(`${header}\n${res.reason}`, res.error ?? 'empty', res)
}

/** Candidate count / body stats for the manifest and the audit. */
export function summarizeResolution(res: SizerResolution): Record<string, unknown> {
	return {
		candidates: res.candidates.length,
		excluded: res.candidates.filter(c => c.excluded).map(c => ({
			index: c.index,
			className: c.className,
			reason: c.excluded
		})),
		selectedIndex: res.candidates.find(c => c.selected)?.index ?? null,
		reason: res.reason,
		ambiguity: res.ambiguity,
		error: res.error
	}
}

/** Content numbers shared by the emptiness check and the manifest stats. */
export function contentMetrics(sizer: HTMLElement): Metrics {
	return measure(sizer)
}

/** Layout facts about `.markdown-preview-view`, captured for fidelity checks. */
export function readPreviewMetrics(
	previewRoot: HTMLElement | null,
	readingRoot: HTMLElement
): PreviewMetrics {
	const target = previewRoot ?? readingRoot
	const { width } = rectOf(target)
	let paddingLeft = 0
	let paddingRight = 0
	let fileLineWidth: string | null = null

	try {
		const style = getComputedStyle(target)
		paddingLeft = parseFloat(style.paddingLeft || '0') || 0
		paddingRight = parseFloat(style.paddingRight || '0') || 0
		const raw = style.getPropertyValue('--file-line-width').trim()
		fileLineWidth = raw || null
	} catch {
		// `getComputedStyle` is unavailable in the unit-test double; the defaults
		// above are still a truthful "unknown" rather than a fabricated number.
	}

	return {
		width,
		paddingLeft,
		paddingRight,
		readableLineWidth:
			previewRoot?.classList.contains('is-readable-line-width') ?? false,
		fileLineWidth
	}
}
