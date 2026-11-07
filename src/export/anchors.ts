/**
 * Same-article internal anchor jumping (Task 3).
 *
 * Scope — deliberately narrow: only links that point *within the current note*.
 * Cross-note links (`[[other-note#heading]]`, whose target does not start with
 * `#`) are left to the existing share-sanitisation pass and are never turned
 * into in-page jumps here. External `https:` links keep their original behaviour.
 *
 * What this does, in `buildHtml` (so the preview iframe *and* every exported
 * file get identical anchors):
 *
 *   1. Assign a stable, unique `id` to every heading and to every block that
 *      carries a block id (`#^block-id`). The id is derived from the visible
 *      text / block id, kept Unicode-safe (CJK survives), and disambiguated on
 *      collision (`-2`, `-3`, …) so no two elements in one document share an id.
 *   2. Rewrite in-page links —
 *        `[[#heading]]`, `[[#heading|alias]]`, `[text](#heading)`,
 *        `[[#^block-id]]` — to point at the generated `id`.
 *   3. A link whose target cannot be found in *this* document is made inert:
 *      its text stays, its `href` is removed, and a diagnostic `title` /
 *      `data-he-unresolved-anchor` is added. No dangling fake link is emitted.
 *   4. Resolved links lose Obsidian's `target="_blank"` / `rel`, otherwise a
 *      saved file opens a new tab instead of scrolling to the heading. Only
 *      the preview iframe has a click handler that could mask this.
 *
 * Why not just re-use Obsidian's own `id`s? They are not guaranteed stable, not
 * guaranteed present for every heading, and the source `[[#…]]` fragment is a
 * *heading string*, not a DOM id — so we build our own mapping from the rendered
 * structure and never depend on the original Vault path or Obsidian internals.
 */

/** Keep Unicode letters/numbers (incl. CJK), turn everything else into `-`. */
function slugBase(text: string): string {
	const norm = String(text ?? '').normalize('NFC').trim()
	let out = ''
	for (const ch of norm) {
		// \p{L} = any letter (incl. Chinese), \p{N} = any number. The `u` flag
		// makes the Unicode property escapes work; the `try` is a guard for very
		// old engines that would throw on the property class.
		let isWord = false
		try {
			isWord = /\p{L}|\p{N}/u.test(ch)
		} catch {
			isWord = /[A-Za-z0-9]/.test(ch)
		}
		out += isWord ? ch : '-'
	}
	return out.replace(/-+/g, '-').replace(/^-+|-+$/g, '')
}

function decodeFragment(fragment: string): string {
	// Obsidian may store the link target percent-encoded; the heading text we read
	// from the DOM is never encoded. Decode defensively so the two sides match.
	try {
		const decoded = decodeURIComponent(fragment)
		return decoded
	} catch {
		return fragment
	}
}

export interface AnchorResult {
	/** Number of in-page links that were successfully pointed at a target. */
	resolved: number
	/** Number of links left inert because their target is absent from this note. */
	unresolved: number
	/** Every id that was assigned, for diagnostics / tests. */
	ids: string[]
}

/**
 * Mutate `root` in place: assign anchor ids and rewrite same-article links.
 * Returns a small summary so callers / tests can assert behaviour.
 */
export function applyInternalAnchors(root: HTMLElement): AnchorResult {
	// Defensive: some callers (offline unit-test mocks, a Node host without a DOM
	// implementation) hand `buildHtml` a sizer whose `cloneNode()` returns a plain
	// object with no `querySelectorAll`. There is nothing to anchor in that
	// context and the export is serialised from a string anyway, so a no-op is
	// the correct behaviour and keeps the offline suite green. Real captures
	// (browser / Obsidian) always pass a genuine DOM element.
	const maybeRoot = root as unknown as { querySelectorAll?: unknown }
	if (typeof maybeRoot.querySelectorAll !== 'function') {
		return { resolved: 0, unresolved: 0, ids: [] }
	}
	const used = new Set<string>()
	const headingMap = new Map<string, string[]>() // slug -> ids (first wins for duplicates)
	const blockMap = new Map<string, string>() // blockId -> id

	const uniqueId = (base: string): string => {
		const clean = base || 'section'
		let id = clean
		let n = 2
		while (used.has(id)) id = `${clean}-${n++}`
		used.add(id)
		return id
	}

	// Pass 1 — headings.
	root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6').forEach(h => {
		const slug = slugBase(h.textContent ?? '')
		const id = uniqueId(slug)
		h.setAttribute('id', id)
		const list = headingMap.get(slug) ?? []
		list.push(id)
		headingMap.set(slug, list)
	})

	// Pass 2 — block ids. Two render forms Obsidian uses:
	//   `<el data-block-id="abc123">`  and  `<el id="^abc123">`.
	root.querySelectorAll<HTMLElement>('[data-block-id]').forEach(el => {
		const bid = (el.getAttribute('data-block-id') ?? '').trim()
		if (!bid || blockMap.has(bid)) return
		const id = uniqueId(slugBase(bid) || `block-${bid}`)
		el.setAttribute('id', id)
		blockMap.set(bid, id)
	})
	root.querySelectorAll<HTMLElement>('[id^="^"]').forEach(el => {
		const raw = el.getAttribute('id') ?? ''
		const bid = raw.replace(/^\^/, '').trim()
		if (!bid || blockMap.has(bid)) return
		const id = uniqueId(slugBase(bid) || `block-${bid}`)
		el.setAttribute('id', id)
		blockMap.set(bid, id)
	})

	// Pass 3 — rewrite links.
	let resolved = 0
	let unresolved = 0
	const links = root.querySelectorAll<HTMLAnchorElement>(
		'a[href^="#"], a[data-href^="#"]'
	)
	links.forEach(a => {
		const raw = (
			a.getAttribute('data-href') ||
			a.getAttribute('href') ||
			''
		).trim()
		if (!raw.startsWith('#')) return
		const fragment = decodeFragment(raw.slice(1))
		if (fragment === '') return

		let targetId: string | undefined
		let label = '章节'
		if (fragment.startsWith('^')) {
			label = '块'
			targetId = blockMap.get(fragment.slice(1))
		} else {
			targetId = headingMap.get(slugBase(fragment))?.[0]
		}

		if (targetId) {
			a.setAttribute('href', `#${targetId}`)
			a.setAttribute('data-href', `#${targetId}`)
			// Obsidian renders *every* internal link with target="_blank" and
			// rel="noopener". The preview masks that with a delegated click
			// handler (preventDefault + scroll), but a saved HTML file has no
			// such handler: clicking a same-note link would open a new tab
			// instead of scrolling this document. Strip the navigation hints so
			// the native `href="#id"` fragment jump works offline in both the
			// single-file share and the full package.
			a.removeAttribute('target')
			a.removeAttribute('rel')
			a.removeAttribute('download')
			a.removeAttribute('data-he-unresolved')
			a.removeAttribute('data-he-unresolved-anchor')
			a.removeAttribute('aria-disabled')
			resolved++
		} else {
			// Missing target: keep the readable text, drop the dead jump, diagnose.
			a.removeAttribute('href')
			a.removeAttribute('data-href')
			a.removeAttribute('target')
			a.removeAttribute('rel')
			a.setAttribute('data-he-unresolved-anchor', '1')
			a.setAttribute('aria-disabled', 'true')
			if (!a.getAttribute('title')) {
				a.setAttribute('title', `本篇未找到对应${label}：${fragment}`)
			}
			unresolved++
		}
	})

	return { resolved, unresolved, ids: Array.from(used) }
}
