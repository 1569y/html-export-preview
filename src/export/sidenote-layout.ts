/**
 * P1 — put the Side Notes back into the margin of the exported page.
 *
 * The problem this closes: a long note is captured through an off-screen
 * `MarkdownRenderer.render`, where the Side Notes plugin does not run. Obsidian's
 * own inline-footnote markup survives — `<span class="sidenote">正文</span>` — so
 * the text is all there, but nothing wraps it and nothing positions it: the
 * export shows 75 notes *inside their sentences*. The live reading view, at a
 * width where the plugin has room, instead produces
 *
 *   <span class="sidenote-number" data-sidenote-num="34">
 *     <span class="sidenote">正文</span>        ← clipped to 0 × 0, text kept
 *     <small class="sidenote-margin" …>正文</small>
 *   </span>
 *
 * with the margin block `position: absolute` and a per-note `--sidenote-line-offset`
 * measured by the plugin in the *app* pane. Those offsets are meaningless in a
 * static page — the page has a different width, and nothing re-measures on
 * resize — so this module rebuilds the *structure* but deliberately throws the
 * *geometry* away, and the exported CSS lays the notes out with right floats
 * instead (see `sidenoteCss` in ../export/exporter.ts).
 *
 * Why floats rather than absolute offsets:
 *  - `clear: right` makes consecutive notes stack instead of overlapping, which
 *    is the one thing a static page cannot fix later (the app solves it with JS
 *    on every layout change; an exported file has no such loop).
 *  - A float is placed at the line where it appears in the flow, so it stays
 *    attached to its anchor without any measurement.
 *  - Nothing depends on the viewport, so zooming or resizing cannot make two
 *    notes collide; the page has a fixed width and simply scrolls.
 *
 * Nothing here touches the note or the plugin: it operates on the *detached
 * clone* that is about to be serialised, and it never deletes text — the inline
 * copy stays in the DOM (the CSS clips it, exactly like the plugin does) and the
 * margin copy carries the same nodes.
 */

/** Width of the margin column, in CSS px. */
export const SIDENOTE_WIDTH = 240

/** Gap between the text column and the margin column. */
export const SIDENOTE_GAP = 40

/**
 * Horizontal space the export must add to fit the margin column.
 *
 * The page keeps the text at the width it was captured at and grows by this
 * much on the right, so the note re-wraps exactly like the reading view did
 * while the notes get a column of their own.
 */
export const SIDENOTE_ROOM = SIDENOTE_WIDTH + SIDENOTE_GAP

/**
 * Below this viewport width the margin column is dropped and the notes go back
 * inline: a text column narrower than this is not worth reading, and two
 * columns would have to overlap to fit.
 */
export const SIDENOTE_INLINE_BELOW = 620

export interface SidenoteLayout {
	/** Notes rendered as margin blocks. */
	margin: number
	/** Notes left inline because a margin cannot be attached to them. */
	inline: number
	/** Of `margin`: pairs the plugin had already built (live capture path). */
	reused: number
	/** Horizontal space added to the page, in CSS px (0 when inactive). */
	room: number
}

const EMPTY: SidenoteLayout = { margin: 0, inline: 0, reused: 0, room: 0 }

/**
 * Rebuild the `<span class="sidenote-number"><span class="sidenote">…</span>
 * <small class="sidenote-margin">…</small></span>` pair for every inline note.
 *
 * Returns what it did, so the manifest can state it instead of assuming it.
 */
export function layOutSidenotes(root: HTMLElement): SidenoteLayout {
	const doc = root.ownerDocument ?? (typeof document === 'undefined' ? null : document)
	if (!doc) return EMPTY

	const spans = Array.from(root.querySelectorAll<HTMLElement>('span.sidenote'))
	if (spans.length === 0) return EMPTY

	let number = 0
	let promoted = 0
	let reused = 0
	let inline = 0

	for (const span of spans) {
		const holder = span.closest('.sidenote-number')
		const existing = holder?.querySelector('small.sidenote-margin') ?? null

		if (holder && existing) {
			// Live capture: the plugin already built the pair, and measured the
			// margin against the app's pane. Keep the structure, drop the
			// measurements — `style` on these two nodes is only geometry
			// (`--sidenote-line-offset`, `--sidenote-shift`, `--sidenote-offset*`),
			// none of which describes the page we are writing.
			holder.removeAttribute('style')
			existing.removeAttribute('style')
			number++
			holder.setAttribute('data-sidenote-num', String(number))
			existing.setAttribute('data-sidenote-num', String(number))
			reused++
			continue
		}

		// A note anchored in a table cell cannot have a margin column: the cell
		// has no room to the right, and a float there would either squeeze the
		// neighbouring column or be clipped. Leave it inline — visible, in the
		// cell, which is what the reading view shows for a narrow pane anyway.
		if (span.closest('table')) {
			inline++
			continue
		}

		number++
		promoted++
		wrap(doc, span, number)
	}

	const margin = promoted + reused
	return {
		margin,
		inline,
		reused,
		room: margin > 0 ? SIDENOTE_ROOM : 0
	}
}

/** Build the holder + margin pair around one inline note. */
function wrap(doc: Document, span: HTMLElement, number: number): void {
	const parent = span.parentElement
	if (!parent) return

	const holder = doc.createElement('span')
	holder.className = 'sidenote-number'
	holder.setAttribute('data-sidenote-num', String(number))

	const margin = doc.createElement('small')
	margin.className = 'sidenote-margin'
	margin.setAttribute('data-sidenote-num', String(number))
	// Clone the span once, then move its children into the margin: cloning the
	// span keeps text nodes and nested inline markup together, and moving (not
	// re-cloning) keeps mixed content order intact.
	const copy = span.cloneNode(true) as HTMLElement
	for (const child of Array.from(copy.childNodes)) margin.appendChild(child)

	parent.insertBefore(holder, span)
	span.remove()
	holder.appendChild(span)
	holder.appendChild(margin)
}

/** One-line summary for the manifest / notices. */
export function describeSidenotes(layout: SidenoteLayout): string {
	if (layout.margin === 0 && layout.inline === 0) return '侧注：无'
	const parts = [`侧注：${layout.margin} 条排入右侧批注栏`]
	if (layout.reused > 0) parts.push(`其中 ${layout.reused} 条沿用应用中已生成的配对`)
	if (layout.inline > 0) parts.push(`${layout.inline} 条位于表格内，保留行内`)
	return parts.join('，')
}
