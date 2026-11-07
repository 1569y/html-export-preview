import type { App } from 'obsidian'
import { TFile } from 'obsidian'

/**
 * Copy the media a cloned page references into an `assets/` folder and rewrite
 * the references to relative paths.
 *
 * Obsidian renders local attachments as `app://<vault-id>/<path>` URLs, which
 * mean nothing outside the app. The path portion is still the vault-relative
 * path, so it can be mapped back to a file and copied out.
 *
 * Review round 2 (D1 / R8) changed three things:
 *
 *  - **Roles.** A note image is `content`: if it cannot be copied the export is
 *    incomplete and must say so. A theme font or an Obsidian UI icon is
 *    `environment`: it may legitimately stay behind, but it is recorded.
 *  - **Honest counters.** `written` now counts files that actually landed on
 *    disk. Failures are listed individually instead of being folded into the
 *    entry count.
 *  - **Real categories.** `app://obsidian.md/*` (the app's own bundle) and
 *    root-relative `/lib/…` paths are *not* missing note assets. They are
 *    classified as `external` and never inflate the "missing" number.
 *
 * Resolution rules:
 *  - `data:` is already self-contained and is left alone.
 *  - `http(s):` / `//` stay remote URLs (work online, reported as remote).
 *  - `app://obsidian.md/*` is the app bundle → external, never copied.
 *  - `app://<vault-id>/*` is a vault file → decoded, matched **exactly** first;
 *    a suffix match is accepted only when it is unique AND reported.
 *  - `blob:` / `file:` / bare relative refs / root-relative `/…` are refused
 *    and categorised, never guessed.
 */

/** Whether losing this reference damages the note itself. */
export type AssetRole = 'content' | 'environment'

export type MissingKind =
	| 'app-resource'
	| 'root-relative'
	| 'blob'
	| 'file'
	| 'relative'
	| 'remote'
	| 'not-found'
	| 'ambiguous'
	| 'copy-failed'

export interface MissingRef {
	ref: string
	reason: string
	/** Where the reference came from: `html`, `assets`, or a stylesheet origin. */
	source: string
	kind: MissingKind
	role: AssetRole
}

/** A reference we deliberately do not package, with the reason recorded. */
export interface ExternalRef {
	ref: string
	kind: 'app-resource' | 'root-relative' | 'remote'
	source: string
	note: string
}

export interface AssetEntry {
	name: string
	vaultPath: string
	bytes: number
	role: AssetRole
}

/** A file that was registered but could not be copied. */
export interface AssetFailure {
	name: string
	vaultPath: string
	reason: string
	role: AssetRole
}

export interface AssetReport {
	/** Files that actually reached disk. */
	written: number
	/**
	 * The entries that actually reached disk.
	 *
	 * Round 2A (R6/X8): `written` used to be `entries.length`, so a run where
	 * every copy threw still reported a full success count. The manifest then
	 * listed failures as if they were packaged. `writtenEntries` is the list the
	 * manifest publishes as `entries`; failed items only ever appear in `failed`.
	 */
	writtenEntries: AssetEntry[]
	/** How many copies were attempted (`writtenEntries.length + failed.length`). */
	attempted: number
	failed: AssetFailure[]
	/**
	 * Every registered entry, written or not.
	 *
	 * Kept for callers that need to reason about the full set; **not** what the
	 * manifest publishes as `entries` (see `writtenEntries`).
	 */
	entries: AssetEntry[]
	missing: MissingRef[]
	warnings: string[]
	remote: string[]
	external: ExternalRef[]
	/** Content-role files that failed to *copy*. */
	contentFailed: number
	/**
	 * Distinct content-role references that never made it into the export —
	 * unresolved (not found, ambiguous, blob/file, bare relative) **or** failed
	 * to copy, counted once per reference.
	 *
	 * Review B1: unresolved content used to leave the export marked `ok`, which
	 * is the same fake success this round set out to kill. Review C1: a copy
	 * failure is also recorded in `missing`, so this must be a union rather
	 * than `contentFailed + contentMissing`.
	 */
	contentMissing: number
}

/**
 * Placeholder prefix used by the single-file (share) mode.
 *
 * A data URL can only be produced asynchronously, but `resolve()` is called
 * synchronously while the HTML/CSS strings are being assembled. So the inline
 * mode registers each file and returns an opaque marker; `materializeInline()`
 * later turns every marker into a `data:` URL and the caller replaces them in
 * one pass over the finished document.
 *
 * The prefix is deliberately not a valid URL scheme *and* not a substring a
 * note could plausibly contain, so a leftover marker is detectable rather than
 * silently shipping a broken `src`.
 */
export const INLINE_TOKEN_PREFIX = '%HE-INLINE-'

/** Wraps the marker so it can be found in attributes and `url()` alike. */
function inlineToken(index: number): string {
	return `${INLINE_TOKEN_PREFIX}${index}%`
}

/** True when a finished document still carries an unresolved marker. */
export function findInlineToken(text: string): string | null {
	const match = new RegExp(`${INLINE_TOKEN_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\d+%`).exec(text)
	return match ? match[0] : null
}

export interface AssetCollectorOptions {
	/**
	 * Single-file share mode: nothing is written to disk. `resolve()` returns an
	 * opaque marker per file, and `materializeInline()` produces the data URLs.
	 */
	inline?: boolean
	/**
	 * Strict self-containment (share mode).
	 *
	 * Without it a remote `http(s)` reference is *kept*: the directory export is
	 * read by the vault's owner, online, so a linked image still works and
	 * "remote" is an honest category. A file sent to someone else must not work
	 * that way — and must not silently depend on the network either. In strict
	 * mode a remote reference is recorded as missing (`kind: 'remote'`) and
	 * returns `null`, so the caller sees it as a blocker instead of shipping a
	 * document whose pictures only load online.
	 *
	 * No request is made to a third party either way: the collector reads the
	 * vault, never the network.
	 */
	strict?: boolean
}

export class AssetCollector {
	readonly missing: MissingRef[] = []
	readonly warnings: string[] = []
	readonly remote: string[] = []
	readonly external: ExternalRef[] = []
	/**
	 * Remote references split by what losing them costs.
	 *
	 * `content` is note media (an image the note shows); `environment` is a
	 * stylesheet resource (a theme font or background). The split is what lets
	 * a share report say "3 remote images block this" while a remote theme font
	 * is only a warning.
	 */
	readonly remoteContent: string[] = []
	readonly remoteEnvironment: string[] = []

	private byVaultPath = new Map<string, string>()
	private entries: AssetEntry[] = []
	private fileIndex: TFile[] | null = null
	private readonly inline: boolean
	private readonly strict: boolean

	constructor(
		private readonly app: App,
		options: AssetCollectorOptions = {}
	) {
		this.inline = options.inline === true
		this.strict = options.strict === true
	}

	/** True when this collector produces markers instead of file names. */
	get isInline(): boolean {
		return this.inline
	}

	/**
	 * True when a remote reference must never survive into the output.
	 *
	 * The exporter reads this to decide whether an unresolved `<video>`/`<iframe>`
	 * may keep its original `src`: in a share file it must not, even though the
	 * build is about to be refused — a refusal that happens after a live URL was
	 * written into a string is one bug away from shipping it.
	 */
	get isStrict(): boolean {
		return this.strict
	}

	/**
	 * Map one reference to its exported form.
	 * @param prefix path prefix from the *referring* file (`assets/media/` for
	 *   index.html, `media/` for assets/export.css).
	 * @param source where the reference came from, for the report.
	 * @param role `content` for note media, `environment` for CSS-level assets.
	 */
	resolve(
		rawUrl: string,
		prefix: string,
		source = 'html',
		role: AssetRole = 'content'
	): string | null {
		const url = rawUrl.trim()
		if (!url) return null

		const lower = url.toLowerCase()
		if (lower.startsWith('data:')) return url
		if (lower.startsWith('#')) return url

		if (lower.startsWith('blob:')) {
			this.reportMissing(
				url,
				'blob: URL 只存在于当前会话，无法写入静态 HTML',
				source,
				'blob',
				role
			)
			return null
		}

		if (lower.startsWith('http://') || lower.startsWith('https://')) {
			return this.reportRemote(url, source, role)
		}
		if (url.startsWith('//')) {
			return this.reportRemote(`https:${url}`, source, role)
		}

		if (lower.startsWith('app://')) {
			return this.resolveAppUrl(url, prefix, source, role)
		}

		if (lower.startsWith('file:')) {
			this.reportMissing(
				url,
				'file:// 资源位于知识库之外，无法复制',
				source,
				'file',
				role
			)
			return null
		}

		// Root-relative (`/lib/mathjax/…`). Inside an *inline* stylesheet the
		// document base applies, which in Obsidian is the app bundle — never a
		// note asset. Inside a *file-based* sheet the base is that file's
		// origin (`app://<vault-id>/`), so `/x` really is a vault path
		// (review B11).
		if (url.startsWith('/')) {
			const origin = /^app:\/\/([^/]+)\//.exec(source)
			if (origin) {
				return this.resolveAppUrl(`app://${origin[1]}${url}`, prefix, source, role)
			}
			this.reportExternal(
				url,
				'root-relative',
				source,
				'根相对路径，指向应用资源而非知识库文件，不打包'
			)
			return null
		}

		// Anything still relative here should have been absolutised by the CSS
		// collector; if it was not, say so instead of emitting a dead path.
		this.reportMissing(
			url,
			'相对路径没有可用的基准 URL，无法解析',
			source,
			'relative',
			role
		)
		return null
	}

	/**
	 * Classify a remote reference and answer what the caller receives.
	 *
	 * Non-strict (directory export): the URL is kept, and the manifest records
	 * it as `remote` — the file is read online by the vault's owner. Strict
	 * (share): the URL is *not* kept and the reference is recorded as missing,
	 * because a document promised to open with no network must not contain a
	 * display reference that only works with one.
	 */
	private reportRemote(
		absolute: string,
		source: string,
		role: AssetRole
	): string | null {
		this.remote.push(absolute)
		if (role === 'content') this.remoteContent.push(absolute)
		else this.remoteEnvironment.push(absolute)
		if (!this.strict) return absolute

		this.reportMissing(
			absolute,
			'远程资源不会随文件携带，严格自包含模式不抓取第三方内容',
			source,
			'remote',
			role
		)
		return null
	}

	/** Explicitly record a reference we chose not to (or could not) resolve. */
	reportMissing(
		ref: string,
		reason: string,
		source: string,
		kind: MissingKind = 'not-found',
		role: AssetRole = 'content'
	): void {
		this.missing.push({ ref, reason, source, kind, role })
	}

	/** Record a reference that is intentionally not packaged. */
	reportExternal(
		ref: string,
		kind: ExternalRef['kind'],
		source: string,
		note: string
	): void {
		if (this.external.some(e => e.ref === ref && e.source === source)) return
		this.external.push({ ref, kind, source, note })
	}

	/**
	 * Copy every collected asset into `dir`.
	 *
	 * `destination` is the adapter the export root lives on. It defaults to the
	 * vault adapter; the external mode (Task 3) passes a facade rooted at the
	 * folder the user picked. Reads stay on the vault adapter on purpose — the
	 * bytes always come from the vault, only the write side moves.
	 */
	async flush(
		dir: string,
		destination?: Pick<App['vault']['adapter'], 'writeBinary'>
	): Promise<AssetReport> {
		// An inline collector exists to *embed* bytes, not to copy them. Writing
		// here would produce an `assets/media` directory next to a share file that
		// no longer references it — fail loudly instead of creating litter.
		if (this.inline) {
			throw new Error('inline 资源收集器不写盘，请改用 materializeInline()')
		}
		const target = destination ?? this.app.vault.adapter
		/** Recorded only after `writeBinary` resolved — the disk is the judge. */
		const writtenEntries: AssetEntry[] = []
		const failed: AssetFailure[] = []

		for (const entry of this.entries) {
			try {
				const data = await this.app.vault.adapter.readBinary(entry.vaultPath)
				await target.writeBinary(`${dir}/${entry.name}`, data)
				writtenEntries.push(entry)
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error)
				failed.push({
					name: entry.name,
					vaultPath: entry.vaultPath,
					reason,
					role: entry.role
				})
				this.reportMissing(
					entry.vaultPath,
					`复制失败: ${reason}`,
					'assets',
					'copy-failed',
					entry.role
				)
			}
		}

		const contentFailed = failed.filter(f => f.role === 'content').length
		const missing = dedupeMissing(this.missing)
		// Count distinct content references, not report rows: the same image can
		// appear in the HTML pass and in a stylesheet, and a copy failure is also
		// recorded in `missing` (review C1) — so this is a union, not a sum.
		const contentMissing = new Set([
			...failed.filter(f => f.role === 'content').map(f => f.vaultPath),
			...missing.filter(m => m.role === 'content').map(m => m.ref)
		]).size

		return {
			written: writtenEntries.length,
			writtenEntries,
			attempted: this.entries.length,
			failed,
			entries: this.entries,
			missing,
			warnings: Array.from(new Set(this.warnings)),
			remote: Array.from(new Set(this.remote)),
			external: this.external,
			contentFailed,
			contentMissing
		}
	}

	private resolveAppUrl(
		url: string,
		prefix: string,
		source: string,
		role: AssetRole
	): string | null {
		let parsed: URL
		try {
			parsed = new URL(url)
		} catch {
			this.reportMissing(url, 'app:// URL 解析失败', source, 'not-found', role)
			return null
		}

		// `app://obsidian.md/*` is Obsidian's own bundle (app.css, bundled fonts,
		// MathJax). It lives inside app.asar, not in the vault, so it can never
		// be copied — and it is not a note asset. Classify, do not cry "missing".
		if (parsed.host === 'obsidian.md') {
			this.reportExternal(
				url,
				'app-resource',
				source,
				'Obsidian 应用内置资源（app.asar），不在知识库内'
			)
			return null
		}

		let path = ''
		try {
			// `decodeURIComponent` restores spaces / CJK that Obsidian encoded.
			path = decodeURIComponent(parsed.pathname).replace(/^\/+/, '')
		} catch {
			this.reportMissing(url, 'app:// URL 路径无法解码', source, 'not-found', role)
			return null
		}
		if (!path) {
			this.reportMissing(url, 'app:// URL 不含文件路径', source, 'not-found', role)
			return null
		}

		const file = this.fileFromPath(path, url, source, role)
		if (!file) return null
		// Inline mode ignores `prefix` on purpose: the marker is replaced by a
		// `data:` URL, which has no path relative to a referring file.
		const name = this.add(file, role)
		return this.inline ? name : `${prefix}${name}`
	}

	private fileFromPath(
		path: string,
		originalUrl: string,
		source: string,
		role: AssetRole
	): TFile | null {
		// Exact match first — the only path that can never pick the wrong file
		// when two attachments share a basename.
		const direct = this.app.vault.getAbstractFileByPath(path)
		if (direct instanceof TFile) return direct

		// Some builds prefix the path with a vault segment. Accept a suffix
		// match only when exactly one file qualifies — and say that we did.
		if (!this.fileIndex) this.fileIndex = this.app.vault.getFiles()
		const candidates = this.fileIndex.filter(
			f => path === f.path || path.endsWith(`/${f.path}`)
		)
		if (candidates.length === 1) {
			const file = candidates[0] as TFile
			this.warnings.push(
				`使用后缀匹配解析资源（唯一命中）: ${path} -> ${file.path}`
			)
			return file
		}
		if (candidates.length > 1) {
			this.reportMissing(
				originalUrl,
				`存在 ${candidates.length} 个候选文件，拒绝猜测: ` +
					candidates.slice(0, 3).map(f => f.path).join(' | '),
				source,
				'ambiguous',
				role
			)
			return null
		}
		this.reportMissing(
			originalUrl,
			`知识库中找不到路径: ${path}`,
			source,
			'not-found',
			role
		)
		return null
	}

	private add(file: TFile, role: AssetRole): string {
		const existing = this.byVaultPath.get(file.path)
		if (existing) return existing

		const name = this.inline
			? inlineToken(this.entries.length)
			: `${shortHash(file.path)}-${safeName(file.name)}`
		this.byVaultPath.set(file.path, name)
		this.entries.push({ name, vaultPath: file.path, bytes: file.stat.size, role })
		return name
	}

	/**
	 * Read every registered file and return `marker → data:` URL.
	 *
	 * Only meaningful in inline mode. A file that cannot be read is recorded in
	 * `missing` with role `content` (the same rule the on-disk mode applies to a
	 * failed copy), so a share file missing an image is reported as incomplete
	 * rather than published as a clean success.
	 */
	async materializeInline(): Promise<Map<string, string>> {
		if (!this.inline) {
			throw new Error('materializeInline() 只能在 inline 模式下调用')
		}
		const out = new Map<string, string>()
		for (const entry of this.entries) {
			try {
				const data = await this.app.vault.adapter.readBinary(entry.vaultPath)
				out.set(entry.name, toDataUrl(new Uint8Array(data), entry.vaultPath))
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error)
				this.reportMissing(
					entry.vaultPath,
					`读取失败: ${reason}`,
					'assets',
					'copy-failed',
					entry.role
				)
			}
		}
		return out
	}

	/** The files inline mode would embed — reported to the user, never written. */
	get registered(): AssetEntry[] {
		return this.entries
	}
}

/* ------------------------------------------------------------------------- *
 * Single-file mode: bytes → data: URL
 * ------------------------------------------------------------------------- */

const MIME_BY_EXT: Record<string, string> = {
	png: 'image/png',
	apng: 'image/apng',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	jfif: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	avif: 'image/avif',
	bmp: 'image/bmp',
	ico: 'image/x-icon',
	svg: 'image/svg+xml',
	mp4: 'video/mp4',
	webm: 'video/webm',
	ogv: 'video/ogg',
	mp3: 'audio/mpeg',
	wav: 'audio/wav',
	ogg: 'audio/ogg',
	m4a: 'audio/mp4',
	flac: 'audio/flac',
	woff: 'font/woff',
	woff2: 'font/woff2',
	ttf: 'font/ttf',
	otf: 'font/otf',
	pdf: 'application/pdf'
}

/** Extension of a vault path, lowercased, without the dot. */
function extOf(path: string): string {
	const base = path.slice(path.lastIndexOf('/') + 1)
	const dot = base.lastIndexOf('.')
	return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase()
}

/**
 * Base64 without `btoa` and without spreading a large array into `apply`.
 *
 * A 5 MB image passed through `String.fromCharCode(...bytes)` overflows the
 * call stack, and `btoa` needs a binary string. This loops over three bytes at
 * a time — slower per byte, but constant memory.
 */
export function base64Of(bytes: Uint8Array): string {
	const table =
		'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
	let out = ''
	for (let i = 0; i < bytes.length; i += 3) {
		const b0 = bytes[i]
		const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0
		const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0
		out += table[b0 >> 2]
		out += table[((b0 & 0x03) << 4) | (b1 >> 4)]
		out += i + 1 < bytes.length ? table[((b1 & 0x0f) << 2) | (b2 >> 6)] : '='
		out += i + 2 < bytes.length ? table[b2 & 0x3f] : '='
	}
	return out
}

/** Wrap bytes as a `data:` URL, guessing the MIME type from the extension. */
export function toDataUrl(bytes: Uint8Array, path: string): string {
	const ext = extOf(path)
	const mime = MIME_BY_EXT[ext] ?? 'application/octet-stream'
	return `data:${mime};base64,${base64Of(bytes)}`
}

/** Deterministic, dependency-free short hash (FNV-1a 32-bit). */
function shortHash(input: string): string {
	let hash = 0x811c9dc5
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i)
		hash = Math.imul(hash, 0x01000193) >>> 0
	}
	return hash.toString(16).padStart(8, '0')
}

function safeName(name: string): string {
	return name.replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_').slice(-60)
}

function dedupeMissing(items: MissingRef[]): MissingRef[] {
	const seen = new Set<string>()
	const out: MissingRef[] = []
	for (const item of items) {
		const key = `${item.ref}|${item.reason}`
		if (seen.has(key)) continue
		seen.add(key)
		out.push(item)
	}
	return out
}
