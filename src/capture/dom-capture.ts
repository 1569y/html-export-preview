import type { App, TFile } from 'obsidian'
import { Component, MarkdownRenderer, MarkdownView } from 'obsidian'
import { cloneContent } from './dom-clone'
import { readSameNoteIdentity } from './link-identity'
import {
	buildBaseline,
	checkCompleteness,
	describeCompleteness
} from './note-baseline'
import type { NoteBaseline } from './note-baseline'
import { snapshotRoot } from './root-vars'
import { describeSidenotes, layOutSidenotes } from '../export/sidenote-layout'
import {
	CaptureError,
	assertResolved,
	contentMetrics,
	readPreviewMetrics,
	resolveSizer,
	summarizeResolution
} from './dom-resolver'
import type { CaptureSnapshot, ElementSnapshot } from './types'
import type { Metrics } from './dom-resolver'

const SETTLE_TIMEOUT_MS = 3000
const QUIET_AFTER_FRAMES_MS = 250

/**
 * SC-01: budget for the reading view to re-render after being parked at the
 * top. Deliberately shorter than `SETTLE_TIMEOUT_MS`: this wait is the *gate*
 * (a timeout here fails the export), so it must not be so long that a stuck
 * view hangs the command, and not so short that a wide note is judged unstable.
 */
const TOP_SETTLE_TIMEOUT_MS = 2000
const TOP_SETTLE_SAMPLE_MS = 80
/** Consecutive identical samples required to call the re-render finished. */
const TOP_SETTLE_STABLE_SAMPLES = 4

/**
 * P1: budget for the virtualiser to re-mount the blocks around the reader's
 * old position after the capture parked the view at the top. Each retry costs
 * ~85 ms (one frame + one short delay), so this is roughly 25 attempts.
 */
const RESTORE_TIMEOUT_MS = 2500

const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6'

/**
 * Capture the reading view exactly as it is on screen.
 *
 * Order matters: fonts change line heights, images change block heights, and
 * Side Notes measures line offsets after both settle. Capturing too early
 * produces sidenotes that are a few pixels off — or worse, stacked against
 * stale measurements.
 *
 * The body container is chosen by `dom-resolver.ts`, never by a bare
 * `querySelector`. Review round 2 (S1): a plugin-injected decoy carrying the
 * same class sat before the real body, and the first-match query captured it.
 */
export async function captureReadingView(
	app: App,
	target?: MarkdownView | null
): Promise<CaptureSnapshot> {
	const view = target ?? app.workspace.getActiveViewOfType(MarkdownView)
	if (!view) throw new CaptureError('没有活动的 Markdown 视图。请先打开一篇笔记。', 'no-view')
	if (view.getMode() !== 'preview') {
		throw new CaptureError('当前不是阅读视图。请先切换到阅读视图再执行。', 'not-reading')
	}

	const readingRoot = view.containerEl.querySelector<HTMLElement>(
		'.markdown-reading-view'
	)
	if (!readingRoot) {
		throw new CaptureError('找不到 .markdown-reading-view 容器。', 'no-view')
	}

	// One resolver call decides the body for capture, audit and manifest alike.
	const resolution = resolveSizer(readingRoot)
	assertResolved(resolution)

	const sizer = resolution.sizer
	const previewRoot = resolution.previewRoot

	const warnings: string[] = []

	// SC-01 — the reading view is virtualised: Obsidian keeps only the blocks
	// near the viewport mounted, so capturing while scrolled down silently drops
	// the top of the note. Measured on DOC-01 (10 headings in the source), the
	// live DOM held 10 / 8 / 5 headings at top / 950px / bottom; the export then
	// faithfully cloned whatever was mounted, and every gate stayed green because
	// they compared the live DOM against its own copy.
	//
	// So: remember the reader's position, park at the top, wait for the re-render,
	// capture, then put them back — always, in `finally`.
	const scroll = captureScrollTarget(previewRoot, readingRoot)
	let snapshot: CaptureSnapshot | null = null
	let offscreen: OffscreenRender | null = null

	try {
		await parkAtTop(scroll, sizer, warnings)

		// Fonts and media are settled *after* parking: the top of the note has
		// just been re-mounted, and those are the nodes whose line heights and
		// image heights the export is about to measure.
		await settle(sizer, warnings)

		const file = view.file
		const captureWidth = Math.round(
			readingRoot.getBoundingClientRect().width || readingRoot.clientWidth
		)

		// P0 — completeness is measured against the *note*, never against the view.
		//
		// Measured on a 2,699-line note (271 headings, 85,190px tall), the reading
		// view mounted 22–32 blocks / ~1,400 characters at every scroll position,
		// `scrollTop = 0` included: Obsidian mounts the blocks near the viewport
		// and reserves height for the rest. Parking at the top therefore does not
		// make the DOM whole — it only decides *which* slice is mounted. The
		// baseline below is what turns that into a visible, falsifiable number.
		const baseline = await readBaseline(app, file)

		const liveReport = checkCompleteness(baseline, sizer)
		let body = sizer
		let captureSource: CaptureSnapshot['captureSource'] = 'reading-view'

		if (!liveReport.ok) {
			warnings.push(
				`阅读视图只挂载了部分正文（标题 ${liveReport.headingMatched}/${liveReport.headingExpected}、` +
					`正文 ${(liveReport.coverage * 100).toFixed(1)}%），改用整篇渲染捕获`
			)
			offscreen = await renderWholeNote(
				app,
				view,
				sizer,
				previewRoot,
				readingRoot,
				captureWidth,
				warnings
			)
			body = offscreen.sizer
			captureSource = 'offscreen-render'
		}

		// The gate that is allowed to fail the export: whatever body we ended up
		// with must contain every heading and every substantive line of the note.
		const report = checkCompleteness(baseline, body)
		if (!report.ok) {
			throw new CaptureError(
				`导出正文不完整，已停止（未写入任何文件）。\n` +
					`标题 ${report.headingMatched}/${report.headingExpected}，` +
					`正文 ${(report.coverage * 100).toFixed(1)}%（顺序 ${(report.orderRatio * 100).toFixed(1)}%）。\n` +
					(report.missingSamples.length > 0
					? `缺失示例：\n${report.missingSamples.slice(0, 5).join('\n')}\n`
					: '') +
				(report.notes.length > 0 ? `${report.notes.join('\n')}\n` : '') +
					'这通常意味着笔记的一部分没能渲染出来，请反馈该笔记的结构特征。',
				'incomplete'
			)
		}
		warnings.push(describeCompleteness(report))

		// P2 Task 1: resolve the *source file identity* while the Obsidian
		// metadata cache is live. The clone pass needs it to tell a same-note
		// heading link from a cross-note link; after capture there is no `app`
		// context to ask again, and the exported HTML must not carry any of it.
		const sameNote = readSameNoteIdentity(app, file)
		const { content: sizerClone, warnings: cloneWarnings } = cloneContent(
			body,
			sameNote
		)
		warnings.push(...cloneWarnings)

		// EI-01: the clone is a deep copy of the captured body, so it must hold
		// exactly the same number of content nodes. Anything less means the copy
		// silently lost part of the note.
		warnings.push(assertContentComplete(body, sizerClone))

		const live = contentMetrics(body)
		// Measured on the clone, never on the live node (review B3). Mixing the two
		// let a clone that lost its content pass the gate on the live block count,
		// and `innerHTML.length > 0` let a whitespace-only body through.
		//
		// A detached clone always measures 0×0 (review C5): `width`/`height` in
		// these metrics must never be used as a content signal.
		const copy = contentMetrics(sizerClone)

		const stats = {
			images: body.querySelectorAll('img').length,
			mermaid: body.querySelectorAll('.mermaid').length,
			mermaidWithSvg: body.querySelectorAll('.mermaid svg').length,
			sidenotes: body.querySelectorAll('small.sidenote-margin').length,
			sidenoteLeft: countSidenotes(body, 'left'),
			sidenoteRight: countSidenotes(body, 'right'),
			marginNotes: body.querySelectorAll('.sidenote-number.margin-note').length,
			stylesheets: document.styleSheets.length,
			bytesOfContent: sizerClone.innerHTML.length,
			blocks: live.blocks,
			math: live.math
		}

		// Second gate, after the clone: the *copy* must carry content too. A resolver
		// that picked correctly but cloned nothing would otherwise slip through.
		if (!hasRenderableContent(copy)) {
			throw new CaptureError(
				'抓取到的正文为空：容器已定位，但克隆结果没有任何内容。\n' +
					resolution.reason,
				'empty',
				resolution
			)
		}

		const previewMetrics = readPreviewMetrics(previewRoot, readingRoot)

		warnings.push(...describeResolution(resolution))

		// P1 — rebuild the Side Notes structure on the *clone*, after the
		// completeness gate and every node-count check have passed: this step
		// duplicates each note's text into a margin block, and a gate that ran
		// afterwards would be counting our own additions. The off-screen render
		// never runs the plugin, so without this the notes stay inside their
		// sentences; the live path already has the pairs and is only re-measured
		// for the export's own width.
		const sidenotes = layOutSidenotes(sizerClone)
		warnings.push(describeSidenotes(sidenotes))

		snapshot = {
			notePath: file?.path ?? '(unknown)',
			noteTitle: file?.basename ?? 'note',
			capturedAt: new Date().toISOString(),
			captureWidth,
			root: snapshotRoot(),
			reading: snapshotElement(readingRoot),
			preview: previewRoot
				? snapshotElement(previewRoot)
				: { className: 'markdown-preview-view', style: '', data: {} },
			resolution,
			previewMetrics,
			captureSource,
			sidenotes,
			sizer: sizerClone,
			stats,
			warnings
		}
	} finally {
		// A failed export must never leave the note scrolled somewhere the user
		// did not put it — so this runs on the throw path too.
		await releaseAfterCapture(scroll, warnings, offscreen)
	}

	if (!snapshot) {
		throw new CaptureError('抓取未完成，未生成快照。', 'empty', resolution)
	}

	return snapshot
}

/**
 * Restore the reader's position, then always release the offscreen host.
 *
 * Both steps run in the capture `finally`: a failure in either must not replace
 * the error that actually stopped the export, and a failure in the restore must
 * not keep the host (and its Component) alive.
 */
export async function releaseAfterCapture(
	scroll: ScrollTarget,
	warnings: string[],
	offscreen: OffscreenRender | null
): Promise<void> {
	try {
		await restoreScroll(scroll, warnings)
	} catch (error) {
		warnings.push(
			`滚动位置还原失败：${error instanceof Error ? error.message : String(error)}`
		)
	} finally {
		try {
			offscreen?.dispose()
		} catch {
			/* disposal must never mask the capture error */
		}
	}
}

/** A body is renderable if it has blocks, media, diagrams, notes or text. */
function hasRenderableContent(m: Metrics): boolean {
	return (
		m.blocks > 0 ||
		m.media > 0 ||
		m.mermaid > 0 ||
		m.sidenotes > 0 ||
		m.math > 0 ||
		m.textLength > 0
	)
}

/** The element the reading view really scrolls, plus where the reader was. */
export interface ScrollTarget {
	el: HTMLElement | null
	top: number
	label: string
}

/**
 * Find the element that scrolls the reading view and record its offset (SC-01).
 *
 * `.markdown-preview-view` is the usual answer, but the chain differs by theme
 * and by "readable line length", so instead of assuming we walk up from the body
 * and take the first ancestor that both allows scrolling and actually overflows.
 * A short note has nothing to scroll — that is not an error, just a recorded 0.
 */
function captureScrollTarget(
	previewRoot: HTMLElement | null,
	readingRoot: HTMLElement
): ScrollTarget {
	const scrolls = (el: HTMLElement): boolean => {
		const overflowY = window.getComputedStyle(el).overflowY
		const allowed =
			overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay'
		return allowed && el.scrollHeight > el.clientHeight + 2
	}

	for (
		let el: HTMLElement | null = previewRoot ?? readingRoot;
		el;
		el = el.parentElement
	) {
		if (el === document.documentElement) break
		if (scrolls(el)) {
			return { el, top: el.scrollTop, label: describeElement(el) }
		}
	}

	// Last resort: layouts where the document element itself is the scroller.
	const doc = document.scrollingElement
	if (doc instanceof HTMLElement && doc.scrollTop > 0) {
		return { el: doc, top: doc.scrollTop, label: 'document.scrollingElement' }
	}

	if (previewRoot) {
		return {
			el: previewRoot,
			top: previewRoot.scrollTop,
			label: describeElement(previewRoot)
		}
	}
	return { el: null, top: 0, label: '(none)' }
}

function describeElement(el: HTMLElement): string {
	const className = typeof el.className === 'string' ? el.className.trim() : ''
	const first = className ? `.${className.split(/\s+/)[0]}` : ''
	return `${el.tagName.toLowerCase()}${first}`
}

/**
 * Park the view at the top and wait until the re-render settles.
 *
 * Throws `unstable` when the body is still changing after the budget: exporting
 * a half-rendered view is the silent corruption this guard exists for, so it
 * fails loudly rather than writing a plausible-looking file.
 */
async function parkAtTop(
	target: ScrollTarget,
	sizer: HTMLElement,
	warnings: string[]
): Promise<void> {
	if (!target.el) {
		warnings.push('滚动位置：未找到滚动容器，跳过归零')
		return
	}
	if (target.top <= 0) {
		warnings.push(`滚动位置：${target.label} 已在顶部（scrollTop=0）`)
		return
	}

	target.el.scrollTop = 0
	const result = await waitForStableRender(target.el, sizer)

	if (!result.stable) {
		throw new CaptureError(
			`阅读视图在 ${TOP_SETTLE_TIMEOUT_MS} ms 内未稳定（最后采样：标题 ` +
				`${result.last.headings}、内容块 ${result.last.blocks}、` +
				`scrollHeight ${result.last.scrollHeight}；${result.samples} 次采样）。\n` +
				'请稍后重试；若反复出现，说明这篇笔记在本机渲染过慢。' +
				(result.samples < 8
					? '\n采样次数偏少：窗口可能被遮挡或渲染线程被限流，请让 Obsidian 保持在前台后重试。'
					: ''),
			'unstable'
		)
	}

	warnings.push(
		`滚动位置：${target.label} ${target.top} → 0，稳定用时 ` +
			`${result.elapsedMs} ms（${result.samples} 次采样，` +
			`标题 ${result.last.headings}、内容块 ${result.last.blocks}）`
	)
}

interface RenderSample {
	scrollTop: number
	scrollHeight: number
	headings: number
	blocks: number
}

/** Poll until consecutive samples agree, or the budget runs out. */
async function waitForStableRender(
	scroller: HTMLElement,
	sizer: HTMLElement
): Promise<{
	stable: boolean
	elapsedMs: number
	samples: number
	last: RenderSample
}> {
	const started = performance.now()
	const sample = (): RenderSample => ({
		scrollTop: Math.round(scroller.scrollTop),
		scrollHeight: Math.round(scroller.scrollHeight),
		headings: sizer.querySelectorAll(HEADING_SELECTOR).length,
		blocks: sizer.querySelectorAll('p, li, blockquote, pre, table').length
	})

	let previous: RenderSample | null = null
	let identical = 0
	let samples = 0
	let last = sample()

	while (performance.now() - started < TOP_SETTLE_TIMEOUT_MS) {
		await nextFrame()
		await delay(TOP_SETTLE_SAMPLE_MS)
		const current = sample()
		samples++
		last = current
		if (
			previous &&
			current.scrollTop === previous.scrollTop &&
			current.scrollHeight === previous.scrollHeight &&
			current.headings === previous.headings &&
			current.blocks === previous.blocks
		) {
			identical++
			if (identical >= TOP_SETTLE_STABLE_SAMPLES - 1) {
				return {
					stable: true,
					elapsedMs: Math.round(performance.now() - started),
					samples,
					last: current
				}
			}
		} else {
			identical = 0
		}
		previous = current
	}

	return {
		stable: false,
		elapsedMs: Math.round(performance.now() - started),
		samples,
		last
	}
}

/**
 * Put the reader back where they were; report it when that does not stick.
 *
 * The first write almost never lands where we want it: the view was parked at
 * the top, so the blocks around the old position are unmounted and the
 * virtualiser's `scrollHeight` is still short. Writing the offset then clamps
 * to the *current* maximum — measured on a 2,699-line note, a target of 21,786
 * landed on 21,642, i.e. the last 144px of the document were not laid out yet.
 *
 * Three fixed retries (the previous implementation) only worked when the height
 * recovered within ~240 ms; when it took longer the export reported a "restored"
 * position that was 144px short. So: retry until it sticks, or until the budget
 * runs out, and report the *reason* — a clamp (document shorter than the offset)
 * is not the same failure as a write that was ignored.
 */
async function restoreScroll(
	target: ScrollTarget,
	warnings: string[]
): Promise<void> {
	if (!target.el || target.top <= 0) return
	const el = target.el
	const deadline = performance.now() + RESTORE_TIMEOUT_MS

	let actual = 0
	let maxScroll = 0

	while (performance.now() < deadline) {
		maxScroll = Math.max(0, Math.round(el.scrollHeight - el.clientHeight))
		el.scrollTop = target.top
		await nextFrame()
		await delay(60)
		actual = Math.round(el.scrollTop)
		if (Math.abs(actual - target.top) <= 1) {
			warnings.push(`原滚动位置已还原：${actual}`)
			return
		}
		if (maxScroll >= target.top + 2) {
			// There is room for the offset and it still did not stick: retrying
			// the same write will not help, so stop instead of burning the budget.
			break
		}
	}

	if (Math.abs(actual - target.top) <= 1) {
		warnings.push(`原滚动位置已还原：${actual}`)
		return
	}
	warnings.push(
		`原滚动位置未能完全还原：期望 ${target.top}，实际 ${actual}` +
			(actual < target.top
				? `（可滚动高度只有 ${maxScroll}px，正文比抓取时短 ${target.top - actual}px）`
				: '')
	)
}

/**
 * Heading texts from Obsidian's own cache: it lists every heading in the file,
 * whatever the view has mounted.
 */
function headingTextsFromMetadata(app: App, file: TFile | null): string[] {
	if (!file) return []
	const cache = app.metadataCache.getFileCache(file)
	return (cache?.headings ?? [])
		.map(h => h.heading)
		.filter(text => typeof text === 'string' && text.trim().length > 0)
}

/**
 * Read the note itself and turn it into a baseline the export can be checked
 * against.
 *
 * `metadataCache` can lag a just-saved edit, so a file that visibly has headings
 * but no cache entries falls back to reading them from the markdown — still the
 * source, never the view.
 */
async function readBaseline(app: App, file: TFile | null): Promise<NoteBaseline> {
	if (!file) {
		throw new CaptureError(
			'无法读取笔记内容：当前视图没有关联文件，完整性无从校验。',
			'no-view'
		)
	}

	const markdown = await app.vault.read(file)
	let headings = headingTextsFromMetadata(app, file)

	if (headings.length === 0) {
		// Cache lag on a just-saved file: read the headings from the markdown, but
		// skip fenced code — `# install` in a shell block is not a heading.
		headings = []
		let inFence = false
		for (const line of markdown.split(/\r?\n/)) {
			if (/^\s*(?:```+|~~~+)/.test(line)) {
				inFence = !inFence
				continue
			}
			if (inFence) continue
			const match = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/)
			if (match) headings.push(match[1])
		}
	}

	return buildBaseline(markdown, headings)
}

/** The off-screen host built by `renderWholeNote`, and how to take it down. */
export interface OffscreenRender {
	sizer: HTMLElement
	host: HTMLElement
	dispose: () => void
}

/** Budget for a whole-note render: a stuck post-processor must not hang the command. */
const RENDER_TIMEOUT_MS = 20000

/**
 * P0 — render the whole note into a body that does not depend on the viewport.
 *
 * `MarkdownRenderer.render` is public API and walks the entire markdown string:
 * there is no virtualisation to fight, so a note is rendered in one pass no
 * matter how tall it is. The host is laid out at the reading view's exact width
 * and carries the reading view's own class chain, so theme CSS, snippets and
 * post-processors (callouts, Mermaid, Side Notes, highlighter) apply as usual.
 * It is positioned off-screen and made transparent, not `display: none`: the
 * host must keep a real layout box for measuring plugins and for `innerText`.
 *
 * Nothing here touches the note or the live view. Every failure between
 * attaching the host and returning — component load, render rejection, render
 * timeout, settle — disposes it before propagating, and `dispose` is idempotent
 * so the caller's `finally` can call it again safely.
 *
 * Exported for the host-release regression test.
 */
export async function renderWholeNote(
	app: App,
	view: MarkdownView,
	liveSizer: HTMLElement,
	previewRoot: HTMLElement | null,
	readingRoot: HTMLElement,
	width: number,
	warnings: string[],
	budgetMs = RENDER_TIMEOUT_MS
): Promise<OffscreenRender> {
	const file = view.file
	if (!file) {
		throw new CaptureError(
			'无法整篇渲染：当前视图没有关联文件。',
			'no-view'
		)
	}

	const markdown = await app.vault.read(file)
	const started = performance.now()

	const host = document.createElement('div')
	host.className = readingRoot.className || 'markdown-reading-view'
	for (const attr of Array.from(readingRoot.attributes)) {
		if (attr.name.startsWith('data-')) host.setAttribute(attr.name, attr.value)
	}
	// Laid out at the reading view's width — so theme CSS, Media queries and
	// plugins that measure all see a real box — but shifted off-screen and
	// transparent. `opacity: 0` rather than `visibility: hidden` keeps the host
	// in the paint tree, which is what makes `innerText` (the completeness check's
	// primary signal) report the rendered words instead of an empty string.
	host.setAttribute(
		'style',
		`position:absolute;left:-200000px;top:0;width:${width}px;` +
			'opacity:0;pointer-events:none;'
	)

	const preview = document.createElement('div')
	preview.className =
		previewRoot?.className || 'markdown-preview-view markdown-rendered'
	const sizer = document.createElement('div')
	sizer.className =
		liveSizer.className || 'markdown-preview-sizer markdown-preview-section'
	preview.appendChild(sizer)
	host.appendChild(preview)

	const component = new Component()
	let disposed = false
	const dispose = () => {
		if (disposed) return
		disposed = true
		try {
			component.unload()
		} catch {
			/* unloading a render component must never mask the real error */
		}
		try {
			host.remove()
		} catch {
			/* already detached: nothing left to release */
		}
	}

	try {
		// Attach only here: everything above is pure construction, so a failure
		// there cannot leave a host behind.
		document.body.appendChild(host)
		component.load()
		await renderWithBudget(
			MarkdownRenderer.render(app, markdown, sizer, file.path, component),
			budgetMs,
			dispose
		)
		// Mermaid and images are produced by post-processors that finish
		// asynchronously; the same settle pass the reading view uses applies here.
		await settle(sizer, warnings)
	} catch (error) {
		dispose()
		if (error instanceof CaptureError) throw error
		throw new CaptureError(
			`整篇渲染失败：${error instanceof Error ? error.message : String(error)}`,
			'incomplete'
		)
	}

	warnings.push(
		`整篇渲染：${Math.round(performance.now() - started)} ms，` +
			`${markdown.length.toLocaleString()} 字符 → ` +
			`${sizer.querySelectorAll('p, li, pre, table, blockquote').length} 个内容块`
	)

	return { sizer, host, dispose }
}

/**
 * Await a render, but never indefinitely.
 *
 * `MarkdownRenderer.render` has no cancellation token, so a `Promise.race` on
 * its own would only stop *waiting* while the task kept writing into a live
 * host. The timeout therefore tears the host down first (`onTimeout`), and only
 * then rejects: whatever the render does afterwards lands on a detached tree,
 * and the Component that owns its post-processors is unloaded. The residual
 * work is disclosed in the error instead of being presented as a clean cancel.
 */
async function renderWithBudget<T>(
	task: Promise<T>,
	ms: number,
	onTimeout: () => void
): Promise<T> {
	let timer = 0
	const budget = new Promise<never>((_, reject) => {
		timer = window.setTimeout(() => {
			onTimeout()
			reject(
				new CaptureError(
					`整篇渲染超过 ${ms} ms 未完成，已移除离屏宿主并中止导出。` +
						'底层渲染任务无法取消，但它的写入只会落在已分离的节点上。',
					'incomplete'
				)
			)
		}, ms)
	})
	try {
		return await Promise.race([task, budget])
	} finally {
		window.clearTimeout(timer)
	}
}

/**
 * Content shapes that must survive the clone 1:1 (EI-01).
 *
 * Deliberately *not* "count everything": `script`, `style`, the pusher and the
 * hover-only UI shells are removed on purpose, so a generic node count would
 * cry wolf. These six are the shapes a reader would notice missing, and each is
 * unambiguous markdown output.
 */
const CONTENT_SHAPES: ReadonlyArray<{ label: string; selector: string }> = [
	{ label: '标题', selector: 'h1, h2, h3, h4, h5, h6' },
	{ label: '段落', selector: 'p' },
	{ label: '列表项', selector: 'li' },
	{ label: '表格', selector: 'table' },
	{ label: '代码块', selector: 'pre' },
	{ label: '引用', selector: 'blockquote' }
]

/**
 * Refuse to export a body that lost content during cloning.
 *
 * Returns one human-readable line for the manifest so every export carries its
 * own proof of completeness ("标题 10/10、段落 7/7、…"), instead of a reviewer
 * having to open the HTML and count by hand.
 */
function assertContentComplete(live: HTMLElement, copy: HTMLElement): string {
	const summary: string[] = []
	const lost: string[] = []

	for (const { label, selector } of CONTENT_SHAPES) {
		const liveCount = live.querySelectorAll(selector).length
		const copyCount = copy.querySelectorAll(selector).length
		if (copyCount < liveCount) lost.push(`${label} ${liveCount}→${copyCount}`)
		summary.push(`${label} ${copyCount}/${liveCount}`)
	}

	if (lost.length > 0) {
		throw new CaptureError(
			`抓取结果比阅读视图少了内容（${lost.join('、')}），已停止导出。\n` +
				'克隆阶段丢了节点，继续写盘只会得到一份残缺页面。',
			'incomplete'
		)
	}

	return `内容完整性：${summary.join('，')}`
}

/** Keep the resolver's justification in the manifest, not just in the code. */
function describeResolution(
	resolution: CaptureSnapshot['resolution']
): string[] {
	const out: string[] = []
	const summary = summarizeResolution(resolution)
	if ((summary.candidates as number) > 1) {
		out.push(
			`正文容器候选 ${summary.candidates} 个，已排除 ` +
				`${(summary.excluded as unknown[]).length} 个`
		)
	}
	for (const item of summary.excluded as { reason: string }[]) {
		out.push(`已排除候选：${item.reason}`)
	}
	return out
}

function snapshotElement(el: HTMLElement): ElementSnapshot {
	const data: Record<string, string> = {}
	for (const attr of Array.from(el.attributes)) {
		if (attr.name.startsWith('data-')) data[attr.name] = attr.value
	}
	return {
		className: el.className,
		style: el.getAttribute('style') ?? '',
		data
	}
}

/** Resolve each margin's effective side (per-note override wins over global). */
function countSidenotes(root: HTMLElement, side: 'left' | 'right'): number {
	const global = root
		.closest('.markdown-reading-view')
		?.getAttribute('data-sidenote-position')
	let count = 0
	root.querySelectorAll<HTMLElement>('small.sidenote-margin').forEach(el => {
		const override = el.dataset.sidenoteSide
		const effective = override === 'left' || override === 'right'
			? override
			: global === 'left'
				? 'left'
				: 'right'
		if (effective === side) count++
	})
	return count
}

async function settle(root: HTMLElement, warnings: string[]): Promise<void> {
	try {
		await withTimeout(document.fonts.ready, SETTLE_TIMEOUT_MS, '字体加载超时')
	} catch {
		// A timeout here is not fatal: the export still works, but line heights
		// may differ from what the user sees. Say so instead of hiding it.
		warnings.push('字体加载超时，批注行偏移可能有偏差')
	}

	await Promise.all([
		waitForImages(root, warnings),
		waitForMermaid(root, warnings)
	])

	await nextFrame()
	await nextFrame()
	await delay(QUIET_AFTER_FRAMES_MS)
}

function waitForImages(root: HTMLElement, warnings: string[]): Promise<void> {
	const images = Array.from(root.querySelectorAll('img'))
	const pending = images.filter(img => !img.complete || img.naturalWidth === 0)
	if (pending.length === 0) return Promise.resolve()

	return Promise.all(
		pending.map(
			img =>
				new Promise<void>(resolve => {
					let done = false
					const finish = (ok: boolean) => {
						if (done) return
						done = true
						if (!ok) warnings.push(`图片加载失败: ${img.getAttribute('src') ?? ''}`)
						resolve()
					}
					const timer = window.setTimeout(() => finish(false), SETTLE_TIMEOUT_MS)
					img.addEventListener(
						'load',
						() => {
							window.clearTimeout(timer)
							finish(true)
						},
						{ once: true }
					)
					img.addEventListener(
						'error',
						() => {
							window.clearTimeout(timer)
							finish(false)
						},
						{ once: true }
					)
				})
		)
	).then(() => undefined)
}

async function waitForMermaid(
	root: HTMLElement,
	warnings: string[]
): Promise<void> {
	const diagrams = Array.from(root.querySelectorAll<HTMLElement>('.mermaid'))
	if (diagrams.length === 0) return

	const deadline = Date.now() + SETTLE_TIMEOUT_MS
	while (Date.now() < deadline) {
		const missing = diagrams.filter(d => !d.querySelector('svg'))
		if (missing.length === 0) return
		await delay(100)
	}
	const stillMissing = diagrams.filter(d => !d.querySelector('svg')).length
	if (stillMissing > 0) {
		warnings.push(`${stillMissing} 个 Mermaid 图在超时内未生成 SVG`)
	}
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	return Promise.race([
		promise,
		new Promise<T>((_, reject) =>
			window.setTimeout(() => reject(new Error(message)), ms)
		)
	])
}

/**
 * One animation frame — but never longer than `ms`.
 *
 * The stability gate only checks its budget *between* awaits, so a stalled
 * `requestAnimationFrame` (occluded window, throttled renderer) turns a 2 s
 * timeout into an unbounded wait: measured once at 324 s, the command looked
 * hung long after the budget had expired. Falling back to a timer keeps the
 * budget honest; `samples` then tells the caller the sampling was starved.
 */
function nextFrame(ms = TOP_SETTLE_SAMPLE_MS): Promise<void> {
	return new Promise(resolve => {
		let timer = 0
		let done = false
		const finish = () => {
			if (done) return
			done = true
			window.clearTimeout(timer)
			resolve()
		}
		timer = window.setTimeout(finish, ms)
		window.requestAnimationFrame(finish)
	})
}

function delay(ms: number): Promise<void> {
	return new Promise(resolve => window.setTimeout(resolve, ms))
}
