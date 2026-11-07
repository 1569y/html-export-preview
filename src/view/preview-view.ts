import { ItemView, Notice, WorkspaceLeaf } from 'obsidian'
import {
	normalizeLayout,
	type ExportLayoutOptions
} from '../export/layout-settings'
import { assertVaultRelativeLocation } from '../export/path-safety'
import type { ExternalRequest } from '../export/external/target'
import { LayoutPanel, type MediaSelection } from './layout-panel'

export const VIEW_TYPE_HTML_EXPORT_PREVIEW = 'html-export-preview-view'

/** Which pipeline the confirm button will run. */
export type ExportKind = 'share' | 'package'

/**
 * The id prefix emitted by `media-identity.ts` is the single source of truth
 * for the block kind: `t…` is a table, `m…` a picture or a diagram. Using the
 * id rather than `tagName` / classList keeps the preview and the generated CSS
 * in lockstep (both branch on the same prefix), and works even when a theme
 * wraps or restyles the table element.
 */
function mediaKind(id: string, block: HTMLElement): MediaSelection['kind'] {
	if (id.charCodeAt(0) === 116 /* t */) return 'table'
	if (block.classList?.contains?.('mermaid')) return 'mermaid'
	return 'image'
}

const MEDIA_PANEL_TITLE: Record<MediaSelection['kind'], string> = {
	image: '图片设置',
	mermaid: 'Mermaid 设置',
	table: '表格设置'
}

export interface PreviewDocument {
	/** Complete standalone page, exactly as `buildHtml` produced it. */
	html: string
	/** Tab label. */
	tabTitle?: string
	noteTitle?: string
	notePath?: string
}

/**
 * What the view needs from the plugin. Kept as an interface so the view can be
 * exercised by the lifecycle tests with a fake host, and so the view never
 * holds the snapshot, the CSS collection or the signing key.
 */
export interface PreviewViewHost {
	/**
	 * Stylesheet for the *current* layout, applied to the already-loaded
	 * document. This is the whole point of the editor's performance contract:
	 * a slider move rewrites one `<style>` element, it does not re-capture the
	 * note, re-scan the vault's CSS or re-pack fonts.
	 */
	liveCss(layout: ExportLayoutOptions): string
	/** Re-capture the note; resolves once the new document is set on the view. */
	refresh(): Promise<void>
	/** Write files. Only ever called by the confirm button. */
	exportNow(
		kind: ExportKind,
		layout: ExportLayoutOptions,
		/** User-chosen Vault-relative folder for this export only; never persisted. */
		location?: string | null,
		/** Task 3: write outside the Vault instead; validated again by the plugin. */
		external?: ExternalRequest | null
	): Promise<void>
	/** Default safe output folder, the starting point for the location picker. */
	defaultExportFolder(): string
	/** One-line description of where the chosen format writes. */
	targetHint(
		kind: ExportKind,
		location?: string | null,
		external?: ExternalRequest | null
	): string
	/** Whether this runtime can write outside the Vault, and why not. */
	externalSupport(): { available: boolean; reason: string | null }
	/** Opens the system dialog; null when the user cancelled. */
	pickExternalTarget(
		kind: ExportKind,
		current: ExternalRequest | null
	): Promise<ExternalRequest | null>
	/** The view is gone: drop the snapshot, the CSS and the audit. */
	releaseSession(): void
}

/**
 * Preview-first export editor (P2).
 *
 * Layout: a toolbar (note name · viewport presets · refresh), the rendered page
 * in an iframe, the layout panel on the right, and a footer that decides
 * **what** gets written and confirms it. Nothing is written until the user
 * presses 确认导出 — closing the tab cancels silently.
 *
 * The iframe keeps the export's CSS out of Obsidian's UI and vice versa. It is
 * sandboxed to `allow-same-origin` only: scripts inside the document never run,
 * while the parent can still reach `contentDocument` to swap the live layout
 * stylesheet. `srcdoc` is a payload, not a URL — teardown removes the attribute
 * (never assigns `about:blank`) and detaches the frame so the browsing context,
 * its fonts and its decoded images can be discarded.
 */
export class PreviewView extends ItemView {
	/** Exposed for the lifecycle tests; null after teardown. */
	frame: HTMLIFrameElement | null = null
	pendingHtml: string | null = null
	/**
	 * `ItemView` already owns `titleEl` (the tab title). Shadowing it with a
	 * class field would null it after `super()` and break Obsidian's `load()` —
	 * which calls `titleEl.setText()` — so `onOpen()` would never run.
	 */
	previewTitleEl: HTMLElement | null = null
	/** Listeners this view attached itself; all released on close/unload. */
	disposers: Array<() => void> = []

	private released = false
	private host: PreviewViewHost | null
	private panel: LayoutPanel | null = null
	private layout: ExportLayoutOptions
	private kind: ExportKind = 'share'
	private busy = false
	private doc: PreviewDocument | null = null
	/** The `<style>` this view appended to the iframe document. */
	private liveStyle: HTMLStyleElement | null = null
	/** Task 3: the delegated `#`-link listener installed on the iframe document. */
	private detachAnchorNav: (() => void) | null = null
	/** P2 Task 2: the media block the user selected, and its click listener. */
	private selectedMediaEl: HTMLElement | null = null
	private detachMediaSelect: (() => void) | null = null

	private refreshBtn: HTMLButtonElement | null = null
	private kindSelect: HTMLSelectElement | null = null
	private exportBtn: HTMLButtonElement | null = null
	private hintEl: HTMLElement | null = null

	/** Task 2: user-chosen Vault-relative export folder for this export only. */
	private exportLocation: string | null = null
	private locationInput: HTMLInputElement | null = null
	private locationHintEl: HTMLElement | null = null
	private locationValid = true
	/** Task 3: 'vault' keeps the old behaviour; 'external' uses the dialog. */
	private exportMode: 'vault' | 'external' = 'vault'
	private external: ExternalRequest | null = null
	private modeSelect: HTMLSelectElement | null = null
	private browseBtn: HTMLButtonElement | null = null
	private externalPathEl: HTMLElement | null = null
	private vaultRowEl: HTMLElement | null = null
	private externalRowEl: HTMLElement | null = null

	constructor(leaf: WorkspaceLeaf, host?: PreviewViewHost) {
		super(leaf)
		this.host = host ?? null
		this.layout = normalizeLayout(undefined)
	}

	getViewType(): string {
		return VIEW_TYPE_HTML_EXPORT_PREVIEW
	}

	getDisplayText(): string {
		return 'HTML 预览与导出'
	}

	getIcon(): string {
		return 'file-code-2'
	}

	async onOpen(): Promise<void> {
		this.released = false
		this.render()
	}

	async onClose(): Promise<void> {
		this.release()
	}

	/** Plugin disable / vault close is a second path into the same teardown. */
	onunload(): void {
		this.release()
		super.onunload()
	}

	/* --------------------------------------------------------------- content -- */

	/**
	 * Low-level: hand the view the document to render.
	 *
	 * A closed view must not buffer another full copy of the page, so this is a
	 * no-op after teardown.
	 */
	setHtml(html: string, title?: string): void {
		if (this.released) return
		if (title && this.previewTitleEl) this.previewTitleEl.setText(title)
		if (this.frame) this.frame.srcdoc = html
		else this.pendingHtml = html
	}

	/** Full document update: content plus the metadata the toolbar shows. */
	setDocument(doc: PreviewDocument): void {
		this.doc = doc
		this.setHtml(doc.html, doc.tabTitle ?? doc.noteTitle)
		this.updateHint()
	}

	/** Preselect the footer format (the share command opens it on 单文件). */
	setPreferredKind(kind: ExportKind): void {
		this.kind = kind
		if (this.kindSelect) this.kindSelect.value = kind
		this.updateHint()
	}

	/** Current layout — the plugin builds both exports from exactly this. */
	getLayout(): ExportLayoutOptions {
		return { ...this.layout }
	}

	setLayout(layout: Partial<ExportLayoutOptions>): void {
		this.layout = normalizeLayout({ ...this.layout, ...layout })
		this.panel?.update(this.layout)
		this.applyLiveCss()
	}

	setBusy(busy: boolean): void {
		this.busy = busy
		if (this.exportBtn) {
			this.exportBtn.disabled = busy
			this.exportBtn.setText(busy ? '导出中…' : '确认导出')
		}
		if (this.refreshBtn) this.refreshBtn.disabled = busy
	}

	/* ----------------------------------------------------------------- build -- */

	private render(): void {
		// Re-opening the same view rebuilds the subtree; release the previous
		// listeners first so they cannot accumulate across open/close cycles.
		this.disposeListeners()

		const root = this.contentEl
		root.empty()
		root.addClass('he-preview-root')

		/* toolbar ------------------------------------------------------------ */
		const bar = root.createDiv({ cls: 'he-preview-bar' })
		this.previewTitleEl = bar.createDiv({
			cls: 'he-preview-title',
			text: '尚未抓取'
		})

		const widths = bar.createDiv({ cls: 'he-preview-widths' })
		widths.setAttribute(
			'title',
			'切换预览画布宽度：画布比面板宽时可横向滚动。只影响预览窗口，不改变最终导出文件的内容大小'
		)
		const presets: Array<[string, string]> = [
			['桌面', '1440px'],
			['平板', '820px'],
			['手机', '420px'],
			['自适应', '100%']
		]
		for (const [label, width] of presets) {
			const btn = widths.createEl('button', { text: label })
			this.listen(btn, 'click', () => {
				if (this.frame) this.frame.style.width = width
			})
		}

		const refresh = bar.createEl('button', { cls: 'he-preview-refresh', text: '刷新' })
		refresh.setAttribute('title', '重新抓取当前笔记（保留左/右侧已调整的排版）')
		this.refreshBtn = refresh
		this.listen(refresh, 'click', () => {
			if (this.busy || !this.host) return
			void this.host.refresh()
		})

		/* body: page + panel -------------------------------------------------- */
		const body = root.createDiv({ cls: 'he-preview-body' })
		const holder = body.createDiv({ cls: 'he-preview-holder' })
		const frame = holder.createEl('iframe', { cls: 'he-preview-frame' })
		frame.setAttribute('title', 'HTML 导出预览')
		// No `allow-scripts`: the generated page has no scripts, and a document
		// rendered from note content must not be able to run one. Same-origin is
		// kept so the parent can swap the live layout stylesheet.
		frame.setAttribute('sandbox', 'allow-same-origin')
		this.frame = frame
		this.listen(frame, 'load', () => {
			// A new document means the previous <style> node is gone with it.
			this.liveStyle = null
			// The old selection belonged to the old document; the *settings*
			// stay in `this.layout` and are re-applied by the new document's own
			// `data-he-media-id` attributes.
			this.clearMediaSelection()
			this.applyLiveCss()
			this.installAnchorNavigation()
			this.installMediaSelection()
		})

		const panelHost = body.createDiv({ cls: 'he-preview-panel' })
		this.panel = new LayoutPanel(
			panelHost,
			this.layout,
			layout => {
				this.layout = layout
				this.applyLiveCss()
			},
			{
				register: dispose => this.disposers.push(dispose),
				onExitMedia: () => this.selectMedia(null)
			}
		)

		/* footer: what to write ---------------------------------------------- */
		const foot = root.createDiv({ cls: 'he-preview-foot' })
		const label = foot.createEl('label', { cls: 'he-preview-format', text: '导出格式' })
		const select = label.createEl('select', { cls: 'dropdown' })
		select.setAttribute('data-he-control', 'exportKind')
		for (const [value, text] of [
			['share', '单文件 HTML（分享）'],
			['package', '完整资源包（归档）']
		] as Array<[ExportKind, string]>) {
			const option = select.createEl('option', { text })
			option.setAttribute('value', value)
		}
		select.value = this.kind
		this.kindSelect = select
		this.listen(select, 'change', () => {
			const next = select.value === 'package' ? 'package' : 'share'
			if (next !== this.kind) {
				// A "save as" file name and a target folder are different
				// questions, so the answer to the previous one does not carry
				// over — the file target would be meaningless for a package.
				this.external = null
			}
			this.kind = next
			this.renderLocationMode()
		})

		const exportBtn = foot.createEl('button', { cls: 'mod-cta', text: '确认导出' })
		this.exportBtn = exportBtn
		this.listen(exportBtn, 'click', () => this.confirm())

		/* Task 2: export location selection (Vault-internal, safe boundary). */
		const locSection = foot.createDiv({ cls: 'he-preview-loc' })
		// Safety boundary: the chosen location stays inside the Vault. We never use
		// Node `fs` to write arbitrary filesystem paths, and the writer re-validates
		// every value with the same path-safety rules as the configured folder.
		locSection.createDiv({ cls: 'he-panel-section', text: '导出位置' })

		// Task 3: two destinations, one of which is a folder on this computer.
		// The external path is *only* obtainable from the system dialog — there
		// is no text field to type one into, and the read-only label below shows
		// what the dialog returned.
		const support = this.host?.externalSupport() ?? { available: false, reason: null }
		const modeSelect = locSection.createEl('select', { cls: 'dropdown he-loc-mode' })
		modeSelect.setAttribute('data-he-control', 'exportMode')
		const vaultOption = modeSelect.createEl('option', { text: 'Vault 内（默认）' })
		vaultOption.setAttribute('value', 'vault')
		const externalOption = modeSelect.createEl('option', {
			text: '电脑上的其他位置…'
		})
		externalOption.setAttribute('value', 'external')
		if (!support.available) {
			externalOption.disabled = true
			externalOption.setAttribute(
				'title',
				support.reason ?? '当前运行环境无法访问电脑上的文件夹'
			)
			modeSelect.setAttribute(
				'title',
				support.reason ?? '当前运行环境无法访问电脑上的文件夹'
			)
		}
		modeSelect.value = 'vault'
		this.modeSelect = modeSelect

		const vaultRow = locSection.createDiv({ cls: 'he-loc-row he-loc-vault' })
		this.vaultRowEl = vaultRow
		this.locationInput = vaultRow.createEl('input', {
			cls: 'he-panel-input he-location-input'
		})
		this.locationInput.setAttribute('type', 'text')
		this.locationInput.setAttribute(
			'placeholder',
			'Vault 内相对路径，例如 html-export/MyNote'
		)
		this.locationInput.setAttribute(
			'title',
			'仅支持当前 Vault 内的相对路径（例如 html-export/MyNote）。' +
				'驱动器号、绝对路径和 “..” 都会被拒绝。'
		)
		this.locationInput.value = this.host?.defaultExportFolder() ?? ''
		this.listen(this.locationInput, 'input', () => this.onLocationInput())
		// A real control, not just "clear the field": after an invalid path the
		// user must be able to get back to the configured folder in one click.
		const locReset = vaultRow.createEl('button', {
			cls: 'he-loc-reset',
			text: '恢复默认目录'
		})
		locReset.setAttribute(
			'title',
			`恢复到插件设置中的默认文件夹（${this.host?.defaultExportFolder() ?? ''}）`
		)
		this.listen(locReset, 'click', () => {
			if (!this.locationInput) return
			this.locationInput.value = this.host?.defaultExportFolder() ?? ''
			this.onLocationInput()
		})

		const externalRow = locSection.createDiv({ cls: 'he-loc-row he-loc-external' })
		this.externalRowEl = externalRow
		this.externalPathEl = externalRow.createDiv({ cls: 'he-loc-path' })
		const browse = externalRow.createEl('button', {
			cls: 'he-loc-browse',
			text: '浏览…'
		})
		browse.setAttribute(
			'title',
			this.kind === 'share'
				? '打开系统的“另存为”窗口，选择文件夹与 HTML 文件名'
				: '选择目标文件夹，插件会在其中新建专用导出子目录'
		)
		this.browseBtn = browse
		this.listen(browse, 'click', () => void this.pickExternal())
		this.listen(modeSelect, 'change', () => {
			this.exportMode = modeSelect.value === 'external' ? 'external' : 'vault'
			this.renderLocationMode()
		})

		this.locationHintEl = locSection.createDiv({ cls: 'he-preview-loc-hint' })
		this.renderLocationMode()
		this.onLocationInput()

		this.hintEl = foot.createDiv({ cls: 'he-preview-hint' })
		this.updateHint()

		if (this.pendingHtml) {
			frame.srcdoc = this.pendingHtml
			this.pendingHtml = null
		}
	}

	private updateHint(): void {
		if (!this.hintEl) return
		const hint =
			this.host?.targetHint(
				this.kind,
				this.exportMode === 'vault' ? this.exportLocation : null,
				this.exportMode === 'external' ? this.external : null
			) ?? ''
		this.hintEl.setText(hint)
	}

	/**
	 * Show the row that belongs to the current destination and hide the other.
	 *
	 * Two rows instead of one polymorphic field: the vault path is typed and
	 * validated as a relative path, while the external path is read-only text
	 * produced by the system dialog. Sharing one input would blur the rule that
	 * an external path can never be typed.
	 */
	private renderLocationMode(): void {
		const vault = this.exportMode === 'vault'
		if (this.vaultRowEl) this.vaultRowEl.style.display = vault ? '' : 'none'
		if (this.externalRowEl) this.externalRowEl.style.display = vault ? 'none' : ''
		if (this.externalPathEl) {
			this.externalPathEl.setText(
				this.external ? this.external.path : '尚未选择位置，点击「浏览…」'
			)
			this.externalPathEl.toggleClass('he-loc-empty', !this.external)
		}
		if (this.browseBtn) {
			this.browseBtn.setAttribute(
				'title',
				this.kind === 'share'
					? '打开系统的“另存为”窗口，选择文件夹与 HTML 文件名'
					: '选择目标文件夹，插件会在其中新建专用导出子目录'
			)
		}
		this.updateHint()
	}

	/**
	 * Ask the plugin for a system dialog and remember what came back.
	 *
	 * A cancelled dialog leaves the previous choice untouched and writes
	 * nothing — the dialog is the only way to obtain this path, so "cancel"
	 * must never be interpreted as "keep the old one and export anyway".
	 */
	private async pickExternal(): Promise<void> {
		if (this.busy || !this.host) return
		const chosen = await this.host.pickExternalTarget(this.kind, this.external)
		if (!chosen) {
			this.updateHint()
			return
		}
		this.external = chosen
		this.exportMode = 'external'
		if (this.modeSelect) this.modeSelect.value = 'external'
		this.renderLocationMode()
	}

	private confirm(): void {
		if (this.busy || !this.host) return
		// Only the button writes files. Everything before it is a preview.
		if (this.exportMode === 'external') {
			if (!this.external) {
				new Notice('请先点击「浏览…」选择保存位置，本次没有写入任何文件。', 5000)
				return
			}
			void this.host.exportNow(
				this.kind,
				{ ...this.layout },
				null,
				this.external
			)
			return
		}
		if (!this.locationValid) {
			new Notice('导出位置不安全，请修正路径或点击“恢复默认目录”后再导出。', 4000)
			return
		}
		void this.host.exportNow(this.kind, { ...this.layout }, this.exportLocation)
	}

	/**
	 * Validate and remember the user's chosen export folder.
	 *
	 * Empty input → fall back to the configured default (and clears the
	 * per-export override). A non-empty value must be a Vault-relative path:
	 * `assertVaultRelativeLocation` rejects drive letters / UNC / absolute paths
	 * and every `..` segment, mirroring the rules that govern the stored
	 * `outputFolder` but stricter for a value typed by hand. Invalid input is
	 * marked but never written — `confirm()` refuses to export until it is
	 * corrected or the "恢复默认目录" button is used.
	 */
	private onLocationInput(): void {
		const raw = (this.locationInput?.value ?? '').trim()
		this.exportLocation = raw || null
		if (!raw) {
			this.locationValid = true
			this.locationInput?.removeClass('he-invalid')
		} else {
			try {
				assertVaultRelativeLocation(raw)
				this.locationValid = true
				this.locationInput?.removeClass('he-invalid')
			} catch {
				this.locationValid = false
				this.locationInput?.addClass('he-invalid')
			}
		}
		// Both hints are derived from the *validated* state. Refreshing them before
		// validation made the diagnostic lag one keystroke behind the input.
		this.updateLocationHint()
		// The footer's target description must follow the chosen folder too.
		this.updateHint()
	}

	private updateLocationHint(): void {
		if (!this.locationHintEl) return
		const raw = (this.locationInput?.value ?? '').trim()
		if (!raw) {
			this.locationHintEl.setText(
				`使用默认文件夹：${this.host?.defaultExportFolder() ?? ''}`
			)
			return
		}
		if (this.locationValid) {
			this.locationHintEl.setText(
				`将导出到 Vault 内：${raw}（文件名/子目录由插件自动命名，不会覆盖已有导出）`
			)
		} else {
			this.locationHintEl.setText(
				'路径不安全：必须是 Vault 内相对路径，不能含驱动器号、绝对路径或 “..”。'
			)
		}
	}

	/**
	 * Push the current layout into the already-loaded document.
	 *
	 * A `<style>` element appended after the document's own stylesheet wins for
	 * equal specificity, so the rules can simply be restated. Replacing its
	 * `textContent` is the only DOM write a slider move performs — no capture,
	 * no re-render, no reflow of the editing UI.
	 */
	private applyLiveCss(): void {
		const doc = this.frame?.contentDocument
		if (!doc || !this.host) return
		const css = this.host.liveCss(this.layout)
		let style = this.liveStyle
		if (!style || !style.isConnected) {
			style = doc.createElement('style')
			style.setAttribute('id', 'he-live-layout')
			const parent = doc.head ?? doc.documentElement
			parent?.appendChild(style)
			this.liveStyle = style
		}
		style.textContent = css
	}

	/**
	 * Task 3 — make same-article links jump *inside the preview iframe*.
	 *
	 * A `srcdoc` document has no URL to fragment-navigate: `location` stays
	 * `about:srcdoc`, so a native `<a href="#heading">` click neither scrolls
	 * nor changes the hash. The exported HTML is a real file/http URL where the
	 * very same native link works offline, so only the preview needs a patch.
	 *
	 * The listener is attached to the iframe document but runs in the parent
	 * realm; the frame stays `sandbox="allow-same-origin"` without
	 * `allow-scripts`. It only changes `scrollTop` on the iframe's own scroll
	 * container: no `srcdoc` reassignment, no re-capture, no layout or panel
	 * writes, so unconfirmed settings survive the jump. Unresolved anchors have
	 * no `href` at all (see `applyInternalAnchors`) and are left alone.
	 */
	private installAnchorNavigation(): void {
		const doc = this.frame?.contentDocument
		if (!doc || typeof doc.addEventListener !== 'function') return
		this.detachAnchorNav?.()

		const onClick = (event: Event): void => {
			const target = event.target as Element | null
			const anchor =
				typeof target?.closest === 'function'
					? (target.closest('a[href^="#"]') as HTMLAnchorElement | null)
					: null
			if (!anchor) return
			const raw = anchor.getAttribute('href') ?? ''
			if (raw.length < 2) return
			let id = raw.slice(1)
			try {
				id = decodeURIComponent(id)
			} catch {
				/* Keep the raw fragment; getElementById handles it literally. */
			}
			const dest =
				typeof doc.getElementById === 'function' ? doc.getElementById(id) : null
			if (!dest) return
			event.preventDefault()
			// `scrollIntoView` would also scroll the Obsidian window to reveal the
			// frame. Writing scrollTop keeps the movement strictly inside preview.
			const delta = dest.getBoundingClientRect().top - 16
			const scroller = this.previewScroller(doc)
			if (scroller) {
				scroller.scrollTop = Math.max(0, scroller.scrollTop + delta)
			}
			// A document whose root scroller is shorter than the note (a narrow
			// reading view, a zoomed page) can clamp scrollTop before the target
			// reaches the top. Only then fall back to the browser's own chain of
			// scroll containers; the frame itself is already visible, so this
			// still does not scroll the Obsidian window or rebuild the document.
			if (
				typeof dest.scrollIntoView === 'function' &&
				Math.abs(dest.getBoundingClientRect().top) > 120
			) {
				dest.scrollIntoView({ block: 'start' })
			}
		}

		const listener = onClick as EventListener
		doc.addEventListener('click', listener, true)
		const detach = (): void => {
			try {
				doc.removeEventListener('click', listener, true)
			} catch {
				/* The document is already gone with the browsing context. */
			}
		}
		this.detachAnchorNav = detach
		this.disposers.push(detach)
	}

	/** The element inside the preview that actually owns the scrollbar. */
	private previewScroller(doc: Document): HTMLElement | null {
		const view = doc.defaultView
		const scrollable = (el: HTMLElement | null): boolean => {
			if (!el) return false
			if (el.scrollHeight <= el.clientHeight + 2) return false
			const overflow = view?.getComputedStyle?.(el).overflowY
			return (
				overflow === 'auto' ||
				overflow === 'scroll' ||
				overflow === 'overlay' ||
				el === doc.scrollingElement
			)
		}
		const candidates: Array<HTMLElement | null> = [
			doc.querySelector('.markdown-preview-view') as HTMLElement | null,
			doc.scrollingElement as HTMLElement | null,
			doc.documentElement as HTMLElement | null
		]
		for (const el of candidates) if (scrollable(el)) return el
		return (doc.scrollingElement ?? doc.documentElement) as HTMLElement | null
	}

	/**
	 * P2 Task 2 — select an image / Mermaid block by clicking it.
	 *
	 * The listener runs in the parent realm on the iframe document, exactly like
	 * the anchor handler: the frame stays `sandbox="allow-same-origin"` with no
	 * `allow-scripts`, so nothing in the rendered note can run code. A click
	 * either selects a `[data-he-media-id]` block, or clears the selection when
	 * it lands on empty space. Same-note links are left to the anchor handler.
	 *
	 * Selection is *preview-only*: the highlight is an inline outline on the
	 * live iframe node and is never part of `buildHtml`, so it cannot reach an
	 * exported file.
	 */
	private installMediaSelection(): void {
		const doc = this.frame?.contentDocument
		if (!doc || typeof doc.addEventListener !== 'function') return
		this.detachMediaSelect?.()

		const onClick = (event: Event): void => {
			const target = event.target as Element | null
			if (!target || typeof target.closest !== 'function') return
			// A same-note link is a jump, not a selection.
			if (target.closest('a[href^="#"]')) return
			const block = target.closest('[data-he-media-id]') as HTMLElement | null
			if (
				!block ||
				(typeof block.closest === 'function' && !block.closest('.markdown-preview-sizer'))
			) {
				this.selectMedia(null)
				return
			}
			// Only outermost tables carry an id. A click inside a *nested*
			// table would otherwise resolve to the outer table and silently
			// apply「表格设置」to the wrong block. Refuse the selection instead.
			const clickedTable = target.closest('table') as HTMLElement | null
			if (
				clickedTable &&
				clickedTable !== block &&
				typeof block.contains === 'function' &&
				block.contains(clickedTable)
			) {
				this.selectMedia(null)
				return
			}
			this.selectMedia(block)
		}

		const listener = onClick as EventListener
		doc.addEventListener('click', listener, true)
		const detach = (): void => {
			try {
				doc.removeEventListener('click', listener, true)
			} catch {
				/* The document is already gone with the browsing context. */
			}
		}
		this.detachMediaSelect = detach
		this.disposers.push(detach)
	}

	/** Highlight one block and switch the panel to its properties. */
	private selectMedia(block: HTMLElement | null): void {
		const doc = this.frame?.contentDocument
		if (!doc) return
		if (this.selectedMediaEl && this.selectedMediaEl !== block) {
			this.clearHighlight(this.selectedMediaEl)
		}
		const id = block?.getAttribute('data-he-media-id') ?? ''
		if (!block || !id) {
			this.selectedMediaEl = null
			this.panel?.setSelection(null)
			return
		}
		this.selectedMediaEl = block
		this.highlight(block)

		const kind = mediaKind(id, block)
		const sameKind = Array.from(
			doc.querySelectorAll<HTMLElement>('[data-he-media-id]')
		).filter(el => mediaKind(el.getAttribute('data-he-media-id') ?? '', el) === kind)
		const index = Math.max(0, sameKind.indexOf(block)) + 1

		const columnWidth = Math.max(1, this.availableWidth(block, doc))
		const effectivePx = Math.max(1, Math.round(block.getBoundingClientRect().width))
		const effectivePct = Math.min(
			100,
			Math.max(1, Math.round((effectivePx / columnWidth) * 100))
		)

		this.panel?.setSelection({
			id,
			kind,
			label: `${MEDIA_PANEL_TITLE[kind]} · 第 ${index} 张`,
			effectivePct,
			effectivePx,
			columnWidth,
			// A table has no global alignment control of its own: the global
			// 图片 / Mermaid 默认对齐 options are image-block rules and must not
			// be presented as the value a table inherits. `as-is` makes the
			// panel say「跟随主题（未单独设置）」instead.
			globalAlign:
				kind === 'table'
					? 'as-is'
					: kind === 'mermaid'
						? this.layout.mermaidAlign
						: this.layout.imageAlign
		})
	}

	/**
	 * The block's own available width — the base a percentage is relative to.
	 *
	 * Deliberately the *containing block*, not the sizer: a picture inside a
	 * list item is laid out in the item's content box, so `width: 50%` means
	 * half of the space that picture can actually use. Measuring against the
	 * sizer instead would show a "50%" block as 33% and make the number lie.
	 */
	private availableWidth(block: HTMLElement | null, doc: Document): number {
		const parent =
			block?.parentElement ??
			(doc.querySelector('.markdown-preview-sizer') as HTMLElement | null)
		if (!parent) return Math.max(1, doc.documentElement?.clientWidth ?? 1)
		const view = doc.defaultView
		const style = view?.getComputedStyle?.(parent)
		const padLeft = Number.parseFloat(style?.paddingLeft ?? '0') || 0
		const padRight = Number.parseFloat(style?.paddingRight ?? '0') || 0
		return Math.max(1, parent.clientWidth - padLeft - padRight)
	}

	private highlight(block: HTMLElement): void {
		block.setAttribute('data-he-media-selected', '1')
		block.style.setProperty(
			'outline',
			'2px solid var(--interactive-accent, #4c8dff)'
		)
		block.style.setProperty('outline-offset', '3px')
	}

	private clearHighlight(block: HTMLElement): void {
		block.removeAttribute('data-he-media-selected')
		block.style.removeProperty('outline')
		block.style.removeProperty('outline-offset')
	}

	/** Drop the selection without touching the document (it may be gone). */
	private clearMediaSelection(): void {
		if (this.selectedMediaEl) {
			this.clearHighlight(this.selectedMediaEl)
			this.selectedMediaEl = null
		}
		this.panel?.setSelection(null)
	}

	private listen(el: HTMLElement, type: string, handler: () => void): void {
		el.addEventListener(type, handler)
		this.disposers.push(() => el.removeEventListener(type, handler))
	}

	private disposeListeners(): void {
		for (const dispose of this.disposers.splice(0)) {
			try {
				dispose()
			} catch {
				// Teardown must never throw: Obsidian may be mid-close and a
				// second close/unload must remain a harmless no-op.
			}
		}
	}

	/**
	 * Idempotent teardown, only ever called from a close/unload lifecycle.
	 *
	 * `srcdoc` is an HTML *payload*, not a URL: assigning the literal text
	 * "about:blank" would render that string and keep a document alive. Removing
	 * the attribute drops the payload; removing the element lets the browser
	 * discard the frame's browsing context. The visible preview is never touched
	 * by this method — it runs after Obsidian has decided to close the view.
	 */
	private release(): void {
		// Fully idempotent: Obsidian may call `onClose` and `onunload` for one
		// close, and `releaseSession()` must not run twice for one session.
		if (this.released) return
		this.released = true
		const frame = this.frame
		this.frame = null
		this.previewTitleEl = null
		this.pendingHtml = null
		this.liveStyle = null
		this.detachAnchorNav = null
		this.detachMediaSelect = null
		this.selectedMediaEl = null
		this.panel = null
		this.doc = null
		this.refreshBtn = null
		this.kindSelect = null
		this.exportBtn = null
		this.hintEl = null
		this.locationInput = null
		this.locationHintEl = null
		this.modeSelect = null
		this.browseBtn = null
		this.externalPathEl = null
		this.vaultRowEl = null
		this.externalRowEl = null
		this.external = null
		if (frame) {
			frame.removeAttribute('srcdoc')
			frame.remove()
		}
		this.disposeListeners()
		// The snapshot / CSS / audit are the big objects: the plugin drops them
		// here, not on the next open.
		this.host?.releaseSession()
	}
}
