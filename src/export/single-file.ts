import type { App } from 'obsidian'
import type { CaptureSnapshot } from '../capture/types'
import type { CssCollection } from '../css/css-collector'
import { renderCss } from '../css/css-collector'
import {
	AssetCollector,
	findInlineToken,
	type AssetEntry,
	type AssetRole
} from '../assets/resource-manager'
import { buildHtml } from './exporter'
import { normalizeLayout, type ExportLayoutOptions } from './layout-settings'
import { auditShareDocument, type ShareAuditResult } from './share-audit'
import { sanitizeForShare, type ShareSanitizeReport } from './share-sanitize'

/**
 * Single-file ("share") mode.
 *
 * The directory export exists to be archived and re-exported: it keeps an
 * `export-manifest.json` with a SHA-256 per file and an HMAC over the manifest,
 * a `runtime-audit.json` with app-side measurements, and a sidecar
 * `assets/export.css` + `assets/media/*`. None of that can travel to a
 * recipient — a manifest is meaningless without this vault's key, and a bare
 * HTML file cannot open a sidecar if it is moved on its own.
 *
 * So the share mode produces **one** self-contained `.html`:
 *
 *  - the collected stylesheet, inlined in a `<style>` element;
 *  - MathJax fonts already inlined as `data:` URLs by `inlineBundledFonts`;
 *  - every note image / video / audio / attachment embedded as a `data:` URL;
 *  - Mermaid and math already rendered to SVG/CHTML in the captured DOM;
 *  - sidenote markup and its margin-column CSS, unchanged.
 *
 * Deliberately **not** included, because they are local state rather than
 * content: the signing key, `export-manifest.json`, `runtime-audit.json`,
 * `data-he-original-src` fallbacks (they hold `app://`/`file://` paths), and the
 * `/* ==== <sheet origin> ==== *\/` comments (absolute app URLs). The directory
 * export is untouched — it still writes and signs all of the above.
 *
 * Round 2 of the share feature adds the part that makes the file safe to hand
 * to someone else, and it is all *refusal*, never "best effort":
 *
 *  - **strict self-containment**: remote images/video/iframes and unreadable
 *    vault files are blockers, not "works online" leftovers. Third-party CSS is
 *    never fetched during the build;
 *  - **privacy**: `obsidian://` / `data-href` / local paths are removed, and an
 *    internal link keeps its text but stops pretending to be clickable;
 *  - **executable content**: `<script>`, `on*`, `srcdoc` are removed and
 *    reported; any that survive the pass abort the build;
 *  - **an independent audit of the finished string** — the bytes that would be
 *    written — so a reference the assembler failed to classify cannot be
 *    published by accident.
 *
 * Nothing here runs at plugin load: the whole module is only reached from the
 * share command callback. (`writeShareFile` lives in `share-publish.ts` and is
 * re-exported below so the command keeps one import site.)
 */

export interface ShareBlocker {
	/** `remote` / `not-found` / `local-state` / `executable` / `srcdoc` / … */
	kind: string
	ref: string
	/** Where it was found: `img[src]`, `style url()`, `a[href]`, … */
	where: string
	role: AssetRole | 'document'
}

export interface ShareStats {
	/** Bytes of the finished document, UTF-8. */
	htmlBytes: number
	/** Bytes of the inlined stylesheet. */
	cssBytes: number
	cssSheets: number
	/** Files embedded as `data:` URLs, and their raw byte total. */
	mediaEmbedded: number
	mediaBytes: number
	/** MathJax / bundled `@font-face` URLs inlined by the CSS collector. */
	inlineFonts: number
	/** Remote **content** references that could not be embedded (blockers). */
	remoteContent: number
	/** Remote **stylesheet** references, neutralised and reported. */
	remoteEnvironment: number
	/** Remote `@import` stylesheets that were deliberately not fetched. */
	remoteImports: string[]
	/** Content-role references that could not be embedded. */
	missingContent: number
	/** `url("data:,")` placeholders left by a missing theme font. */
	placeholders: number
	/** Embedded files, for the notice ("7 张图片已内嵌"). */
	embedded: AssetEntry[]
	/** What the privacy/safety pass removed or neutralised. */
	privacy: ShareSanitizeReport
	/** Independent audit of the finished string. */
	audit: ShareAuditResult
	/** Non-blocking measurement of display references that are embedded. */
	embeddedRefs: number
}

export interface ShareBuild {
	html: string
	stats: ShareStats
	layout: ExportLayoutOptions
}

export interface ShareBuildOptions {
	layout?: Partial<ExportLayoutOptions>
	rootDataAllow?: ReadonlySet<string>
	/** Injected for tests; defaults to the CSS collector's own list. */
	inlineFonts?: Map<string, string>
}

/**
 * Thrown when the document would not be self-contained. Carries the list so the
 * notice can name what to fix instead of saying "分享失败".
 */
export class ShareRefusedError extends Error {
	constructor(
		message: string,
		readonly blockers: ShareBlocker[]
	) {
		super(message)
		this.name = 'ShareRefusedError'
	}
}

/**
 * Build the self-contained document. Pure: reads vault files, writes nothing.
 *
 * Throws `ShareRefusedError` when a display dependency would be missing or
 * remote — before a single byte is written.
 */
export async function buildSingleFile(
	app: App,
	snap: CaptureSnapshot,
	css: CssCollection,
	opts: ShareBuildOptions = {}
): Promise<ShareBuild> {
	const layout = normalizeLayout(opts.layout)
	const assets = new AssetCollector(app, { inline: true, strict: true })

	// The stylesheet is rendered first so its `url()` references register on the
	// same collector as the note's media. Both passes must finish before the
	// markers are resolved — a `data:` URL cannot be produced synchronously.
	//
	// `comments: false` drops the `/* ==== app://<vault-id>/… ==== */` headers:
	// useful inside the vault, a local path in a shared file.
	const cssText = renderCss(css, {
		assets,
		prefix: '',
		comments: false,
		inlineFonts: opts.inlineFonts,
		strict: true
	})

	let privacy: ShareSanitizeReport = {
		scripts: 0,
		handlers: 0,
		base: 0,
		srcdoc: 0,
		internalLinks: 0,
		externalLinks: 0,
		strippedAttributes: 0,
		dynamic: []
	}

	const html = buildHtml(snap, {
		mode: 'single',
		cssText,
		assets,
		layout: opts.layout,
		rootDataAllow: opts.rootDataAllow,
		stripLocalPaths: true,
		prepare: root => {
			privacy = sanitizeForShare(root)
		}
	})

	const markers = await assets.materializeInline()
	let out = html
	for (const [marker, dataUrl] of markers) {
		// `split/join`, not `replace`: a `$` in a base64 payload is literal here
		// and `replace` would interpret `$&` sequences in it.
		out = out.split(marker).join(dataUrl)
	}

	// A marker that survived means a reference the collector registered but
	// `materializeInline()` could not resolve, or a note that happens to contain
	// the marker text. Either way the document would ship a broken `src`, so the
	// caller is told instead of publishing it silently.
	const leftover = findInlineToken(out)
	if (leftover) {
		throw new Error(
			`单文件打包后仍残留未解析的资源标记 ${leftover}，已中止（避免发出缺资源的文件）`
		)
	}

	// --- independent audit of the final string ------------------------------
	const audit = auditShareDocument(out)
	const blockers = collectBlockers(assets, audit, privacy)
	if (blockers.length > 0) {
		throw new ShareRefusedError(describeBlockers(blockers), blockers)
	}

	const mediaBytes = assets.registered.reduce((sum, entry) => sum + entry.bytes, 0)
	const placeholders = (out.match(/url\(\s*["']?data:,["']?\s*\)/g) ?? []).length

	return {
		html: out,
		layout,
		stats: {
			htmlBytes: byteLength(out),
			cssBytes: byteLength(cssText),
			cssSheets: css.chunks.length,
			mediaEmbedded: markers.size,
			mediaBytes,
			inlineFonts: (opts.inlineFonts ?? css.inlineFonts)?.size ?? 0,
			remoteContent: new Set(assets.remoteContent).size,
			remoteEnvironment: new Set(assets.remoteEnvironment).size,
			remoteImports: Array.from(new Set(css.remoteImports ?? [])),
			missingContent: assets.missing.filter(m => m.role === 'content').length,
			placeholders,
			embedded: assets.registered,
			privacy,
			audit,
			embeddedRefs: audit.embedded
		}
	}
}

/**
 * Everything that makes the file "not really self-contained", in one list.
 *
 * Three independent sources are unioned on purpose — the collector knows what
 * it could not embed, the sanitizer knows what it had to remove, and the audit
 * knows what is still in the string. Relying on any single one of them is how a
 * category gets forgotten.
 */
function collectBlockers(
	assets: AssetCollector,
	audit: ShareAuditResult,
	privacy: ShareSanitizeReport
): ShareBlocker[] {
	const out: ShareBlocker[] = []
	const seen = new Set<string>()
	const push = (blocker: ShareBlocker) => {
		const key = `${blocker.kind}|${blocker.ref}|${blocker.where}`
		if (seen.has(key)) return
		seen.add(key)
		out.push(blocker)
	}

	for (const missing of assets.missing) {
		if (missing.role !== 'content') continue
		push({
			kind: missing.kind,
			ref: missing.ref,
			where: missing.source,
			role: 'content'
		})
	}

	for (const issue of audit.display) {
		push({ kind: issue.kind, ref: issue.ref, where: issue.where, role: 'content' })
	}

	for (const issue of audit.localState) {
		push({ kind: 'local-state', ref: issue.value, where: issue.where, role: 'document' })
	}

	for (const executable of audit.executable) {
		push({ kind: 'executable', ref: executable, where: 'document', role: 'document' })
	}

	if (privacy.srcdoc > 0) {
		push({
			kind: 'srcdoc',
			ref: `${privacy.srcdoc} 处 iframe srcdoc（内嵌 HTML 会随文件执行/丢失）`,
			where: 'iframe',
			role: 'document'
		})
	}

	return out
}

const KIND_TEXT: Record<string, string> = {
	remote: '远程资源（不会随文件携带）',
	'not-found': '知识库中找不到该文件',
	ambiguous: '存在多个同名候选，无法确定',
	blob: 'blob: 地址只存在于当前会话',
	file: 'file:// 地址在知识库之外',
	relative: '相对路径没有可用基准',
	'copy-failed': '读取失败',
	'local-state': '本机 / Vault 路径',
	executable: '可执行内容',
	srcdoc: 'iframe srcdoc 内嵌文档'
}

function describeBlockers(blockers: ShareBlocker[]): string {
	const shown = blockers.slice(0, 5).map(blocker => {
		const kind = KIND_TEXT[blocker.kind] ?? blocker.kind
		return `  · ${kind}：${shorten(blocker.ref)}（${blocker.where}）`
	})
	const more = blockers.length > shown.length ? `\n  …另有 ${blockers.length - shown.length} 处` : ''
	return (
		`单文件分享已中止：有 ${blockers.length} 处内容无法随文件携带，` +
		'因此没有写入任何文件（不会生成一个看起来正常、实际缺图的分享文件）。\n' +
		shown.join('\n') +
		more +
		'\n处理办法：把远程图片/附件下载到知识库并改用本地链接，或确认图片在阅读视图中可见；' +
		'含 iframe srcdoc / 脚本的笔记请改用目录导出。'
	)
}

function shorten(value: string, max = 90): string {
	const text = String(value ?? '')
	return text.length > max ? `${text.slice(0, max)}…` : text
}

/* ------------------------------------------------------------------------- *
 * Writing: never overwrite (see `share-publish.ts`)
 * ------------------------------------------------------------------------- */

export {
	writeShareFile,
	shareRootFor,
	resolveShareDir,
	sha256Hex,
	ShareWriteError,
	DEFAULT_SHARE_ROOT
} from './share-publish'
export type {
	ShareWriteResult,
	ShareStage,
	ShareReplacePlan
} from './share-publish'

function byteLength(text: string): number {
	if (typeof TextEncoder === 'function') {
		return new TextEncoder().encode(text).length
	}
	return text.length
}
