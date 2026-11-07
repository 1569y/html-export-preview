import { App, Modal, Setting } from 'obsidian'

/**
 * P2 使用反馈 #3 — the one place the plugin asks before touching an existing
 * target.
 *
 * The default is *not* to overwrite. Nothing here writes, deletes or renames a
 * file; the modal only produces a decision. `取消` is the focused (safe)
 * button, so pressing Enter or closing the window with Esc can never replace a
 * file. The caller is responsible for the dedicated replace flow, which is the
 * only path allowed to swap a target after an explicit `替换现有文件` click.
 *
 * Stable `data-he-*` attributes exist for the real-UI CDP harness: a native
 * Windows dialog cannot be automated, but an Obsidian modal can.
 */

export type ConflictChoice = 'cancel' | 'save-as' | 'replace'

export interface ConflictOptions {
	title: string
	heading: string
	detail: string
	/** Absolute path shown read-only, exactly as validated by the caller. */
	target: string
	/** Single-file targets may be replaced; directories currently may not. */
	allowReplace: boolean
	/** Extra line explaining how ownership was (or was not) proven. */
	ownership?: string | null
	/** Label for the safe "write somewhere else" action. */
	saveAsLabel?: string
}

export class ExportConflictModal extends Modal {
	private settled = false
	private cancelButton: HTMLButtonElement | null = null

	constructor(
		app: App,
		private readonly options: ConflictOptions,
		private readonly done: (choice: ConflictChoice) => void
	) {
		super(app)
	}

	onOpen(): void {
		const { contentEl, modalEl, titleEl } = this
		modalEl.setAttribute('data-he-conflict', '1')
		modalEl.setAttribute('data-he-conflict-target', this.options.target)
		titleEl.setText(this.options.title)
		contentEl.empty()

		const heading = contentEl.createEl('p', { text: this.options.heading })
		heading.addClass('he-conflict-heading')

		const path = contentEl.createEl('div', { cls: 'he-conflict-path' })
		path.setText(this.options.target)
		path.setAttribute('data-he-conflict-path', '1')

		contentEl.createEl('p', {
			cls: 'setting-item-description',
			text: this.options.detail
		})
		if (this.options.ownership) {
			contentEl.createEl('p', {
				cls: 'setting-item-description',
				text: this.options.ownership
			})
		}

		const row = new Setting(contentEl)

		row.addButton(button => {
			button.setButtonText('取消（保留现有文件）')
			this.cancelButton = button.buttonEl
			button.buttonEl.setAttribute('data-he-choice', 'cancel')
			button.onClick(() => this.finish('cancel'))
		})
		row.addButton(button => {
			button.setButtonText(this.options.saveAsLabel ?? '另存为…')
			button.setCta()
			button.buttonEl.setAttribute('data-he-choice', 'save-as')
			button.onClick(() => this.finish('save-as'))
		})
		if (this.options.allowReplace) {
			row.addButton(button => {
				button.setButtonText('替换现有文件')
				button.setWarning()
				button.buttonEl.setAttribute('data-he-choice', 'replace')
				button.onClick(() => this.finish('replace'))
			})
		}

		// Safe default focus: Enter / space never triggers a replacement.
		this.cancelButton?.focus()
	}

	onClose(): void {
		// Esc / clicking the backdrop is a cancellation, never an overwrite.
		// Do NOT call close() from here: Obsidian is already closing the modal.
		if (this.settled) return
		this.settled = true
		this.done('cancel')
	}

	private finish(choice: ConflictChoice): void {
		if (this.settled) return
		this.settled = true
		this.done(choice)
		this.close()
	}
}

/** Resolve with the user's choice; closing the modal resolves to `cancel`. */
export function askExportConflict(
	app: App,
	options: ConflictOptions
): Promise<ConflictChoice> {
	return new Promise<ConflictChoice>(resolve => {
		new ExportConflictModal(app, options, resolve).open()
	})
}
