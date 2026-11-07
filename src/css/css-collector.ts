import type { App } from 'obsidian'
import type { AssetCollector } from '../assets/resource-manager'

/**
 * Collect every stylesheet the app currently has loaded, in cascade order.
 *
 * The point is fidelity: the export must look like the reading view, so the
 * theme, the enabled snippets, and the plugin stylesheets all have to travel
 * with the content. We do not try to "clean up" rules — a selector we think is
 * unused may still match something inside the cloned DOM.
 *
 * Completeness rules (review round 1, R2):
 *  - CSSOM when readable, raw text when not — a sheet is never dropped silently.
 *  - `@import` is inlined recursively (depth-limited, cycle-guarded).
 *  - Relative `url()` is resolved against the sheet's own URL, so theme-relative
 *    fonts and background images keep working.
 *  - Anything unreadable produces an explicit warning *and* a CSS comment.
 */

export interface CssChunk {
	/** CSS text with relative URLs already absolutised. */
	text: string
	origin: string
}

export interface SheetInfo {
	index: number
	href: string | null
	ownerTag: string | null
	ownerId: string | null
	method: 'cssom' | 'raw' | 'skipped'
	ruleCount: number
	bytes: number
	error: string | null
}

export interface CssCollection {
	chunks: CssChunk[]
	sheets: SheetInfo[]
	warnings: string[]
	bytes: number
	/** Which theme/snippets were active when the sheets were read. */
	theme: ThemeInfo
	/**
	 * `@import` URLs that were **not** fetched because the caller asked for an
	 * offline collection.
	 *
	 * Fetching a stylesheet from a third-party host while the user exports is a
	 * network request the export never promised to make — and it is precisely
	 * the kind of dependency a self-contained share file cannot carry. They are
	 * recorded here so the report can name them instead of pretending the
	 * stylesheet simply had no imports.
	 */
	remoteImports: string[]
	/** True when `collectCss` was called in offline mode. */
	offline: boolean
	/**
	 * App-bundle font references inlined as `data:` URLs, keyed by the exact
	 * `url()` reference as it appears in the collected CSS.
	 *
	 * P1: MathJax's CHTML output needs `MJX-TEX-*` webfonts. Those live in
	 * `app.asar`, not in the vault, so `AssetCollector` used to classify them
	 * as `external` and `renderCss` replaced every one with `url("data:,")`.
	 * The DOM (29 `mjx-container`s in the real ReAct export) was complete, but
	 * every glyph fell back to a system font — the report "some formulas look
	 * cut off". Fetching the bytes *while Obsidian is still running* and
	 * inlining them keeps the export self-contained.
	 */
	inlineFonts: Map<string, string>
	/** References actually inlined, for the manifest / user-facing summary. */
	fontsInlined: string[]
}

/**
 * Provenance for the appearance state at capture time.
 *
 * The sheet list alone cannot answer "was the theme collected?" — a theme and a
 * plugin stylesheet look identical once serialised. Recording the active theme
 * name, its version and the enabled snippets makes that answer part of the
 * artefact (round 3.3.3: the first hypothesis for a white export was always
 * "the theme was never captured", and there was nothing in the manifest to
 * check it against).
 */
export interface ThemeInfo {
	/** `appearance.json` → `cssTheme`; empty when the default theme is used. */
	name: string
	version: string
	/** Enabled CSS snippet names, in the order Obsidian reports them. */
	snippets: string[]
}

const MAX_IMPORT_DEPTH = 4

const IMPORT_RE =
	/@import\s+(?:url\(\s*(['"]?)([^'")]+)\1\s*\)|(['"])([^'"]+)\3)\s*([^;]*);/gi

const URL_RE = /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi

export interface CssCollectOptions {
	/**
	 * Do not touch the network while collecting.
	 *
	 * Used by the single-file share mode: a `@import` pointing at a third-party
	 * host must not be fetched during an export (it is an unsolicited request,
	 * and the fetched rules could not travel with a file that must be
	 * self-contained anyway). Such imports are recorded in `remoteImports` and
	 * replaced by an inert comment, never silently dropped.
	 */
	offline?: boolean
}

export async function collectCss(
	app: App,
	options: CssCollectOptions = {}
): Promise<CssCollection> {
	const offline = options.offline === true
	const sheets: SheetInfo[] = []
	const warnings: string[] = []
	const chunks: CssChunk[] = []
	const remoteImports: string[] = []

	const list = Array.from(document.styleSheets)
	// `document.styleSheets` never contains constructable stylesheets. Obsidian
	// 1.8 loads the theme through a `<style>` element, but a plugin (or a future
	// Obsidian) may `adoptStyleSheet` instead, and such a sheet would be dropped
	// without a trace. They cascade after the document's own sheets, so that is
	// where they are appended.
	const adopted =
		(document as Document & { adoptedStyleSheets?: CSSStyleSheet[] })
			.adoptedStyleSheets ?? []
	const all = [...list, ...Array.from(adopted)]

	for (let index = 0; index < all.length; index++) {
		const sheet = all[index] as CSSStyleSheet
		const owner = sheet.ownerNode as HTMLElement | null
		const isAdopted = index >= list.length
		const info: SheetInfo = {
			index,
			href: sheet.href,
			ownerTag: owner?.tagName ?? null,
			ownerId: owner?.id ?? null,
			method: 'skipped',
			ruleCount: 0,
			bytes: 0,
			error: null
		}

		let text: string | null = null

		// 1) Preferred: structured rules. Gives us rule counts and a faithful
		//    serialisation even for sheets built at runtime.
		try {
			const rules = sheet.cssRules
			if (rules) {
				text = serializeRules(rules)
				info.method = 'cssom'
				info.ruleCount = rules.length
			}
		} catch (error) {
			info.error = error instanceof Error ? error.name : 'unknown'
		}

		// 2) Fallback: raw text (inline <style> content, or a re-read of the
		//    stylesheet by URL). Cross-origin sheets land here.
		if (text === null) {
			const raw = await readSheetText(app, sheet, owner, offline)
			if (raw !== null) {
				text = raw
				info.method = 'raw'
			} else if (offline && sheet.href && isRemoteRef(sheet.href)) {
				// A `<link rel=stylesheet href=https://…>` in the app. Offline
				// mode must not fetch it, and the sheet's rules are genuinely
				// missing from the output — say so, do not skip quietly.
				remoteImports.push(sheet.href)
				warnings.push(`远程样式表未抓取（离线模式）：${sheet.href}`)
			}
		}

		const label = sheet.href
			? sheet.href
			: isAdopted
				? `adopted#${index - list.length}`
				: `inline#${index}`

		if (text === null) {
			info.method = 'skipped'
			const reason = info.error ?? '无法读取规则或原始文本'
			warnings.push(`样式表被跳过：${label}（${reason}）`)
			sheets.push(info)
			continue
		}

		const origin = label

		// Cycle detection uses the *ancestor* chain, not a global "seen" set:
		// two independent sheets may legitimately `@import` the same file, and
		// CSS semantics say those rules then apply twice. A global set would
		// drop the second import as if it were a cycle.
		const ancestry = sheet.href ? [sheet.href] : []

		const processed = await processText(
			app,
			text,
			sheet.href,
			0,
			ancestry,
			warnings,
			offline ? remoteImports : null
		)

		info.bytes = processed.length
		sheets.push(info)
		chunks.push({ text: processed, origin })
	}

	const bytes = chunks.reduce((sum, c) => sum + c.text.length, 0)
	// Fetch app-bundle fonts while Obsidian is still running; a failure is a
	// warning, not a broken export (the previous `data:,` fallback still applies).
	//
	// This is *not* a third-party request: the URLs are `app://obsidian.md/lib/…`
	// or `/lib/…`, i.e. files inside Obsidian's own bundle, read from the local
	// process. `collectCss({offline:true})` still allows it for exactly that
	// reason — without those bytes the formulas fall back to a system font.
	const inlineFonts = await inlineBundledFonts(chunks, warnings)
	return {
		chunks,
		sheets,
		warnings,
		bytes,
		theme: readThemeInfo(app),
		inlineFonts,
		fontsInlined: Array.from(inlineFonts.keys()),
		remoteImports,
		offline
	}
}

/**
 * Best-effort read of the active appearance state.
 *
 * `app.customCss` is the module that owns theme/snippet loading. Reading it is
 * optional by design: if a future Obsidian renames it, the export must still
 * work, so every access is guarded and an unknown state is recorded as empty
 * rather than failing the capture.
 */
function readThemeInfo(app: App): ThemeInfo {
	const css = (
		app as App & {
			customCss?: {
				theme?: string
				themes?: Record<string, { version?: string }>
				enabledSnippets?: Set<string> | string[]
			}
		}
	).customCss
	const name = css?.theme ?? ''
	const version = name ? (css?.themes?.[name]?.version ?? '') : ''
	let snippets: string[] = []
	try {
		snippets = Array.from(css?.enabledSnippets ?? [])
	} catch {
		snippets = []
	}
	return { name, version: String(version), snippets }
}

/**
 * P1 — inline the app-bundle webfonts a MathJax CHTML formula needs.
 *
 * Obsidian serves MathJax from `app://obsidian.md/lib/…` (or a root-relative
 * `/lib/…` URL in an inline `<style>`). `AssetCollector` cannot copy files out
 * of `app.asar`, so those references became `url("data:,")` in `export.css` and
 * `document.fonts` reported `status: "error"` for every `MJX-*` family. The
 * formula DOM was intact — this is a *font* failure, not a render or clipping
 * failure — but the glyphs fell back to a UI font and looked incomplete.
 *
 * While the app is running, the very same URL is loadable by the renderer, so
 * we fetch each font once and store it as a base64 data URL. The result is a
 * self-contained stylesheet: no extra files, no network at view time, and no
 * dependency on a hard-coded MathJax version or file name.
 */
const FONT_FACE_RE = /@font-face\s*\{([^}]*)\}/gi
const FONT_FILE_RE = /\.(?:woff2?|ttf|otf)(?:[?#]|$)/i

function isBundledFontRef(ref: string): boolean {
	if (!FONT_FILE_RE.test(ref)) return false
	return (
		ref.startsWith('/lib/') ||
		/^app:\/\/obsidian\.md\//i.test(ref) ||
		/^app:\/\/[^/]+\/lib\//i.test(ref)
	)
}

function fontMime(bytes: Uint8Array): string {
	const head = String.fromCharCode(...bytes.subarray(0, 4))
	if (head === 'wOF2') return 'font/woff2'
	if (head === 'wOFF') return 'font/woff'
	if (head === 'OTTO') return 'font/woff'
	return 'font/ttf'
}

function toBase64(bytes: Uint8Array): string {
	let out = ''
	for (let i = 0; i < bytes.length; i += 0x8000) {
		out += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
	}
	return btoa(out)
}

type FontFetch = (url: string) => Promise<{
	ok: boolean
	status?: number
	arrayBuffer(): Promise<ArrayBuffer>
}>

export async function inlineBundledFonts(
	chunks: CssChunk[],
	warnings: string[],
	opts: { fetchImpl?: FontFetch; baseURI?: string } = {}
): Promise<Map<string, string>> {
	const refs = new Set<string>()
	for (const chunk of chunks) {
		for (const face of chunk.text.matchAll(FONT_FACE_RE)) {
			for (const url of face[1].matchAll(URL_RE)) {
				const ref = (url[2] ?? '').trim()
				if (ref && isBundledFontRef(ref)) refs.add(ref)
			}
		}
	}
	const out = new Map<string, string>()
	if (refs.size === 0 || typeof fetch === 'undefined') return out

	const doFetch: FontFetch = opts.fetchImpl ?? ((url: string) => fetch(url))
	const rawBase =
		opts.baseURI ??
		(typeof document !== 'undefined' ? document.baseURI : undefined)
	// A test double / non-browser host has no document origin to resolve
	// `/lib/…` against. That is not a CSS defect, so stay silent and keep the
	// legacy (asset-collector) behaviour instead of emitting a false warning.
	if (!rawBase) return out
	try {
		new URL(rawBase)
	} catch {
		return out
	}
	const base = rawBase

	for (const ref of refs) {
		let absolute: string
		try {
			absolute = new URL(ref, base).href
		} catch {
			warnings.push(`应用内置字体 URL 无法解析，未内联：${ref}`)
			continue
		}
		try {
			const res = await doFetch(absolute)
			if (!res?.ok) throw new Error(`HTTP ${res?.status ?? '?'}`)
			const bytes = new Uint8Array(await res.arrayBuffer())
			if (bytes.length < 4) throw new Error('文件为空')
			out.set(ref, `data:${fontMime(bytes)};base64,${toBase64(bytes)}`)
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error)
			warnings.push(`应用内置字体未能内联（沿用原有回退）：${ref}（${reason}）`)
		}
	}
	return out
}

/**
 * P1c — allow-list for replaying `<html>` / `<body>` `data-*` state.
 *
 * `snapshotRoot()` records every root attribute verbatim. Some are pure
 * runtime/plugin state (and may carry values that have no business in a
 * standalone file); only attributes a collected stylesheet actually uses in a
 * selector can change the rendering. Filtering by *name* keeps this generic —
 * no plugin, theme or attribute name is hard-coded — and it is derived from
 * the very CSS written into the export, so root state and stylesheet cannot
 * drift apart. Attributes needed by the note itself (`data-callout`,
 * `data-task`, …) already live on the cloned DOM and are unaffected.
 */
const DATA_ATTR_RE = /\[\s*(data-[a-zA-Z0-9_.:-]+)/g

export function referencedDataAttributes(chunks: CssChunk[]): Set<string> {
	const out = new Set<string>()
	for (const chunk of chunks) {
		for (const match of chunk.text.matchAll(DATA_ATTR_RE)) out.add(match[1])
	}
	return out
}

/**
 * Render the collection into one stylesheet.
 *
 * With no `assets`, URLs are left absolute (`app://…`) — correct for the
 * in-app preview. With `assets`, every local URL is copied and rewritten to a
 * path relative to the CSS file. `inlineFonts` (MathJax etc.) takes priority
 * in both modes: a data URL needs no asset collector at all.
 *
 * `comments` (default true) emits `/* ==== <origin> ==== *\/` before each
 * sheet. Those origins are absolute `app://<vault-id>/…` URLs, which are useful
 * when diagnosing a theme problem inside the vault but are local paths that a
 * shared single file must not carry — the share mode turns them off.
 */
export function renderCss(
	col: CssCollection,
	opts: {
		assets?: AssetCollector
		prefix?: string
		inlineFonts?: Map<string, string>
		comments?: boolean
		/**
		 * Strict self-containment (share mode): a remote `url()` is handed to the
		 * collector instead of being passed through. The collector records it and
		 * answers `null`, so the rule keeps an inert `url("data:,")` — no request
		 * at view time, and the reference shows up in the report rather than
		 * quietly surviving into a file that is supposed to need no network.
		 */
		strict?: boolean
	} = {}
): string {
	const prefix = opts.prefix ?? 'media/'
	const assets = opts.assets
	const inline = opts.inlineFonts ?? col.inlineFonts
	const comments = opts.comments !== false
	const strict = opts.strict === true

	const inlineRefs = (match: string, _quote: string, ref: string) => {
		const dataUrl = inline?.get(ref.trim())
		return dataUrl ? `url("${dataUrl}")` : match
	}

	const parts = col.chunks.map(chunk => {
		// Inlined fonts first: a `data:` URL is left alone by the asset pass.
		let body = inline?.size ? chunk.text.replace(URL_RE, inlineRefs) : chunk.text
		if (assets) {
			body = body.replace(URL_RE, (match, quote: string, ref: string) => {
				const value = ref.trim()
					if (!value) return match
					const lower = value.toLowerCase()
					if (lower.startsWith('data:') || value.startsWith('#')) return match
					// A remote reference is left alone in the directory export
					// (read online by the vault's owner) and routed through the
					// collector in strict mode, where it is recorded and dropped.
					if (!strict && /^(https?:)?\/\//i.test(value)) return match

					// CSS-level assets are `environment`: a missing theme font must
					// not mark the note itself as broken (review round 2, D1).
					const next = assets.resolve(value, prefix, chunk.origin, 'environment')
					if (next) return `url(${quote}${next}${quote})`
					// Inert placeholder: the failure is recorded in the manifest,
					// and no request is made for a resource we do not have.
				return 'url("data:,")'
			})
		}

		return comments ? `/* ==== ${chunk.origin} ==== */\n${body}` : body
	})

	return parts.join('\n\n')
}

function serializeRules(rules: CSSRuleList): string {
	const parts: string[] = []
	for (const rule of Array.from(rules)) {
		if (rule.type === CSSRule.IMPORT_RULE) {
			const imp = rule as CSSImportRule
			const media = imp.media?.mediaText?.trim() ?? ''
			parts.push(`@import url("${imp.href}")${media ? ` ${media}` : ''};`)
			continue
		}
		parts.push(rule.cssText)
	}
	return parts.join('\n')
}

/** Inline `@import` chains, then absolutise whatever is left. */
async function processText(
	app: App,
	text: string,
	base: string | null,
	depth: number,
	ancestry: string[],
	warnings: string[],
	remoteSink: string[] | null = null
): Promise<string> {
	let out = text

	const imports: { raw: string; url: string; media: string }[] = []
	for (const match of text.matchAll(IMPORT_RE)) {
		imports.push({
			raw: match[0],
			url: (match[2] ?? match[4] ?? '').trim(),
			media: (match[5] ?? '').trim()
		})
	}

	for (const imp of imports) {
		if (!imp.url) continue
		let absolute = imp.url
		if (!isAbsoluteRef(imp.url)) {
			if (!base) {
				warnings.push(`@import 无基准 URL，无法内联：${imp.url}`)
				out = out.split(imp.raw).join(`/* @import unresolved: ${imp.url} */`)
				continue
			}
			try {
				absolute = new URL(imp.url, base).href
			} catch {
				warnings.push(`@import URL 解析失败：${imp.url}`)
				out = out.split(imp.raw).join(`/* @import invalid: ${imp.url} */`)
				continue
			}
		}

		if (depth >= MAX_IMPORT_DEPTH) {
			warnings.push(`@import 嵌套超过 ${MAX_IMPORT_DEPTH} 层，已停止：${absolute}`)
			out = out.split(imp.raw).join(`/* @import too deep: ${absolute} */`)
			continue
		}
		if (ancestry.includes(absolute)) {
			out = out.split(imp.raw).join(`/* @import cycle skipped: ${absolute} */`)
			continue
		}

		// Offline mode: a third-party stylesheet is not fetched. The import is
		// replaced by an inert comment *and* recorded, so the missing rules are
		// a fact in the report rather than a hole in the stylesheet.
		if (remoteSink && isRemoteRef(absolute)) {
			remoteSink.push(absolute)
			warnings.push(`远程 @import 未抓取（离线模式，样式可能不完整）：${absolute}`)
			out = out.split(imp.raw).join(`/* he: remote @import not fetched */`)
			continue
		}

		const raw = await readByUrl(app, absolute)
		if (raw === null) {
			warnings.push(`@import 无法读取，已跳过：${absolute}`)
			out = out.split(imp.raw).join(`/* @import unreadable: ${absolute} */`)
			continue
		}

		const inner = await processText(app, raw, absolute, depth + 1, [
			...ancestry,
			absolute
		], warnings, remoteSink)
		const wrapped = imp.media ? `@media ${imp.media} {\n${inner}\n}` : inner
		out = out.split(imp.raw).join(wrapped)
	}

	return absolutize(out, base, ref =>
		warnings.push(`相对资源缺少基准 URL，未改写：${ref}`)
	)
}

function absolutize(
	text: string,
	base: string | null,
	onUnresolved: (ref: string) => void
): string {
	return text.replace(URL_RE, (match, quote: string, ref: string) => {
		const value = ref.trim()
		if (!value || isAbsoluteRef(value)) return match
		if (!base) {
			onUnresolved(value)
			return match
		}
		try {
			return `url(${quote}${new URL(value, base).href}${quote})`
		} catch {
			onUnresolved(value)
			return match
		}
	})
}

function isAbsoluteRef(ref: string): boolean {
	const lower = ref.toLowerCase()
	return (
		lower.startsWith('data:') ||
		lower.startsWith('http:') ||
		lower.startsWith('https:') ||
		lower.startsWith('app:') ||
		lower.startsWith('file:') ||
		lower.startsWith('blob:') ||
		lower.startsWith('chrome-extension:') ||
		ref.startsWith('#') ||
		ref.startsWith('//') ||
		// Root-relative (`/lib/mathjax/…`). Not resolvable against a sheet that
		// has no URL, and not a vault file either — it belongs to the app
		// bundle. Treating it as absolute keeps `absolutize` from emitting 24
		// bogus "no base URL" warnings (review round 2, R9); the asset
		// collector classifies it as `external` instead.
		(ref.startsWith('/') && !ref.startsWith('//'))
	)
}

async function readSheetText(
	app: App,
	sheet: CSSStyleSheet,
	owner: HTMLElement | null,
	offline = false
): Promise<string | null> {
	if (owner && owner.tagName === 'STYLE') {
		const text = owner.textContent
		if (text && text.trim()) return text
	}
	if (sheet.href) {
		// Offline mode never re-reads a remote stylesheet: the request would be
		// made on the user's behalf to a host the export does not need.
		if (offline && isRemoteRef(sheet.href)) return null
		return readByUrl(app, sheet.href)
	}
	return null
}

/** `http(s)://` or protocol-relative — anything that leaves the machine. */
function isRemoteRef(ref: string): boolean {
	return /^(?:https?:)?\/\//i.test(String(ref ?? '').trim())
}

async function readByUrl(app: App, url: string): Promise<string | null> {
	const lower = url.toLowerCase()
	try {
		if (lower.startsWith('app://')) {
			let path = ''
			try {
				path = decodeURIComponent(new URL(url).pathname).replace(/^\/+/, '')
			} catch {
				return null
			}
			if (!path) return null
			if (!(await app.vault.adapter.exists(path))) return null
			return await app.vault.adapter.read(path)
		}
		if (lower.startsWith('http://') || lower.startsWith('https://')) {
			const res = await fetch(url)
			if (!res.ok) return null
			return await res.text()
		}
	} catch {
		return null
	}
	// file:// and anything else: reading outside the vault is out of scope for
	// Phase 1, and the caller records an explicit warning.
	return null
}
