/**
 * Static audit of the finished share document.
 *
 * The share command promises one file that opens with no network. That promise
 * is easy to *state* and easy to break silently: one `src="https://…"` left in
 * the body, one `url()` in a theme rule that was never fetched, one `obsidian://`
 * link that leaks a vault path — and the recipient sees a broken page, or the
 * recipient's browser phones home for something we promised not to need.
 *
 * The build already classifies every reference it *sees* while assembling the
 * page. This pass is the independent backstop: it reads the final string — the
 * exact bytes that would be written — and reports every display-affecting
 * reference that is not `data:`/fragment, every executable construct, and every
 * attribute value that still looks like local state.
 *
 * Two rules keep it honest:
 *
 *  - it never *fixes* anything. A blocker found here is a reason to refuse the
 *    publish, never something to paper over at the last moment;
 *  - it never inspects prose. Only attribute values, `<style>` blocks and link
 *    targets are read, so a note that merely *talks about* `C:\Users\…` is not
 *    mistaken for a leak.
 */

import { parseSrcset } from './srcset'

export type DisplayRefKind = 'remote' | 'local' | 'blob' | 'relative' | 'unknown'

export interface DisplayRefIssue {
	/** The reference as it appears in the document. */
	ref: string
	/** `img[src]`, `style url()`, `link[href]`, … */
	where: string
	kind: DisplayRefKind
}

export interface LocalStateIssue {
	where: string
	value: string
}

export interface ShareAuditResult {
	/** Display dependencies that are not self-contained. Every one blocks. */
	display: DisplayRefIssue[]
	/** Attribute values that still name the vault / a local path. */
	localState: LocalStateIssue[]
	/** Executable constructs. Any entry blocks the publish. */
	executable: string[]
	/** `https:` links that are legitimately still clickable. */
	externalLinks: number
	/** `data:` display references, for the "everything is embedded" number. */
	embedded: number
	styleBlocks: number
	/** How much of the document was inspected. */
	bytes: number
}

/** Attributes that load something, per element. Everything else is metadata. */
const DISPLAY_ATTRS: Record<string, string[]> = {
	img: ['src', 'srcset'],
	source: ['src', 'srcset'],
	video: ['src', 'poster'],
	audio: ['src'],
	track: ['src'],
	iframe: ['src'],
	embed: ['src'],
	object: ['data'],
	link: ['href'],
	image: ['href', 'xlink:href'],
	use: ['href', 'xlink:href'],
	feimage: ['href', 'xlink:href'],
	mpath: ['href', 'xlink:href'],
	input: ['src']
}

/** Attributes whose value is a URL list rather than a single URL. */
const SRCSET_ATTR = 'srcset'

const TAG_RE = /<([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
const STYLE_BLOCK_RE = /<style\b[^>]*>([\s\S]*?)<\/style>/gi
const CSS_URL_RE = /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi
const CSS_IMPORT_RE = /@import\s+(?:url\(\s*(['"]?)([^'")]*)\1\s*\)|(['"])([^'"]*)\3)/gi

/** Attribute values are truncated for the report; paths are short but values
 *  can be megabytes of base64 and a message must stay readable. */
function preview(value: string, max = 120): string {
	const text = String(value ?? '')
	return text.length > max ? `${text.slice(0, max)}…` : text
}

/**
 * Undo HTML entity escaping before analysing a value.
 *
 * `outerHTML` writes `url("data:…")` inside a `style` attribute as
 * `url(&quot;data:…&quot;)`. Analysing the escaped form made the audit see a
 * bare relative reference whose "URL" started with `&quot;` — a false blocker
 * on an image that was embedded perfectly well.
 */
function decodeEntities(value: string): string {
	return String(value ?? '')
		.replace(/&quot;/g, '"')
		.replace(/&#0*39;|&#x0*27;/gi, "'")
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&')
}

function classify(ref: string): 'ok' | DisplayRefKind {
	const value = String(ref ?? '').trim()
	if (!value) return 'ok'
	if (value.startsWith('#')) return 'ok'
	if (/^data:/i.test(value)) return 'ok'
	if (/^about:blank$/i.test(value)) return 'ok'
	// A remote reference is the one case where "it would work online" is
	// exactly why it must not ship.
	if (/^(?:https?:)?\/\//i.test(value)) {
		// `//host/path` is protocol-relative; on its own it still needs the net.
		return 'remote'
	}
	if (/^blob:/i.test(value)) return 'blob'
	if (/^(?:app|file|chrome-extension|resource|obsidian):/i.test(value)) return 'local'
	return 'relative'
}

/** Local-looking text anywhere in an attribute value. */
const LOCAL_PATTERNS: { label: string; re: RegExp }[] = [
	{ label: 'app://', re: /app:\/\//i },
	{ label: 'file://', re: /file:\/\//i },
	{ label: 'obsidian://', re: /obsidian:\/\//i },
	{ label: '盘符路径', re: /(?:^|[\s"'(])[A-Za-z]:[\\/]/ },
	{ label: 'UNC 路径', re: /\\\\[A-Za-z0-9._-]+\\/ },
	{ label: '/Users/', re: /\/Users\/[A-Za-z0-9._-]+/ },
	{ label: 'vault 诊断属性', re: /^data-he-original-/i }
]

export function auditShareDocument(html: string): ShareAuditResult {
	const doc = String(html ?? '')
	const result: ShareAuditResult = {
		display: [],
		localState: [],
		executable: [],
		externalLinks: 0,
		embedded: 0,
		styleBlocks: 0,
		bytes: doc.length
	}

	// `<style>` bodies are CSS, not markup: pull them out first so their `>`
	// combinators cannot be mistaken for the end of a tag, and audit them with
	// the CSS rules instead of the attribute rules.
	const cssBlocks: string[] = []
	const masked = doc.replace(STYLE_BLOCK_RE, (_match, css: string) => {
		cssBlocks.push(css)
		return '<style></style>'
	})
	result.styleBlocks = cssBlocks.length

	for (const css of cssBlocks) {
		auditCss(css, result)
	}

	for (const match of masked.matchAll(TAG_RE)) {
		const tag = match[1].toLowerCase()
		const rawAttrs = match[2] ?? ''

		// `<script` inside the body would be executable content; the sanitizer
		// removed it already, and this is the check that proves it.
		if (tag === 'script') result.executable.push('<script>')

		let href: string | null = null

		for (const attr of rawAttrs.matchAll(ATTR_RE)) {
			const name = attr[1].toLowerCase()
			const value = decodeEntities(attr[2] ?? attr[3] ?? '')
			const where = `${tag}[${name}]`

			if (name.startsWith('on')) {
				result.executable.push(`${where} 事件处理器`)
				continue
			}
			if (name === 'srcdoc') {
				result.executable.push(`${where} srcdoc`)
				continue
			}
			if (/^\s*(?:javascript|vbscript):/i.test(value)) {
				result.executable.push(`${where} 脚本 URL`)
			}

			auditLocalState(where, value, result)

			if (name === 'style') {
				auditCss(value, result, `${tag}[style]`)
				continue
			}

			if (tag === 'a' && name === 'href') {
				href = value
				continue
			}

			const wanted = DISPLAY_ATTRS[tag]
			if (!wanted || !wanted.includes(name)) continue

			if (name === SRCSET_ATTR) {
				for (const candidate of parseSrcset(value)) {
					pushDisplay(candidate.url, where, result)
				}
				continue
			}
			pushDisplay(value, where, result)
		}

		if (tag === 'a' && href !== null) {
			// A hyperlink is not a display dependency: it needs the network only
			// when the reader clicks it, so `https:` (and `mailto:`/`tel:`/`#`)
			// stay legal. A local target is different — it is a dead link that
			// also names a vault path.
			const target = href.trim()
			if (/^(?:https?:|mailto:|tel:|#)/i.test(target) || /^data:/i.test(target)) {
				result.externalLinks++
			} else {
				const kind = classify(target)
				if (kind !== 'ok') {
					result.display.push({
						ref: preview(href),
						where: 'a[href]（Vault 内部链接）',
						kind
					})
				}
			}
		}
	}

	return result
}

function pushDisplay(ref: string, where: string, result: ShareAuditResult): void {
	const kind = classify(ref)
	if (kind === 'ok') {
		if (/^data:/i.test(String(ref).trim())) result.embedded++
		return
	}
	result.display.push({ ref: preview(ref), where, kind })
}

function auditLocalState(where: string, value: string, result: ShareAuditResult): void {
	if (!value) return
	// A `data:` payload is the *opposite* of a leak; skip it so a base64 body
	// can never be scanned as text.
	if (/^\s*data:/i.test(value)) return
	for (const pattern of LOCAL_PATTERNS) {
		if (pattern.re.test(value)) {
			result.localState.push({ where, value: preview(value) })
			return
		}
	}
}

function auditCss(css: string, result: ShareAuditResult, where = 'style'): void {
	for (const match of css.matchAll(CSS_IMPORT_RE)) {
		const ref = (match[2] ?? match[4] ?? '').trim()
		if (!ref) continue
		const kind = classify(ref)
		if (kind === 'ok') continue
		result.display.push({ ref: preview(ref), where: `${where} @import`, kind })
	}
	for (const match of css.matchAll(CSS_URL_RE)) {
		const ref = (match[2] ?? '').trim()
		if (!ref) continue
		pushDisplay(ref, `${where} url()`, result)
	}
}
