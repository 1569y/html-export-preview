/**
 * Static visibility audit for the export stylesheet.
 *
 * Round 3.3.1 (blank-page investigation): the user reported `index.html`
 * opening to a completely blank page in a real browser even though the export
 * reported success and referenced media. The capture step embeds the cloned
 * `.markdown-preview-sizer` verbatim between `<!--he-body-start-->` /
 * `<!--he-body-end-->` markers (see exporter.buildHtml), and `verifyExport`
 * already refuses an empty body — so a blank page with referenced media means
 * the **content is present but hidden by CSS**.
 *
 * `export.css` collects the entire theme + snippet cascade.
 * `exporter.BASE_CSS` only overrides `overflow` / `height` with `!important`
 * and deliberately does NOT touch `display` / `visibility` / `opacity`, so a
 * collected rule such as `.markdown-preview-view { display: none }` blanks the
 * page and nothing in the export recovers it.
 *
 * This audit is a *static, heuristic* guardrail — it scans the collected CSS
 * for declarations that would hide the body chain and reports them. It is NOT a
 * real render: it cannot run Obsidian's cascade or resolve `@media`/`@supports`
 * context, so it is advisory. A real browser is still the final judge (see
 * review docs: host visual verification is NOT TESTED in this headless run).
 *
 * Conservative by design: it only flags selectors that target the body chain
 * and only the properties that hide content. False negatives are acceptable
 * (the real page may still hide via a context we cannot see); false positives
 * are minimised by requiring a body-chain selector. The audit never blocks a
 * publish on its own — it is surfaced as a warning.
 */

/** A selector that, if hidden, blanks the whole export. */
const BODY_CHAIN = [
	'markdown-reading-view',
	'markdown-preview-view',
	'markdown-preview-sizer',
	'view-content',
	'workspace-leaf',
	'workspace',
	'cm-editor',
	'markdown-folding'
]

const HIDE_RE = [
	{ property: 'display', re: /^\s*display\s*:\s*none\b/i },
	{ property: 'visibility', re: /^\s*visibility\s*:\s*hidden\b/i },
	{ property: 'opacity', re: /^\s*opacity\s*:\s*(0|0\.0+)(%|\b)/i },
	{ property: 'position', re: /^\s*position\s*:\s*(absolute|fixed)\b/i }
]

export interface VisibilityWarning {
	/** Selector text (trimmed, truncated for readability). */
	selector: string
	/** Which declaration triggered the warning. */
	property: string
	/** The offending value. */
	value: string
	/** Approximate 1-based line in the CSS text, for tracing. */
	line: number
}

export interface VisibilityAuditResult {
	warnings: VisibilityWarning[]
	/**
	 * True when at least one rule hides part of the body chain. Advisory only:
	 * the export is still written; the user is warned not to trust "success".
	 */
	blankRisk: boolean
	cssBytes: number
	/**
	 * Rules that cannot apply to a static export page and were therefore not
	 * reported: `@media print`, `:hover`, and the mobile/print body classes.
	 * Counted rather than silently dropped, so "0 warnings" is not mistaken for
	 * "the whole cascade was checked".
	 */
	ignored: number
}

/**
 * Selectors that only match in a context the export page never enters.
 *
 * A theme shipping `.is-mobile .markdown-preview-view { display: none }` (the
 * phone layout) or `.print .markdown-preview-view { … }` would otherwise be
 * reported as "content hidden by CSS" on every single export. Those warnings are
 * wrong every time, and a stream of them is exactly what buries the one real
 * failure.
 */
const INACTIVE_SELECTOR =
	/(?:\.is-mobile\b|\.is-phone\b|\.is-tablet\b|\.is-ios\b|\.is-android\b|\.print\b|:hover\b|:focus\b|:focus-within\b|:active\b)/i

/**
 * Blank out `@media print { … }` blocks, keeping the line count intact so the
 * reported line numbers still point at the original stylesheet.
 */
function stripPrintBlocks(css: string): string {
	let out = ''
	let i = 0
	while (i < css.length) {
		const at = css.indexOf('@media print', i)
		if (at === -1) {
			out += css.slice(i)
			break
		}
		out += css.slice(i, at)
		const open = css.indexOf('{', at)
		if (open === -1) {
			out += css.slice(at)
			break
		}
		let depth = 0
		let j = open
		for (; j < css.length; j++) {
			const ch = css[j]
			if (ch === '{') depth++
			else if (ch === '}') {
				depth--
				if (depth === 0) {
					j++
					break
				}
			}
		}
		const removed = css.slice(at, j)
		out += removed.replace(/[^\n]/g, ' ')
		i = j
	}
	return out
}

function targetsBodyChain(selector: string): boolean {
	const s = selector.trim()
	if (!s) return false
	// Document-level elements.
	if (/^(html|body|:root|\*)$/i.test(s)) return true
	if (/\b(html|body|:root)\b/i.test(s)) return true
	// Obsidian body-chain classes (word-boundary so `.foo-bar` never matches
	// `bar` unless `bar` is a listed token).
	for (const token of BODY_CHAIN) {
		if (new RegExp(`\\.${token}\\b`).test(s)) return true
	}
	return false
}

export function auditCssVisibility(cssText: string): VisibilityAuditResult {
	const warnings: VisibilityWarning[] = []
	let ignored = 0
	// `@media print` never applies to the exported page: a white-space copy keeps
	// every remaining line number honest.
	const scannable = stripPrintBlocks(cssText)
	// Heuristic block split. Nested at-rules (@media/@keyframes) may hide a rule
	// from this scan — an acceptable false negative for an advisory check.
	const blockRe = /([^{}]+)\{([^{}]*)\}/g
	let m: RegExpExecArray | null
	while ((m = blockRe.exec(scannable)) !== null) {
		const selector = m[1].trim()
		const body = m[2]
		if (!targetsBodyChain(selector)) continue
		if (INACTIVE_SELECTOR.test(selector)) {
			ignored++
			continue
		}

		const declRe = /([a-z-]+)\s*:\s*([^;]+)/gi
		let d: RegExpExecArray | null
		while ((d = declRe.exec(body)) !== null) {
			const name = d[1].toLowerCase()
			const value = d[2].trim()
			for (const h of HIDE_RE) {
				if (name !== h.property) continue
				if (!h.re.test(`${name}:${value}`)) continue
				warnings.push({
					selector: selector.slice(0, 120),
					property: h.property,
					value: value.slice(0, 60),
					line: cssText.slice(0, m.index).split('\n').length
				})
			}
		}
	}

	return {
		warnings,
		blankRisk: warnings.length > 0,
		cssBytes: typeof cssText === 'string' ? cssText.length : 0,
		ignored
	}
}
