/**
 * P2 Task 2 — stable identity for every *selectable* media block.
 *
 * Per-element layout settings have to survive a preview refresh, and they must
 * never land on the wrong picture when the note changed in between. A DOM index
 * (`querySelectorAll(...)[3]`) fails both: inserting one image shifts every
 * later index, so an override meant for image B silently moves to image C.
 *
 * So every block gets `data-he-media-id`, derived from what the block *is*:
 *
 *   image    — the normalised resource reference + `alt`
 *   mermaid  — diagram type + `viewBox` + visible words + path geometry
 *   table    — row count + header/first-row text (never cell edits)
 *
 * Tables carry a `t…` id and pictures / diagrams an `m…` id. The prefix is
 * part of the public shape because `layout-css.ts` must generate *different*
 * rules: a table must keep `display: table` (headers, colspan/rowspan, borders
 * and theme styling all depend on it), while a picture block needs
 * `display: block` and an inner `img/svg` that fills it.
 *
 * The Mermaid key deliberately excludes the renderer's own output (the SVG
 * `<style>` block carries a new random id on every render), because a key that
 * changes per capture would drop the user's per-diagram width on refresh.
 *
 * and only the *duplicate counter within that same key* disambiguates two
 * identical pictures. Inserting a different image before them therefore leaves
 * their ids unchanged; replacing a picture changes its id, so the old override
 * stops applying instead of jumping to another element.
 *
 * The id is a 32-bit FNV-1a hash in base 36 — a short opaque token. No vault
 * path, note name or file name is emitted, because the id travels into the
 * final single-file HTML and the shared package.
 *
 * Selection is deliberately narrower than "every `<img>`":
 *   - `.image-embed:not(.inline)` is the block wrapper Obsidian renders for
 *     `![[pic.png]]` / `![](pic.png)`. The wrapper is what alignment and width
 *     must move, not the inner `<img>`.
 *   - a bare `<img>` that is the only content of a block container is accepted
 *     too (external image syntax renders without a wrapper in some themes).
 *   - inline images, sidenote content, the Side Notes measuring probe and the
 *     Mermaid hover toolbar are excluded — they are not content blocks.
 *   - `.mermaid` without an `<svg>` is not selectable: there is nothing to size.
 *   - only *outermost* tables get an id. A `<table>` nested inside another
 *     table is not independently selectable: clicking it would otherwise be
 *     ambiguous (the outer table is also an ancestor with an id), and applying
 *     an outer table's width to a nested one is never what the user asked for.
 */

const BLOCK_PARENTS = new Set(['P', 'DIV', 'LI', 'FIGURE', 'SECTION', 'TD'])
const EXCLUDED_ANCESTORS = '.sidenote-margin, .sidenote, .inline'

export interface MediaIdReport {
	images: number
	mermaid: number
	tables: number
	ids: string[]
}

/** 32-bit FNV-1a, base 36. Deterministic across sessions and hosts. */
function hashKey(value: string): string {
	let hash = 0x811c9dc5
	for (let i = 0; i < value.length; i++) {
		hash ^= value.charCodeAt(i)
		hash = Math.imul(hash, 0x01000193)
	}
	return (hash >>> 0).toString(36)
}

/** Resource reference without query/hash and without the vault origin. */
function imageKey(img: Element): string {
	const src = (img.getAttribute('data-src') || img.getAttribute('src') || '').trim()
	const normalised = src
		.replace(/[?#].*$/, '')
		.replace(/^app:\/\/[^/]+\//i, '')
		.replace(/^file:\/\/\/?/i, '')
	const alt = (img.getAttribute('alt') || '').trim()
	return `${normalised}|${alt}`.slice(0, 320)
}

/**
 * What the diagram says, plus its geometry — and nothing the renderer invents.
 *
 * Mermaid writes a `<style>` block into every SVG whose selectors are keyed by a
 * **freshly generated id per render** (`#m2ad4a3d062ce6f65 { … }` vs
 * `#m44fa3caeec0d2558 { … }` for the same diagram). Hashing `textContent`
 * therefore produced a different id on every capture, and a refresh silently
 * dropped the per-diagram width the user had just set (measured:
 * `m12o09id-0` → `meazdkf-0`, width back to 100%). The parts that *are* stable
 * across renders are the coordinate box, the visible words and the path
 * geometry, so the key is built from exactly those.
 *
 * Labels live in `<text>` for some diagram types and in `<foreignObject>` HTML
 * for others (flowcharts with `htmlLabels`), so both are collected; the `<text>`
 * query already includes its `<tspan>` children and is not repeated.
 */
function mermaidKey(svg: Element): string {
	const kind = svg.getAttribute('aria-roledescription') ?? svg.getAttribute('class') ?? ''
	const box = svg.getAttribute('viewBox') ?? ''
	const words = Array.from(svg.querySelectorAll('text, foreignObject'))
		.map(node => node.textContent ?? '')
		.join('\u0001')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 240)
	// Geometry is what separates two diagrams that happen to say the same thing.
	// Hashing it keeps the key short without letting a renamed node change it.
	const geometry = Array.from(svg.querySelectorAll('path'))
		.map(path => path.getAttribute('d') ?? '')
		.join('')
	return `${kind}|${box}|${words}|${hashKey(geometry)}`
}

/**
 * Identity of a table, without keying on its body cells.
 *
 * A per-table width must survive editing a number or a word inside a cell, so
 * only the *shape* (row / column count), the header row and the first data row
 * are hashed. Editing any other cell leaves the id alone; adding / removing a
 * row, a column or rewriting the header changes it, which is the same "the
 * block is no longer the same block" rule pictures use. Two identical tables
 * are still separated by the duplicate counter in `put()`.
 *
 * Column count is taken from the widest row so a `colspan` header does not make
 * two structurally different tables look identical, and cell text is sliced
 * so a pathological table cannot produce an unbounded key.
 */
function tableKey(table: Element): string {
	const rows = Array.from(table.querySelectorAll('tr'))
	const cells = (row: Element): string[] =>
		Array.from(row.querySelectorAll('td, th')).map(cell =>
			(cell.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)
		)
	const header = rows[0] ? cells(rows[0]).join('\u0002') : ''
	const firstBody = rows[1] ? cells(rows[1]).join('\u0002') : ''
	const columns = rows.reduce((max, row) => Math.max(max, cells(row).length), 0)
	return `${rows.length}|${columns}|${header}|${firstBody}`.slice(0, 320)
}

function isExcluded(el: Element): boolean {
	return typeof el.closest === 'function' && !!el.closest(EXCLUDED_ANCESTORS)
}

/** A bare `<img>` that owns its paragraph, rather than flowing inside text. */
function isStandaloneImage(img: Element): boolean {
	const parent = img.parentElement
	if (!parent || !BLOCK_PARENTS.has(parent.tagName)) return false
	const images = parent.querySelectorAll('img')
	return images.length === 1
}

/**
 * Mutate `root` in place, assigning `data-he-media-id` to every selectable
 * block. Safe to call on a detached clone; returns counts for diagnostics.
 */
export function assignMediaIds(root: HTMLElement): MediaIdReport {
	const maybe = root as unknown as { querySelectorAll?: unknown }
	if (typeof maybe.querySelectorAll !== 'function') {
		return { images: 0, mermaid: 0, tables: 0, ids: [] }
	}

	const counters = new Map<string, number>()
	const ids: string[] = []
	let images = 0
	let mermaid = 0
	let tables = 0

	const put = (el: Element, kind: 'image' | 'mermaid' | 'table', key: string): void => {
		const base = `${kind}|${key}`
		const seen = counters.get(base) ?? 0
		counters.set(base, seen + 1)
		// `t…` marks a table. The prefix is part of the emitted shape: both
		// `layout-settings.ts` (id validation) and `layout-css.ts` (which rule
		// set to emit) and `preview-view.ts` (which panel to show) read it.
		const id = `${kind === 'table' ? 't' : 'm'}${hashKey(base)}-${seen}`
		el.setAttribute('data-he-media-id', id)
		if (kind === 'table') el.setAttribute('data-he-media-kind', 'table')
		ids.push(id)
	}

	// 1) Block image wrappers.
	root.querySelectorAll<HTMLElement>('.image-embed').forEach(block => {
		if (block.classList.contains('inline') || isExcluded(block)) return
		const img = block.querySelector('img')
		if (!img) return
		put(block, 'image', imageKey(img))
		images++
	})

	// 2) Bare block images (no wrapper).
	root.querySelectorAll<HTMLElement>('img').forEach(img => {
		if (isExcluded(img)) return
		// A wrapper already claimed this picture; the wrapper is the block.
		if (typeof img.closest === 'function' && img.closest('.image-embed')) return
		if (!isStandaloneImage(img)) return
		put(img, 'image', imageKey(img))
		images++
	})

	// 3) Mermaid containers with a rendered SVG.
	root.querySelectorAll<HTMLElement>('.mermaid').forEach(box => {
		if (isExcluded(box)) return
		const svg = box.querySelector('svg')
		if (!svg) return
		put(box, 'mermaid', mermaidKey(svg))
		mermaid++
	})

	// 4) Outermost tables. `closest('table')` starting from the parent (not
	// from the element itself, which would always match) detects nesting
	// without needing `Node.contains` — the offline DOM double has no such
	// method, and a nested table outside the sizer is not a content block.
	root.querySelectorAll<HTMLElement>('table').forEach(table => {
		if (isExcluded(table)) return
		const parent = table.parentElement
		if (parent && typeof parent.closest === 'function' && parent.closest('table')) return
		put(table, 'table', tableKey(table))
		tables++
	})

	return { images, mermaid, tables, ids }
}
