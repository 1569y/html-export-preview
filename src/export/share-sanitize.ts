import { parseSrcset, serializeSrcset } from './srcset'

/**
 * Make a captured note safe to hand to someone who does not have the vault.
 *
 * The capture pipeline (`capture/dom-clone.ts`) already drops `<script>` and
 * `on*` attributes from the *clone* it produces, and rewrites resolved internal
 * links to `obsidian://open?file=…`. Both are correct inside the app — the
 * preview and the directory export are read by the person who owns the vault —
 * and both are wrong for a file that travels:
 *
 *  - `obsidian://open?file=Notes/Some%20Note.md` names a path inside a vault.
 *    For a recipient it is a dead link that also reveals the vault's structure,
 *    and `data-href` is the same value spelled differently.
 *  - a `<script>` or `onclick=` in a file someone opens from an email is
 *    executable content that was never part of "read my note".
 *
 * So the share path runs this pass over the clone *before* serialisation. It is
 * deliberately structural: text, highlights, sidenotes, headings, formulas and
 * Mermaid SVG are never touched, only link targets and executable attributes.
 * Anything it removes or neutralises is counted and reported — nothing here is
 * allowed to be a silent drop.
 */

export interface ShareSanitizeReport {
	/** Executable elements removed. */
	scripts: number
	/** `on*` attributes removed (the clone usually has none left). */
	handlers: number
	/** `<base>` elements removed — they would re-point every relative URL. */
	base: number
	/**
	 * `srcdoc` payloads removed. A `srcdoc` is a whole HTML document inside an
	 * attribute: it can carry its own scripts, and it cannot be audited as
	 * references. The frame stays (empty) and the count is reported, because
	 * the embedded content really is lost.
	 */
	srcdoc: number
	/** Links made inert because their target only exists inside the vault. */
	internalLinks: number
	/** `https:` / `mailto:` / `tel:` / `#` links left clickable. */
	externalLinks: number
	/** Diagnostic attributes stripped (`data-href`, `data-he-original-*`, …). */
	strippedAttributes: number
	/** Resources that cannot be represented in a static file at all. */
	dynamic: { tag: string; reason: string }[]
}

/** Attributes that describe the vault, not the document. */
const VAULT_METADATA = /^data-(?:href|he-original-|path|vault)(?:$|-)/i

/** A hyperlink a reader outside the vault can still follow. */
const KEEPABLE_HREF = /^(?:https?:|mailto:|tel:|#)/i

/** Tags whose content is live state rather than a picture. */
const DYNAMIC_TAGS: Record<string, string> = {
	canvas: 'canvas 的像素只在渲染时存在，静态文件里会是空白',
	object: 'object 依赖外部文档/插件，无法随文件携带',
	embed: 'embed 依赖外部插件，无法随文件携带'
}

function emptyReport(): ShareSanitizeReport {
	return {
		scripts: 0,
		handlers: 0,
		base: 0,
		srcdoc: 0,
		internalLinks: 0,
		externalLinks: 0,
		strippedAttributes: 0,
		dynamic: []
	}
}

export function sanitizeForShare(root: HTMLElement): ShareSanitizeReport {
	const report = emptyReport()

	// 1) Executable elements. `script` never has a visual meaning in a static
	//    page; `base` would silently re-point every relative URL.
	for (const el of Array.from(root.querySelectorAll('script'))) {
		el.remove()
		report.scripts++
	}
	for (const el of Array.from(root.querySelectorAll('base'))) {
		el.remove()
		report.base++
	}

	// 2) Attribute-level pass over everything that is left.
	for (const el of Array.from(root.querySelectorAll('*'))) {
		const tag = el.tagName.toLowerCase()
		if (tag === 'canvas' || tag === 'object' || tag === 'embed') {
			report.dynamic.push({ tag, reason: DYNAMIC_TAGS[tag] })
		}

		for (const attr of Array.from(el.attributes ?? [])) {
			const name = attr.name.toLowerCase()
			const value = String(attr.value ?? '')

			if (name.startsWith('on')) {
				el.removeAttribute(attr.name)
				report.handlers++
				continue
			}
			if (name === 'srcdoc') {
				el.removeAttribute(attr.name)
				report.srcdoc++
				continue
			}
			// `javascript:` / `vbscript:` anywhere a URL is expected.
			if (/^\s*(?:javascript|vbscript|data:text\/html)/i.test(value)) {
				el.removeAttribute(attr.name)
				report.handlers++
				continue
			}
			if (VAULT_METADATA.test(name)) {
				el.removeAttribute(attr.name)
				report.strippedAttributes++
			}
		}

		if (tag === 'a') {
			sanitizeAnchor(el as HTMLAnchorElement, report)
		}
	}

	return report
}

/**
 * Keep readable text, drop the promise of a destination.
 *
 * `a.internal-link` is left in place with its class (the theme styles it and
 * the reader still sees the phrase that was linked) but without `href`. The
 * `data-he-unresolved` marker is the same one the exporter's BASE_CSS uses to
 * stop such a link looking clickable, so no new styling is needed.
 */
function sanitizeAnchor(anchor: HTMLAnchorElement, report: ShareSanitizeReport): void {
	const href = anchor.getAttribute('href')
	// No `href` at all: nothing to neutralise (and `data-href` was already
	// stripped by the attribute pass).
	if (!href) return

	if (KEEPABLE_HREF.test(href.trim())) {
		report.externalLinks++
		return
	}

	// Everything else — `obsidian://`, `app://`, `file://`, a bare relative
	// path that only resolves inside the vault — is not a destination this
	// file can honour.
	anchor.removeAttribute('href')
	anchor.removeAttribute('target')
	anchor.removeAttribute('rel')
	anchor.removeAttribute('download')
	anchor.setAttribute('data-he-unresolved', '1')
	anchor.setAttribute('aria-disabled', 'true')
	if (!anchor.getAttribute('title')) {
		anchor.setAttribute('title', '该链接指向 Vault 内部笔记，单独打开此文件时无法跳转')
	}
	report.internalLinks++
}

/**
 * Rewrite `srcset` candidates through the caller's resolver.
 *
 * Kept here (not in the exporter) so the comma rules live in one place and the
 * exporter stays about the page skeleton.
 */
export function rewriteSrcset(
	value: string,
	rewrite: (url: string) => string | null
): string {
	const candidates = parseSrcset(value).map(candidate => {
		const next = rewrite(candidate.url)
		return next === null ? null : { url: next, descriptor: candidate.descriptor }
	})
	return serializeSrcset(
		candidates.filter((candidate): candidate is { url: string; descriptor: string } =>
			candidate !== null
		)
	)
}
