import type { App } from 'obsidian'
import { normalizePath } from 'obsidian'
import {
	PathEscapeError,
	assertVaultRelativeLocation,
	assertVaultRelativeRoot,
	identitySuffix,
	normalizeVaultPath,
	safeFolderName
} from './path-safety'
import { ensureFolder } from './writer'

/**
 * Publishing one share file without ever destroying an existing one.
 *
 * The directory export gets this property from a transaction: write into
 * `.tmp-*`, verify, then rename the whole directory into place, and refuse
 * outright when the target cannot be proven to be ours (`writer.ts`). A share
 * file has no directory to swap, so it needs a different proof.
 *
 * What the previous version did — `exists()` then `write()` — is a
 * time-of-check/time-of-use hole. Two shares of the same note in the same
 * second both see "free", both write, and the second silently replaces the
 * first; worse, anything the user dropped at that path in between is gone.
 * `rename()` does not help: on POSIX *and* on Windows it replaces the target.
 *
 * So the only primitive used to create the published file is an **exclusive
 * create** (`open(…, "wx")`), which the kernel resolves atomically: either the
 * name was free and we now own the new file, or it already exists and the call
 * fails with `EEXIST` — never "overwrite it quietly". The first half of the
 * flow is still a transaction:
 *
 *   1. resolve the directory with the same Vault-relative / containment rules
 *      the directory export uses;
 *   2. write the UTF-8 bytes to a temp file inside that directory;
 *   3. read the temp file back and compare SHA-256 — a resolved `write` is not
 *      proof that the bytes are on disk;
 *   4. publish by exclusive create, retrying the next numbered name on
 *      `EEXIST` (that is both the "someone got here first" and the
 *      "concurrent share" case);
 *   5. read the published file back and compare SHA-256 again; if it does not
 *      match, delete *the file we just created* and fail.
 *
 * If the runtime offers no exclusive-create primitive, the write is **refused**
 * rather than downgraded to an overwriting one. A share file is exactly the
 * artefact a user may have hand-edited or kept next to an older revision, so
 * "probably fine" is not good enough.
 */

export const DEFAULT_EXPORT_ROOT = 'html-export'
export const DEFAULT_SHARE_ROOT = 'html-export-share'

export type ShareStage =
	| '路径'
	| '适配器'
	| '目录'
	| '临时文件'
	| '写入校验'
	| '发布'
	| '清理'

export class ShareWriteError extends Error {
	constructor(
		message: string,
		readonly stage: ShareStage,
		/** Files that may still exist, so the notice never claims "nothing" wrongly. */
		readonly leftover: string | null = null,
		/**
		 * Machine-readable reason, so the caller can decide whether to surface the
		 * conflict modal instead of a plain failure.
		 *
		 *   - `TARGET_EXISTS`        an exact-name target exists and no replace plan
		 *                            was supplied → offer 替换 / 另存为 / 取消;
		 *   - `REPLACE_UNSUPPORTED`  an exact target exists but the adapter cannot
		 *                            safely replace it → only 另存为 / 取消;
		 *   - `TARGET_CHANGED`       the confirmed target was changed/replaced by
		 *                            another actor before the swap → re-confirm;
		 *   - `REPLACE_FAILED`       the confirmed swap failed for another reason.
		 */
		readonly code?:
			| 'TARGET_EXISTS'
			| 'REPLACE_UNSUPPORTED'
			| 'TARGET_CHANGED'
			| 'REPLACE_FAILED'
	) {
		super(message)
		this.name = 'ShareWriteError'
	}
}

export interface ShareWriteResult {
	/** Vault-relative path of the file actually published. */
	path: string
	bytes: number
	/** Lowercase hex SHA-256 of the published bytes, read back from disk. */
	sha256: string
	/** True when the requested name was taken and a numbered name was used. */
	renamed: boolean
	/** True when the user explicitly confirmed replacing an existing target. */
	replaced: boolean
	/** Backup kept when a confirmed replace could not clean it up. */
	leftoverBackup: string | null
	/** Temp directory that could not be removed, if any. Never the target. */
	leftoverTemp: string | null
}

/**
 * The fingerprint of the file the user saw in the conflict modal.
 *
 * Produced by `main.ts` *before* asking, and re-checked by
 * `ExternalAdapter.replaceVerified()` immediately before the swap. A change in
 * between stops the replace instead of silently destroying a newer file.
 * The plan alone is inert: without it `writeShareFile` stays create-only.
 */
export interface ShareReplacePlan {
	bytes: number
	sha256: string
}

/** Capability offered only by the external facade. */
type ReplaceCapable = {
	replaceVerified?: (
		from: string,
		to: string,
		expectedOld: ShareReplacePlan,
		expectedNew: ShareReplacePlan
	) => Promise<{ backupLeftover: string | null }>
}

/**
 * The share directory: always a **sibling** of the export root.
 *
 * It cannot live inside the export root. `inspectOwnership` treats any file the
 * manifest does not account for as the user's and refuses to replace the
 * directory, so a single share file there would make the next export refuse to
 * run — a self-inflicted "this directory belongs to someone else".
 *
 * The rules are the ones `resolveExportDir` already enforces, reused rather
 * than re-invented:
 *
 *   - `outputRoot` must be a plain Vault-relative path: no drive letter, no
 *     UNC, no leading slash (`assertVaultRelativeRoot`);
 *   - the joined path is normalised, and `..` that would climb above the vault
 *     root throws (`normalizeVaultPath`);
 *   - the result is re-checked: still Vault-relative, still one path segment
 *     deeper than nothing, i.e. a sibling — never a parent, never absolute.
 */
export function resolveShareDir(outputRoot: string): {
	dir: string
	root: string
	base: string
} {
	const raw = String(outputRoot ?? '').trim()
	assertVaultRelativeRoot(raw)
	const root = normalizeVaultPath(raw === '' ? DEFAULT_EXPORT_ROOT : raw)
	const base = root === '.' ? DEFAULT_SHARE_ROOT : `${root}-share`
	const dir = normalizePath(base)

	// Re-check the *result*, not the inputs: `normalizePath` is the last thing
	// that touched it, and this is the assertion that must never be skipped.
	if (!dir || dir === '.' || dir.startsWith('/') || /^[A-Za-z]:/.test(dir)) {
		throw new PathEscapeError(base, root)
	}
	if (dir.split('/').includes('..')) throw new PathEscapeError(base, root)
	if (root !== '.' && dir !== `${root}-share`) {
		throw new PathEscapeError(dir, root)
	}

	return { dir, root, base }
}

/** Backwards-compatible name: the share directory for a configured root. */
export function shareRootFor(outputRoot: string): string {
	return resolveShareDir(outputRoot).dir
}

/**
 * The adapter surface the export transaction actually uses.
 *
 * Deliberately narrower than `DataAdapter`: the external facade (Task 3) is a
 * small object rooted at a folder outside the vault, and it should not have to
 * pretend to be the vault's adapter. Anything outside this list cannot be
 * called by accident either.
 */
type Adapter = Pick<
	App['vault']['adapter'],
	'exists' | 'mkdir' | 'write' | 'writeBinary' | 'read' | 'readBinary' | 'rename' | 'list' | 'stat' | 'remove' | 'rmdir'
>

/** `created` when this call made the file, `exists` when the name was taken. */
export type ExclusiveCreate = (
	vaultPath: string,
	bytes: Uint8Array
) => Promise<'created' | 'exists'>

/**
 * Load Node's `fs` without making it a module-level dependency.
 *
 * `import fs from 'node:fs'` at the top of this file would be evaluated when
 * the plugin loads — on mobile there is no `fs`, so the whole plugin would fail
 * to load for a feature the user has not run. A `require` inside the function
 * keeps the price at zero until a share is actually published, and returns
 * `null` where the module is unavailable.
 */
function loadNodeFs(): {
	promises: {
		open(path: string, flags: string): Promise<{
			writeFile(data: Uint8Array): Promise<void>
			sync(): Promise<void>
			close(): Promise<void>
		}>
		unlink(path: string): Promise<void>
	}
} | null {
	let loader: ((id: string) => unknown) | null = null
	try {
		const globalRequire = (globalThis as { require?: (id: string) => unknown })
			.require
		loader =
			typeof globalRequire === 'function'
				? globalRequire
				: typeof require === 'function'
					? (require as (id: string) => unknown)
					: null
	} catch {
		return null
	}
	if (!loader) return null
	// Some hosts only resolve the bare name, some only the `node:` prefix.
	for (const id of ['node:fs', 'fs']) {
		try {
			const fs = loader(id)
			if (fs && (fs as { promises?: unknown }).promises) {
				return fs as ReturnType<typeof loadNodeFs>
			}
		} catch {
			// Try the next spelling.
		}
	}
	return null
}

function isEexist(error: unknown): boolean {
	// Only `EEXIST` means "the name is taken". A permission error (`EPERM`,
	// `EACCES`) must fail loudly: treating it as "taken" would silently write
	// the share under a new name and hide a real filesystem problem.
	const code = (error as { code?: unknown } | null)?.code
	return code === 'EEXIST'
}

/**
 * A create-only writer backed by the vault's real directory, or `null`.
 *
 * `getBasePath()` is how Obsidian's desktop adapter (and only that one) exposes
 * the folder on disk; mobile adapters do not have it, and they also have no
 * atomic exclusive create. Returning `null` there is the whole point: the
 * caller refuses instead of writing in a way that could overwrite.
 */
export function createExclusiveWriter(adapter: Adapter): ExclusiveCreate | null {
	// Task 3: an adapter that provides create-only writing itself is used
	// directly. The external facade does, so its own containment check stays the
	// single place a path is resolved — re-deriving an absolute path from
	// `getBasePath()` here would be a second, weaker copy of that rule.
	const native = (
		adapter as {
			createExclusive?: (path: string, bytes: Uint8Array) => Promise<'created' | 'exists'>
		}
	).createExclusive
	if (typeof native === 'function') {
		return (path, bytes) => native.call(adapter, path, bytes)
	}

	const getBasePath = (adapter as { getBasePath?: () => string }).getBasePath
	if (typeof getBasePath !== 'function') return null
	let basePath: string
	try {
		basePath = String(getBasePath.call(adapter) ?? '')
	} catch {
		return null
	}
	if (!basePath) return null
	const fs = loadNodeFs()
	if (!fs?.promises?.open) return null

	const root = basePath.replace(/[\\/]+$/, '')
	return async (vaultPath, bytes) => {
		const absolute = `${root}/${vaultPath.replace(/^\/+/, '')}`
		let handle: Awaited<ReturnType<typeof fs.promises.open>> | null = null
		try {
			handle = await fs.promises.open(absolute, 'wx')
		} catch (error) {
			if (isEexist(error)) return 'exists'
			throw error
		}
		try {
			await handle.writeFile(bytes)
			// Durability: without `sync` a crash can leave a truncated file that
			// the read-back below would not have caught either.
			await handle.sync()
		} catch (error) {
			// We created this file exclusively, so removing it can never destroy
			// someone else's data — and leaving half a share file behind is
			// exactly what the "never report a partial file as success" rule is
			// about.
			await handle.close().catch(() => undefined)
			await fs.promises.unlink(absolute).catch(() => undefined)
			throw error
		}
		await handle.close()
		return 'created'
	}
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto
		?.subtle
	if (!subtle) {
		throw new ShareWriteError(
			'当前运行环境没有 crypto.subtle，无法校验写入的字节是否完整。' +
				'为避免发布一个无法验证的文件，本次没有写入任何内容。',
			'写入校验'
		)
	}
	// `digest` wants a `BufferSource`; the slice keeps the view honest even when
	// the caller handed us a subarray of a larger buffer.
	const digest = await subtle.digest('SHA-256', toArrayBuffer(bytes))
	return Array.from(new Uint8Array(digest))
		.map(byte => byte.toString(16).padStart(2, '0'))
		.join('')
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength
	) as ArrayBuffer
}

async function readBytes(adapter: Adapter, path: string): Promise<Uint8Array | null> {
	try {
		const data = await adapter.readBinary(path)
		return new Uint8Array(data)
	} catch {
		return null
	}
}

async function removeQuietly(adapter: Adapter, path: string): Promise<void> {
	try {
		if (typeof adapter.remove === 'function') await adapter.remove(path)
	} catch {
		// Nothing to do: the caller reports the leftover path instead.
	}
}

async function removeDirQuietly(adapter: Adapter, path: string): Promise<boolean> {
	try {
		if (typeof adapter.rmdir !== 'function') return !(await adapter.exists(path))
		await adapter.rmdir(path, true)
		return true
	} catch {
		try {
			return !(await adapter.exists(path))
		} catch {
			return false
		}
	}
}

/**
 * Write the share document. Never overwrites; throws instead.
 *
 * `maxAttempts` bounds the numbered-name search. Reaching it means the folder
 * already holds that many shares of this note, which is the point where telling
 * the user to move something is more useful than `-201.html`.
 */
export async function writeShareFile(
	app: App,
	html: string,
	outputRoot: string,
	noteTitle: string,
	notePath: string,
	maxAttempts = 200,
	/**
	 * Optional user-chosen, Vault-relative output folder for *this* export.
	 *
	 * Safety boundary (Task 2): still confined to the Vault — `assertVaultRelativeLocation`
	 * rejects drive letters / UNC / absolute paths and every `..` segment, so we
	 * never reach for Node `fs` to write arbitrary
	 * locations. When omitted, the note's configured `outputRoot` is used. The
	 * numbered-suffix publish below already refuses to overwrite an existing file.
	 */
	explicitDir?: string | null,
	/**
	 * Task 3: write through this adapter instead of the vault's.
	 *
	 * The external mode hands over a facade rooted at the folder the user picked
	 * in the system dialog. Everything below — the staging file, the read-back,
	 * the SHA-256 comparison and the create-only publish — runs unchanged; only
	 * the root moves.
	 */
	destination?: Adapter,
	/**
	 * Task 3: publish under exactly this name instead of a numbered one.
	 *
	 * A "save as" target is a file name the user typed, so appending `-2` when
	 * it already exists would silently write somewhere they did not ask for.
	 * With this set, an existing name is a refusal the caller reports.
	 */
	exactName?: string | null,
	/**
	 * P2 使用反馈 #3: a plan produced ONLY by the user's explicit
	 * 「替换现有文件」 choice in the conflict modal.
	 *
	 * `null` (the default) keeps this function strictly create-only. With a
	 * plan, the already-built-and-hashed document is published through the
	 * adapter's dedicated `replaceVerified`, which re-checks the old file's
	 * SHA-256, keeps an exclusive backup, swaps atomically, verifies the new
	 * bytes and restores the backup on failure. An adapter without that
	 * capability refuses and the caller offers 「另存为」.
	 */
	replace?: ShareReplacePlan | null
): Promise<ShareWriteResult> {
	// Path first: a refusal here must happen before a single byte is written.
	const dir = destination
		? ''
		: explicitDir && explicitDir.trim()
			? assertVaultRelativeLocation(explicitDir)
			: resolveShareDir(outputRoot).dir

	const adapter = destination ?? app.vault.adapter
	const exclusive = createExclusiveWriter(adapter)
	if (!exclusive) {
		throw new ShareWriteError(
			'当前文件适配器无法提供"创建新文件且绝不覆盖"的保证（缺少独占创建能力），' +
				'因此拒绝写入分享文件。' +
				'这不会降级成可能覆盖同名文件的写入方式——' +
				'请把知识库放在桌面版 Obsidian 中打开后重试。' +
				'本次没有写入任何内容。',
			'适配器'
		)
	}

	const bytes = new TextEncoder().encode(html)
	const expected = await sha256Hex(bytes)

	try {
		await ensureFolder(adapter, dir)
	} catch (error) {
		throw new ShareWriteError(
			`无法创建分享目录 ${dir}：${describe(error)}`,
			'目录'
		)
	}

	const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
	// The external root is `''` (the adapter already points at the chosen
	// folder), and `'' + '/' + name` would look like an absolute path to the
	// facade's containment check.
	const under = (name: string): string => (dir ? `${dir}/${name}` : name)
	const tempDir = under(`.he-tmp-${stamp}`)
	const tempPath = `${tempDir}/payload.html`

	try {
		await ensureFolder(adapter, tempDir)
	} catch (error) {
		throw new ShareWriteError(
			`无法创建临时目录 ${tempDir}：${describe(error)}`,
			'临时文件'
		)
	}

	let published: ShareWriteResult | null = null
	try {
		// --- 1. temp file, then read it back ------------------------------
		try {
			await adapter.writeBinary(tempPath, toArrayBuffer(bytes))
		} catch (error) {
			throw new ShareWriteError(`写入临时文件失败：${describe(error)}`, '临时文件')
		}

		const echo = await readBytes(adapter, tempPath)
		if (!echo || echo.byteLength !== bytes.byteLength) {
			throw new ShareWriteError(
				`临时文件写入后长度不一致（期望 ${bytes.byteLength} 字节，实际 ${
					echo?.byteLength ?? '读取失败'
				} 字节），已中止，没有发布任何文件。`,
				'写入校验'
			)
		}
		const echoHash = await sha256Hex(echo)
		if (echoHash !== expected) {
			throw new ShareWriteError(
				'临时文件写入后 SHA-256 与内存中的文档不一致（磁盘上的字节被改动或截断），' +
					'已中止，没有发布任何文件。',
				'写入校验'
			)
		}

		// --- 2. publish by exclusive create -------------------------------
		const slug = safeFolderName(noteTitle)
		// The identity suffix keeps two *different* notes with the same title
		// apart; the counter below keeps two shares of the *same* note apart.
		const suffix = identitySuffix(notePath)
		const base = `${dir}/${slug}-${suffix}`
		const exact = exactName && exactName.trim() ? exactName.trim() : null

		for (let index = 0; index <= maxAttempts; index++) {
			const name = exact
				? under(exact)
				: index === 0
					? `${base}.html`
					: `${base}-${index + 1}.html`
			let created: 'created' | 'exists'
			try {
				created = await exclusive(name, bytes)
			} catch (error) {
				throw new ShareWriteError(
					`发布 ${name} 失败：${describe(error)}。` +
						'该文件是否已创建无法确认，请检查分享目录后再重试。',
					'发布',
					name
				)
			}
			if (created === 'exists') {
				// An exact name has nowhere to go by default: writing `-2` would
				// put the file somewhere the user did not ask for, and a blind
				// overwrite is refused. The ONLY exception is a plan that came
				// from an explicit 「替换现有文件」 click.
				if (exact && replace) {
					const swap = (adapter as Adapter & ReplaceCapable).replaceVerified
					const shown = absoluteFor(adapter, name)
				if (typeof swap !== 'function') {
					throw new ShareWriteError(
						`当前文件适配器无法安全替换 ${shown}（缺少校验、备份与恢复能力）。` +
							'为避免覆盖你已有的文件，本次没有写入任何内容。请选择「另存为」。',
						'发布',
						shown,
						'REPLACE_UNSUPPORTED'
					)
				}
					let outcome: { backupLeftover: string | null }
					try {
						outcome = await swap.call(adapter, tempPath, name, replace, {
							bytes: bytes.byteLength,
							sha256: expected
						})
					} catch (error) {
				const changed = (error as { code?: unknown } | null)?.code === 'TARGET_CHANGED'
					throw new ShareWriteError(
						`替换 ${shown} 已停止：${describe(error)}` +
							(changed
								? '\n请重新导出，并在确认框里再次明确选择「替换现有文件」。'
								: '\n本次没有把不完整的结果当作成功。'),
						'发布',
						shown,
						changed ? 'TARGET_CHANGED' : 'REPLACE_FAILED'
					)
					}
					// `replaceVerified` already verified the published bytes;
					// read once more here so the reported hash always comes from
					// the file on disk rather than from memory.
					const replacement = await readBytes(adapter, name)
					const replacementHash = replacement ? await sha256Hex(replacement) : null
					if (
						!replacement ||
						replacement.byteLength !== bytes.byteLength ||
						replacementHash !== expected
					) {
						throw new ShareWriteError(
							`替换后的文件读回校验失败（${shown}），本次没有把结果当作成功。` +
								(outcome.backupLeftover
									? ` 原文件备份：${outcome.backupLeftover}`
									: ''),
							'发布',
							shown
						)
					}
					published = {
						path: name,
						bytes: bytes.byteLength,
						sha256: replacementHash,
						renamed: false,
						replaced: true,
						leftoverBackup: outcome.backupLeftover,
						leftoverTemp: null
					}
					break
				}
				if (exact) {
					const shown = absoluteFor(adapter, name)
					throw new ShareWriteError(
						`目标文件已存在：${shown}\n` +
							'为避免覆盖你已有的文件，本次没有写入任何内容。' +
							'目标可能是在选择位置之后才被其他程序创建的；请重新导出，' +
							'在确认框中选择「替换现有文件」或「另存为」。',
						'发布',
						shown,
						'TARGET_EXISTS'
					)
				}
				continue
			}

			// --- 3. read the published file back -------------------------
			const disk = await readBytes(adapter, name)
			const diskHash = disk ? await sha256Hex(disk) : null
			if (!disk || disk.byteLength !== bytes.byteLength || diskHash !== expected) {
				// We created this name exclusively a moment ago, so deleting it
				// cannot touch anything the user had.
				await removeQuietly(adapter, name)
				throw new ShareWriteError(
					`发布后的文件校验失败（写入 ${bytes.byteLength} 字节，读回 ${
						disk?.byteLength ?? '失败'
					} 字节），已删除该文件，没有把不完整的结果当作成功。`,
					'发布'
				)
			}

			published = {
				path: name,
				bytes: bytes.byteLength,
				sha256: diskHash,
				renamed: index > 0,
				replaced: false,
				leftoverBackup: null,
				leftoverTemp: null
			}
			break
		}

		if (!published) {
			throw new ShareWriteError(
				`分享目录中已有 ${maxAttempts + 1} 个同名文件（${base}*.html），` +
					'为避免覆盖请先移走旧文件。本次没有发布任何文件。',
				'发布'
			)
		}
	} finally {
		const cleaned = await removeDirQuietly(adapter, tempDir)
		if (!cleaned && published) {
			published.leftoverTemp = tempDir
		}
	}

	return published
}

/**
 * Absolute form of a written path, for messages and for the error's `path`.
 *
 * The facade knows the folder it is rooted at; the vault adapter's relative
 * path and an external file name look identical otherwise, and the failure
 * notice would point the user at the wrong directory.
 */
function absoluteFor(adapter: Adapter, name: string): string {
	const base = (adapter as { getBasePath?: () => string }).getBasePath
	try {
		const root = typeof base === 'function' ? String(base.call(adapter) ?? '') : ''
		if (root && !/^[A-Za-z]:[\\/]/.test(name) && !name.startsWith('/')) {
			return `${root.replace(/[\\/]+$/, '')}/${name}`.replace(/\\/g, '/')
		}
	} catch {
		// Fall through: a truthful relative path beats a fabricated absolute one.
	}
	return name
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
