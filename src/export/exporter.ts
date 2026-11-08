import type { CaptureSnapshot } from '../capture/types'
import type { AssetCollector } from '../assets/resource-manager'
import { responsiveCss, themeOf } from './layout-css'
import { normalizeLayout, type ExportLayoutOptions } from './layout-settings'
import {
	assertEmbeddableCss,
	neutralizeStyleEndTags
} from '../css/style-boundary'
import { parseSrcset, serializeSrcset, type SrcsetCandidate } from './srcset'
import { applyInternalAnchors } from './anchors'
import { assignMediaIds } from './media-identity'
import {
	SIDENOTE_INLINE_BELOW,
	SIDENOTE_ROOM,
	SIDENOTE_WIDTH
} from './sidenote-layout'

export interface BuildOptions {
	/**
	 * `preview` keeps `app://` URLs (they resolve inside Obsidian); `export`
	 * writes a directory with a linked stylesheet; `single` is the share mode —
	 * the stylesheet is inlined and every asset reference is a marker that the
	 * caller replaces with a `data:` URL.
	 */
	mode: 'preview' | 'export' | 'single'
	cssText: string
	assets?: AssetCollector
	/**
	 * P1 layout options shared by the preview and the saved HTML.
	 * Omitted → `DEFAULT_LAYOUT`. Not persisted to `data.json` yet (see
	 * `layout-settings.ts`); the preview editor will supply it later.
	 */
	layout?: Partial<ExportLayoutOptions>
	/**
	 * P1c: names of `data-*` attributes the collected CSS actually uses.
	 * Root attributes outside this set are runtime/plugin state and are not
	 * replayed into the standalone document. Omitted → no name filtering
	 * (older callers/tests keep their behaviour); `main.ts` always supplies it.
	 */
	rootDataAllow?: ReadonlySet<string>
	/**
	 * Share mode only. `rewriteMedia` normally keeps the original URL of a media
	 * file it could not resolve (`data-he-original-src`), which is exactly the
	 * `app://<vault-id>/…` / `file://…` value a recipient must never see. When
	 * true, that attribute is dropped and only the "missing" marker remains.
	 */
	stripLocalPaths?: boolean
	/**
	 * Share mode only: a last pass over the cloned body before it is
	 * serialised. Used for the privacy/safety rules that apply to a file
	 * leaving the vault (internal links, executable attributes) and that must
	 * **not** apply to the preview or the directory export, where those same
	 * attributes are the working, useful form.
	 */
	prepare?: (root: HTMLElement) => void
}

/**
 * Root attributes that must never be replayed: they describe the app's pane at
 * capture time, not the exported page. `readingData()` already strips them
 * from the reading container; a copy on `<html>`/`<body>` would re-enable the
 * very `display:none !important` rules it guards against.
 */
const ROOT_DATA_DENY = new Set(['data-sidenote-mode', 'data-sidenote-no-room'])

/** Replay only root state a stylesheet can actually observe. */
function filterRootData(
	data: Record<string, string> | undefined,
	allow?: ReadonlySet<string>
): Record<string, string> {
	const out: Record<string, string> = {}
	for (const [name, value] of Object.entries(data ?? {})) {
		if (name.startsWith('data-he-') || ROOT_DATA_DENY.has(name)) continue
		if (allow && !allow.has(name)) continue
		out[name] = value
	}
	return out
}

/**
 * Layout rules the export owns.
 *
 * Two deliberate choices, both review round 2A:
 *
 * 1. `!important` — Obsidian themes routinely carry higher-specificity
 *    selectors such as `.markdown-preview-view.markdown-rendered`. Specificity
 *    beats source order, so plain declarations here lost to the theme's
 *    `overflow: auto; height: 900px` and the "continuous page" was really a
 *    900px scroll box.
 * 2. Emitted **after** the collected stylesheet (see `buildHtml`) — order is
 *    the tie-breaker among `!important` rules, and it also protects against
 *    themes that ship their own `!important`.
 */
const BASE_CSS = `
html, body { margin: 0; padding: 0; }
/* EI-01: Obsidian's own stylesheet locks the document to the window —
   \`html, body { height: 100% }\` plus \`body { overflow: clip; contain: strict }\`.
   \`contain: strict\` includes *size* containment, so the body keeps the viewport
   height no matter how tall the note is and paints everything below the fold
   into nothing. The result is a page that looks truncated after ~800px and
   cannot be scrolled. The export is a document, not an app shell: undo all four
   declarations (they are unlayered and mostly !important-free, but a theme may
   add !important, hence the same weight here). */
html, body {
	height: auto !important;
	max-height: none !important;
	overflow: visible !important;
	contain: none !important;
}
body { background: var(--background-primary); color: var(--text-normal); }
/* The export is a continuous page: never apply print/pagination geometry. */
.markdown-reading-view { overflow: visible !important; }
.markdown-preview-view {
	overflow: visible !important;
	height: auto !important;
	max-height: none !important;
}
.markdown-preview-sizer {
	min-height: 0 !important;
	/* "Scroll past end" padding; the clone strips it, this is the safety net. */
	padding-bottom: 0 !important;
}
/* Scroll-sync placeholder: zero content, only reserves height in the app. */
.markdown-preview-pusher { display: none !important; }
/* Placement transitions would animate on first paint in a static page. */
.sidenote-margin { transition: none !important; }
/* A resource we could not resolve is visible, not silently blank. */
[data-he-missing="1"] { outline: 2px dashed #d9534f; }
/* EI-01: an unresolved internal link has no destination outside the vault. It
   must not look clickable, and it must not inherit the "broken link" hover. */
[data-he-unresolved="1"] { cursor: default; }
`.trim()

/**
 * P1 — the margin column (see `sidenote-layout.ts` for why floats).
 *
 * Every rule is scoped to `[data-he-sidenotes]`, which `buildHtml` only emits
 * when at least one note was given a margin block: a note without sidenotes
 * keeps the exact geometry it had before, so nothing regresses for it.
 *
 * `!important` is not decoration here. The collected stylesheet contains the
 * plugin's own `.markdown-reading-view[data-sidenote-position="right"]
 * .sidenote-margin { right: calc(…) }` and `…[data-sidenote-no-room="true"]
 * .sidenote-margin { display: none !important }`. Those describe *the app's*
 * pane, which was measured on screen; the page has its own width and its own
 * layout, so the export's declarations have to win regardless of specificity.
 */
function sidenoteCss(frameWidth: number): string {
	return `
/* Reserve the margin column: the text keeps the width it was captured at,
   the page grows by the same amount on the right. */
[data-he-sidenotes] .markdown-preview-sizer { padding-right: ${SIDENOTE_ROOM}px !important; }
/* Readable line length centres a narrower box; widen the box, not the text. */
[data-he-sidenotes] .markdown-preview-view.is-readable-line-width .markdown-preview-sizer {
	max-width: calc(var(--file-line-width, 700px) + ${SIDENOTE_ROOM}px) !important;
}
/* The inline copy stays in the DOM — same text, still selectable and findable —
   but out of the visual line, which is exactly what the plugin does in-app.
   Deleting it would lose the note if the CSS ever failed to load. */
[data-he-sidenotes] .sidenote-number { position: relative; }
[data-he-sidenotes] .sidenote-number > span.sidenote {
	display: inline-block !important;
	width: 0 !important;
	max-width: 0 !important;
	overflow: hidden !important;
	white-space: nowrap !important;
	vertical-align: baseline !important;
}
[data-he-sidenotes] .sidenote-number::after {
	content: attr(data-sidenote-num);
	font-size: 0.68em;
	font-weight: 600;
	line-height: 0;
	vertical-align: super;
	margin-left: 0.12em;
	color: var(--text-accent, var(--color-accent, #1aa2a2));
}
/* The margin note itself. Geometry only — typography stays the plugin's, so a
   user's font size / colour / alignment settings still describe the export. */
[data-he-sidenotes] .sidenote-margin {
	display: block !important;
	visibility: visible !important;
	opacity: 1 !important;
	position: static !important;
	inset: auto !important;
	transform: none !important;
	float: right !important;
	clear: right !important;
	width: ${SIDENOTE_WIDTH}px !important;
	margin: 0 -${SIDENOTE_ROOM}px 0.7rem 0 !important;
	padding: 0 !important;
	z-index: auto !important;
	will-change: auto !important;
	transition: none !important;
}
/* Keep the column from ending in mid-air: the last note is a float, and a
   float does not add to its container's height unless something clears it. */
[data-he-sidenotes] .markdown-preview-sizer::after {
	content: "";
	display: block;
	clear: both;
}
/* A note anchored inside a blockquote / callout is narrower than the page;
   keep its margin note inside the reserved strip instead of the block's box. */
[data-he-sidenotes] .callout,
[data-he-sidenotes] blockquote { overflow: visible !important; }

/* A window narrower than the page (zoom, a small screen) must not push the
   margin column off-screen: the page becomes fluid, the text column gives way,
   the notes keep their strip. The breakpoint is generated per export, because
   only this page knows how wide it was captured. */
@media (max-width: ${frameWidth}px) {
	[data-he-sidenotes].markdown-reading-view {
		width: auto !important;
		min-width: 0 !important;
	}
}
/* Below this there is no room for a text column *and* a margin: put the notes
   back inline rather than letting them collide with the text or each other.
   Nothing is removed — the inline copy has been in the DOM all along. */
@media (max-width: ${SIDENOTE_INLINE_BELOW}px) {
	[data-he-sidenotes] .sidenote-margin { display: none !important; }
	[data-he-sidenotes] .sidenote-number > span.sidenote {
		display: inline !important;
		width: auto !important;
		max-width: none !important;
		overflow: visible !important;
		white-space: normal !important;
	}
	[data-he-sidenotes] .markdown-preview-sizer { padding-right: 0 !important; }
}
`.trim()
}

/** 1x1 transparent GIF — keeps a broken-image icon from appearing. */
const PLACEHOLDER =
	'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

/**
 * Markers around the note body.
 *
 * `verifyExport` measures the bytes *between these two comments in the file it
 * just wrote*. Without them, the only evidence that the body was non-empty was
 * `snap.stats`, which the capture step produced — so a capture that grabbed an
 * empty container still verified as fine (review B2; that is exactly R7).
 */
export const BODY_START = '<!--he-body-start-->'
export const BODY_END = '<!--he-body-end-->'

/**
 * Clone the captured sizer into an **inert** document — one with no browsing
 * context — before any reference is rewritten.
 *
 * Cloning into the live document looks harmless because the clone is detached,
 * but a detached `<img>` still loads: assigning `src` starts a fetch regardless
 * of whether the element is in a tree, and the base URL is the owner document's.
 * Every rewritten reference was therefore really requested by Obsidian:
 *
 *   - export → `app://obsidian.md/assets/media/<hash>-image-4.png` (a 404 per
 *     image that nobody asked for);
 *   - share  → `app://obsidian.md/%HE-INLINE-0%`, the inline-mode marker.
 *
 * The second one is not cosmetic. `%HE` is not a valid percent escape, so
 * Obsidian's main-process `app://` handler throws while decoding it —
 * `URIError: URI malformed`, obsidian.asar/main.js:38:3857 — and logs it as an
 * uncaught main-process exception while the share still succeeds. A document
 * from `createHTMLDocument` has no browsing context, so nothing inside it ever
 * loads and the markers survive as plain strings until the final replacement.
 *
 * `importNode` (not `adoptNode`) keeps the snapshot untouched.
 */
function isolateSizer(source: HTMLElement): HTMLElement {
	const doc = source.ownerDocument as Document | undefined
	const inert = doc?.implementation?.createHTMLDocument?.('')
	if (inert) return inert.importNode(source, true) as HTMLElement
	// Hosts without a DOM implementation (unit-test doubles) keep the plain
	// clone; there is nothing there that could issue a request.
	return source.cloneNode(true) as HTMLElement
}

/**
 * Assemble the standalone page.
 *
 * Element chain (exactly one of each, matching the reading view):
 *
 *   .markdown-reading-view      ← snapshot.reading (positioning root)
 *     .markdown-preview-view    ← snapshot.preview (scroll container)
 *       .markdown-preview-sizer ← snapshot.sizer  (cloned element, inserted as-is)
 *
 * The sizer is **not** recreated here. Wrapping the clone in a second sizer was
 * review finding R1.
 */
export function buildHtml(snap: CaptureSnapshot, opts: BuildOptions): string {
	const sizer = isolateSizer(snap.sizer)

	// Share mode's privacy/safety pass runs on the clone, before any reference
	// is rewritten: removing an executable element first also means the media
	// pass never has to reason about it.
	if (opts.prepare) opts.prepare(sizer)

	// P2 Task 2 — stable ids must be derived from the *original* resource
	// reference, so this runs before `rewriteMedia` turns `app://…` into an
	// `assets/…` relative path. Every mode therefore assigns the same id to the
	// same block, which is what lets a per-element override follow the note
	// from the preview into the single file and the package.
	assignMediaIds(sizer)

	if (opts.mode !== 'preview' && opts.assets) {
		rewriteMedia(sizer, opts.assets, opts.stripLocalPaths === true)
	}

	// Task 3 — same-article anchor jump (runs after the clone is fully resolved,
	// so every heading/block id survives the share privacy pass and the `#` link
	// rewrite targets only in-page references). Must run for every mode: the live
	// preview iframe, the directory export and the single-file share all need
	// identical anchors, and none of them should move the targets the way an
	// earlier catch-up clone would have.
	applyInternalAnchors(sizer)

	// P1: with a margin column the page is wider than the text was captured at,
	// by exactly the reserved strip. A note without sidenotes keeps the old
	// width bit for bit (`room === 0`).
	const room = snap.sidenotes?.room ?? 0
	const frameWidth = snap.captureWidth + room
	const layout = normalizeLayout(opts.layout)
	// Appended after the legacy BASE_CSS / sidenoteCss blocks. The `!important`
	// geometry rules there describe the frozen capture; these id-scoped rules
	// win the cascade when the adaptive layout is selected, while every user
	// theme / snippet rule for content keeps applying unchanged.
	const layoutRules = responsiveCss(layout, {
		frameWidth,
		room,
		theme: themeOf(snap.root.className)
	})

	const readingStyle = [
		// Fallback geometry for `pageLayout: 'as-is'` and for a viewer that
		// strips the generated <style>. In adaptive mode the `#he-page` rules
		// below override these with `width: 100%` + `min-width: 0` +
		// `max-width: none`, so the page follows the real preview pane / browser
		// window instead of being frozen at the capture-time reading width.
		`width:${frameWidth}px`,
		`min-width:${frameWidth}px`,
		'max-width:none',
		'margin:0 auto',
		// The live inline style already contains `width:100%; height:100%`.
		// Appending it verbatim silently overrode `captureWidth` (review round 2,
		// R10) and left a `height:100%` whose percentage base is meaningless in a
		// static page. Drop those declarations, keep everything else
		// (`--sidenote-*`, `--editor-width`, …).
		sanitizeReadingStyle(snap.reading.style)
	]
		.filter(Boolean)
		.join(';')

	// A directory export links the stylesheet it wrote next to the page. The
	// preview and the share file both inline it: the preview because `app://`
	// cannot be linked from an iframe, the share file because it must travel as
	// one document with no sidecar.
	//
	// Inlining is the one place where CSS becomes HTML. A literal `</style`
	// inside the collected CSS (Border's SVG data URIs have 19) would end the
	// RAWTEXT element early and render every following rule as visible body
	// text. `embedCss` neutralises those sequences with a CSS escape, so the
	// stylesheet still applies in full. See src/css/style-boundary.ts.
	const styleTag =
		opts.mode === 'export'
			? '<link rel="stylesheet" href="assets/export.css">'
			: `<style>\n${embedCss(opts.cssText)}\n</style>`

	const sidenoteRules = room > 0 ? `\n${sidenoteCss(frameWidth)}` : ''
	// P1c: root state is replayed only where a collected stylesheet can see it.
	// No exporter markers, no pane state, no unrelated runtime/plugin values.
	const htmlData = filterRootData(snap.root.data, opts.rootDataAllow)
	const bodyData = filterRootData(snap.root.bodyData, opts.rootDataAllow)

	return `<!doctype html>
<html class="${escapeAttr(snap.root.className)}" style="${escapeAttr(snap.root.style)}" data-he-zoom="${layout.zoom}" data-he-layout="${layout.pageLayout}"${attrsToString(htmlData)}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(snap.noteTitle)}</title>
${styleTag}
<style>
${BASE_CSS}${sidenoteRules}${layoutRules ? `\n${layoutRules}` : ''}
</style>
</head>
<body class="${escapeAttr(snap.root.bodyClassName)}"${bodyStyleAttr(snap.root.bodyStyle)}${attrsToString(bodyData)}>
<div id="he-page" class="${escapeAttr(snap.reading.className)}" style="${escapeAttr(readingStyle)}"${attrsToString(
		readingData(snap, room > 0)
	)}>
<div class="${escapeAttr(snap.preview.className)}" style="${escapeAttr(snap.preview.style)}"${attrsToString(snap.preview.data)}>
${BODY_START}
${sizer.outerHTML}
${BODY_END}
</div>
</div>
</body>
</html>
`
}

/**
 * Make collected CSS safe to inline in a `<style>` element.
 *
 * CSS escapes are resolved by the CSS parser, so `<\/style` is still `</style`
 * inside a `url()` value / string / comment — the SVG data URI keeps working —
 * but the HTML tokenizer no longer sees a style end tag.
 *
 * The final assertion is the visible-degradation guard: if any sequence that
 * could break out of the style element somehow survives, refuse to build the
 * page instead of quietly emitting a document that shows the theme CSS as
 * body text and reporting success.
 */
function embedCss(css: string): string {
	const { text, count } = neutralizeStyleEndTags(css)
	if (count > 0) assertEmbeddableCss(text)
	return text
}

/**
 * Attributes for the `.markdown-reading-view` wrapper.
 *
 * The app's own sidenote state must not be replayed verbatim. Measured on a
 * 871px pane, the plugin had decided it had *no room* and set
 * `data-sidenote-mode="hidden"`; the collected stylesheet then carries
 * `.markdown-reading-view[data-sidenote-mode="hidden"]
 *  span.sidenote:not(.sidenote-number > span.sidenote) { display: none
 *  !important }`. The previous export copied that attribute, so all 75 notes
 * were present in the HTML and invisible on screen — the state described the
 * pane, not the page.
 *
 * So: drop the pane-measured state, and mark the page as one that owns its own
 * sidenote layout (the CSS in `sidenoteCss` is keyed on the marker).
 */
function readingData(snap: CaptureSnapshot, marginColumn: boolean): Record<string, string> {
	const notes = (snap.sidenotes?.margin ?? 0) + (snap.sidenotes?.inline ?? 0)
	if (notes === 0) return snap.reading.data
	const out: Record<string, string> = {}
	for (const [name, value] of Object.entries(snap.reading.data)) {
		if (name === 'data-sidenote-no-room' || name === 'data-sidenote-mode') continue
		out[name] = value
	}
	if (marginColumn) out['data-he-sidenotes'] = '1'
	return out
}

/**
 * Replay the custom properties Obsidian wrote inline on `<body>`.
 *
 * The theme *class* (`theme-light`) only selects a rule block. The values the
 * user actually chose — accent hue/saturation/lightness — live in
 * `body.style`, and `--color-accent: hsl(var(--accent-h) …)` in app.css means
 * every link, tag and callout tint depends on them. Without this attribute the
 * export keeps the theme's background but drops the accent, which looks like
 * "the theme was not applied" (round 3.3.3).
 *
 * `snap.root.bodyStyle` is already filtered to `--*` declarations by
 * `pickCustomProperties`, so this cannot re-introduce layout properties.
 */
function bodyStyleAttr(style: string): string {
	if (!style) return ''
	return ` style="${escapeAttr(style)}"`
}

function rewriteMedia(
	root: HTMLElement,
	assets: AssetCollector,
	stripLocalPaths = false
): void {
	/** Record the unresolvable URL for debugging — unless the page is shared. */
	const markMissing = (el: HTMLElement, src: string) => {
		el.setAttribute('data-he-missing', '1')
		if (!stripLocalPaths) el.setAttribute('data-he-original-src', src)
		else el.removeAttribute('data-he-original-src')
	}

	// `iframe` belongs here too: the resolver counts it as body media, so
	// ignoring it on the way out made the two sides disagree (review C2).
	const targets = Array.from(
		root.querySelectorAll<HTMLElement>(
			'img, source, video, audio, track, embed, iframe'
		)
	)
	for (const el of targets) {
		const src = el.getAttribute('src')
		if (src) {
			// Note media is `content`: failing to copy it makes the export
			// incomplete, unlike a theme font (review round 2, D1).
			const next = assets.resolve(src, 'assets/media/', 'html', 'content')
			if (next) {
				el.setAttribute('src', next)
			} else {
				// Keep the original value for debugging, show a placeholder
				// instead of a broken-image icon, and let the manifest carry
				// the failure.
				markMissing(el, src)
				if (el.tagName === 'IMG') el.setAttribute('src', PLACEHOLDER)
				// Share mode: the build is about to be refused over this
				// reference, but a live URL must not be in the string at all —
				// a refusal that happens one branch later is one refactor away
				// from shipping it.
				else if (assets.isStrict) el.removeAttribute('src')
			}
		}
		const poster = el.getAttribute('poster')
		if (poster) {
			const next = assets.resolve(poster, 'assets/media/', 'html', 'content')
			if (next) el.setAttribute('poster', next)
			else {
				markMissing(el, poster)
				if (assets.isStrict) el.removeAttribute('poster')
			}
		}
		const srcset = el.getAttribute('srcset')
		if (srcset) {
			// `parseSrcset`, not `split(',')`: every embedded candidate is a
			// `data:` URL, and base64 contains commas. Splitting there would
			// shred the candidate it was meant to rewrite.
			const rewritten = parseSrcset(srcset)
				.map(candidate => {
					const next = assets.resolve(
						candidate.url,
						'assets/media/',
						'html',
						'content'
					)
					if (next) return { url: next, descriptor: candidate.descriptor }
					// A shared page must not carry the original `app://` URL as a
					// fallback candidate — drop the entry instead of leaking it.
					if (stripLocalPaths || assets.isStrict) return null
					return candidate
				})
				.filter((candidate): candidate is SrcsetCandidate => candidate !== null)
			const value = serializeSrcset(rewritten)
			if (value) el.setAttribute('srcset', value)
			else {
				el.removeAttribute('srcset')
				markMissing(el, srcset)
			}
		}
	}

	// Inline `style="background-image:url(…)"` is note content too, and the tag
	// list above cannot see it. Without this pass such an image keeps its
	// `app://` URL — a dead link outside Obsidian — while the export still
	// reported `ok` (review C2). Unresolved refs are reported by `resolve()`
	// with role `content`, which makes the export `incomplete`.
	const styled = Array.from(
		root.querySelectorAll<HTMLElement>('[style*="url("]')
	)
	for (const el of styled) {
		const style = el.getAttribute('style')
		if (!style) continue
		const next = style.replace(
			/url\(\s*(['"]?)([^'")]+)\1\s*\)/g,
			(match: string, _quote: string, url: string) => {
				const resolved = assets.resolve(url, 'assets/media/', 'html', 'content')
				if (resolved) return `url("${resolved}")`
				// Same reason as `srcset`: never leave a local URL in a shared file.
				return stripLocalPaths ? 'url("data:,")' : match
			}
		)
		if (next !== style) el.setAttribute('style', next)
	}
}

/**
 * Strip the declarations the export container must own itself.
 *
 * `width` / `height` are re-derived from `captureWidth` and the page flow; any
 * copy of them in the snapshot only fights the export's own values.
 *
 * Round 2A widened this list: the live reading view carries
 * `overflow: hidden` (Obsidian's scroll container) and `min-width`/`max-width`
 * from the theme. Replaying any of them re-created the very scroll box that
 * `BASE_CSS` exists to remove, so the geometry rules stay with the exporter.
 */
const CONTAINER_OWNED = new Set([
	'width',
	'min-width',
	'max-width',
	'height',
	'min-height',
	'max-height',
	'overflow',
	'overflow-x',
	'overflow-y'
])

export function sanitizeReadingStyle(style: string): string {
	if (!style) return ''
	return splitDeclarations(style)
		.map(part => part.trim())
		.filter(Boolean)
		.filter(part => {
			const name = declarationName(part)
			return !CONTAINER_OWNED.has(name)
		})
		.join('; ')
}

/**
 * Split on `;` only at paren depth 0 and outside quotes.
 *
 * A `url(data:image/png;base64,…)` value contains a semicolon. A naive
 * `split(';')` re-joined it as `url(data:image/png; base64,…)`, which made the
 * whole declaration invalid and also produced a garbage one (review B4).
 */
function splitDeclarations(style: string): string[] {
	const out: string[] = []
	let depth = 0
	let quote: '"' | "'" | null = null
	let current = ''

	for (let i = 0; i < style.length; i++) {
		const ch = style[i]
		if (quote) {
			current += ch
			if (ch === quote && !isEscaped(style, i)) quote = null
			continue
		}
		if (ch === '"' || ch === "'") {
			quote = ch
			current += ch
			continue
		}
		if (ch === '(') {
			depth++
		} else if (ch === ')') {
			depth = Math.max(0, depth - 1)
		} else if (ch === ';' && depth === 0) {
			out.push(current)
			current = ''
			continue
		}
		current += ch
	}
	out.push(current)

	// An unbalanced quote or paren means the scan never found the real
	// boundaries, so everything after it was swallowed into one declaration.
	// Falling back to a plain split can break a data URL, but it guarantees
	// `width`/`height` are removed — the safer direction (review C3).
	if (quote !== null || depth !== 0) return style.split(';')
	return out
}

/** True when the character at `index` is preceded by an odd number of `\`. */
function isEscaped(text: string, index: number): boolean {
	let count = 0
	for (let i = index - 1; i >= 0 && text[i] === '\\'; i--) count++
	return count % 2 === 1
}

/** Property name of one declaration — everything before the first colon. */
function declarationName(part: string): string {
	const colon = part.indexOf(':')
	if (colon <= 0) return ''
	return part.slice(0, colon).trim().toLowerCase()
}

function attrsToString(data: Record<string, string>): string {
	return Object.entries(data)
		.map(([name, value]) => ` ${name}="${escapeAttr(value)}"`)
		.join('')
}

function escapeAttr(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
}

function escapeHtml(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
