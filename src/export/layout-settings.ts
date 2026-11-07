/**
 * Settings surface for the future preview editor (P1 visual fidelity, step 3).
 *
 * This module is deliberately just a **typed contract + defaults**. No UI is
 * built here and, importantly, none of these values are persisted into the
 * vault's `data.json` yet: the existing config has a strict key set that the
 * upgrade/rollback tooling verifies byte-for-byte, and adding keys before the
 * editor exists would change the user's settings file for no benefit.
 *
 * Every option is consumed by `buildHtml`, which is shared by the in-app
 * preview and the exported file. That is what makes zoom a property of the
 * *document* rather than of the preview iframe: `responsiveCss` writes it into
 * the generated `<style>` block, so the saved HTML carries the same scale.
 */

export type PageLayoutMode = 'as-is' | 'adaptive-center'
/**
 * Horizontal placement of an *image block* (a block-level picture, never an
 * inline image inside running text). `as-is` keeps whatever the theme painted.
 */
export type MediaAlign = 'as-is' | 'left' | 'center' | 'right'
export type MermaidAlign = 'as-is' | 'left' | 'center' | 'right'
/**
 * Paper colour of the exported page.
 *
 * `theme` keeps whatever the collected stylesheet paints (the default, and the
 * only mode that is guaranteed to look exactly like the reading view).
 * `white` / `custom` repaint the page background and, **only when the captured
 * theme is dark**, restate the text palette on `#he-page` — a light sheet of
 * paper with the dark theme's near-white text would be unreadable.
 */
export type PageBackground = 'theme' | 'white' | 'custom'

/**
 * Width of the text column. `'theme'` is the default and deliberately does
 * **not** choose a number: it keeps the active theme/snippet's own readable
 * line length (`--file-line-width`). A number is an optional px cap for the
 * future preview editor — no user is forced onto a hard-coded width.
 */
export type ContentMaxWidth = 'theme' | number

/**
 * P2 Task 2 — width of one media block.
 *
 * `pct` is a share of the text column (what a reader actually perceives);
 * `px` is an absolute width for a picture that must keep its pixel size. Both
 * are clamped on the way in, and the generated CSS always adds
 * `max-width: 100%` so a value can never overflow / clip the column.
 */
export type MediaWidthUnit = 'pct' | 'px'

export interface MediaWidth {
	value: number
	unit: MediaWidthUnit
}

/**
 * Overrides for a single image block / Mermaid container, keyed by
 * `data-he-media-id` (see `media-identity.ts`).
 *
 * Every field is optional and *absent means "follow the global setting"* — that
 * is what makes 恢复该元素默认 a deletion rather than a copy of today's global
 * value (which would freeze it against later global changes).
 */
export interface MediaOverride {
	width?: MediaWidth
	align?: Exclude<MediaAlign, 'as-is'>
}

export const MEDIA_WIDTH_PCT_MIN = 10
export const MEDIA_WIDTH_PCT_MAX = 100
export const MEDIA_WIDTH_PX_MIN = 40
export const MEDIA_WIDTH_PX_MAX = 2400

export interface ExportLayoutOptions {
	/** `as-is` freezes the captured width; `adaptive-center` reflows with the window. */
	pageLayout: PageLayoutMode
	/** `center` centres images *inside* the text column, never the page itself. */
	imageAlign: MediaAlign
	/** Horizontal placement of the whole Mermaid diagram block. */
	mermaidAlign: MermaidAlign
	/** Diagram size multiplier, 0.5 – 2 (clamped). */
	mermaidScale: number
	/** Text-column cap; `'theme'` defers to `--file-line-width`. */
	contentMaxWidth: ContentMaxWidth
	/** Document zoom written into the HTML, 0.75 – 1.75 (clamped). */
	zoom: number
	/** Paper colour; `theme` keeps the collected stylesheet's own painting. */
	background: PageBackground
	/** `#rgb` / `#rrggbb`, only meaningful when `background === 'custom'`. */
	backgroundColor: string
	/**
	 * Per-element overrides, keyed by the stable `data-he-media-id` of a block.
	 * Empty by default; an element with no entry follows the global image /
	 * Mermaid settings above.
	 */
	mediaOverrides: Record<string, MediaOverride>
}

export const ZOOM_MIN = 0.75
export const ZOOM_MAX = 1.75
export const MERMAID_SCALE_MIN = 0.5
export const MERMAID_SCALE_MAX = 2
/** Safety bounds for a user-supplied cap, not a default width. */
export const CONTENT_WIDTH_MIN = 320
export const CONTENT_WIDTH_MAX = 4000

/** Quick picks in the editor panel; none of them is a default. */
export const WIDTH_PRESETS = [800, 900, 1000] as const
export const ZOOM_PRESETS = [1, 1.25, 1.5] as const
/** Fallback used by the colour input before the user picks anything. */
export const DEFAULT_BACKGROUND_COLOR = '#ffffff'

export const DEFAULT_LAYOUT: ExportLayoutOptions = {
	pageLayout: 'adaptive-center',
	imageAlign: 'as-is',
	mermaidAlign: 'as-is',
	mermaidScale: 1,
	contentMaxWidth: 'theme',
	zoom: 1,
	background: 'theme',
	backgroundColor: DEFAULT_BACKGROUND_COLOR,
	mediaOverrides: {}
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
	const n = typeof value === 'number' ? value : Number(value)
	if (!Number.isFinite(n)) return fallback
	return Math.min(max, Math.max(min, n))
}

const COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i

/**
 * Keep only a colour the CSS can actually use.
 *
 * This value is interpolated into a `<style>` block of the exported document,
 * so anything that is not a plain hex colour is rejected rather than escaped:
 * a note is not allowed to smuggle declarations into the stylesheet through a
 * saved setting.
 */
export function normalizeColor(value: unknown): string | null {
	if (typeof value !== 'string') return null
	const trimmed = value.trim()
	return COLOR.test(trimmed) ? trimmed.toLowerCase() : null
}

/**
 * `<m|t><base36>-<n>` — the only shape `media-identity.ts` ever emits.
 *
 * `m…` = picture / Mermaid block, `t…` = table. The prefix is part of the
 * contract, not decoration: `layout-css.ts` emits a different rule set for a
 * table (it must keep `display: table` and must not gain the inner `img/svg`
 * sizing rules), and the preview uses it to choose「表格设置」.
 *
 * Keeping the shape this strict matters because the id is interpolated into a
 * generated `<style>` selector. Neither prefix widens what can be smuggled in:
 * still only `[a-z0-9]` plus a bounded numeric suffix.
 */
const MEDIA_ID = /^[mt][a-z0-9]+-\d{1,3}$/

/** True for ids produced for a `<table>` block. */
export function isTableMediaId(id: string): boolean {
	return typeof id === 'string' && id.charCodeAt(0) === 116 /* t */ && MEDIA_ID.test(id)
}

/**
 * Keep only overrides the CSS can safely interpolate.
 *
 * This object is written into a `<style>` block of the exported document, so
 * the id becomes a selector and the numbers become declarations: a strict id
 * shape plus numeric clamps means a note or a stale setting cannot smuggle a
 * rule into the page. Unknown keys and empty entries are dropped so the
 * generated stylesheet stays minimal.
 */
export function normalizeMediaOverrides(input: unknown): Record<string, MediaOverride> {
	if (!input || typeof input !== 'object') return {}
	const out: Record<string, MediaOverride> = {}
	for (const [id, raw] of Object.entries(input as Record<string, unknown>)) {
		if (!MEDIA_ID.test(id)) continue
		if (!raw || typeof raw !== 'object') continue
		const entry = raw as Record<string, unknown>
		const override: MediaOverride = {}

		const width = entry.width
		if (width && typeof width === 'object') {
			const w = width as Record<string, unknown>
			const unit: MediaWidthUnit = w.unit === 'px' ? 'px' : 'pct'
			const min = unit === 'px' ? MEDIA_WIDTH_PX_MIN : MEDIA_WIDTH_PCT_MIN
			const max = unit === 'px' ? MEDIA_WIDTH_PX_MAX : MEDIA_WIDTH_PCT_MAX
			const value = clamp(w.value, min, max, Number.NaN)
			if (Number.isFinite(value)) {
				override.width = { value: Math.round(value), unit }
			}
		}
		if (
			entry.align === 'left' ||
			entry.align === 'center' ||
			entry.align === 'right'
		) {
			override.align = entry.align
		}
		if (override.width || override.align) out[id] = override
	}
	return out
}

/** Never throw on a partial/legacy config; unknown enums fall back to defaults. */
export function normalizeLayout(input?: Partial<ExportLayoutOptions> | null): ExportLayoutOptions {
	const raw = input ?? {}
	const background: PageBackground =
		raw.background === 'white' || raw.background === 'custom' ? raw.background : 'theme'
	return {
		pageLayout: raw.pageLayout === 'as-is' ? 'as-is' : 'adaptive-center',
			imageAlign:
			raw.imageAlign === 'left' ||
			raw.imageAlign === 'center' ||
			raw.imageAlign === 'right'
				? raw.imageAlign
				: 'as-is',
		mermaidAlign:
			raw.mermaidAlign === 'left' ||
			raw.mermaidAlign === 'center' ||
			raw.mermaidAlign === 'right'
				? raw.mermaidAlign
				: 'as-is',
		mermaidScale: clamp(
			raw.mermaidScale,
			MERMAID_SCALE_MIN,
			MERMAID_SCALE_MAX,
			DEFAULT_LAYOUT.mermaidScale
		),
		contentMaxWidth:
			typeof raw.contentMaxWidth === 'number' && Number.isFinite(raw.contentMaxWidth)
				? clamp(
						Math.round(raw.contentMaxWidth),
						CONTENT_WIDTH_MIN,
						CONTENT_WIDTH_MAX,
						CONTENT_WIDTH_MIN
					)
				: 'theme',
		zoom: clamp(raw.zoom, ZOOM_MIN, ZOOM_MAX, DEFAULT_LAYOUT.zoom),
		background,
		// A custom background without a usable colour degrades to white rather
		// than to "no background": the user asked for a repaint, and the panel
		// shows the swatch they will actually get.
		backgroundColor: normalizeColor(raw.backgroundColor) ?? DEFAULT_BACKGROUND_COLOR,
		mediaOverrides: normalizeMediaOverrides(raw.mediaOverrides)
	}
}
