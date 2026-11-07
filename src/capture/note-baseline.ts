/**
 * P0 — completeness measured against the note itself, not against the DOM.
 *
 * The reading view is virtualised: it mounts the blocks near the viewport and
 * leaves the rest as reserved height. Measured on a 2,699-line note (271
 * headings, 85,190px tall), the body held 22–32 blocks / ~1,400 characters at
 * any scroll position, including `scrollTop = 0`. Every earlier gate compared
 * the live DOM with its own clone, so a body that was 5% rendered passed all of
 * them.
 *
 * This module builds a baseline from two public sources — `metadataCache` for
 * headings and the raw file for text and structure — and answers one question:
 * does the body we are about to write contain the whole note?
 *
 * Requirements are exact, not statistical: every supported line must be found
 * once, in order, and every countable structure (Mermaid diagram, image, block
 * formula, inline sidenote) must be present in the rendered body. Content that
 * cannot be verified reliably is listed as *unverified* and is never folded
 * into a "100% complete" claim.
 */

/** One line of the note, reduced to the text a reader should see. */
export interface BaselineLine {
	/** Normalised text (no whitespace) used for containment checks. */
	text: string
	/** 1-based source line, so a failure can point at the note. */
	line: number
	/** Human-readable excerpt for failure messages. */
	raw?: string
	/**
	 * Same line with its sidenote bodies inline — the form the text run takes
	 * when `<span class="sidenote">` is rendered as ordinary inline content
	 * (an offscreen render, or a vault where Side Notes leaves the span alone).
	 */
	alt?: string
}

export type StructureKind = 'mermaid' | 'image' | 'math' | 'sidenote'

/** A countable shape that must survive rendering, with its source count. */
export interface StructureExpectation {
	kind: StructureKind
	expected: number
	label: string
}

export interface NoteBaseline {
	headings: string[]
	lines: BaselineLine[]
	/** Inline `<span class="sidenote">` bodies: checked as text, not as order. */
	sidenotes: BaselineLine[]
	structures: StructureExpectation[]
	/** Things we refuse to claim: reported, never counted as verified. */
	unverified: string[]
	/** Lines too short to match reliably (reported, not silently dropped). */
	shortLines: number
	/** Total normalised characters of all baseline lines. */
	characters: number
}

export interface StructureReport {
	kind: StructureKind
	label: string
	expected: number
	actual: number
	ok: boolean
	/** Why it is ok/failed, or why the count is advisory. */
	detail?: string
}

export interface CompletenessReport {
	ok: boolean
	headingExpected: number
	headingMatched: number
	headingMissing: string[]
	lineExpected: number
	/** Lines found at or after the cursor (i.e. present *and* in order). */
	lineMatched: number
	/** Lines present somewhere but before the cursor — order violated. */
	lineOutOfOrder: number
	coverage: number
	orderRatio: number
	missingSamples: string[]
	structures: StructureReport[]
	unverified: string[]
	shortLines: number
	notes: string[]
}

/**
 * Emoji are glyphs, and parsers disagree about them: Obsidian's highlighting
 * kept `🌳` but dropped the leading `🟢` of `==🟢🌳==`. They are decorative
 * markers, not sentences, so they are removed from the baseline; the words
 * around them are still matched exactly.
 */
const EMOJI = /[\p{Extended_Pictographic}\u{FE0E}\u{FE0F}\u{200D}\u{20E3}\u{1F3FB}-\u{1F3FF}]/gu

/**
 * Sidenote bodies are raw HTML text: markdown inside `<span class="sidenote">`
 * is not parsed, so `**bold**` and `*italic*` stay literal while the rendered
 * margin note may or may not keep them. Comparing letters and digits only makes
 * that difference irrelevant without weakening the words themselves.
 */
function lettersOnly(value: string): string {
	return value.replace(/[^\p{L}\p{N}]/gu, '')
}

/** Whitespace is layout, not content: compare on the squeezed string. */
function squeeze(value: string): string {
	return value.replace(/\s+/g, '')
}

/** Inline HTML that renders as text (sidenote spans are handled separately). */
const SIDENOTE_SPAN =
	/<span\b[^>]*\bclass="[^"]*\bsidenote\b[^"]*"[^>]*>([\s\S]*?)<\/span>/gi

const BLOCK_TAG = /<[^>]+>/g

/**
 * Reduce inline markdown to the text a renderer would show.
 *
 * Every rule here removes markup that is *by design* absent from `textContent`
 * (or present verbatim, in the case of code). Nothing here makes the match
 * fuzzy: after this pass the comparison is exact containment.
 */
function normalizeInline(value: string, literal = false): string {
	if (literal) return squeeze(value).replace(EMOJI, '')
	return squeeze(
		value
			.replace(/<!--[\s\S]*?-->/g, '')
			.replace(/!\[\[[^\]]*\]\]/g, '')
			.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
			.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
			.replace(/\[\[([^\]]+)\]\]/g, '$1')
			.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
			.replace(/`([^`]*)`/g, '$1')
			.replace(/==([^=]*)==/g, '$1')
			.replace(/\*\*([^*]+)\*\*/g, '$1')
			.replace(/\*([^*]+)\*/g, '$1')
			.replace(/~~([^~]+)~~/g, '$1')
			.replace(/\[\^[^\]]*\]/g, '')
			.replace(BLOCK_TAG, '')
			.replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, '$1')
			.replace(/&nbsp;/g, ' ')
			.replace(/&amp;/g, '&')
			.replace(/&lt;/g, '<')
			.replace(/&gt;/g, '>')
			.replace(/&quot;/g, '"')
			.replace(/&#39;/g, "'")
	).replace(EMOJI, '')
}

/** Strip block-level prefixes (`#`, `>`, `-`, `1.`, `|`). */
function stripBlockPrefix(value: string): string {
	let text = value
	text = text.replace(/^\s{0,3}#{1,6}\s+/, '')
	text = text.replace(/^\s{0,3}>+\s?/, '')
	text = text.replace(/^\s*[-*+]\s+\[[ xX]\]\s+/, '')
	text = text.replace(/^\s*[-*+]\s+/, '')
	text = text.replace(/^\s*\d+[.)]\s+/, '')
	// Callout headers render as a title without the `[!type]` marker.
	text = text.replace(/^\s*\[![^\]]+\]\s*/, '')
	// Table rows only: keep the cell text, drop the pipes. Applying this to every
	// line would also eat the `|` in `[[note|alias]]`.
	if (/^\s*\|/.test(text)) {
		text = text.replace(/^\s*\|/, '').replace(/\|\s*$/, '').replace(/\s*\|\s*/g, '')
	}
	return text
}

const SKIP_LINE = /^\s*(?:-{3,}|\*{3,}|_{3,}|<!--|<\/?[a-zA-Z][^>]*>)\s*$/

/**
 * Table separators (`| --- | :---: |`) survive as `------------` once the pipes
 * are stripped, and would otherwise be counted as a paragraph that the rendered
 * output can never contain: they render to nothing by design.
 */
const TABLE_SEPARATOR = /^[\s|:-]*-{2,}[\s|:-]*$/

const IMAGE_FILE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i
/** Lines shorter than this cannot be matched without false positives. */
const MIN_LINE_CHARS = 6

interface ImageScan {
	images: number
	unresolvedEmbeds: string[]
}

/** Count image syntax and collect embeds we cannot classify as images. */
function scanImages(raw: string): ImageScan {
	let images = 0
	const unresolvedEmbeds: string[] = []
	for (const match of raw.matchAll(/!\[\[([^\]]+)\]\]/g)) {
		const target = match[1].split('|')[0].split('#')[0].trim()
		if (IMAGE_FILE.test(target)) images++
		else unresolvedEmbeds.push(target)
	}
	// Standard markdown images always render as an `img`, whatever the target.
	for (const _ of raw.matchAll(/!\[[^\]]*\]\([^)]*\)/g)) images++
	return { images, unresolvedEmbeds }
}

/**
 * Build the baseline from the note's own markdown.
 *
 * Sidenote spans are blanked out *before* line splitting (they may span several
 * source lines) and their bodies are kept separately: the Side Notes plugin
 * moves that text into the margin, so it must not be required to stay inside
 * the paragraph's text run.
 */
/** Split one source line into the keys it contributes (inline math splits it). */
function linePieces(raw: string): string[] {
	const withoutPrefix = stripBlockPrefix(raw)
	// `$$…$$` may sit inline in a paragraph (measured in the ReAct note): it is
	// display math and renders as glyphs, so it must not stay in the text run.
	const pieces = withoutPrefix.split(/\$\$[\s\S]{0,400}?\$\$|\$[^$\n]{1,200}\$/g)
	return pieces.map(piece => lettersOnly(normalizeInline(piece)))
}

/**
 * Build the baseline from the note's own markdown.
 *
 * Sidenote spans are blanked out *before* line splitting (they may span several
 * source lines), and their bodies are kept separately: the Side Notes plugin
 * either keeps that text inline in the paragraph or moves it out to the margin.
 * Each line therefore carries two keys — with and without the sidenote body —
 * and the comparison accepts whichever form the body it is handed actually uses.
 */
export function buildBaseline(markdown: string, headings: string[]): NoteBaseline {
	const sidenotes: BaselineLine[] = []
	const blanked = markdown.replace(SIDENOTE_SPAN, (whole, inner: string, offset: number) => {
		const body = lettersOnly(inner)
		if (body.length >= 2) {
			const line = markdown.slice(0, offset).split('\n').length
			sidenotes.push({ text: body, line, raw: squeeze(inner).slice(0, 60) })
		}
		const open = whole.slice(0, whole.indexOf('>') + 1)
		const tail = whole.slice(whole.lastIndexOf('</'))
		return open + inner.replace(/[^\n]/g, ' ') + tail
	})
	const inlined = markdown.replace(SIDENOTE_SPAN, (whole, inner: string) => {
		const open = whole.slice(0, whole.indexOf('>') + 1)
		const tail = whole.slice(whole.lastIndexOf('</'))
		return open + inner + tail
	})

	const blankLines = blanked.split(/\r?\n/)
	const inlineLines = inlined.split(/\r?\n/)
	const out: BaselineLine[] = []
	let shortLines = 0
	let fence: string | null = null
	let fenceLang = ''
	let inFrontmatter = false
	let inBlockMath = false
	let mermaid = 0
	let blockMath = 0
	let images = 0
	const unresolvedEmbeds: string[] = []

	for (let i = 0; i < blankLines.length; i++) {
		const raw = blankLines[i]
		const rawInline = inlineLines[i] ?? raw
		const lineNo = i + 1

		if (i === 0 && raw.trim() === '---') {
			inFrontmatter = true
			continue
		}
		if (inFrontmatter) {
			if (raw.trim() === '---') inFrontmatter = false
			continue
		}

		const fenceMatch = raw.match(/^\s*(```+|~~~+)\s*([A-Za-z0-9_-]*)/)
		if (fenceMatch) {
			if (fence === null) {
				fence = fenceMatch[1][0]
				fenceLang = (fenceMatch[2] || '').toLowerCase()
				if (fenceLang === 'mermaid') mermaid++
			} else if (fenceMatch[1][0] === fence) {
				fence = null
				fenceLang = ''
			}
			continue
		}

		if (fence !== null) {
			if (fenceLang === 'mermaid') continue
			// Inside a fence the text is literal: use the original line, not the
			// blanked one, so a snippet that mentions a sidenote span stays intact.
			const code = lettersOnly(rawInline)
			if (code.length >= MIN_LINE_CHARS) {
				out.push({ text: code, line: lineNo, raw: squeeze(rawInline).slice(0, 60) })
			} else if (code.length > 0) shortLines++
			continue
		}

		if (!raw.trim() || SKIP_LINE.test(raw)) continue
		// Headings are verified separately, with the metadataCache list as the
		// source of truth; including them here would double-count and would make a
		// one-word heading look like a "short text" that escaped the line check.
		if (/^\s{0,3}#{1,6}\s+/.test(raw)) continue
		if (TABLE_SEPARATOR.test(raw)) continue
		// Block math renders to MathML: the source symbols are not the visible text.
		if (raw.trim() === '$$') {
			inBlockMath = !inBlockMath
			if (inBlockMath) blockMath++
			continue
		}
		if (inBlockMath) continue

		const scan = scanImages(raw)
		images += scan.images
		unresolvedEmbeds.push(...scan.unresolvedEmbeds)

		// Display math may be a `$$` line pair *or* sit inline in a paragraph. Both
		// render as block-level MathJax, so both count towards the expectation.
		blockMath += (raw.match(/\$\$[\s\S]{0,400}?\$\$/g) ?? []).length

		const keys = linePieces(raw)
		const altKeys = linePieces(rawInline)
		for (let j = 0; j < keys.length; j++) {
			const text = keys[j]
			const alt = altKeys[j]
			if (text.length >= MIN_LINE_CHARS) {
				out.push({
					text,
					line: lineNo,
					raw: squeeze(raw).slice(0, 60),
					alt: alt && alt !== text ? alt : undefined
				})
			} else if (text.length > 0 || (alt ?? '').length > 0) {
				shortLines++
			}
		}
	}

	const structures: StructureExpectation[] = []
	if (mermaid > 0) structures.push({ kind: 'mermaid', expected: mermaid, label: 'Mermaid 图' })
	if (images > 0) structures.push({ kind: 'image', expected: images, label: '图片' })
	if (blockMath > 0) structures.push({ kind: 'math', expected: blockMath, label: '块级公式' })
	if (sidenotes.length > 0) {
		structures.push({ kind: 'sidenote', expected: sidenotes.length, label: '侧注' })
	}

	const unverified: string[] = []
	if (unresolvedEmbeds.length > 0) {
		const sample = unresolvedEmbeds.slice(0, 3).join('、')
		const kinds = [...new Set(unresolvedEmbeds.map(t => t.split('.').pop() ?? t))]
		unverified.push(
			`${unresolvedEmbeds.length} 个非图片嵌入未作为结构验收（扩展名 ${kinds.join('/')}，如 ${sample}）`
		)
	}
	if (shortLines > 0) {
		unverified.push(`${shortLines} 行短文本（<${MIN_LINE_CHARS} 字符）未纳入逐行核对`)
	}

	return {
		headings: headings.map(h => normalizeHeading(h)).filter(Boolean),
		lines: out,
		sidenotes,
		structures,
		unverified,
		shortLines,
		characters: out.reduce((sum, l) => sum + l.text.length, 0)
	}
}

/**
 * Heading text as it appears in the rendered `<hN>`.
 *
 * Rendering differences that are *expected* are normalised here (inline markup
 * removed, whitespace squeezed); everything else must match exactly. No
 * `startsWith` fallback: `## 测试` must not accept `## 测试结果`.
 */
export function normalizeHeading(value: string): string {
	return squeeze(
		value
			.replace(/^\s{0,3}#{1,6}\s+/, '')
			.replace(/\s*#+\s*$/, '')
			.replace(/<!--[\s\S]*?-->/g, '')
			.replace(/!\[\[[^\]]*\]\]/g, '')
			.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
			.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
			.replace(/\[\[([^\]]+)\]\]/g, '$1')
			.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
			.replace(/`([^`]*)`/g, '$1')
			.replace(/==([^=]*)==/g, '$1')
			.replace(/\*\*([^*]+)\*\*/g, '$1')
			.replace(/\*([^*]+)\*/g, '$1')
			.replace(/~~([^~]+)~~/g, '$1')
			.replace(/\[\^[^\]]*\]/g, '')
			.replace(BLOCK_TAG, '')
			.replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, '$1')
			.replace(/&nbsp;/g, ' ')
			.replace(/&amp;/g, '&')
			.replace(/&lt;/g, '<')
			.replace(/&gt;/g, '>')
			.replace(/&quot;/g, '"')
			.replace(/&#39;/g, "'")
	).replace(EMOJI, '')
}

/**
 * A heading that contains inline math (`## 公式 $a^2$`) cannot be compared as
 * one string: the source keeps `$…$`, the DOM holds the rendered glyphs. The
 * literal segments on either side must still appear, in order.
 */
function headingSegments(value: string): string[] | null {
	if (!/\$[^$\n]{1,200}\$/.test(value)) return null
	const parts = value.split(/\$[^$\n]{1,200}\$/g)
	const segments = parts.map(p => normalizeHeading(p)).filter(s => s.length > 0)
	return segments.length > 0 ? segments : null
}

function headingMatches(expected: string, actual: string): boolean {
	if (expected === actual) return true
	const segments = headingSegments(expected)
	if (!segments) return false
	let cursor = 0
	for (const segment of segments) {
		const at = actual.indexOf(segment, cursor)
		if (at < 0) return false
		cursor = at + segment.length
	}
	return true
}

/**
 * Read the body as a reader would see it.
 *
 * `innerText` is the honest signal — it skips nodes that are not rendered — but
 * it is also *empty* for an element outside the paint tree, which is exactly
 * what a deliberately hidden capture host is. `textContent` still carries the
 * words there, so it is the fallback rather than the primary source.
 */
function bodyTextOf(body: HTMLElement, override?: string): string {
	if (typeof override === 'string' && override.trim().length > 0) return override
	const rendered = body.innerText
	if (rendered && rendered.trim().length > 0) return rendered
	return body.textContent ?? ''
}

function countOf(body: HTMLElement, selector: string): number {
	try {
		return body.querySelectorAll(selector).length
	} catch {
		return 0
	}
}

/** Count structures in the rendered body and compare with the source counts. */
function evaluateStructures(
	baseline: NoteBaseline,
	body: HTMLElement,
	unverified: string[]
): StructureReport[] {
	return baseline.structures.map(exp => {
		if (exp.kind === 'mermaid') {
			const nodes = Array.from(body.querySelectorAll<HTMLElement>('.mermaid'))
			const withSvg = nodes.filter(el => el.querySelector('svg')).length
			return {
				kind: exp.kind,
				label: exp.label,
				expected: exp.expected,
				actual: withSvg,
				ok: nodes.length === exp.expected && withSvg === exp.expected,
				detail: `${nodes.length} 个容器，${withSvg} 个已生成 SVG`
			}
		}
		if (exp.kind === 'image') {
			const actual = countOf(body, 'img')
			const unresolved = countOf(body, '.internal-embed.is-unresolved')
			if (actual + unresolved < exp.expected) {
				return {
					kind: exp.kind,
					label: exp.label,
					expected: exp.expected,
					actual,
					ok: false,
					detail: `仅 ${actual} 张图片、${unresolved} 个未解析嵌入`
				}
			}
			if (unresolved > 0) {
				unverified.push(`${unresolved} 个嵌入未能解析为图片（附件可能不存在）`)
			}
			return {
				kind: exp.kind,
				label: exp.label,
				expected: exp.expected,
				actual: actual + unresolved,
				ok: true,
				detail: `${actual} 张图片` + (unresolved > 0 ? `，${unresolved} 个未解析` : '')
			}
		}
		if (exp.kind === 'math') {
			const nodes = Array.from(body.querySelectorAll<HTMLElement>('.math-block'))
			const rendered = nodes.filter(el => el.querySelector('mjx-container')).length
			return {
				kind: exp.kind,
				label: exp.label,
				expected: exp.expected,
				actual: rendered,
				ok: nodes.length === exp.expected && rendered === exp.expected,
				detail: `${nodes.length} 个块，${rendered} 个已渲染`
			}
		}
		// Sidenotes have two legitimate rendered forms: the plugin's margin note,
		// or the original inline `span.sidenote` (which the plugin's CSS leaves at
		// `display: none` when it does not take over). Both preserve the content;
		// only the first is visible, so the detail says which one we saw.
		const margins = countOf(body, 'small.sidenote-margin')
		if (margins > 0) {
			return {
				kind: exp.kind,
				label: exp.label,
				expected: exp.expected,
				actual: margins,
				ok: margins === exp.expected,
				detail: `${margins}/${exp.expected} 处 margin 注`
			}
		}
		const spans = countOf(body, 'span.sidenote')
		if (spans > 0) {
			return {
				kind: exp.kind,
				label: exp.label,
				expected: exp.expected,
				actual: spans,
				ok: spans === exp.expected,
				detail: `${spans}/${exp.expected} 处以 span.sidenote 保留（未渲染为 margin）`
			}
		}
		unverified.push(`${exp.expected} 处侧注在导出正文中未找到（margin 与 span 均为 0）`)
		return {
			kind: exp.kind,
			label: exp.label,
			expected: exp.expected,
			actual: 0,
			ok: true,
			detail: '未找到侧注结构，降级为文本核对'
		}
	})
}

/**
 * Compare a rendered body against the baseline.
 *
 * Text matching is a strictly forward scan: the cursor advances past each hit,
 * so one stretch of rendered text can satisfy only one baseline line. That is
 * what makes "a note with the same paragraph twice lost one copy" fail instead
 * of silently reusing the first copy.
 */
export function checkCompleteness(
	baseline: NoteBaseline,
	body: HTMLElement,
	bodyText?: string
): CompletenessReport {
	const notes: string[] = []
	const text = lettersOnly(bodyTextOf(body, bodyText))

	// ---- headings -------------------------------------------------------
	const domHeadings = Array.from(
		body.querySelectorAll('h1, h2, h3, h4, h5, h6')
	).map(h => normalizeHeading(h.textContent ?? ''))

	const headingMissing: string[] = []
	let headingCursor = 0
	for (const expected of baseline.headings) {
		let found = -1
		for (let i = headingCursor; i < domHeadings.length; i++) {
			if (headingMatches(expected, domHeadings[i])) {
				found = i
				break
			}
		}
		if (found === -1) headingMissing.push(expected.slice(0, 40))
		else headingCursor = found + 1
	}
	const headingMatched = baseline.headings.length - headingMissing.length

	// ---- structures -----------------------------------------------------
	const unverified = [...baseline.unverified]
	const structures = evaluateStructures(baseline, body, unverified)
	const structureOk = structures.every(s => s.ok)
	const sidenoteStructure = structures.find(s => s.kind === 'sidenote')
	const sidenoteRendered = (sidenoteStructure?.actual ?? 0) > 0

	// ---- body text ------------------------------------------------------
	const missingSamples: string[] = []
	let matched = 0
	let outOfOrder = 0
	let cursor = 0

	for (const line of baseline.lines) {
		// A line that carries a sidenote has two legitimate rendered forms and
		// *no reliable way to predict which one this body will use*: the live
		// reading view hides `<span class="sidenote">` and shows the margin note
		// (text run without the body), while the offscreen host has no Side Notes
		// transform at all, so the same span stays visible inline (text run with
		// the body). Measured on the ReAct note, guessing from a selector gave
		// 89.1% — 33 of the 33 sidenote paragraphs "missing" while their text was
		// right there in `innerText`.
		//
		// So both forms are accepted for *that line only*, and exactly one of them
		// has to be found at or after the cursor. The duplicate/order guarantee is
		// unchanged: a hit consumes its own span and the cursor never moves back.
		const keys = line.alt ? [line.text, line.alt] : [line.text]
		let at = -1
		let used = ''
		for (const key of keys) {
			const found = text.indexOf(key, cursor)
			// Earliest wins, so a later form can never skip past text that belongs
			// to the next line.
			if (found >= 0 && (at < 0 || found < at)) {
				at = found
				used = key
			}
		}
		if (at >= 0) {
			matched++
			cursor = at + used.length
			continue
		}
		// Present, but only before the cursor: that is an order violation, and it
		// must not be counted as a hit (it may be a reused duplicate).
		if (keys.some(key => text.indexOf(key) >= 0)) {
			outOfOrder++
			if (missingSamples.length < 8) {
				missingSamples.push(`L${line.line}: 顺序异常 ${(line.raw ?? line.text).slice(0, 48)}`)
			}
			continue
		}
		if (missingSamples.length < 8) {
			missingSamples.push(`L${line.line}: ${(line.raw ?? line.text).slice(0, 48)}`)
		}
	}

	const expectedLines = baseline.lines.length
	const coverage = expectedLines === 0 ? 1 : (matched + outOfOrder) / expectedLines
	const orderRatio = expectedLines === 0 ? 1 : matched / expectedLines

	// Sidenote text is only enforceable where the margin rendering exists: in a
	// vault where Side Notes leaves `<span class="sidenote">` at `display: none`,
	// the reader does not see that text either, so requiring it would fail every
	// export instead of describing the state. Absent margin notes are reported
	// as unverified by `evaluateStructures`.
	// `textContent` includes text the reading view hides (a `display: none`
	// sidenote is still in the file, exactly as in the export).
	const domLetters = lettersOnly(body.textContent ?? '')
	const sidenoteMissing = sidenoteRendered
		? baseline.sidenotes.filter(sn => !domLetters.includes(sn.text))
		: []
	if (sidenoteMissing.length > 0) {
		notes.push(
			`${sidenoteMissing.length} 处侧注文本未出现在导出正文，例如 L${sidenoteMissing[0].line}: ` +
				(sidenoteMissing[0].raw ?? sidenoteMissing[0].text).slice(0, 40)
		)
	}

	const ok =
		headingMissing.length === 0 &&
		missingSamples.length === 0 &&
		coverage === 1 &&
		orderRatio === 1 &&
		sidenoteMissing.length === 0 &&
		structureOk

	if (headingMissing.length > 0) {
		notes.push(`缺 ${headingMissing.length} 个标题，例如：${headingMissing.slice(0, 3).join(' / ')}`)
	}
	if (outOfOrder > 0) notes.push(`${outOfOrder} 行顺序异常`)
	if (matched < expectedLines) {
		notes.push(`缺正文 ${expectedLines - matched - outOfOrder} 行（${expectedLines} 行中）`)
	}
	for (const s of structures) {
		if (!s.ok) notes.push(`${s.label}：期望 ${s.expected}，实际 ${s.actual}（${s.detail ?? ''}）`)
	}
	if (unverified.length > 0) notes.push(`未验证：${unverified.join('；')}`)

	return {
		ok,
		headingExpected: baseline.headings.length,
		headingMatched,
		headingMissing,
		lineExpected: expectedLines,
		lineMatched: matched,
		lineOutOfOrder: outOfOrder,
		coverage,
		orderRatio,
		missingSamples,
		structures,
		unverified,
		shortLines: baseline.shortLines,
		notes
	}
}

/** One line for the manifest: the report must be self-explanatory. */
export function describeCompleteness(r: CompletenessReport): string {
	const pct = (v: number) => `${(v * 100).toFixed(1)}%`
	const parts = [
		`标题 ${r.headingMatched}/${r.headingExpected}`,
		`正文 ${r.lineMatched}/${r.lineExpected}（${pct(r.coverage)}）`,
		`顺序 ${pct(r.orderRatio)}`
	]
	for (const s of r.structures) {
		parts.push(`${s.label} ${s.actual}/${s.expected}`)
	}
	const verified =
		`完整性（可验证部分）：${parts.join('，')}` +
		(r.unverified.length > 0 ? `；未验证：${r.unverified.join('；')}` : '')
	return verified
}
