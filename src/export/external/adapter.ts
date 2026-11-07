/**
 * Task 3 — a `DataAdapter`-shaped facade over a folder **outside** the vault.
 *
 * The export pipeline (staging directory → write → read back → SHA-256 → verify
 * → rename → manifest + HMAC) was written against `app.vault.adapter`. Instead
 * of duplicating that pipeline for a second destination — which is how the two
 * copies would drift and how one of them would end up skipping a check — this
 * facade re-roots it: every relative path the pipeline builds is resolved
 * against the folder the user picked, and every call keeps the same semantics.
 *
 * What that buys, unchanged and therefore un-regressed:
 *
 *   - writes go to a `.tmp-*` staging directory first;
 *   - every file is read back and hashed before the directory is published;
 *   - the manifest is signed with this vault's key;
 *   - the share file is created exclusively (`wx`), so an existing file is
 *     never overwritten.
 *
 * **Publishing a package is NOT a rename here.** On Windows Node's `fs.rename`
 * maps to `MoveFileExW(MOVEFILE_REPLACE_EXISTING)`: renaming a directory onto
 * an existing *file* succeeds and destroys that file. `writer.ts` still uses a
 * rename for the vault adapter (whose own implementation refuses an existing
 * destination); the external facade instead exposes `publishExclusive`, an
 * atomic `mkdir` claim plus exclusive per-file creates. See the doc block on
 * `materializeExclusive` for the exact guarantee and its boundaries.
 *
 * The one thing this layer also adds is **containment**. Paths handed to it
 * come from the pipeline, but a single `..` or an absolute path would otherwise
 * escape the chosen folder entirely, so every path is resolved and re-checked
 * against the base before it is used.
 */

import type { ExternalHost, FileHandleLike, FsPromises, PathModule } from './host'

export class ExternalPathError extends Error {
	constructor(readonly given: string, readonly base: string) {
		super(`路径越界：${given} 不在导出目录 ${base} 之内，已拒绝。`)
		this.name = 'ExternalPathError'
	}
}

export interface ExternalAdapter {
	/** Absolute folder this adapter is rooted at. */
	getBasePath(): string
	exists(path: string): Promise<boolean>
	mkdir(path: string): Promise<void>
	write(path: string, data: string): Promise<void>
	writeBinary(path: string, data: ArrayBuffer | Uint8Array): Promise<void>
	read(path: string): Promise<string>
	readBinary(path: string): Promise<ArrayBuffer>
	rename(from: string, to: string): Promise<void>
	remove(path: string): Promise<void>
	rmdir(path: string, recursive: boolean): Promise<void>
	list(path: string): Promise<{ files: string[]; folders: string[] }>
	/**
	 * Sizes for the post-write verification.
	 *
	 * Without this the verify stage reports "适配器不提供 stat，大小未校验" — a
	 * weaker check than the vault path gets. The external mode must be verified
	 * at least as strictly as the internal one, so it is implemented here.
	 */
	stat(path: string): Promise<{ size: number; mtime: number; ctime: number; type: 'file' | 'folder' }>
	/**
	 * Create-only write, used by the share publisher.
	 *
	 * Exposed as a first-class capability so the exclusive create runs through
	 * this module's containment check instead of re-deriving an absolute path
	 * from `getBasePath()` and trusting the caller's string.
	 */
	createExclusive(path: string, bytes: Uint8Array): Promise<'created' | 'exists'>
	/**
	 * Atomically publish a fully verified staging directory as `to`.
	 *
	 * `to` must not exist: it is claimed with `mkdir(recursive:false)`, so an
	 * existing file/directory/symlink is an `EEXIST` refusal rather than a
	 * replace. Only the external facade implements this; `writer.ts` selects it
	 * instead of its rename/backup/restore path whenever it is present.
	 */
	publishExclusive(from: string, to: string): Promise<void>
	/**
	 * Replace one existing regular file with a fully verified staging file.
	 *
	 * ONLY reachable after the user explicitly chose 替换现有文件 in the
	 * conflict modal. It re-checks the target's identity and SHA-256 against
	 * the fingerprint taken at confirmation time, keeps an exclusive-created
	 * backup of the old bytes, uses a single atomic `rename` for the swap, and
	 * restores the backup if the published bytes fail verification. Any other
	 * caller gets `EEXIST` refusals from `createExclusive`/`publishExclusive`;
	 * this method does not weaken those paths.
	 */
	replaceVerified(
		from: string,
		to: string,
		expectedOld: { bytes: number; sha256: string },
		expectedNew: { bytes: number; sha256: string }
	): Promise<{ backupLeftover: string | null }>
}

function isEnoent(error: unknown): boolean {
	const code = (error as { code?: unknown } | null)?.code
	return code === 'ENOENT' || code === 'ENOTDIR'
}

function isEexist(error: unknown): boolean {
	const code = (error as { code?: unknown } | null)?.code
	return code === 'EEXIST'
}

/**
 * `rename` that refuses an existing destination, matching the vault adapter.
 *
 * Obsidian's own `FileSystemAdapter.rename` throws `Destination file already
 * exists!`; Node's `fs.rename` does not. It maps to `MoveFileExW` with
 * `MOVEFILE_REPLACE_EXISTING`, and measured on this machine that means:
 *
 *   - directory → existing **file**: **succeeds**, and the file is replaced by
 *     a directory. Silent destruction of a file the user had.
 *   - directory → existing directory: `EPERM` (so the caller's retry loop burns
 *     ~3.5 s and then reports a transient-lock error, not "already exists").
 *   - file → existing file: silently replaces it.
 *
 * This is **no longer on the package publish path**. `writer.ts` detects
 * `publishExclusive` and calls `materializeExclusive` instead, so an external
 * resource package never uses a rename at all. The guard stays as defence in
 * depth for any other caller that reaches `adapter.rename` directly (the
 * facade's `rename` is part of its public `DataAdapter` shape).
 *
 * Residual risk, stated rather than hidden: Node exposes no
 * "move-only-if-absent" syscall for directories on Windows, so a destination
 * created in the microseconds between this `lstat` and the `rename` can still be
 * replaced. The window is no longer "however long the verify stage takes", but
 * it is not zero. A truly atomic publish would need `MoveFileEx` without
 * `MOVEFILE_REPLACE_EXISTING`, which the public Node API does not offer. That
 * residual risk is exactly why package publishing was moved off rename.
 */
async function renameNoClobber(
	fs: FsPromises,
	from: string,
	to: string
): Promise<void> {
	try {
		await fs.lstat(to)
	} catch (error) {
		if (isEnoent(error)) {
			await fs.rename(from, to)
			return
		}
		throw error
	}
	const error = new Error(`Destination file already exists! ${to}`) as Error & {
		code?: string
	}
	error.code = 'EEXIST'
	throw error
}

/** The signed manifest is written last, so its presence marks a complete package. */
const MANIFEST_NAME = 'export-manifest.json'

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) return false
	for (let i = 0; i < left.byteLength; i++) if (left[i] !== right[i]) return false
	return true
}

/**
 * Lowercase hex SHA-256 of a byte range. Fails closed when `crypto.subtle` is
 * unavailable — a replace that cannot verify its own bytes must never happen.
 */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto
		?.subtle
	if (!subtle) {
		throw new Error('当前环境缺少 crypto.subtle，无法安全替换目标文件。')
	}
	const view = bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength
	) as ArrayBuffer
	const digest = await subtle.digest('SHA-256', view)
	return Array.from(new Uint8Array(digest))
		.map(byte => byte.toString(16).padStart(2, '0'))
		.join('')
}

/** A distinct, machine-readable reason so the UI can ask for re-confirmation. */
function targetChanged(message: string): Error {
	const error = new Error(message) as Error & { code?: string }
	error.code = 'TARGET_CHANGED'
	return error
}

/**
 * `FileHandle.write` is allowed to perform a short write. Loop until every
 * byte is down — otherwise a large font or image can be truncated while the
 * call still resolves successfully. The read-back comparison below would catch
 * that and refuse the publish, but writing fully is the correct first step.
 */
async function writeAll(handle: FileHandleLike, bytes: Uint8Array): Promise<void> {
	let written = 0
	while (written < bytes.byteLength) {
		const { bytesWritten } = await handle.write(bytes.subarray(written))
		if (!Number.isFinite(bytesWritten) || bytesWritten <= 0) {
			throw new Error('文件写入中断：本次没有写入任何字节')
		}
		written += bytesWritten
	}
}

/**
 * Publish a staged package without ever replacing a name that already exists.
 *
 * `renameNoClobber` above is only a narrowing of a TOCTOU window: an `lstat`
 * followed by `fs.rename` can still be beaten by another process creating the
 * destination in between, and Windows then silently replaces it. This function
 * removes the `rename` from the external publish path altogether:
 *
 *   1. `mkdir(to)` without `recursive` is the **atomic claim**. `CreateDirectoryW`
 *      either creates the directory — this task now owns exactly that name —
 *      or returns `EEXIST` because a file, directory or link already occupies
 *      it. No check precedes the claim, so there is no check/use window.
 *   2. Subdirectories are created non-recursively *inside* the claimed root;
 *      each file is created with `open(…, 'wx')`, also atomic and also refusing
 *      an existing name. An intruder file therefore causes a failure, never an
 *      overwrite.
 *   3. Every copied file is read back and compared byte-for-byte with its
 *      staging copy (which already passed the full SHA-256 / HMAC verification
 *      in `writer.ts`). `writer.ts` additionally re-runs `verifyExport` on the
 *      published directory before reporting success.
 *   4. `export-manifest.json` is copied **last**. A run interrupted before that
 *      point leaves a directory without a valid signed manifest, which can
 *      neither pass `inspectOwnership` nor be reported as a finished export.
 *   5. Only after all of the above is the staging directory removed. It has a
 *      unique `.tmp-<stamp>` name owned by this task; on any failure nothing
 *      outside the claimed root is deleted, and the error names both leftover
 *      paths so the user can inspect them.
 *
 * A pre-existing destination is a plain refusal even if it was produced by an
 * earlier export of this plugin. Node exposes no atomic directory swap on
 * Windows, so "replace only when ownership is proven" cannot be made race-free
 * through the public API. Refusing is the honest guarantee; the user picks a
 * different folder (or moves the old one) and exports again.
 */
async function materializeExclusive(
	fs: FsPromises,
	path: PathModule,
	from: string,
	to: string
): Promise<void> {
	try {
		await fs.mkdir(to)
	} catch (error) {
		if (isEexist(error)) {
			const refusal = new Error(
				`目标目录已存在：${to}。为避免覆盖你已有的文件，本次没有覆盖任何内容，也没有发布资源包。` +
					'请换一个文件夹，或先把同名目录改名/移走后重试。'
			) as Error & { code?: string }
			refusal.code = 'EEXIST'
			throw refusal
		}
		throw error
	}

	const dirs: string[] = []
	const files: string[] = []
	const walk = async (rel: string): Promise<void> => {
		const entries = await fs.readdir(rel ? path.join(from, rel) : from, {
			withFileTypes: true
		})
		for (const entry of entries) {
			const relPath = rel ? `${rel}/${entry.name}` : entry.name
			const info = await fs.lstat(path.join(from, relPath))
			if (info.isSymbolicLink()) {
				throw new Error(`暂存目录中有符号链接，已中止发布：${relPath}`)
			}
			if (entry.isDirectory()) {
				dirs.push(relPath)
				await walk(relPath)
			} else if (entry.isFile()) {
				files.push(relPath)
			}
		}
	}
	await walk('')

	for (const rel of dirs) await fs.mkdir(path.join(to, rel))

	const ordered = [
		...files.filter(name => name !== MANIFEST_NAME),
		...files.filter(name => name === MANIFEST_NAME)
	]
	for (const rel of ordered) {
		const bytes = await fs.readFile(path.join(from, rel))
		const handle = await fs.open(path.join(to, rel), 'wx')
		try {
			await writeAll(handle, bytes)
			await handle.sync()
		} finally {
			await handle.close().catch(() => undefined)
		}
		const echo = await fs.readFile(path.join(to, rel))
		if (!sameBytes(bytes, echo)) {
			throw new Error(`发布后的文件与暂存内容不一致：${rel}`)
		}
	}

	// Best effort: a locked staging directory must not turn a completed publish
	// into a reported failure. Neither cleanup path touches the claimed root.
	await fs.rm(from, { recursive: true, force: false }).catch(() => undefined)
}

/**
 * The dedicated, explicitly-confirmed replace path.
 *
 * This is deliberately NOT a general "write over whatever is there" helper.
 * `writeShareFile` only calls it when the caller supplied a `ShareReplacePlan`
 * produced by the conflict modal, and the adapter is the only implementation.
 * A vault adapter (no `replaceVerified`) therefore cannot reach it at all —
 * the caller refuses and offers 另存为 instead.
 *
 * Guarantees, in order:
 *   1. `lstat` the target again: it must still be a plain regular file, not a
 *      symlink/directory created after the user picked it.
 *   2. Read it and compare byte length + SHA-256 with the fingerprint taken
 *      when the user confirmed. A change after confirmation is a STOP, not a
 *      "probably fine": the old file is left untouched and the caller asks for
 *      a new confirmation (`TARGET_CHANGED`).
 *   3. Verify the staging bytes are still the exact, already-hashed document.
 *   4. Copy the old bytes into an exclusive-created (`wx`) backup and read it
 *      back. The backup can never overwrite a foreign file.
 *   5. One atomic `fs.rename(staging, target)`. On Windows this is the only
 *      in-place swap primitive Node exposes; there is no check/use gap *inside*
 *      the rename itself.
 *   6. Read the published file back and compare SHA-256. On mismatch, restore
 *      from the backup with another atomic rename; if even that fails, report
 *      the backup path so the user can recover the old bytes manually.
 *   7. Remove the backup only after the new bytes are proven on disk.
 *
 * Stated boundary: steps 1–4 and step 5 cannot be made one atomic operation
 * through Node's public API. A foreign process that rewrites the target in that
 * microsecond window is not detectable here; the fingerprint check plus the
 * byte-exact backup narrows the exposure to that single window and guarantees
 * the bytes we replaced are recoverable. This is why the default stays
 * no-clobber and replacement requires an explicit click.
 */
async function replaceVerifiedFile(
	fs: FsPromises,
	path: PathModule,
	from: string,
	to: string,
	expectedOld: { bytes: number; sha256: string },
	expectedNew: { bytes: number; sha256: string }
): Promise<{ backupLeftover: string | null }> {
	const describe = (error: unknown): string =>
		error instanceof Error ? error.message : String(error)

	let info: Awaited<ReturnType<FsPromises['lstat']>>
	try {
		info = await fs.lstat(to)
	} catch {
		throw targetChanged(
			'目标文件在确认后已消失或不可访问，已停止替换，未改动任何内容。请重新导出并再次确认。'
		)
	}
	if (info.isSymbolicLink() || !info.isFile()) {
		throw targetChanged(
			'目标位置已不再是普通文件（可能是符号链接或目录），已拒绝替换。请选择「另存为」。'
		)
	}

	const old = new Uint8Array(await fs.readFile(to))
	if (
		old.byteLength !== expectedOld.bytes ||
		(await sha256Hex(old)) !== expectedOld.sha256.toLowerCase()
	) {
		throw targetChanged(
			'目标文件在确认后被改动，已停止替换，原文件保持不变。请重新导出并再次确认。'
		)
	}

	const fresh = new Uint8Array(await fs.readFile(from))
	if (
		fresh.byteLength !== expectedNew.bytes ||
		(await sha256Hex(fresh)) !== expectedNew.sha256.toLowerCase()
	) {
		throw new Error('待发布的内容校验失败，已停止替换，原文件保持不变。')
	}

	const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
	const backup = path.join(path.dirname(to), `.he-backup-${stamp}.html`)
	let backupHandle: Awaited<ReturnType<FsPromises['open']>> | null = null
	try {
		backupHandle = await fs.open(backup, 'wx')
		await writeAll(backupHandle, old)
		await backupHandle.sync()
	} catch (error) {
		if (backupHandle) await backupHandle.close().catch(() => undefined)
		await fs.unlink(backup).catch(() => undefined)
		throw new Error(`无法为旧文件创建独占备份，已拒绝替换：${describe(error)}`)
	}
	await backupHandle.close()
	const backupEcho = new Uint8Array(await fs.readFile(backup))
	if (!sameBytes(old, backupEcho)) {
		await fs.unlink(backup).catch(() => undefined)
		throw new Error('旧文件备份读回校验失败，已拒绝替换，原文件保持不变。')
	}

	try {
		await fs.rename(from, to)
	} catch (error) {
		await fs.unlink(backup).catch(() => undefined)
		throw new Error(`替换失败，原文件保持不变：${describe(error)}`)
	}

	let verified = false
	try {
		const published = new Uint8Array(await fs.readFile(to))
		verified =
			published.byteLength === expectedNew.bytes &&
			(await sha256Hex(published)) === expectedNew.sha256.toLowerCase()
	} catch {
		verified = false
	}
	if (!verified) {
		try {
			await fs.rename(backup, to)
			throw new Error(
				'替换后的文件校验失败，已用备份恢复原文件。本次导出未成功，请重试。'
			)
		} catch (restoreError) {
			if (restoreError instanceof Error && /已用备份恢复原文件/.test(restoreError.message)) {
				throw restoreError
			}
			throw new Error(
				`替换后的文件校验失败，且自动恢复未完成（${describe(restoreError)}）。` +
					`原文件的完整备份仍在：${backup}。请先手动恢复后再重试。`
			)
		}
	}

	try {
		await fs.unlink(backup)
		return { backupLeftover: null }
	} catch {
		return { backupLeftover: backup }
	}
}

/**
 * Resolve a pipeline-relative path under `base`, refusing anything that would
 * land outside it.
 *
 * Rejects `..` segments and absolute inputs *before* normalising — a value that
 * is collapsed first (`a/../../b` → `../b`) is exactly the case worth refusing,
 * and checking the result alone would let an absolute path through on Windows
 * where `resolve(base, 'C:/x')` discards the base.
 */
export function resolveUnderBase(path: PathModule, base: string, given: string): string {
	const raw = String(given ?? '').replace(/\\/g, '/')
	if (path.isAbsolute(raw)) throw new ExternalPathError(given, base)
	if (raw.split('/').includes('..')) throw new ExternalPathError(given, base)
	const absolute = path.resolve(base, raw)
	const back = path.relative(base, absolute)
	if (back.startsWith('..') || path.isAbsolute(back)) {
		throw new ExternalPathError(given, base)
	}
	return absolute
}

/** `dir/name` with forward slashes, matching what the vault adapter returns. */
function joinRelative(dir: string, name: string): string {
	const clean = dir.replace(/^\/+|\/+$/g, '')
	return clean ? `${clean}/${name}` : name
}

export function createExternalAdapter(host: ExternalHost, base: string): ExternalAdapter {
	const { fs, path } = host
	const at = (given: string): string => resolveUnderBase(path, base, given)

	return {
		getBasePath(): string {
			return base
		},

		async exists(given) {
			try {
				await fs.access(at(given))
				return true
			} catch {
				return false
			}
		},

		async mkdir(given) {
			await fs.mkdir(at(given), { recursive: true })
		},

		async write(given, data) {
			await fs.writeFile(at(given), data, { encoding: 'utf8' })
		},

		async writeBinary(given, data) {
			const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
			await fs.writeFile(at(given), bytes)
		},

		async read(given) {
			return fs.readFile(at(given), 'utf8')
		},

		async readBinary(given) {
			const bytes = await fs.readFile(at(given))
			// `Buffer` is a `Uint8Array` view over a pooled ArrayBuffer; slicing by
			// the view's own bounds keeps the returned buffer exactly these bytes.
			return bytes.buffer.slice(
				bytes.byteOffset,
				bytes.byteOffset + bytes.byteLength
			) as ArrayBuffer
		},

		async rename(from, to) {
			await renameNoClobber(fs, at(from), at(to))
		},

		async publishExclusive(from, to) {
			await materializeExclusive(fs, path, at(from), at(to))
		},

		async replaceVerified(from, to, expectedOld, expectedNew) {
			return replaceVerifiedFile(
				fs,
				path,
				at(from),
				at(to),
				expectedOld,
				expectedNew
			)
		},

		async remove(given) {
			try {
				await fs.unlink(at(given))
			} catch (error) {
				if (!isEnoent(error)) throw error
			}
		},

		async rmdir(given, recursive) {
			try {
				await fs.rm(at(given), { recursive: !!recursive, force: false })
			} catch (error) {
				if (!isEnoent(error)) throw error
			}
		},

		async list(given) {
			const dir = at(given)
			const entries = await fs.readdir(dir, { withFileTypes: true })
			const files: string[] = []
			const folders: string[] = []
			for (const entry of entries) {
				if (entry.isDirectory()) folders.push(joinRelative(given, entry.name))
				else if (entry.isFile()) files.push(joinRelative(given, entry.name))
			}
			return { files, folders }
		},

		async stat(given) {
			const info = await fs.stat(at(given))
			const mtime = (info as { mtimeMs?: number }).mtimeMs ?? 0
			const ctime = (info as { ctimeMs?: number }).ctimeMs ?? 0
			return {
				size: (info as { size?: number }).size ?? 0,
				mtime,
				ctime,
				type: info.isDirectory() ? 'folder' : 'file'
			}
		},

		async createExclusive(given, bytes) {
			const absolute = at(given)
			let handle: Awaited<ReturnType<FsPromises['open']>>
			try {
				handle = await fs.open(absolute, 'wx')
			} catch (error) {
				if (isEexist(error)) return 'exists'
				throw error
			}
			try {
				await writeAll(handle, bytes)
				// Same durability rule as the vault path: without `sync` a crash can
				// leave a truncated file that the read-back would not catch either.
				await handle.sync()
			} catch (error) {
				await handle.close().catch(() => undefined)
				await fs.unlink(absolute).catch(() => undefined)
				throw error
			}
			await handle.close()
			return 'created'
		}
	}
}
