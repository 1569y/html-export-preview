import {
	SIDENOTE_INLINE_BELOW,
	SIDENOTE_ROOM,
	SIDENOTE_WIDTH
} from './sidenote-layout'
import {
	isTableMediaId,
	normalizeLayout,
	type ExportLayoutOptions,
	type MediaOverride
} from './layout-settings'

/**
 * The export's *own* responsive layout, appended after the collected
 * stylesheet **and** after the legacy `BASE_CSS` / `sidenoteCss` blocks.
 *
 * Why the `#he-page` prefix (an id added by `buildHtml`):
 *
 * The real daily vault runs a theme + several snippets that style the reading
 * containers with very high specificity `!important` rules — e.g.
 *
 *   .markdown-preview-view:not(.npl-left):not(.npl-center):not(.npl-right)
 *     :not(.npl-custom):not(.npl-full) .markdown-preview-sizer {
 *       width: calc(100% - var(--npl-global-left-gap) - …) !important;
 *       max-width: none !important;
 *       margin-left: … !important;
 *   }
 *
 * An `[data-he-sidenotes] …` selector (0,4,0) loses to that (0,7,0), so on the
 * real export the sizer measured 1233px inside a 1585px page: 320px of dead
 * space on the right and the two columns not lining up. An id contributes a
 * higher cascade origin than any number of classes, so these geometry rules
 * win *without* deleting or rewriting a single user rule. Everything not
 * listed here (typography, headings, highlights, theme colours, the snippets'
 * own responsive blocks) keeps applying untouched.
 *
 * Two different "centre" behaviours are kept apart on purpose:
 *   - `#he-page { margin-inline:auto }` centres the **page** in the window;
 *   - `text-align` / `margin-inline` on a heading or an image is its own
 *     option and is never inferred from the page geometry.
 */

export interface LayoutGeometry {
	/**
	 * captureWidth + reserved sidenote strip. Still emitted as
	 * `--he-frame-width` (the generated sidenote breakpoint and older exports
	 * read it), but adaptive-center no longer uses it to cap the page.
	 */
	frameWidth: number
	/** 0 when this note has no margin column. */
	room: number
	/**
	 * Theme the page was captured in. Only used by the background options: a
	 * light sheet of paper under a dark theme's near-white text is unreadable,
	 * so `white` / `custom` restate the text palette in that case.
	 */
	theme?: 'dark' | 'light' | 'unknown'
}

/**
 * Paper colour.
 *
 * The repaint is deliberately *scoped*: `html`/`body` get the colour (that is
 * the paper), the containers the reading view painted get `transparent` (so the
 * theme's `--background-primary` no longer covers it), and — only on a dark
 * capture — the text palette variables are restated on `#he-page` instead of
 * forcing `color` on every element. Themes and snippets read those variables,
 * so headings, muted text and borders follow without overwriting their own
 * element rules (`!important` on `h1 { color }` would).
 */
function backgroundRules(layout: ExportLayoutOptions, theme: 'dark' | 'light' | 'unknown'): string {
	if (layout.background === 'theme') return ''
	const color = layout.background === 'white' ? '#ffffff' : layout.backgroundColor
	const rules = [
		`html, body { background: ${color} !important; background-color: ${color} !important; }`,
		`#he-page, #he-page .markdown-preview-view, #he-page .markdown-preview-sizer,
#he-page .markdown-preview-section, #he-page .markdown-reading-view {
	background: transparent !important;
	background-color: transparent !important;
}`
	]
	if (theme === 'dark') {
		// Text palette only. Background variables are left alone on purpose:
		// themes reuse `--background-primary-alt` / `--code-background` for code
		// blocks and table headers, and painting those with the paper colour
		// would delete the contrast they were chosen for.
		rules.push(`#he-page {
	--text-normal: #1b1b1b;
	--text-muted: #5c5c5c;
	--text-faint: #8a8a8a;
	--text-title: #111111;
	color: var(--text-normal);
}`)
	}
	return rules.join('\n')
}

/**
 * Which theme the page was captured in, from `<html class>`.
 *
 * Obsidian puts exactly one of `theme-dark` / `theme-light` there; anything
 * else (an old snapshot, a unit-test fixture) is `unknown`, and `unknown` never
 * triggers the text-palette restatement.
 */
export function themeOf(rootClassName: string | undefined | null): 'dark' | 'light' | 'unknown' {
	const names = (rootClassName ?? '').split(/\s+/)
	if (names.includes('theme-dark')) return 'dark'
	if (names.includes('theme-light')) return 'light'
	return 'unknown'
}

/** Media rules that apply whatever the page layout mode is. */
function mediaRules(layout: ExportLayoutOptions): string {
	const scalePct = Math.round(layout.mermaidScale * 100)
	const rules = [
		`#he-page .markdown-preview-sizer img,
#he-page .markdown-preview-sizer video,
#he-page .markdown-preview-sizer canvas {
	max-width: 100% !important;
	height: auto !important;
	object-fit: contain;
}`,
		`#he-page .mermaid,
#he-page .mermaid svg { max-width: 100% !important; box-sizing: border-box; }
#he-page .mermaid svg { height: auto !important; max-width: min(100%, ${scalePct}%) !important; }`,
		`/* MathJax CHTML: never clip a formula. ` +
			`The bundled MathJax CSS uses \`overflow: auto clip\` / \`hidden clip\` for
   equations it judged too wide at capture time; in a static page that silently
   cuts off the right or bottom of the expression. Both axes become scrollable,
   so the whole formula stays reachable. */`,
		`#he-page mjx-container[jax="CHTML"] { max-width: 100%; box-sizing: border-box; }
#he-page mjx-container[overflow="scroll"][display],
#he-page mjx-container[overflow="truncate"][display] {
	overflow: auto !important;
	min-width: 0 !important;
}`
	]

	if (layout.imageAlign !== 'as-is') {
		// `as-is` keeps the theme's own alignment. For any other value we move the
		// *whole image block*, not just the <img> inside it: Obsidian wraps a block
		// picture in `<span class="internal-embed image-embed">`, an inline-block.
		// Centring the inner <img> only moves it within that span, which stays
		// pinned to the left of the text column — so the picture never visibly
		// moves. Making the wrapper a fit-content block lets `margin-inline` shift
		// the entire block left / centre / right of the content area.
		//
		// `:not(.inline)` keeps an image used mid-sentence flowing with its text.
		// `width: fit-content` + `max-width: 100%` means a picture wider than the
		// column scales down to the column (no clipping, no overflow); a narrower
		// one keeps its ratio and is positioned by the margins.
		const [ml, mr] = blockMargins(layout.imageAlign)
		rules.push(`#he-page .markdown-preview-sizer img:not(.inline),
#he-page .markdown-preview-sizer .image-embed:not(.inline) {
	display: block !important;
	width: fit-content !important;
	max-width: 100% !important;
	height: auto !important;
	margin-left: ${ml} !important;
	margin-right: ${mr} !important;
}`)
	}
	if (layout.mermaidAlign !== 'as-is') {
		// Same idea as the image block: `justify-content` on a `.mermaid` whose svg
		// already fills the column produces no visible shift. Sizing the block to
		// its contents lets `margin-inline` move the diagram as a unit, while
		// `max-width: 100%` keeps a wide diagram scaling with the column.
		const [ml, mr] = blockMargins(layout.mermaidAlign)
		rules.push(`#he-page .markdown-preview-sizer .mermaid {
	display: block !important;
	width: fit-content !important;
	max-width: 100% !important;
	margin-left: ${ml} !important;
	margin-right: ${mr} !important;
}`)
	}
	return rules.join('\n')
}

/**
 * P2 Task 2 — one rule set per element the user sized / aligned by hand.
 *
 * Three details make this actually win the cascade:
 *
 * 1. **Specificity.** The global rules above are written as
 *    `#he-page .markdown-preview-sizer .image-embed:not(.inline)` (id + 3
 *    classes). A plain `#he-page [data-he-media-id]` would lose despite being
 *    later, so each selector repeats the block class: `… .image-embed[data-…]`
 *    and `… .mermaid[data-…]` both reach id + 3 classes and then win on order.
 * 2. **The wrapper, not the `<img>`.** Width and margins go on the block; the
 *    inner picture / SVG is stretched to 100% of that block. Moving the inner
 *    `<img>` alone was the exact bug the global alignment fix had to undo.
 * 3. **`max-width: 100%` always.** A 900px picture in a 600px column is
 *    scaled down rather than clipped, and a 200% value is impossible because
 *    the clamp lives in `normalizeMediaOverrides` too.
 *
 * `height: auto` on the SVG is what preserves the viewBox aspect ratio; the
 * diagram's text, arrows and markers are untouched — only the viewport scales.
 *
 * **Tables are different.** Reusing the picture rule would force
 * `display: block` on the `<table>` (breaking `border-collapse`, `colspan` /
 * `rowspan` and the theme's header / border styling) and the inner `img/svg`
 * rule would resize every MathJax glyph or icon inside a cell to 100%. A
 * `t…` id therefore gets its own, much narrower rule: only the width and the
 * two margins, with the table's own display mode, `table-layout`, borders and
 * header styles left exactly as the theme painted them. `overflow: visible`
 * is restated so a table wider than the column stays reachable by scrolling
 * rather than being clipped; auto table layout already refuses to squeeze a
 * cell below its minimum content width.
 */
function pictureOverrideRules(id: string, override: MediaOverride): string {
	const attr = `[data-he-media-id="${id}"]`
	const selector = [
		`#he-page .markdown-preview-sizer ${attr}`,
		`#he-page .markdown-preview-sizer .image-embed${attr}`,
		`#he-page .markdown-preview-sizer .mermaid${attr}`
	].join(',\n')

	const width = override.width
	const size = width
		? width.unit === 'pct'
			? `${width.value}%`
			: `${width.value}px`
		: 'fit-content'
	const declarations = [
		'display: block !important',
		'box-sizing: border-box !important',
		`width: ${size} !important`,
		'max-width: 100% !important',
		'height: auto !important'
	]
	if (override.align) {
		const [ml, mr] = blockMargins(override.align)
		declarations.push(`margin-left: ${ml} !important`)
		declarations.push(`margin-right: ${mr} !important`)
	}
	return `${selector} {\n\t${declarations.join(';\n\t')};\n}\n` +
		`#he-page .markdown-preview-sizer ${attr} img,
#he-page .markdown-preview-sizer ${attr} svg {
	display: block !important;
	width: 100% !important;
	max-width: 100% !important;
	height: auto !important;
	object-fit: contain;
}`
}

function tableOverrideRule(id: string, override: MediaOverride): string {
	const attr = `[data-he-media-id="${id}"]`
	// `.markdown-preview-view` is a real ancestor of the sizer in every mode
	// (see buildHtml's element chain); repeating it lifts the selector above
	// the theme's `body … table { width: 100% }` rules.
	const selector = `#he-page .markdown-preview-view .markdown-preview-sizer table${attr}`
	const declarations: string[] = ['box-sizing: border-box !important']
	if (override.width) {
		const size = override.width.unit === 'pct'
			? `${override.width.value}%`
			: `${override.width.value}px`
		declarations.push(`width: ${size} !important`)
		// A percentage is a share of the text column; a pixel width is an
		// explicit "make it this wide" request and must not be clamped back to
		// the column, or the control would be a no-op on every wide table.
		declarations.push(
			override.width.unit === 'pct'
				? 'max-width: 100% !important'
				: 'max-width: none !important'
		)
	}
	// No `display`, no `height`, no `table-layout`, no `overflow: hidden`:
	// those are exactly the declarations that break a table's header cells,
	// spanning and borders, or cut off a wide table's right-hand columns.
	declarations.push('overflow: visible !important')
	if (override.align) {
		const [ml, mr] = blockMargins(override.align)
		declarations.push(`margin-left: ${ml} !important`)
		declarations.push(`margin-right: ${mr} !important`)
	}
	return `${selector} {\n\t${declarations.join(';\n\t')};\n}`
}

function mediaOverrideRules(layout: ExportLayoutOptions): string {
	const entries = Object.entries(layout.mediaOverrides ?? {})
	if (entries.length === 0) return ''
	const rules: string[] = []
	for (const [id, override] of entries) {
		rules.push(
			isTableMediaId(id)
				? tableOverrideRule(id, override)
				: pictureOverrideRules(id, override)
		)
	}
	return rules.join('\n')
}

/**
 * Left / centre / right as `margin-left` / `margin-right` pairs. `auto` on the
 * trailing side pushes the block to the opposite edge; both `auto` centres it.
 * These are the only three values `blockMargins` ever returns, so the callers'
 * `ExportLayoutOptions` alignment unions are exhaustive here.
 */
function blockMargins(
	align: 'left' | 'center' | 'right'
): [string, string] {
	switch (align) {
		case 'left':
			return ['0', 'auto']
		case 'right':
			return ['auto', '0']
		case 'center':
		default:
			return ['auto', 'auto']
	}
}

/**
 * P1c — put the theme's readable line length back instead of overriding it.
 *
 * The P1b rule set was `#he-page .markdown-preview-sizer { max-width: none
 * !important }`. With an id in the selector it beat the core rule
 * `.markdown-preview-view.is-readable-line-width .markdown-preview-sizer {
 * max-width: var(--file-line-width) }` (real export L1030), so a 2400px
 * window produced a 1925px text column.
 *
 * Two distinct cases, on purpose:
 *
 *  - `'theme'` keeps the vault's own choice. Scoped to `.is-readable-line-width`,
 *    a theme with readable line length on is capped by `--file-line-width`;
 *    with it off the column stays full width. No invented px number.
 *  - A **number** is a cap the user explicitly chose in the preview editor. It
 *    must apply even when the active theme has readable line length OFF — the
 *    old `.is-readable-line-width` scoping made the whole 正文最大宽度 control
 *    a no-op on such themes (measured in the real sandbox preview: choosing
 *    1000px changed nothing, the sizer stayed 298px). This is also the control
 *    that creates free space for image / Mermaid alignment, so it has to work.
 *
 * With a margin column the sizer carries `padding-right: var(--he-room)`, so
 * its cap is widened by exactly that strip, keeping the *text* at the chosen
 * width; below `SIDENOTE_INLINE_BELOW` the strip disappears again.
 */
function contentWidthRules(layout: ExportLayoutOptions, room: number): string {
	if (typeof layout.contentMaxWidth === 'number') {
		const cap = `html { --he-content-max-width: ${layout.contentMaxWidth}px; }\n`
		const base = `${cap}#he-page .markdown-preview-sizer {
	max-width: var(--he-content-max-width) !important;
	margin-inline: auto !important;
}`
		// Only a page that actually owns a margin column needs the extra strip —
		// and keeping this selector out of a note without sidenotes keeps the
		// `data-he-sidenotes` marker genuinely absent there (P0 geometry guard).
		if (room <= 0) return base
		return `${base}
#he-page[data-he-sidenotes] .markdown-preview-sizer {
	max-width: calc(var(--he-content-max-width) + var(--he-room)) !important;
}
@media (max-width: ${SIDENOTE_INLINE_BELOW}px) {
	#he-page[data-he-sidenotes] .markdown-preview-sizer {
		max-width: var(--he-content-max-width) !important;
	}
}`
	}
	const base = `#he-page .markdown-preview-view.is-readable-line-width .markdown-preview-sizer {
	max-width: var(--he-content-max-width, var(--file-line-width, 700px)) !important;
	margin-inline: auto !important;
}`
	if (room <= 0) return base
	return `${base}
#he-page[data-he-sidenotes] .markdown-preview-view.is-readable-line-width .markdown-preview-sizer {
	max-width: calc(var(--he-content-max-width, var(--file-line-width, 700px)) + var(--he-room)) !important;
}`
}

/**
 * Build the extra stylesheet. `layout.pageLayout === 'as-is'` deliberately
 * emits no container overrides: the inline `width:<captured>px` from
 * `buildHtml` then stays in force, which is the "freeze the capture" mode.
 */
export function responsiveCss(
	options: ExportLayoutOptions | undefined,
	geometry: LayoutGeometry
): string {
	const layout = normalizeLayout(options)
	const { frameWidth, room } = geometry
	const parts: string[] = []

	// Zoom is a property of the document, not of the preview iframe: it is
	// written into the generated <style>, so the saved HTML keeps the scale.
	parts.push(`/* P1: document zoom (75%–175%), persisted into this HTML file. */
html { --he-zoom: ${layout.zoom}; zoom: var(--he-zoom, 1); }`)

	// Background applies to both layout modes: it is paper, not geometry.
	const background = backgroundRules(layout, geometry.theme ?? 'unknown')
	if (background) parts.push(background)

	parts.push(mediaRules(layout))
	// Per-element overrides are independent of the page-flow mode: they apply
	// to the frozen capture just as they do to the adaptive page. Only pushed
	// when present, so a note with no overrides produces byte-identical CSS.
	const mediaOverrides = mediaOverrideRules(layout)
	if (mediaOverrides) parts.push(mediaOverrides)

	if (layout.pageLayout !== 'adaptive-center') {
		return parts.join('\n\n').trim()
	}

	parts.push(`/* P1: adaptive page. The captured width is a *fallback* for a viewer that
   strips this stylesheet (the inline reading style below), never a ceiling on
   the real page. capping the page at captureWidth+room froze it at 930px on a
   wide monitor even though the preview pane / browser window had far more
   room, and in a narrow pane the text column stayed smaller than the images —
   so left/centre/right alignment had no free space to move into. The page now
   follows the available width; the text column below obeys the user's
   正文最大宽度 or the theme's readable line length. The variable is kept for
   the generated sidenote breakpoint and for older exports that read it.
   The theme/snippet media queries keep evaluating against the real viewport. */
html {
	--he-frame-width: ${frameWidth}px;
	--he-room: ${room || SIDENOTE_ROOM}px;
	--he-note-width: ${SIDENOTE_WIDTH}px;
}
#he-page.markdown-reading-view {
	box-sizing: border-box !important;
	width: 100% !important;
	min-width: 0 !important;
	max-width: none !important;
	margin-inline: auto !important;
	overflow: visible !important;
}
#he-page .markdown-preview-view {
	width: 100% !important;
	box-sizing: border-box !important;
}
#he-page .markdown-preview-sizer {
	box-sizing: border-box !important;
	width: 100% !important;
	min-height: 0 !important;
	padding-bottom: 0 !important;
}`)

	// P1c: no `max-width: none` here. The theme's readable-line-length value
	// is restored below (and can be capped from the future preview editor).
	parts.push(contentWidthRules(layout, room))

	// Middle widths: give the text column back some of the margin strip instead
	// of squeezing it. Both the reserved strip and the note width shrink
	// together, so the float never overlaps the text.
	parts.push(`@media (max-width: 1200px) {
	html { --he-room: 220px; --he-note-width: 190px; }
}
@media (max-width: 900px) {
	html { --he-room: 180px; --he-note-width: 156px; }
}`)

	if (room > 0) {
		parts.push(`#he-page[data-he-sidenotes] .markdown-preview-sizer {
	padding-right: var(--he-room) !important;
}
#he-page[data-he-sidenotes] .sidenote-margin {
	width: var(--he-note-width) !important;
	margin-right: calc(-1 * var(--he-room)) !important;
}
@media (max-width: ${SIDENOTE_INLINE_BELOW}px) {
	#he-page[data-he-sidenotes] .markdown-preview-sizer { padding-right: 0 !important; }
	#he-page[data-he-sidenotes] .sidenote-margin { display: none !important; }
	#he-page[data-he-sidenotes] .sidenote-number > span.sidenote {
		display: inline !important;
		width: auto !important;
		max-width: none !important;
		overflow: visible !important;
		white-space: normal !important;
	}
}`)
	}

	return parts.join('\n\n').trim()
}
