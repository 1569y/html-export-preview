/**
 * Task 3 — the *host* half of exporting outside the vault.
 *
 * Everything here is a capability probe, not an assumption. The plugin runs on
 * Obsidian desktop (Electron) and would run unchanged on mobile, where there is
 * no `require`, no `electron` and no Node `fs`. Rather than feature-detect with
 * a version string, each capability is looked up once and reported as data:
 *
 *   dialog — `electron.remote.dialog` or `@electron/remote`'s dialog
 *   fs     — `node:fs/promises` (falling back to `fs.promises`)
 *   path   — `node:path`
 *   shell  — `electron.shell.showItemInFolder` (revealing a finished export)
 *
 * A missing capability is a *reason the UI can show*, never a crash: the
 * preview panel keeps the vault-internal mode working and disables the
 * "computer" option with the reason attached. `shell` is deliberately NOT part
 * of that gate: a host that can write files but cannot open Explorer must still
 * be able to export — only the "show in folder" convenience degrades.
 *
 * `require` is the module loader Obsidian gives a plugin bundle (esbuild emits
 * CommonJS and marks `electron` plus Node builtins as external), so it is used
 * as the single entry point instead of `import`, which would make the bundle
 * fail to load on mobile at require time rather than degrade at call time.
 */

export interface SavePathOptions {
	title: string
	/** Absolute path the dialog starts at. */
	defaultPath: string
	/** Suggested file name without a directory. */
	defaultName: string
}

export interface PickFolderOptions {
	title: string
	defaultPath: string
}

export interface ExternalHost {
	/** Absolute path of the vault root, as reported by the vault adapter. */
	vaultBase: string
	/** Absolute path of this plugin's install directory (never a write target). */
	pluginDir: string
	/** Absolute path of the vault's `.obsidian` directory (never a write target). */
	configDir: string
	/** Returns the chosen absolute file path, or null when the user cancelled. */
	savePath(options: SavePathOptions): Promise<string | null>
	/** Returns the chosen absolute folder, or null when the user cancelled. */
	pickFolder(options: PickFolderOptions): Promise<string | null>
	/**
	 * Reveal an already-written file in the OS file manager. Optional so a host
	 * without Electron's `shell` still exports normally.
	 * Returns `false` when unsupported or when the call failed.
	 */
	showItemInFolder?(fullPath: string): boolean
	fs: FsPromises
	path: PathModule
}

/** The subset of `node:fs/promises` this feature needs, so it can be faked. */
export interface FsPromises {
	lstat(path: string): Promise<{
		isSymbolicLink(): boolean
		isDirectory(): boolean
		isFile(): boolean
		size?: number
	}>
	stat(path: string): Promise<{
		isDirectory(): boolean
		isFile(): boolean
		size?: number
		mtimeMs?: number
		ctimeMs?: number
	}>
	readdir(
		path: string,
		options: { withFileTypes: true }
	): Promise<Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>>
	readFile(path: string): Promise<Uint8Array>
	readFile(path: string, encoding: 'utf8'): Promise<string>
	writeFile(path: string, data: Uint8Array | string, options?: { encoding?: 'utf8' }): Promise<void>
	/**
	 * `recursive: false` (or no options) is the atomic exclusive claim used by
	 * `publishExclusive`; `recursive: true` is the ordinary staging mkdir.
	 */
	mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined>
	rename(from: string, to: string): Promise<void>
	unlink(path: string): Promise<void>
	rm(path: string, options: { recursive: boolean; force: boolean }): Promise<void>
	access(path: string): Promise<void>
	open(path: string, flags: string): Promise<FileHandleLike>
}

export interface FileHandleLike {
	/** Node resolves with the number of bytes written; a short write is legal. */
	write(data: Uint8Array): Promise<{ bytesWritten: number }>
	sync(): Promise<void>
	close(): Promise<void>
}

/** The subset of `node:path` this feature needs. */
export interface PathModule {
	sep: string
	isAbsolute(value: string): boolean
	normalize(value: string): string
	resolve(...parts: string[]): string
	join(...parts: string[]): string
	dirname(value: string): string
	basename(value: string): string
	relative(from: string, to: string): string
	parse(value: string): { root: string; dir: string; base: string; name: string; ext: string }
}

export interface HostCapabilities {
	desktop: boolean
	dialog: boolean
	fs: boolean
	path: boolean
	/** Whether the OS file manager can be opened after a successful export. */
	showInFolder: boolean
	/** One sentence for the UI when the option is unavailable. */
	reason: string | null
}

/** Minimal shape of the Electron `dialog` object we call. */
interface ElectronDialog {
	showSaveDialog(options: Record<string, unknown>): Promise<{ canceled: boolean; filePath?: string }>
	showOpenDialog(options: Record<string, unknown>): Promise<{ canceled: boolean; filePaths?: string[] }>
}

/** Minimal shape of Electron's `shell`, whose `showItemInFolder` is synchronous. */
interface ElectronShell {
	showItemInFolder(fullPath: string): void
}

type RequireFn = (id: string) => unknown

function getRequire(): RequireFn | null {
	const candidate = (globalThis as { require?: unknown }).require
	return typeof candidate === 'function' ? (candidate as RequireFn) : null
}

function tryRequire<T>(load: RequireFn, id: string): T | null {
	try {
		const value = load(id)
		return (value as T) ?? null
	} catch {
		return null
	}
}

/** `electron.remote.dialog`, else `@electron/remote`'s. */
function resolveDialog(load: RequireFn): ElectronDialog | null {
	const electron = tryRequire<{ remote?: { dialog?: ElectronDialog } }>(load, 'electron')
	const fromElectron = electron?.remote?.dialog
	if (fromElectron && typeof fromElectron.showSaveDialog === 'function') {
		return fromElectron
	}
	const remote = tryRequire<{ dialog?: ElectronDialog }>(load, '@electron/remote')
	const fromPackage = remote?.dialog
	if (fromPackage && typeof fromPackage.showSaveDialog === 'function') {
		return fromPackage
	}
	return null
}

/**
 * Electron's `shell` module, or `null`.
 *
 * `shell` is documented as a main-process module that is *also* available in a
 * non-sandboxed renderer via `require('electron')`, which is how Obsidian loads
 * plugin bundles. Not every build exposes it there, so three safe spellings are
 * probed instead of assuming one:
 *
 *   1. `electron.shell`                                (Obsidian desktop today)
 *   2. `@electron/remote`'s re-exported `shell`       (older remote builds)
 *   3. `@electron/remote`.require('electron').shell   (remote's main-process view)
 *
 * Each lookup is defensive: a `require` that throws, a getter that throws, or a
 * missing `showItemInFolder` all degrade to `null`. Nothing here opens anything
 * — it only answers "could we?" so a successful export is never turned into a
 * reported failure just because Explorer could not be launched.
 */
function resolveShell(load: RequireFn): ElectronShell | null {
	const hasShow = (value: unknown): value is ElectronShell =>
		!!value &&
		typeof (value as { showItemInFolder?: unknown }).showItemInFolder === 'function'

	const electron = tryRequire<{ shell?: unknown }>(load, 'electron')
	if (hasShow(electron?.shell)) return electron.shell

	const remote = tryRequire<{
		shell?: unknown
		require?: (id: string) => unknown
	}>(load, '@electron/remote')
	if (hasShow(remote?.shell)) return remote.shell
	if (typeof remote?.require === 'function') {
		try {
			const main = remote.require('electron') as { shell?: unknown } | null
			if (hasShow(main?.shell)) return main.shell
		} catch {
			// Fall through to "unsupported".
		}
	}
	return null
}

/**
 * Reveal one finished file in the OS file manager.
 *
 * Intentionally synchronous (Electron's API is), intentionally total (never
 * throws) and intentionally independent of `ExternalHost`: vault-internal
 * exports have no external host object but still deserve the same behaviour.
 *
 * Callers MUST invoke this only after the bytes are on disk and verified; a
 * cancelled or failed export must never reach this function.
 */
export function revealInFolder(fullPath: string): boolean {
	if (typeof fullPath !== 'string' || !fullPath) return false
	const load = getRequire()
	if (!load) return false
	const shell = resolveShell(load)
	if (!shell) return false
	try {
		shell.showItemInFolder(fullPath)
		return true
	} catch {
		// A missing Explorer, a bad path or a locked shell is not an export
		// failure. The caller logs it; the success Notice stays a success.
		return false
	}
}

function resolveFs(load: RequireFn): FsPromises | null {
	const direct = tryRequire<FsPromises>(load, 'node:fs/promises')
	if (direct && typeof direct.open === 'function') return direct
	const legacy = tryRequire<{ promises?: FsPromises }>(load, 'fs')
	if (legacy?.promises && typeof legacy.promises.open === 'function') return legacy.promises
	return null
}

function resolvePath(load: RequireFn): PathModule | null {
	const direct = tryRequire<PathModule>(load, 'node:path')
	if (direct && typeof direct.resolve === 'function') return direct
	return null
}

/**
 * What this runtime can do, without touching the filesystem.
 *
 * Kept separate from `resolveExternalHost` so the settings tab and the preview
 * footer can explain *why* the option is unavailable before the user tries it.
 */
export function hostCapabilities(): HostCapabilities {
	const load = getRequire()
	if (!load) {
		return {
			desktop: false,
			dialog: false,
			fs: false,
			path: false,
			showInFolder: false,
			reason: '当前运行环境没有模块加载器（移动端），无法访问电脑上的文件夹。'
		}
	}
	const dialog = resolveDialog(load)
	const fs = resolveFs(load)
	const path = resolvePath(load)
	const shell = resolveShell(load)
	const missing: string[] = []
	if (!dialog) missing.push('系统文件对话框')
	if (!fs) missing.push('文件读写接口')
	if (!path) missing.push('路径解析接口')
	return {
		// `shell` is deliberately excluded: exporting must work even when the
		// file manager cannot be opened.
		desktop: !!dialog && !!fs && !!path,
		dialog: !!dialog,
		fs: !!fs,
		path: !!path,
		showInFolder: !!shell,
		reason: missing.length
			? `当前运行环境缺少${missing.join('、')}，只能在 Vault 内导出。`
			: null
	}
}

/**
 * Build the host, or explain why it cannot be built.
 *
 * `vaultBase`/`pluginDir`/`configDir` are passed in rather than discovered
 * here: the caller already has the `App` and knows `manifest.dir`, and keeping
 * this module free of Obsidian imports lets the unit tests run it with a fake
 * `require`.
 */
export function createExternalHost(input: {
	load?: RequireFn
	vaultBase: string
	/** Vault-relative install directory, e.g. `.obsidian/plugins/html-export-preview`. */
	pluginDirRelative: string
	/** Vault-relative config directory, normally `.obsidian`. */
	configDirRelative: string
}): { host: ExternalHost | null; reason: string | null } {
	const load = input.load ?? getRequire()
	if (!load) {
		return { host: null, reason: '当前运行环境没有模块加载器（移动端），无法访问电脑上的文件夹。' }
	}
	const dialog = resolveDialog(load)
	const fs = resolveFs(load)
	const path = resolvePath(load)
	const shell = resolveShell(load)
	if (!dialog || !fs || !path) {
		const missing: string[] = []
		if (!dialog) missing.push('系统文件对话框')
		if (!fs) missing.push('文件读写接口')
		if (!path) missing.push('路径解析接口')
		return {
			host: null,
			reason: `当前运行环境缺少${missing.join('、')}，只能在 Vault 内导出。`
		}
	}

	return {
		host: {
			vaultBase: path.resolve(input.vaultBase),
			pluginDir: path.resolve(input.vaultBase, input.pluginDirRelative),
			configDir: path.resolve(input.vaultBase, input.configDirRelative),
			fs,
			path,
			showItemInFolder(fullPath: string): boolean {
				if (!shell) return false
				try {
					shell.showItemInFolder(fullPath)
					return true
				} catch {
					return false
				}
			},
			async savePath(options) {
				const result = await dialog.showSaveDialog({
					title: options.title,
					defaultPath: path.join(options.defaultPath, options.defaultName),
					// `showOverwriteConfirmation` is macOS-only; Windows and Linux
					// confirm natively. The plugin refuses to overwrite regardless,
					// so the dialog's answer is never treated as permission.
					properties: ['createDirectory', 'showOverwriteConfirmation'],
					filters: [{ name: 'HTML 文档', extensions: ['html'] }]
				})
				if (!result || result.canceled || !result.filePath) return null
				return result.filePath
			},
			async pickFolder(options) {
				const result = await dialog.showOpenDialog({
					title: options.title,
					defaultPath: options.defaultPath,
					properties: ['openDirectory', 'createDirectory']
				})
				if (!result || result.canceled) return null
				const chosen = result.filePaths?.[0]
				return chosen ? chosen : null
			}
		},
		reason: null
	}
}
