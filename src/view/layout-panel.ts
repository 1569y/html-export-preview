import {
	CONTENT_WIDTH_MAX,
	CONTENT_WIDTH_MIN,
	DEFAULT_LAYOUT,
	MEDIA_WIDTH_PCT_MAX,
	MEDIA_WIDTH_PCT_MIN,
	MEDIA_WIDTH_PX_MAX,
	MEDIA_WIDTH_PX_MIN,
	normalizeColor,
	normalizeLayout,
	WIDTH_PRESETS,
	ZOOM_MAX,
	ZOOM_MIN,
	ZOOM_PRESETS,
	type ExportLayoutOptions,
	type MediaAlign,
	type MediaOverride,
	type MediaWidthUnit,
	type MermaidAlign,
	type PageBackground,
	type PageLayoutMode
} from '../export/layout-settings'

/**
 * The right-hand settings panel of the preview editor.
 *
 * Two modes, one panel:
 *
 *  - **global** (default) — paper colour, page flow, text column, content size
 *    and the *default* media alignment.
 *  - **element** — entered by clicking an image, a Mermaid block or a whole
 *    table in the preview. It shows width (slider + number, % or px),
 *    alignment, a locked aspect-ratio indicator and 恢复该元素默认设置.
 *    Tables additionally offer「原样（跟随主题）」and hide the aspect-ratio
 *    indicator, which means nothing for a table. Returning to the global
 *    panel is either the 返回全局排版 button or a click on empty space.
 *
 * Why one panel instead of two: the element controls are a strict subset of the
 * global ones, and keeping a single scroll container means the panel never
 * jumps position when the selection changes.
 *
 * The panel owns no DOM outside `host` and never touches the iframe: it reports
 * a **normalised** layout on every change and lets the view decide how to show
 * it. Nothing here re-captures the note, so dragging a slider is one style
 * write, not a capture + CSS scan + font pack.
 *
 * Controls are built once and then *synced* from state. Rebuilding the panel on
 * every change would drop focus and interrupt a slider drag.
 */

const WIDTH_CUSTOM = 'custom'
const WIDTH_THEME = 'theme'

const ALIGN_LABEL: Record<MediaAlign, string> = {
	'as-is': '原样（跟随主题）',
	left: '左对齐',
	center: '居中',
	right: '右对齐'
}

/** What the view knows about the element the user just clicked. */
export interface MediaSelection {
	id: string
	kind: 'image' | 'mermaid' | 'table'
	/** Human label, e.g. `图片设置 · 第 2 张` / `表格设置 · 第 1 张`. */
	label: string
	/** Measured width of the block, as a percentage of the text column. */
	effectivePct: number
	/** Measured width of the block, in CSS pixels. */
	effectivePx: number
	/**
	 * Available width of the block's containing area, in CSS pixels — the base
	 * for the percentage and for % ↔ px conversion.
	 */
	columnWidth: number
	/** The global setting this element inherits while no override exists. */
	globalAlign: MediaAlign
}

export interface LayoutPanelOptions {
	/** "恢复默认" button; on by default. */
	showReset?: boolean
	/**
	 * Collector for teardown callbacks. Every listener this panel adds is
	 * reported here so the view can detach them when it closes — a detached
	 * panel would otherwise keep its handlers, and its closures, alive.
	 */
	register?: (dispose: () => void) => void
	/** The user pressed 返回全局排版: the view clears its highlight. */
	onExitMedia?: () => void
}

export class LayoutPanel {
	private state: ExportLayoutOptions
	private selected: MediaSelection | null = null

	/** Where the currently built controls are appended. */
	private mount!: HTMLElement
	private globalHost!: HTMLElement
	private mediaHost!: HTMLElement

	private backgroundSelect!: HTMLSelectElement
	private backgroundSwatch!: HTMLInputElement

	private pageLayoutSelect!: HTMLSelectElement

	private widthSelect!: HTMLSelectElement
	private widthInput!: HTMLInputElement

	private zoomRange!: HTMLInputElement
	private zoomLabel!: HTMLElement

	private imageAlignSelect!: HTMLSelectElement
	private mermaidAlignSelect!: HTMLSelectElement

	private mediaTitle!: HTMLElement
	private mediaUnit!: HTMLSelectElement
	private mediaUnitAsIs!: HTMLOptionElement
	private mediaRange!: HTMLInputElement
	private mediaNumber!: HTMLInputElement
	private mediaAlign!: HTMLSelectElement
	private mediaReset!: HTMLButtonElement
	private mediaHint!: HTMLElement
	private mediaRatioLabel!: HTMLElement

	constructor(
		private readonly host: HTMLElement,
		initial: Partial<ExportLayoutOptions> | undefined,
		private readonly onChange: (layout: ExportLayoutOptions) => void,
		private readonly options: LayoutPanelOptions = {}
	) {
		this.state = normalizeLayout(initial)
		this.build()
		this.sync()
		this.syncMedia()
	}

	/** Current normalised layout. A copy: callers must not mutate ours. */
	get layout(): ExportLayoutOptions {
		return { ...this.state, mediaOverrides: { ...this.state.mediaOverrides } }
	}

	/**
	 * Adopt a layout from outside (a preset, a refresh, a future saved profile)
	 * and push the values back into the controls. Does **not** fire `onChange`:
	 * an adopted layout is already what the caller asked for.
	 */
	update(next: Partial<ExportLayoutOptions>): void {
		this.state = normalizeLayout({ ...this.state, ...next })
		this.sync()
		this.syncMedia()
	}

	/** Back to the defaults, and report it. */
	reset(next: Partial<ExportLayoutOptions> = DEFAULT_LAYOUT): void {
		this.state = normalizeLayout(next)
		this.sync()
		this.syncMedia()
		this.fire()
	}

	/**
	 * Enter / leave element mode. `null` restores the global controls.
	 * Does not fire `onChange`: selecting an element changes no layout value.
	 */
	setSelection(selection: MediaSelection | null): void {
		this.selected = selection
		this.syncMedia()
	}

	/* ------------------------------------------------------------- building -- */

	private build(): void {
		const root = this.host
		root.empty()
		root.addClass('he-panel')

		this.globalHost = root.createDiv({ cls: 'he-panel-global' })
		this.mediaHost = root.createDiv({ cls: 'he-panel-media' })

		this.mount = this.globalHost
		this.buildGlobal()

		this.mount = this.mediaHost
		this.buildMedia()

		this.mount = this.globalHost
	}

	private buildGlobal(): void {
		this.section('背景')
		this.backgroundSelect = this.select(
			'background',
			[
				['theme', '跟随 Obsidian 样式'],
				['white', '白色'],
				['custom', '自定义颜色']
			],
			() => this.patch({ background: this.backgroundSelect.value as PageBackground })
		)
		this.backgroundSwatch = this.colorInput(value =>
			this.patch({ background: 'custom', backgroundColor: value })
		)

		this.section('页面布局')
		this.pageLayoutSelect = this.select(
			'pageLayout',
			[
				['adaptive-center', '响应式居中'],
				['as-is', '原样（冻结抓取宽度）']
			],
			() => this.patch({ pageLayout: this.pageLayoutSelect.value as PageLayoutMode })
		)

		this.section('正文最大宽度')
		this.widthSelect = this.select(
			'contentMaxWidth',
			[
				[WIDTH_THEME, '跟随主题'],
				...WIDTH_PRESETS.map(width => [`${width}`, `${width}px`] as [string, string]),
				[WIDTH_CUSTOM, '自定义…']
			],
			() => this.onWidthSelect()
		)
		this.widthInput = this.numberInput(
			'contentMaxWidth',
			CONTENT_WIDTH_MIN,
			CONTENT_WIDTH_MAX,
			10,
			value => this.patch({ contentMaxWidth: value })
		)

		this.section('内容大小')
		this.zoomRange = this.range(
			'zoom',
			Math.round(ZOOM_MIN * 100),
			Math.round(ZOOM_MAX * 100),
			5,
			value => this.patch({ zoom: value / 100 })
		)
		this.zoomLabel = this.mount.createDiv({ cls: 'he-panel-value he-zoom-label' })
		const chips = this.mount.createDiv({ cls: 'he-panel-chips' })
		for (const preset of ZOOM_PRESETS) {
			const btn = chips.createEl('button', {
				cls: 'he-chip',
				text: `${Math.round(preset * 100)}%`
			})
			this.listen(btn, 'click', () => this.patch({ zoom: preset }))
		}

		this.section('图片默认对齐')
		this.imageAlignSelect = this.select(
			'imageAlign',
			[
				['as-is', '原样（跟随主题）'],
				['left', '左对齐'],
				['center', '居中'],
				['right', '右对齐']
			],
			() =>
				this.patch({
					imageAlign: this.imageAlignSelect.value as MediaAlign
				})
		)

		this.section('Mermaid 默认对齐')
		this.mermaidAlignSelect = this.select(
			'mermaidAlign',
			[
				['as-is', '原样（跟随主题）'],
				['left', '左对齐'],
				['center', '居中'],
				['right', '右对齐']
			],
			() => this.patch({ mermaidAlign: this.mermaidAlignSelect.value as MermaidAlign })
		)
		// Honest UI: an image that already fills the text column physically has
		// nowhere to move. Say so, and point at the two controls that really do
		// create free space (both work now: the canvas no longer shrinks back
		// and a px 正文最大宽度 applies even without .is-readable-line-width).
		this.hint(
			'点击预览中的图片、Mermaid 图或整张表格可单独设置它的宽度与对齐；' +
				'表格还可选「原样」保留主题排版。未单独设置时跟随这里的默认值。' +
				'若图块已占满正文列，左/中/右不会有可见位移。'
		)

		if (this.options.showReset !== false) {
			const reset = this.mount.createEl('button', {
				cls: 'he-panel-reset',
				text: '恢复默认排版'
			})
			this.listen(reset, 'click', () => this.reset())
		}
	}

	private buildMedia(): void {
		this.mediaTitle = this.mount.createDiv({ cls: 'he-media-title' })

		this.section('宽度')
		this.mediaUnit = this.select(
			'mediaWidthUnit',
			[
				['pct', '百分比（% 可用宽度）'],
				['px', '像素（px）'],
				// Only tables offer "as-is": a picture / diagram always has a
				// measured width the slider can start from. Kept last so the
				// default for the existing two kinds is still `pct`.
				['as-is', '原样（跟随主题）']
			],
			() => this.onMediaUnitChange()
		)
		this.mediaUnitAsIs = Array.from(this.mediaUnit.options ?? []).find(
			option => option.value === 'as-is'
		) as HTMLOptionElement
		this.mediaRange = this.range('mediaWidthRange', MEDIA_WIDTH_PCT_MIN, MEDIA_WIDTH_PCT_MAX, 1, value =>
			this.applyMediaWidth(value, this.numericUnit())
		)
		this.mediaNumber = this.numberInput(
			'mediaWidthNumber',
			MEDIA_WIDTH_PCT_MIN,
			MEDIA_WIDTH_PCT_MAX,
			1,
			value => this.applyMediaWidth(value, this.numericUnit())
		)

		this.section('对齐')
		this.mediaAlign = this.select(
			'mediaAlign',
			[
				['inherit', '跟随全局'],
				['left', '左对齐'],
				['center', '居中'],
				['right', '右对齐']
			],
			() => this.onMediaAlignChange()
		)

		// The renderer always writes `height: auto` for these blocks, so the
		// aspect ratio is structurally preserved. The checkbox is checked and
		// disabled rather than omitted: a user looking for the option finds the
		// honest answer instead of wondering whether the picture is distorted.
		this.mediaRatioLabel = this.mount.createEl('label', { cls: 'he-media-ratio' })
		const ratioLabel = this.mediaRatioLabel
		const ratio = ratioLabel.createEl('input')
		ratio.setAttribute('type', 'checkbox')
		ratio.setAttribute('data-he-control', 'mediaKeepRatio')
		ratio.checked = true
		ratio.disabled = true
		// Plain `append` (not Obsidian's `appendText`) keeps this panel usable
		// on the minimal DOM double the lifecycle tests run against.
		ratioLabel.append(' 保持原始宽高比')

		this.mediaReset = this.mount.createEl('button', {
			cls: 'he-media-reset',
			text: '恢复该元素默认设置'
		})
		this.listen(this.mediaReset, 'click', () => this.clearMediaOverride())

		const back = this.mount.createEl('button', {
			cls: 'he-media-back',
			text: '返回全局排版'
		})
		this.listen(back, 'click', () => {
			this.setSelection(null)
			this.options.onExitMedia?.()
		})

		this.mediaHint = this.mount.createDiv({ cls: 'he-panel-hint' })
		this.mediaHint.setText(
			'只影响当前选中的这一个元素；其他图块仍跟随全局默认值。'
		)
	}

	private onWidthSelect(): void {
		const value = this.widthSelect.value
		if (value === WIDTH_THEME) {
			this.patch({ contentMaxWidth: 'theme' })
			return
		}
		if (value === WIDTH_CUSTOM) {
			// Keep the number the user already had; start from the narrowest
			// preset so the input is never empty.
			const current = this.state.contentMaxWidth
			this.patch({
				contentMaxWidth: typeof current === 'number' ? current : WIDTH_PRESETS[0]
			})
			return
		}
		this.patch({ contentMaxWidth: Number(value) })
	}

	/* --------------------------------------------------------- media edits -- */

	/** The raw unit select value. Only tables can legitimately be `as-is`. */
	private currentUnit(): MediaWidthUnit | 'as-is' {
		if (this.mediaUnit?.value === 'as-is') return 'as-is'
		return this.mediaUnit?.value === 'px' ? 'px' : 'pct'
	}

	/** A slider / number callback always needs numeric bounds. */
	private numericUnit(): MediaWidthUnit {
		return this.currentUnit() === 'px' ? 'px' : 'pct'
	}

	/** Width bounds for the active unit; shared by the slider and the input. */
	private unitBounds(unit: MediaWidthUnit): { min: number; max: number; step: number } {
		return unit === 'px'
			? { min: MEDIA_WIDTH_PX_MIN, max: MEDIA_WIDTH_PX_MAX, step: 10 }
			: { min: MEDIA_WIDTH_PCT_MIN, max: MEDIA_WIDTH_PCT_MAX, step: 1 }
	}

	private onMediaUnitChange(): void {
		const selection = this.selected
		if (!selection) return
		const unit = this.currentUnit()
		if (unit === 'as-is') {
			// "原样" must emit *no* width declaration at all. Deleting the field
			// (rather than writing `width: auto`) keeps the theme's own table
			// sizing, borders, header cells and spanning intact, and leaves a
			// wide table scrollable instead of squeezing its columns.
			this.patchMedia({ width: undefined })
			return
		}
		const previous = this.state.mediaOverrides[selection.id]?.width
		const currentValue = Number(this.mediaNumber.value)
		const source = Number.isFinite(currentValue)
			? currentValue
			: previous?.value ?? selection.effectivePct

		// Convert through the measured column so switching units keeps the
		// picture the same physical size instead of reinterpreting 50 as 50px.
		let value = source
		const column = Math.max(1, selection.columnWidth)
		if (unit === 'px' && (previous?.unit ?? 'pct') === 'pct') {
			value = Math.round((column * source) / 100)
		} else if (unit === 'pct' && previous?.unit === 'px') {
			value = Math.round((source / column) * 100)
		}
		this.applyMediaWidth(value, unit)
	}

	private applyMediaWidth(value: number, unit: MediaWidthUnit): void {
		const selection = this.selected
		if (!selection) return
		if (!Number.isFinite(value)) return
		const bounds = this.unitBounds(unit)
		const clamped = Math.min(bounds.max, Math.max(bounds.min, Math.round(value)))
		this.patchMedia({ width: { value: clamped, unit } })
	}

	private onMediaAlignChange(): void {
		const value = this.mediaAlign.value
		if (value === 'inherit') {
			this.patchMedia({ align: undefined })
			return
		}
		if (value === 'left' || value === 'center' || value === 'right') {
			this.patchMedia({ align: value })
		}
	}

	private clearMediaOverride(): void {
		this.patchMedia(null)
	}

	/**
	 * Merge one change into the selected element's override.
	 *
	 * `null` deletes the entry (恢复该元素默认设置). An entry with neither width
	 * nor alignment is deleted too: "follow everything global" and "no entry"
	 * must be the same state, otherwise a later global change would not reach
	 * the element.
	 */
	private patchMedia(change: Partial<MediaOverride> | null): void {
		const selection = this.selected
		if (!selection) return
		const next: Record<string, MediaOverride> = { ...this.state.mediaOverrides }
		if (change === null) {
			delete next[selection.id]
		} else {
			const merged: MediaOverride = { ...(next[selection.id] ?? {}), ...change }
			if (!merged.width) delete merged.width
			if (!merged.align) delete merged.align
			if (merged.width || merged.align) next[selection.id] = merged
			else delete next[selection.id]
		}
		this.state = normalizeLayout({ ...this.state, mediaOverrides: next })
		this.sync()
		this.syncMedia()
		this.fire()
	}

	/* --------------------------------------------------------------- pieces -- */

	private section(title: string): void {
		this.mount.createDiv({ cls: 'he-panel-section', text: title })
	}

	/** Read-only explanation shown next to a setting, never a control. */
	private hint(text: string): void {
		this.mount.createDiv({ cls: 'he-panel-hint', text })
	}

	private select(
		key: string,
		entries: Array<[string, string]>,
		onChange: () => void
	): HTMLSelectElement {
		const el = this.mount.createEl('select', { cls: 'dropdown he-panel-select' })
		el.setAttribute('data-he-control', key)
		for (const [value, text] of entries) {
			const option = el.createEl('option', { text })
			option.setAttribute('value', value)
		}
		this.listen(el, 'change', onChange)
		return el
	}

	private colorInput(onChange: (value: string) => void): HTMLInputElement {
		const el = this.mount.createEl('input', { cls: 'he-panel-color' })
		el.setAttribute('data-he-control', 'backgroundColor')
		el.setAttribute('type', 'color')
		el.setAttribute('title', '自定义背景色')
		this.listen(el, 'change', () => {
			const value = normalizeColor(el.value)
			if (value) onChange(value)
		})
		return el
	}

	private numberInput(
		control: string,
		min: number,
		max: number,
		step: number,
		onChange: (value: number) => void
	): HTMLInputElement {
		const el = this.mount.createEl('input', { cls: 'he-panel-number' })
		el.setAttribute('data-he-control', control)
		el.setAttribute('type', 'number')
		el.setAttribute('min', `${min}`)
		el.setAttribute('max', `${max}`)
		el.setAttribute('step', `${step}`)
		// `change`, not `input`: a half-typed "9" must not resize the page to
		// the clamp floor while the user is still typing "900".
		this.listen(el, 'change', () => {
			const value = Number(el.value)
			if (Number.isFinite(value)) onChange(Math.round(value))
		})
		return el
	}

	private range(
		control: string,
		min: number,
		max: number,
		step: number,
		onChange: (value: number) => void
	): HTMLInputElement {
		const el = this.mount.createEl('input', { cls: 'he-panel-range' })
		el.setAttribute('data-he-control', control)
		el.setAttribute('type', 'range')
		el.setAttribute('min', `${min}`)
		el.setAttribute('max', `${max}`)
		el.setAttribute('step', `${step}`)
		this.listen(el, 'input', () => onChange(Number(el.value)))
		return el
	}

	private listen(el: HTMLElement, type: string, handler: () => void): void {
		el.addEventListener(type, handler)
		this.options.register?.(() => el.removeEventListener(type, handler))
	}

	/* ------------------------------------------------------------ reporting -- */

	private patch(change: Partial<ExportLayoutOptions>): void {
		this.state = normalizeLayout({ ...this.state, ...change })
		this.sync()
		this.syncMedia()
		this.fire()
	}

	private fire(): void {
		this.onChange(this.layout)
	}

	/** Write state into the controls, without dispatching any event. */
	private sync(): void {
		const state = this.state

		this.backgroundSelect.value = state.background
		this.backgroundSwatch.value = state.backgroundColor
		this.backgroundSwatch.style.display =
			state.background === 'custom' ? '' : 'none'

		this.pageLayoutSelect.value = state.pageLayout

		const width = state.contentMaxWidth
		if (width === 'theme') this.widthSelect.value = WIDTH_THEME
		else if ((WIDTH_PRESETS as readonly number[]).includes(width))
			this.widthSelect.value = `${width}`
		else this.widthSelect.value = WIDTH_CUSTOM

		const custom = typeof width === 'number'
		this.widthInput.style.display = custom ? '' : 'none'
		this.widthInput.value = `${custom ? (width as number) : WIDTH_PRESETS[0]}`

		const percent = Math.round(state.zoom * 100)
		this.zoomRange.value = `${percent}`
		this.zoomLabel.setText(`${percent}%`)

		this.imageAlignSelect.value = state.imageAlign
		this.mermaidAlignSelect.value = state.mermaidAlign
	}

	/** Show/hide the two modes and fill the element controls from state. */
	private syncMedia(): void {
		const selection = this.selected
		const active = !!selection
		// Explicit values, never `''`. styles.css deliberately has no fallback
		// `display:none` rule: clearing the inline declaration used to fall back
		// to `.he-panel-media { display:none }`, which hid the element panel
		// while `globalHost` was also hidden — the whole right-hand panel went
		// blank on selection even though the click and the highlight worked.
		this.globalHost.style.display = active ? 'none' : 'block'
		this.mediaHost.style.display = active ? 'block' : 'none'
		if (!selection) return

		this.mediaTitle.setText(selection.label)
		const isTable = selection.kind === 'table'
		if (this.mediaUnitAsIs) {
			this.mediaUnitAsIs.hidden = !isTable
			this.mediaUnitAsIs.disabled = !isTable
		}
		this.mediaRatioLabel.style.display = isTable ? 'none' : ''
		this.mediaHint.setText(
			isTable
				? '只影响当前选中的这一张表格；其他表格不受影响。「原样」保留主题样式，过宽的表格可横向滚动查看，不会压缩单元格文字。'
				: '只影响当前选中的这一个图块；其他图片 / 图表仍跟随全局默认值。宽度不会超过正文列，超出时按比例缩小而不是裁切。'
		)

		const override = this.state.mediaOverrides[selection.id]
		const measured = Math.max(
			MEDIA_WIDTH_PCT_MIN,
			Math.min(MEDIA_WIDTH_PCT_MAX, Math.round(selection.effectivePct))
		)
		const width: { value: number; unit: MediaWidthUnit | 'as-is' } =
			override?.width ?? {
				value: measured,
				unit: isTable ? 'as-is' : 'pct'
			}
		const numericUnit: MediaWidthUnit = width.unit === 'as-is' ? 'pct' : width.unit
		const bounds = this.unitBounds(numericUnit)
		this.mediaUnit.value = width.unit
		const showNumber = width.unit !== 'as-is'
		this.mediaRange.style.display = showNumber ? '' : 'none'
		this.mediaNumber.style.display = showNumber ? '' : 'none'
		this.mediaRange.min = `${bounds.min}`
		this.mediaRange.max = `${bounds.max}`
		this.mediaRange.step = `${bounds.step}`
		this.mediaRange.value = `${width.value}`
		this.mediaNumber.min = `${bounds.min}`
		this.mediaNumber.max = `${bounds.max}`
		this.mediaNumber.step = `${bounds.step}`
		this.mediaNumber.value = `${width.value}`

		this.mediaAlign.value = override?.align ?? 'inherit'
		const inheritOption = this.mediaAlign.options?.[0]
		if (inheritOption) {
			inheritOption.text =
				isTable && selection.globalAlign === 'as-is'
					? '跟随主题（未单独设置）'
					: `跟随全局（${ALIGN_LABEL[selection.globalAlign]}）`
		}
		this.mediaReset.disabled = !override
	}
}
