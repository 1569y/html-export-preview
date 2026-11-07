import { App, Notice, PluginSettingTab, Setting } from 'obsidian'
import type HtmlExportPlugin from './main'
import { describeErrorSafely, type KeyInitState } from './export/signing-key'

export interface HtmlExportSettings {
	/** Vault-relative folder that receives `index.html` + `assets/`. */
	outputFolder: string
	/**
	 * Per-vault HMAC key used to sign `export-manifest.json` (64 hex chars = 32
	 * bytes), or `''` before it has been generated.
	 *
	 * Round 2A.2.2 (S3). It lives here because `data.json` is already per-vault:
	 * two vaults never share a key, and the key never enters the export
	 * directory. It is **not** a user-facing setting — the settings tab only
	 * reports whether it exists, never its value.
	 */
	signingKey: string
	/**
	 * Independent marker recording whether a key was ever committed to this
	 * vault's config (Round 2A.2.2 Review Fix Round 2, S1). It lets the plugin
	 * tell a genuine first install (`false`, config present) apart from an
	 * *existing key that was lost* (`true` but `signingKey` now empty).
	 *
	 * Round 3 (F-07/F-09) supersedes it with `signingKeyInitState`, which can
	 * also express "history unknown". It is still written, so a Round-2 build
	 * reading the same `data.json` keeps working during a rollback.
	 */
	signingKeyInitialized?: boolean
	/**
	 * Persisted init marker (Round 3, F-07/F-09).
	 *
	 * `undefined` means "the stored config does not record one" — a legacy
	 * 2A.2.2 config. It is **deliberately not defaulted**: filling in
	 * `uninitialized` here is exactly what made a lost key resolve to
	 * `first-init`. Every save writes the marker that `resolveKeyOnLoad`
	 * derived, so `unknown` survives an ordinary settings edit (F-09 #2/#3).
	 */
	signingKeyInitState?: KeyInitState
	/**
	 * Reveal a finished export in the OS file manager (P2 使用反馈 #2).
	 *
	 * Deliberately **optional and absent from `DEFAULT_SETTINGS`**: `data.json`
	 * has strict shape/conflict handling, and a fresh plugin version must not
	 * silently rewrite the user's config just because it gained a preference.
	 * `undefined` therefore means the default (`true`, "on"). The key is written
	 * only when the user actually toggles the switch in the settings tab.
	 */
	showInFolder?: boolean
}

/**
 * Default-on without persisting anything: an existing `data.json` is left
 * byte-for-byte alone until the user makes an explicit choice.
 */
export function showInFolderEnabled(settings: HtmlExportSettings): boolean {
	return settings?.showInFolder !== false
}

/**
 * Visible vault folder, not a config directory.
 *
 * The old default was `.obsidian/plugins/html-export-preview/out`: Obsidian
 * does not index `.obsidian`, the folder disappears from the file explorer,
 * a plugin update can wipe it, and the path is long enough to be mistyped.
 * Review round 2 (D4) moved it to a normal, visible folder.
 */
export const RECOMMENDED_FOLDER = 'html-export'

export const DEFAULT_SETTINGS: HtmlExportSettings = {
	outputFolder: RECOMMENDED_FOLDER,
	signingKey: '',
	signingKeyInitialized: false
}

/**
 * Error → user-facing line. Never includes key material (F-10 #6).
 *
 * Round 3.2.3 (F-02): the body used to be
 *
 *     const raw = error instanceof Error ? error.message : String(error)
 *
 * which is unsafe twice over. `String(error)` runs the thrown value's own
 * `toString`; `.message` is read only after `instanceof` vouched for it, and a
 * `Proxy` can satisfy `instanceof` while throwing from the getter. Both cases
 * crash the handler that exists to *report* a failure — and this one runs inside
 * a settings `onChange`, so the crash would surface as an unhandled rejection.
 * `describeErrorSafely` reads defensively and redacts; it cannot throw.
 */
function describeError(error: unknown): string {
	return describeErrorSafely(error)
}

/**
 * The value actually stored for the folder.
 *
 * Shared by the settings UI and the plugin's transactional writer (R3-02) so
 * the two cannot disagree about what "empty input" means.
 */
export function normalizeOutputFolder(value: string): string {
	return (value ?? '').trim() || RECOMMENDED_FOLDER
}

/** Values that were shipped or observed before the change. */
export const LEGACY_FOLDERS = [
	'.obsidian/plugins/html-export-preview/out',
	'.obsidian/pluagins/html-export-preview/out'
]

export interface FolderIssue {
	kind: 'empty' | 'typo' | 'config-dir' | 'legacy'
	message: string
	suggestion: string
}

/**
 * Diagnose the configured output folder without touching it.
 *
 * The user's `data.json` is their configuration — this only *reports*. Any
 * change has to be an explicit click in the settings tab (review round 2, §6.3).
 */
export function inspectOutputFolder(folder: string): FolderIssue | null {
	const value = (folder ?? '').trim()
	if (!value) {
		return {
			kind: 'empty',
			message: '导出目录为空，将使用默认目录。',
			suggestion: RECOMMENDED_FOLDER
		}
	}

	if (value.toLowerCase().includes('pluagins')) {
		return {
			kind: 'typo',
			message:
				`导出目录包含拼写错误 “pluagins”（应为 “plugins”）：${value}。` +
				'文件确实会写到这个拼错的目录，因此按 plugins 去找会找不到。',
			suggestion: RECOMMENDED_FOLDER
		}
	}

	// `LEGACY_FOLDERS` values all live under `.obsidian`, so this must be asked
	// before the generic config-dir branch or it is unreachable (review B7).
	// The typo'd legacy value is still caught by the typo branch above, which
	// gives a more specific message.
	if (LEGACY_FOLDERS.includes(value)) {
		return {
			kind: 'legacy',
			message: `导出目录仍是旧版默认值：${value}。`,
			suggestion: RECOMMENDED_FOLDER
		}
	}

	if (value.startsWith('.obsidian')) {
		return {
			kind: 'config-dir',
			message:
				`导出目录位于 .obsidian 配置目录内：${value}。` +
				'Obsidian 不索引该目录，文件列表中看不到，插件更新也可能被覆盖。',
			suggestion: RECOMMENDED_FOLDER
		}
	}

	return null
}

export class HtmlExportSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly plugin: HtmlExportPlugin
	) {
		super(app, plugin)
	}

	display(): void {
		const { containerEl } = this
		containerEl.empty()

		new Setting(containerEl)
			.setName('导出目录')
			.setDesc(
				'相对知识库根目录。每篇笔记一个子目录，内含 index.html 与 assets/。' +
					`推荐使用 ${RECOMMENDED_FOLDER}/（知识库内可见，不会与插件文件混淆）。`
			)
			.addText(text =>
				text
					.setPlaceholder(RECOMMENDED_FOLDER)
					.setValue(this.plugin.settings.outputFolder)
					.onChange(async value => {
						// R3-02: transactional. The plugin writes the candidate
						// first and commits the in-memory folder only on success, so
						// a failed save cannot leave an export pointing at a folder
						// that was never persisted. This save is also serialised with
						// key rotation by the plugin's single write queue (F-08).
						// F-10: a failed write must be visible, not just a console line.
						try {
							await this.plugin.updateOutputFolder(value)
						} catch (error) {
							new Notice(
								`设置保存失败：${describeError(error)}\n` +
									'导出目录的改动未写入磁盘，仍沿用上一次成功保存的目录，请重试。',
								0
							)
						}
					})
			)

		const issue = inspectOutputFolder(this.plugin.settings.outputFolder)
		if (issue) {
			const box = containerEl.createDiv({ cls: 'html-export-warning' })
			box.createEl('p', { text: `⚠️ ${issue.message}` })
			box.createEl('p', {
				text:
					'迁移是手动的：本插件不会自动修改你的设置，也不会删除或移动已有导出。'
			})
			new Setting(box)
				.setName('使用推荐目录')
				.setDesc(`将导出目录改为 ${issue.suggestion}/（只改设置，不动已有文件）`)
				.addButton(button =>
					button.setButtonText('改为推荐目录').onClick(async () => {
						// R3-02: same transactional path as the text field — the
						// in-memory folder only moves after the write succeeded.
						try {
							await this.plugin.updateOutputFolder(issue.suggestion)
						} catch (error) {
							new Notice(
								`设置保存失败：${describeError(error)}`,
								0
							)
							return
						}
						this.display()
					})
				)
		}

		new Setting(containerEl)
			.setName('导出完成后在文件资源管理器中显示')
			.setDesc(
				'仅在写盘完成并通过 SHA-256 / 完整性校验后定位文件；' +
					'单文件定位 HTML，完整资源包定位目录内的 index.html。' +
					'取消导出、导出失败或宿主不支持时不会打开任何窗口，也不影响导出结果。' +
					'只打开系统文件管理器，不打开浏览器。'
			)
			.addToggle(toggle =>
				toggle
					.setValue(showInFolderEnabled(this.plugin.settings))
					.onChange(async value => {
						// Transactional, exactly like the output folder: the disk
						// write happens first and memory only moves after it
						// succeeds, so a failed save cannot show a switch that
						// disagrees with `data.json`.
						try {
							await this.plugin.setShowInFolder(value)
						} catch (error) {
							new Notice(
								`设置保存失败：${describeError(error)}\n` +
									'本次改动未写入磁盘，仍沿用上一次成功保存的值。',
								0
							)
							this.display()
						}
					})
			)

		// Round 2A.2.2 Review Fix Round 2 (S1/S2): the key is shown as a status,
		// never as a value. The status line is computed by the plugin, which alone
		// knows whether a config file was present (`configPresent`) and whether the
		// vault was already initialised (`signingKeyInitialized`); that lets it
		// distinguish `first-init` / `lost` / `unknown` and apply the strict
		// two-step confirmation where required (S1 #6).
		const status = this.plugin.getKeyStatusLine()
		new Setting(containerEl)
			.setName('清单签名密钥')
			.setDesc(status.detail)
			.addButton(button => {
				const label = status.action === 'generate' ? '生成密钥' : '重新生成'
				button.setButtonText(label).setWarning()
				let confirming = false
				button.onClick(async () => {
					// S1 #6 / F-01 #5: `lost` / `unknown` / `ready` / `corrupted`
					// require a second confirmation. The first click arms it; the
					// button reverts if not confirmed in time. `first-init` does
					// not require it because no existing exports are at risk.
					if (status.confirmTwice && !confirming) {
						confirming = true
						const confirmText =
							status.action === 'generate'
								? '确认生成新密钥？（旧导出将失效）'
								: '确认重新生成？（旧导出将失效）'
						button.setButtonText(confirmText)
						window.setTimeout(() => {
							confirming = false
							this.display()
						}, 6000)
						return
					}
					confirming = false
					// F-10: the result of the rotation is user-visible. Success and
					// failure get DIFFERENT notices, both quote `result.message`, and
					// a failure never reads as a success (S2 #8). Neither notice ever
					// contains key material — the messages are fixed strings.
					try {
						const result = await this.plugin.rotateSigningKey()
						if (result.changed) {
							new Notice(
								`✅ 签名密钥已生成 / 替换成功。\n${result.message}`,
								8000
							)
						} else {
							new Notice(
								`⚠️ 密钥未变更：${result.message}`, 0
							)
						}
					} catch (error) {
						// F-10 #6: a *key* operation never echoes the raw
						// exception — it is free-form text that can carry key
						// material. The user gets a fixed, actionable line; the
						// sanitised detail goes to the console, so a real fault is
						// still diagnosable and nothing key-shaped is logged.
						console.error(
							'[html-export-preview] 密钥操作异常（已脱敏）：' +
								describeError(error)
						)
						new Notice(
							'⚠️ 密钥操作失败：插件内部错误，密钥未变更。\n' +
								'已脱敏的详细信息见开发者控制台；如持续出现请附带日志反馈。',
							0
						)
					} finally {
						// Re-render from the plugin's real state: a corrupted key must
						// keep being shown as corrupted (F-10 #5).
						this.display()
					}
				})
			})

		containerEl.createEl('p', {
			cls: 'setting-item-description',
			text:
				'预览里点击图片、Mermaid 图或整张表格可单独设置宽度与对齐；' +
				'未单独设置的块跟随预览面板中的全局默认值。'
		})
	}
}
