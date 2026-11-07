/**
 * Task 3 — turning a path the user picked in the system dialog into something
 * the exporter is allowed to write to.
 *
 * The dialog is the only way to obtain this path (the preview shows it
 * read-only, there is no text field to type one into), but a path returned by a
 * dialog is still an untrusted string by the time it reaches the writer: it can
 * name a symlink, a junction, the plugin's own install directory, or the vault
 * config that holds `data.json`. So it is validated again at the moment of
 * writing, exactly like `assertVaultRelativeLocation` is for the vault-internal
 * mode — the view is never the security boundary.
 *
 * Refused here, with the reason the user sees:
 *
 *   - a relative path (the dialog always returns an absolute one, so this only
 *     fires on a programming error — but then it must not silently become
 *     "relative to the vault");
 *   - any `..` segment, checked before normalising so `a/../../b` cannot be
 *     collapsed into something that looks contained;
 *   - a path whose existing ancestors include a symlink or a Windows junction.
 *     Those are how a "folder the user picked" turns into a different folder
 *     after the check, and the export would land somewhere nobody chose;
 *   - anything inside `.obsidian` (themes, snippets, `data.json`, this plugin's
 *     own install directory).
 */

import type { ExternalHost } from './host'

export type ExternalTargetKind = 'file' | 'folder'

export class ExternalTargetError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'ExternalTargetError'
	}
}

export interface ExternalTarget {
	kind: ExternalTargetKind
	/** Canonical absolute path of the file or folder the user chose. */
	absolute: string
	/** Folder the adapter is rooted at: the folder itself, or the file's parent. */
	base: string
	/** Path relative to `base`: '' for a folder, the file name for a file. */
	relative: string
	/** What the UI shows and what the success notice names. */
	display: string
}

/**
 * What the preview footer remembers between the system dialog and the write.
 *
 * Deliberately the raw dialog result: the view shows it, and `exportNow`
 * validates it again at the moment of writing. A pre-validated object handed
 * from the view would make the view a security boundary it must not be.
 */
export interface ExternalRequest {
	kind: ExternalTargetKind
	path: string
}

function isEnoent(error: unknown): boolean {
	const code = (error as { code?: unknown } | null)?.code
	return code === 'ENOENT' || code === 'ENOTDIR'
}

/** `child` is `parent` or lives under it (case-insensitive on Windows). */
function isInside(host: ExternalHost, parent: string, child: string): boolean {
	const { path } = host
	const rel = path.relative(parent, child)
	if (rel === '') return true
	if (rel.startsWith('..')) return false
	if (path.isAbsolute(rel)) return false
	return true
}

/**
 * Refuse a path that reaches its destination through a link.
 *
 * `lstat` is used on purpose: `stat` follows the link and would report the
 * target, which is precisely the information this check must not be fooled by.
 * Only *existing* components are inspected — the not-yet-created tail of the
 * path cannot be a link yet, and it is created inside a base that passed.
 */
async function assertNoLinkAncestors(host: ExternalHost, absolute: string): Promise<void> {
	const { fs, path } = host
	const normalised = path.normalize(absolute)
	const parsed = path.parse(normalised)
	const tail = normalised.slice(parsed.root.length).split(/[\\/]+/).filter(Boolean)
	let current = parsed.root
	for (const part of tail) {
		current = path.join(current, part)
		let info: Awaited<ReturnType<ExternalHost['fs']['lstat']>>
		try {
			info = await fs.lstat(current)
		} catch (error) {
			if (isEnoent(error)) return
			throw error
		}
		if (info.isSymbolicLink()) {
			throw new ExternalTargetError(
				`所选位置经过符号链接或目录联接：${current}\n` +
					'链接会让导出落到没有人选择过的目录，因此本次没有写入任何文件。' +
					'请改选真实目录（或在系统中把链接换成实际文件夹）后重试。'
			)
		}
	}
}

export async function resolveExternalTarget(
	host: ExternalHost,
	raw: string,
	kind: ExternalTargetKind
): Promise<ExternalTarget> {
	const { path, fs } = host
	const given = String(raw ?? '').trim()
	if (!given) {
		throw new ExternalTargetError('没有选择导出位置。本次没有写入任何文件。')
	}
	if (!path.isAbsolute(given)) {
		throw new ExternalTargetError(
			`导出位置必须是绝对路径（收到：${given}）。本次没有写入任何文件。`
		)
	}
	if (given.replace(/\\/g, '/').split('/').includes('..')) {
		throw new ExternalTargetError(
			`导出位置不能包含 “..”（收到：${given}）。本次没有写入任何文件。`
		)
	}

	const absolute = path.resolve(given)
	await assertNoLinkAncestors(host, absolute)

	if (isInside(host, host.pluginDir, absolute)) {
		throw new ExternalTargetError(
			`不能把导出写进插件自己的安装目录：${absolute}\n` +
				'覆盖插件文件会让插件无法加载。请换一个文件夹，本次没有写入任何文件。'
		)
	}
	if (isInside(host, host.configDir, absolute)) {
		throw new ExternalTargetError(
			`不能把导出写进 Vault 的配置目录（.obsidian）：${absolute}\n` +
				'该目录保存主题、代码片段、插件设置与签名密钥，导出不会写入其中。' +
				'请换一个文件夹，本次没有写入任何文件。'
		)
	}

	if (kind === 'folder') {
		let info: Awaited<ReturnType<ExternalHost['fs']['stat']>>
		try {
			info = await fs.stat(absolute)
		} catch (error) {
			if (isEnoent(error)) {
				throw new ExternalTargetError(
					`所选文件夹不存在：${absolute}。请重新选择，本次没有写入任何文件。`
				)
			}
			throw error
		}
		if (!info.isDirectory()) {
			throw new ExternalTargetError(
				`所选位置不是文件夹：${absolute}。完整资源包需要一个文件夹，本次没有写入任何文件。`
			)
		}
		return { kind, absolute, base: absolute, relative: '', display: absolute }
	}

	// A file target: the parent must already be a real folder. Creating missing
	// parents would mean writing into a directory the user never chose.
	const parent = path.dirname(absolute)
	let parentInfo: Awaited<ReturnType<ExternalHost['fs']['stat']>>
	try {
		parentInfo = await fs.stat(parent)
	} catch (error) {
		if (isEnoent(error)) {
			throw new ExternalTargetError(
				`所选文件所在的文件夹不存在：${parent}。请重新选择，本次没有写入任何文件。`
			)
		}
		throw error
	}
	if (!parentInfo.isDirectory()) {
		throw new ExternalTargetError(
			`所选文件所在的路径不是文件夹：${parent}。本次没有写入任何文件。`
		)
	}
	const name = path.basename(absolute)
	if (!name) {
		throw new ExternalTargetError(`所选文件名无效：${absolute}。本次没有写入任何文件。`)
	}
	return { kind, absolute, base: parent, relative: name, display: absolute }
}
