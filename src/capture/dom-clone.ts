/**
 * Deep-clone the rendered content and strip the things that must not survive
 * into a static export.
 *
 * Everything here is additive to a *detached* copy — the live reading view is
 * never touched, so closing the preview or cancelling an export cannot affect
 * the note.
 */

import { sameNoteFragment, type SameNoteIdentity } from './link-identity'

/** Runtime artefacts that only make sense while Obsidian is running. */
const DROP_SELECTORS = [
	'script',
	// EI-01: scroll-sync placeholder. It is Obsidian's "reserve the height the
	// inline title occupies" element (`height: 0.1px` normally, hundreds of
	// pixels in some themes/notes) and carries no note content. In a static
	// page it is pure vertical whitespace, so it must not travel with the body.
	'.markdown-preview-pusher',
	'.mermaid-beauty-actions', // hover export buttons (absolute positioned)
	'.sidenote-measure-probe', // Side Notes measuring probe
	'.sidenote-embed-open', // "open in app" button, needs the `app` object
	'.he-editor-layer', // our own selection overlay
	'.he-media-handle'
]

/** Inline properties that cause a visible jump on first paint. */
const DROP_STYLE_PROPS = ['transition', 'will-change']

/**
 * Inline layout on the body container that only describes Obsidian's scroll
 * model (EI-01).
 *
 * - `min-height` / `height` — the sizer is stretched to at least the viewport so
 *   the editor can scroll past the end of the note.
 * - `padding-bottom` — the "scroll past end" gap (385px in a 890px-wide note).
 *
 * Kept on the copy, they become a large empty band under the last paragraph and
 * fight the export's own `min-height: 0`. The scroll container's real geometry
 * is re-derived by the exporter, so nothing of value is lost here.
 */
const DROP_ROOT_STYLE_PROPS = ['min-height', 'max-height', 'height', 'padding-bottom']

export interface CloneResult {
	content: HTMLElement
	warnings: string[]
}

export function cloneContent(
	source: HTMLElement,
	identity?: SameNoteIdentity | null
): CloneResult {
	const clone = source.cloneNode(true) as HTMLElement
	const warnings: string[] = []

	for (const selector of DROP_SELECTORS) {
		clone.querySelectorAll(selector).forEach(el => el.remove())
	}

	// Inline event handlers never survive cloneNode (listeners are not copied),
	// but `onclick="…"` attributes do — strip them so nothing executes later.
	clone.querySelectorAll('*').forEach(el => {
		for (const attr of Array.from(el.attributes)) {
			if (attr.name.startsWith('on')) el.removeAttribute(attr.name)
			if (attr.name === 'contenteditable') el.removeAttribute(attr.name)
		}
		// `HTMLElement` is browser-only. Host doubles (and any future non-DOM
		// caller) must be able to clone content without a global constructor;
		// the style cleanup is cosmetic, so skipping it is safe there.
		if (typeof HTMLElement !== 'undefined' && el instanceof HTMLElement) {
			for (const prop of DROP_STYLE_PROPS) el.style.removeProperty(prop)
		}
	})

	// `is-placing` suppresses the placement transition; if it is still present
	// when we clone (layout not settled yet) the margin would stay hidden.
	clone.querySelectorAll('.sidenote-margin.is-placing').forEach(el => {
		el.classList.remove('is-placing')
	})

	// EI-01: the container's own scroll padding is not content.
	for (const prop of DROP_ROOT_STYLE_PROPS) clone.style.removeProperty(prop)

	normalizeLinks(clone, warnings, identity)
	normalizeMermaid(clone, warnings)

	return { content: clone, warnings }
}

/**
 * Make internal links behave in a page that is no longer inside Obsidian
 * (EI-01).
 *
 * Reading view leaves `href="DOC-02 长文档"` on every internal link — a bare
 * relative URL. In a browser that resolves against the export directory and
 * 404s; an unresolved link is worse, because the page claims a target that does
 * not exist anywhere. Two different outcomes:
 *
 *   - unresolved → drop `href` (keep the text and the original value in
 *     `data-he-original-href`), mark it as inert so it stops looking clickable.
 *   - resolved   → rewrite to `obsidian://open?file=<path>`, which Obsidian
 *     itself registers, so the link still works for a reader who has the vault.
 *
 * External links are left untouched: they are already valid outside Obsidian.
 *
 * P2 Task 1 — **before** either of those branches, a link whose target is a
 * heading of the *source note* is rewritten to a plain `#fragment`. Doing it
 * here (at capture time, while the Obsidian metadata cache is available) is
 * what makes all three outputs agree: the preview iframe, the directory
 * export and the single-file share. If it were left until `applyInternalAnchors`
 * the `data-href` would already have been turned into `obsidian://open?file=…`
 * and then stripped by `sanitizeForShare()`, so the real sidenote #54 link
 * (`[[示例笔记#ABSTRACT]]`) ended up as dead plain text.
 */
function normalizeLinks(
	root: HTMLElement,
	warnings: string[],
	identity?: SameNoteIdentity | null
): void {
	let unresolved = 0
	let rewritten = 0
	let sameNote = 0

	root.querySelectorAll<HTMLAnchorElement>('a.internal-link').forEach(anchor => {
		const raw = anchor.getAttribute('href') ?? ''
		const target = (anchor.getAttribute('data-href') || raw).trim()

		const fragment = sameNoteFragment(target, identity)
		if (fragment) {
			anchor.setAttribute('href', `#${fragment}`)
			anchor.setAttribute('data-href', `#${fragment}`)
			// Same-note jumps are native fragment navigations. Keeping Obsidian's
			// target/rel would open a new tab from a saved HTML file (and the
			// preview's delegated handler would only mask it).
			anchor.removeAttribute('target')
			anchor.removeAttribute('rel')
			anchor.removeAttribute('download')
			anchor.removeAttribute('data-he-unresolved')
			anchor.removeAttribute('aria-disabled')
			anchor.classList.remove('is-unresolved')
			sameNote++
			return
		}

		if (anchor.classList.contains('is-unresolved')) {
			unresolved++
			anchor.removeAttribute('href')
			anchor.removeAttribute('target')
			anchor.removeAttribute('rel')
			anchor.setAttribute('data-he-unresolved', '1')
			anchor.setAttribute('aria-disabled', 'true')
			anchor.setAttribute('title', '链接目标不在当前 Vault 中')
			if (raw) anchor.setAttribute('data-he-original-href', raw)
			return
		}

		if (!target) return
		if (/^(https?:|mailto:|tel:|#)/i.test(target)) return
		anchor.setAttribute('href', `obsidian://open?file=${encodeURIComponent(target)}`)
		rewritten++
	})

	if (unresolved > 0) {
		warnings.push(
			`${unresolved} 个内部链接指向不存在的笔记，已取消跳转（保留文字）`
		)
	}
	if (rewritten > 0) {
		warnings.push(`${rewritten} 个内部链接已改写为 obsidian:// 打开方式`)
	}
	if (sameNote > 0) {
		warnings.push(`${sameNote} 个指向本篇章节的链接已改为页内跳转`)
	}
}

/**
 * Keep the SVG vector as-is, but make sure it has a `viewBox` so a container
 * width can scale it without distortion. Mermaid normally emits one; the
 * fallback covers hand-written or plugin-rewritten diagrams.
 */
function normalizeMermaid(root: HTMLElement, warnings: string[]): void {
	const diagrams = root.querySelectorAll<HTMLElement>('.mermaid')
	diagrams.forEach(diagram => {
		const svg = diagram.querySelector('svg')
		if (!svg) {
			warnings.push('Mermaid 图缺少 <svg>，可能是渲染未完成')
			return
		}
		if (!svg.getAttribute('viewBox')) {
			const w = Number(svg.getAttribute('width') ?? 0)
			const h = Number(svg.getAttribute('height') ?? 0)
			if (w > 0 && h > 0) {
				svg.setAttribute('viewBox', `0 0 ${w} ${h}`)
				warnings.push('Mermaid SVG 缺少 viewBox，已按 width/height 推导')
			} else {
				warnings.push('Mermaid SVG 缺少 viewBox 且无法推导尺寸')
			}
		}
	})
}
