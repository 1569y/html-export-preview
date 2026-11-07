/**
 * P2 Task 1 — prove that an internal link points at the *source note* of this
 * export, using the identity Obsidian itself parsed.
 *
 * The regression case is sidenote #54 of the real ReAct note:
 *
 *     <span class="sidenote">前面abstract中有解释 [[示例笔记#ABSTRACT]] </span>
 *
 * In the sandbox the file is `docs/demo-note.md`, so Obsidian reports
 * `示例笔记` as an *unresolved* link (`unresolvedLinks['docs/demo-note.md']
 * === { '示例笔记': 1 }`) while `getFirstLinkpathDest('示例笔记', …)` is
 * `null`. A naive `linkpath === file.basename` check therefore fails, and a
 * naive `getFirstLinkpathDest(...) !== null` check fails too. Worse, assuming
 * every unresolved link is "this note" would misroute genuine cross-note links.
 *
 * So this module never decides by comparing note *names*. It records four
 * verdicts produced by Obsidian's own metadata cache for the exact `TFile`
 * being exported:
 *
 *   1. `path`             — `TFile.path`, the authoritative file identity.
 *   2. `headings`         — `getFileCache(file).headings`, parsed from that file.
 *   3. `selfLinkpaths`    — linkpaths `getFirstLinkpathDest()` resolves back to
 *                           this exact `TFile.path` (verified, not guessed).
 *   4. `foreignLinkpaths` — linkpaths resolved to a *different* `TFile.path`.
 *                           These are always refused: cross-note protection.
 *   5. `unresolvedLinkpaths` — linkpaths Obsidian marks unresolved *from this
 *                           note*, i.e. there is no destination file at all.
 *
 * Only (3) and a frontmatter alias of (1) can make a `link#fragment` link a
 * same-article jump. A link to another existing note is never converted, even
 * when its fragment happens to name a heading here.
 *
 * Note on (5) — the rule that is deliberately **not** here.
 *
 * An earlier revision treated "Obsidian reports this linkpath unresolved from
 * this note" + "the fragment names a heading parsed from this note" as proof of
 * a same-note link. That inference is unsound, and the counter-example is
 * indistinguishable from the case it was written for:
 *
 *     [[示例笔记#ABSTRACT]]            ← meant as this note's own ABSTRACT
 *     [[一个不存在的其他笔记#ABSTRACT]]  ← meant as a different, absent note
 *
 * Both appear in `unresolvedLinks[file.path]`, both resolve to `null`, both
 * carry a fragment equal to a heading of this file. There is no field in the
 * metadata cache that separates them, so any rule accepting the first also
 * accepts the second and silently rewrites a broken cross-note link into a
 * jump inside *this* document. `applyInternalAnchors()` cannot catch that
 * either: the heading really does exist here, so the fabricated anchor resolves.
 *
 * The sound discriminators are the ones Obsidian itself owns — the linkpath
 * resolves back to this `TFile`, or it is an alias declared in this file's
 * frontmatter. A note that is referred to by a name other than its filename
 * should declare that name as an `alias`; Obsidian then resolves it and rule
 * (2) accepts it. Anything else is left inert, which is the safe degradation:
 * the text stays, the jump does not happen, and no wrong target is invented.
 *
 * `unresolvedLinkpaths` is therefore reported for diagnostics only — it never
 * grants a jump. No vault path ever reaches the emitted `#fragment`.
 */

import type { App, TFile } from 'obsidian'

export interface SameNoteIdentity {
	/** `TFile.path` of the captured source note. */
	path: string
	/** Heading text Obsidian parsed from that exact file. */
	headings: string[]
	/** Frontmatter aliases Obsidian parsed from that exact file. */
	aliases: string[]
	/** Linkpaths Obsidian resolves to this exact `TFile.path`. */
	selfLinkpaths: string[]
	/** Linkpaths Obsidian resolves to a different file — never same-note. */
	foreignLinkpaths: string[]
	/** Linkpaths Obsidian reports unresolved from this note. */
	unresolvedLinkpaths: string[]
}

function norm(value: string): string {
	return String(value ?? '')
		.normalize('NFC')
		.trim()
		.replace(/\s+/g, ' ')
		.toLowerCase()
}

function aliasesOf(frontmatter: unknown): string[] {
	if (!frontmatter || typeof frontmatter !== 'object') return []
	const fm = frontmatter as Record<string, unknown>
	const out: string[] = []
	for (const key of ['aliases', 'alias']) {
		const value = fm[key]
		if (typeof value === 'string') out.push(value)
		else if (Array.isArray(value)) {
			for (const item of value) if (typeof item === 'string') out.push(item)
		}
	}
	return out
}

/** Split `link#fragment` / `link#^block-id` into its two parts. */
function splitTarget(target: string): { linkpath: string; fragment: string } | null {
	const raw = String(target ?? '').trim()
	if (raw.startsWith('//')) return null
	const at = raw.indexOf('#')
	if (at < 0) return null
	const linkpath = raw.slice(0, at).trim()
	let fragment = raw.slice(at + 1).trim()
	if (!fragment) return null
	try {
		fragment = decodeURIComponent(fragment)
	} catch {
		// A malformed escape is not a reason to drop the link; use the raw text.
	}
	return { linkpath, fragment }
}

/**
 * Read the identity at capture time, while `app`, `view.file` and the metadata
 * cache are all live. Everything returned is plain data — no `TFile`, no DOM
 * node, no vault-absolute path — so it is safe to hold for the whole session.
 */
export function readSameNoteIdentity(
	app: App,
	file: TFile | null | undefined
): SameNoteIdentity | null {
	if (!file || !app || !app.metadataCache) return null
	const cache = app.metadataCache.getFileCache?.(file)
	// `getFirstLinkpathDest` is typed as always present, but host doubles /
	// older Obsidian builds may not expose it. Read it through an explicitly
	// optional shape so the runtime guard is also type-safe.
	const resolver = app.metadataCache.getFirstLinkpathDest as
		| ((linkpath: string, sourcePath: string) => { path: string } | null)
		| undefined
	const resolve =
		typeof resolver === 'function'
			? (linkpath: string): { path: string } | null =>
					resolver.call(app.metadataCache, linkpath, file.path)
			: null
	const unresolved = (app.metadataCache.unresolvedLinks?.[file.path] ?? {}) as Record<
		string,
		unknown
	>

	const headings = (cache?.headings ?? [])
		.map(h => String(h?.heading ?? ''))
		.filter(Boolean)
	const aliases = aliasesOf(cache?.frontmatter)

	const candidates = new Set<string>()
	const links = [...(cache?.links ?? []), ...(cache?.embeds ?? [])]
	for (const link of links) {
		const linkpath = String(link?.link ?? '').split('#')[0].trim()
		if (linkpath) candidates.add(linkpath)
	}
	// Canonical forms of the current TFile are only trusted after Obsidian's own
	// resolver confirms they lead back to this exact path.
	for (const own of [
		file.basename,
		file.name,
		file.path,
		file.path.replace(/\.md$/i, '')
	]) {
		if (own) candidates.add(own)
	}
	for (const alias of aliases) if (alias) candidates.add(alias)
	for (const key of Object.keys(unresolved)) if (key) candidates.add(key)

	const self = new Set<string>()
	const foreign = new Set<string>()
	const dangling = new Set<string>()
	for (const linkpath of candidates) {
		const dest = resolve ? resolve(linkpath) : null
		if (dest && typeof dest.path === 'string') {
			if (dest.path === file.path) self.add(linkpath)
			else foreign.add(linkpath)
		} else if (resolve && unresolved[linkpath] !== undefined) {
			// Obsidian explicitly recorded this linkpath as unresolved in the
			// source note's own link cache. No other file owns it.
			dangling.add(linkpath)
		}
	}
	// A linkpath resolved to another file is refused even if it also appears in
	// the unresolved map (stale metadata), so remove the overlap.
	for (const linkpath of foreign) dangling.delete(linkpath)

	return {
		path: file.path,
		headings,
		aliases,
		selfLinkpaths: Array.from(self),
		foreignLinkpaths: Array.from(foreign),
		unresolvedLinkpaths: Array.from(dangling)
	}
}

/**
 * Return the in-page fragment when `target` is a link to a heading/block of the
 * captured source note, otherwise `null` (leave it to cross-note handling).
 *
 * `null` identity = the pre-P2 behaviour: only bare `[[#heading]]` links
 * (already handled by `applyInternalAnchors`) are same-article. Unit fixtures
 * and non-Obsidian callers therefore cannot accidentally gain new behaviour.
 */
export function sameNoteFragment(
	target: string,
	identity: SameNoteIdentity | null | undefined
): string | null {
	const parts = splitTarget(target)
	if (!parts) return null
	const { linkpath, fragment } = parts

	// `[[#heading]]` / `[[^block-id]]` — Obsidian's own "current note" syntax.
	if (linkpath === '') return fragment
	if (!identity) return null

	const key = norm(linkpath)
	const hit = (list: string[]): boolean => list.some(item => norm(item) === key)

	// 1) Hard refusal: Obsidian resolved this linkpath to a different file.
	if (hit(identity.foreignLinkpaths)) return null
	// 2) Definitive: Obsidian resolves it back to the source `TFile.path`.
	if (hit(identity.selfLinkpaths)) return fragment
	// 3) Definitive: an alias Obsidian parsed from the source file's frontmatter.
	if (hit(identity.aliases)) return fragment

	// 4) Nothing left. An unresolved linkpath is *not* evidence of a same-note
	//    link: `[[示例笔记#ABSTRACT]]` and `[[一个不存在的其他笔记#ABSTRACT]]`
	//    are indistinguishable in the metadata cache, so accepting either by
	//    "the heading exists here" also accepts the other and fabricates a jump
	//    into this document. Stay inert; the caller keeps the text and adds a
	//    diagnostic.
	return null
}
