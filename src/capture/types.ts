import type { SidenoteLayout } from '../export/sidenote-layout'

/**
 * Shared shapes for the capture pipeline.
 *
 * A snapshot is a *detached* copy of the reading view: the live note DOM is
 * never mutated. Everything the exporter needs to rebuild the page is carried
 * here, including the root-level CSS variables that Side Notes writes onto
 * `<html>` (see capture/root-vars.ts).
 */

export interface RootSnapshot {
	/** `<html class>` — theme class + platform classes. */
	className: string
	/** `<html style>` — the `--sn-*` custom properties Side Notes writes here. */
	style: string
	/** `data-sn-*` attributes on `<html>`. */
	data: Record<string, string>
	/** `<body class>`. */
	bodyClassName: string
	/**
	 * `data-*` attributes on `<body>`.
	 *
	 * P1 visual fidelity: community plugins and CSS snippets frequently gate
	 * their rules on a body attribute rather than a class. Colourful Highlights,
	 * for example, uses `body[data-ch-highlight-style="rounded"]` and
	 * `body:not([data-ch-color-mode="native"])`. Replaying only `body.className`
	 * silently selected the *wrong branch* of those rules in the export, even
	 * though the stylesheet itself had been collected correctly. Optional for
	 * snapshots produced by older builds / test doubles.
	 */
	bodyData?: Record<string, string>
	/** Custom properties Obsidian wrote **inline** on `<body>`.
	 *
	 * `body.className` carries the theme name (`theme-light`), but not the
	 * values Obsidian derives from the user's appearance settings: the accent
	 * colour is applied as `body.style.setProperty('--accent-h' | '--accent-s'
	 * | '--accent-l')` (`setAccentColor` in the app bundle), and `--color-accent`
	 * — hence `--text-accent`, link colour, tag pills, callout tints — reads
	 * `hsl(var(--accent-h) …)`. Dropping this string silently re-exports every
	 * note in the *default* accent while the class list still says the theme is
	 * active, which is exactly the "theme not reproduced" report of round 3.3.3.
	 *
	 * Only `--*` declarations are kept (see `pickCustomProperties`): layout
	 * properties belong to the exporter, not to the snapshot.
	 */
	bodyStyle: string
}

/** A captured container element, reduced to what the exporter must replay. */
export interface ElementSnapshot {
	/** Class list, verbatim (keeps Obsidian's layout hooks). */
	className: string
	/** Inline style, verbatim (keeps `--sidenote-*` custom properties). */
	style: string
	/** `data-*` attributes, verbatim. */
	data: Record<string, string>
}

export interface CaptureStats {
	images: number
	mermaid: number
	mermaidWithSvg: number
	sidenotes: number
	sidenoteLeft: number
	sidenoteRight: number
	marginNotes: number
	stylesheets: number
	bytesOfContent: number
	/** Content blocks (p, li, h1-h6, blockquote, pre, table) — emptiness check. */
	blocks: number
	/** Rendered math nodes — decides whether missing MathJax fonts matter. */
	math: number
}

/** Why a `.markdown-preview-sizer` candidate was accepted or rejected. */
export interface SizerCandidateInfo {
	index: number
	className: string
	parentClassName: string
	/** 3 = direct child of `.markdown-preview-view`, 2 = descendant, 1 = other. */
	structuralRank: number
	/** Non-null when the candidate can never be the real body. */
	excluded: string | null
	blocks: number
	media: number
	mermaid: number
	sidenotes: number
	math: number
	textLength: number
	width: number
	height: number
	/** Deterministic content weight, used only as a tie-breaker. */
	weight: number
	selected: boolean
}

/**
 * The resolver's verdict. Capture, audit and the manifest all read from this
 * one object, so they can never disagree about which element is the body
 * (review round 2, S1).
 */
export interface SizerResolution {
	/** Chosen element, or null when the view could not be resolved. */
	sizer: HTMLElement | null
	readingRoot: HTMLElement | null
	previewRoot: HTMLElement | null
	candidates: SizerCandidateInfo[]
	/** Human-readable justification for the choice. */
	reason: string
	ambiguity: boolean
	/** Machine-readable failure code, when resolution failed. */
	error: 'no-candidate' | 'empty' | 'ambiguous' | null
}

/** Layout facts about `.markdown-preview-view` that the export must preserve. */
export interface PreviewMetrics {
	width: number
	paddingLeft: number
	paddingRight: number
	/** `.markdown-preview-view.is-readable-line-width` present. */
	readableLineWidth: boolean
	/** Resolved `--file-line-width`, when the theme defines one. */
	fileLineWidth: string | null
}

/**
 * Where the exported body came from.
 *
 * `reading-view` — the mounted reading view was already the whole note.
 * `offscreen-render` — the view was virtualised, so the note was rendered in
 * full off-screen at the same width (P0). The manifest records which one, so a
 * later "why does this export look slightly different" question has an answer.
 */
export type CaptureSource = 'reading-view' | 'offscreen-render'

export interface CaptureSnapshot {
	notePath: string
	noteTitle: string
	capturedAt: string
	/** Width the browser laid the reading view out at — every sidenote offset
	 *  was computed against this. The export container must match it. */
	captureWidth: number
	root: RootSnapshot
	/** `.markdown-reading-view` — positioning root for the sidenote CSS. */
	reading: ElementSnapshot
	/** `.markdown-preview-view` — scroll container; replayed for fidelity. */
	preview: ElementSnapshot
	/** How the body container was identified (candidates, exclusions, reason). */
	resolution: SizerResolution
	/** Width / padding / readable-line-width facts, for fidelity checks. */
	previewMetrics: PreviewMetrics
	/** Which path produced `sizer` (see `CaptureSource`). */
	captureSource: CaptureSource
	/**
	 * P1: how the inline `<span class="sidenote">` notes were turned into margin
	 * blocks, and how much horizontal room the page must reserve for them.
	 *
	 * Optional so older snapshots (and the unit fixtures) still build: absent
	 * means "no margin column", i.e. the pre-P1 geometry.
	 */
	sidenotes?: SidenoteLayout
	/**
	 * The cloned `.markdown-preview-sizer` **element itself** — not its children,
	 * and not a placeholder for a wrapper the exporter should create. The
	 * exporter inserts this element as-is and must NOT add another
	 * `.markdown-preview-sizer` around it (review round 1, finding R1).
	 */
	sizer: HTMLElement
	stats: CaptureStats
	warnings: string[]
}
