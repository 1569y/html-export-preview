import type { App } from 'obsidian'
import { normalizePath } from 'obsidian'
import type { CaptureSnapshot } from '../capture/types'
import type { AssetCollector, AssetReport } from '../assets/resource-manager'
import type { VisibilityAuditResult } from '../css/visibility-audit'
import {
	assertVaultRelativeLocation,
	identitySuffix,
	resolveExportDir
} from './path-safety'
import { BODY_END, BODY_START } from './exporter'
import {
	MANIFEST_VERSION_SIGNED,
	isValidSigningKey,
	readSignature,
	signManifest,
	verifyManifestSignature
} from './manifest-signing'

/**
 * Write the export as one transaction.
 *
 * Review round 2 (D2 / D3) found that the old flow wrote four files, verified
 * none of them, and then showed "导出完成". It also wrote `runtime-audit.json`
 * *after* the transaction had already returned, so a failure there reported
 * "导出失败" while the HTML sat on disk — a fake failure to match the fake
 * success.
 *
 * The flow is now:
 *
 *   temp dir → write every file → verify on disk → publish (rename) → report
 *
 * Publishing is a directory rename, which Obsidian's adapter supports on
 * desktop and on mobile. There is deliberately **no** in-place fallback: it
 * would overwrite the previous export before verification and leave stale
 * media behind, so an adapter without `rename` is refused before anything is
 * written (review B5).
 */

export type ExportStatus = 'ok' | 'incomplete'

export interface VerifyCheck {
	name: string
	ok: boolean
	detail: string
	/**
	 * The adapter could not perform this check at all. A skipped check neither
	 * passes nor fails — reporting "skipped" as "passed" is how a blind spot
	 * hides (review B6).
	 */
	skipped?: boolean
	/**
	 * Round 3.3.1: advisory checks (e.g. the CSS visibility audit) are recorded
	 * but must NOT block publishing a perfectly good export on a heuristic
	 * false positive. When `blocking` is `false`, a failed check lowers the
	 * user-facing confidence (a warning) without flipping `verified.ok`.
	 */
	blocking?: boolean
}

export interface VerifyResult {
	ok: boolean
	checks: VerifyCheck[]
}

export interface ExportReport {
	/** Final directory, relative to the vault. */
	dir: string
	/** Staging directory used before publishing. Does not exist after success. */
	tmpDir: string | null
	/** `incomplete` when a content-role asset failed to copy *or* resolve. */
	status: ExportStatus
	htmlBytes: number
	cssBytes: number
	assets: AssetReport
	manifestPath: string
	verified: VerifyResult
	/** Names of the stages that completed, for the failure report. */
	stages: string[]
	/**
	 * Round 3.3.1: static CSS visibility audit of the collected `export.css`.
	 * Advisory only — never blocks publish. `null` when no audit was supplied.
	 */
	visibility: VisibilityAuditResult | null
	/**
	 * A `.bak-*` directory retained on disk. Round 2A.2 (B5): the previous
	 * export is always moved here on a successful replace and is never
	 * auto-deleted. `null` only when there was no previous export to replace.
	 */
	leftoverBackup: string | null
}

/** Failure that names the exact stage, so the Notice can be actionable. */
export class ExportError extends Error {
	constructor(
		message: string,
		readonly stage: string,
		readonly tmpDir: string | null,
		readonly checks: VerifyCheck[] = []
	) {
		super(message)
		this.name = 'ExportError'
	}
}

export interface WriteExtra {
	css: {
		bytes: number
		sheets: unknown
		warnings: string[]
		/**
		 * Round 3.3.3: which theme and snippets were active when the sheets were
		 * read. Without it a "the export lost my theme" report cannot be settled
		 * from the artefact — the sheet list looks the same either way.
		 */
		theme?: {
			name: string
			version: string
			snippets: string[]
		}
		/** Inline `--*` declarations replayed on `<body>` (accent colour et al). */
		bodyStyle?: string
	}
	pluginVersion: string
	/** Built from the *same* snapshot; written inside the transaction (D3). */
	audit: unknown
	/**
	 * Round 3.3.1: pre-computed static visibility audit of `export.css`. When
	 * supplied it is recorded in the report and surfaced as an advisory check so
	 * a CSS-hidden body is never silently reported as "success".
	 */
	visibility?: VisibilityAuditResult | null
}

/**
 * Refusal text required by the round 2A.2.2 brief. Used verbatim for every
 * directory that cannot be proven intact: legacy, unsigned v1, and anything
 * whose signature does not verify.
 */
const UNVERIFIABLE_DIR_MESSAGE =
	'该目录属于旧版或无法验证的导出，插件无法证明其完整性。' +
	'请先手动备份或移动旧目录，再重新导出。'

/** Files every export must produce, with the minimum size each must reach. */
const REQUIRED_FILES: { path: string; minBytes: number }[] = [
	{ path: 'index.html', minBytes: 1 },
	{ path: 'assets/export.css', minBytes: 1 },
	{ path: 'export-manifest.json', minBytes: 1 },
	{ path: 'runtime-audit.json', minBytes: 1 }
]

/** Build the stage-specific error without losing the cause. */
function stageError(
	stage: string,
	error: unknown,
	tmpDir: string | null
): ExportError {
	const reason = error instanceof Error ? error.message : String(error)
	return new ExportError(`${stage} 阶段失败：${reason}`, stage, tmpDir)
}

export async function writeExport(
	app: App,
	snap: CaptureSnapshot,
	html: string,
	cssText: string,
	assets: AssetCollector,
	outputRoot: string,
	extra: WriteExtra,
	signingKey: string | null,
	/**
	 * Optional user-chosen, Vault-relative output folder for *this* export.
	 *
	 * Safety boundary (Task 2): a user-selected location is still confined to the
	 * Vault. `assertVaultRelativeLocation` rejects drive letters / UNC /
	 * absolute paths and every `..` segment, so this path
	 * can never leave the Vault — we deliberately do **not** reach for Node's
	 * `fs` to write arbitrary filesystem locations. When omitted (the normal
	 * case) the note's own `outputRoot`/identity folder is used, unchanged.
	 *
	 * No-overwrite: when an explicit folder is given and already exists, the
	 * directory name is disambiguated (`-2`, `-3`, …) so the existing export is
	 * never clobbered. The transaction + HMAC + ownership checks below still run
	 * unchanged on whatever final directory is chosen.
	 */
	explicitDir?: string | null,
	/**
	 * Task 3: the adapter every write goes through.
	 *
	 * Defaults to the vault adapter, which is the vault-internal mode. The
	 * external mode passes a facade rooted at the folder the user picked, so the
	 * staging → verify → publish sequence, the manifest signature and the
	 * ownership check all run *unchanged* — this function is not re-implemented
	 * for a second destination.
	 */
	destination?: Adapter
): Promise<ExportReport> {
	// `app.vault.adapter` is a full `DataAdapter`; the external facade is the
	// narrower `Adapter`. Annotating the union keeps `publishExclusive` a typed,
	// optional capability rather than an unchecked property probe (TS2339).
	const adapter: Adapter = destination ?? app.vault.adapter
	// There is no safe in-place fallback: writing straight into the final
	// directory overwrites the previous export before anything is verified, and
	// leaves stale media from the old run behind (review B5). Refuse up front
	// instead of shipping a path that can destroy the last good export.
	if (typeof adapter.rename !== 'function') {
		throw new ExportError(
			'当前文件适配器不支持目录重命名，无法以事务方式提交导出。' +
				'为避免覆盖已有导出，本次没有写入任何文件。',
			'适配器',
			null
		)
	}

	// Round 2A.2.2 (S3): a manifest this build cannot sign is a manifest the next
	// export cannot verify. Refuse before writing anything rather than leaving a
	// directory that will be permanently un-replaceable.
	if (!isValidSigningKey(signingKey)) {
		throw new ExportError(
			'本 Vault 的签名密钥不可用，无法为导出清单签名。' +
				'为避免写出一份无法验证的导出，本次没有写入任何文件。' +
				'请在插件设置中检查（密钥由插件自动生成并保存在本 Vault 的插件配置里）。',
			'签名密钥',
			null
		)
	}
	// Same reasoning for hashing: the manifest must carry a SHA-256 for every
	// file, and round 2A.2.2 removed the size-only fallback.
	if (!hashCapable()) {
		throw new ExportError(
			'当前运行环境没有 crypto.subtle，无法为每个文件计算 SHA-256。' +
				'为避免写出一份无法验证的导出，本次没有写入任何文件。',
			'哈希能力',
			null
		)
	}

	// Path safety (round 2A, X-extra): the old one-line `safeFolder` accepted
	// `..`, `.`, `CON`/`NUL`/`COM1` and trailing dots verbatim, so a note titled
	// `..` wrote its export into the *parent* of the export root.
	//
	// Round 2A.1 (F-03): the folder also carries a suffix derived from the
	// note's vault path, so two notes never share a directory — neither when
	// their titles are identical, nor when they sanitise to the same slug, nor
	// when truncation makes two long titles equal. `resolveExportDir` refuses a
	// non-vault-relative root and re-checks containment after joining.
	let finalDir: string
	let outputFolder: string
	let identitySuffixValue: string
	if (explicitDir && explicitDir.trim()) {
		// User-chosen folder: must stay inside the Vault, and must not overwrite
		// an existing directory (disambiguate instead).
		const wanted = assertVaultRelativeLocation(explicitDir)
		finalDir = await disambiguateDir(adapter, wanted)
		outputFolder = finalDir.split('/').pop() ?? finalDir
		// The suffix identifies the *note*, not the folder name. `inspectOwnership`
		// recomputes it from notePath and refuses a manifest whose value differs,
		// so leaving it empty here would make a user-chosen export permanently
		// unverifiable (and therefore never replaceable) even though it is ours.
		identitySuffixValue = identitySuffix(snap.notePath)
	} else {
		const resolved = resolveExportDir(outputRoot, snap.noteTitle, snap.notePath)
		finalDir = resolved.dir
		outputFolder = resolved.folder
		identitySuffixValue = resolved.suffix
	}
	// The stamp names both the staging dir and the backup dir; two runs in the
	// same millisecond would otherwise share one directory (review B9).
	const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
	const targetDir = `${finalDir}.tmp-${stamp}`
	const stages: string[] = []
	const keepTmp = targetDir

	try {
		await ensureFolder(adapter, targetDir)
		await ensureFolder(adapter, `${targetDir}/assets`)
		await ensureFolder(adapter, `${targetDir}/assets/media`)
	} catch (error) {
		throw stageError('创建目录', error, keepTmp)
	}
	stages.push('mkdir')

	try {
		await adapter.write(`${targetDir}/index.html`, html)
		stages.push('index.html')
		await adapter.write(`${targetDir}/assets/export.css`, cssText)
		stages.push('export.css')
	} catch (error) {
		throw stageError('写入主文件', error, keepTmp)
	}

	let flushed: AssetReport | null = null
	try {
		flushed = await assets.flush(`${targetDir}/assets/media`, adapter)
		stages.push('media')
	} catch (error) {
		throw stageError('复制媒体', error, keepTmp)
	}
	if (!flushed) throw new ExportError('复制媒体阶段没有返回结果', 'media', keepTmp)
	const assetReport: AssetReport = flushed

	// Review B1: a content asset that never *resolved* (not-found / ambiguous /
	// blob:) is just as fatal as one that failed to copy. `contentMissing`
	// already folds copy failures in (review C1), so it is the single source.
	const status: ExportStatus = assetReport.contentMissing > 0 ? 'incomplete' : 'ok'

	// The audit goes first: the manifest has to describe every file that already
	// exists, including this one (round 2A.1, F-02).
	try {
		await adapter.write(
			`${targetDir}/runtime-audit.json`,
			JSON.stringify(extra.audit, null, 2)
		)
		stages.push('runtime-audit')
	} catch (error) {
		throw stageError('写入审计', error, keepTmp)
	}

	// Round 2A.1 (F-02): record every file that reached disk, with its size and
	// SHA-256. This is the list that both the post-write verification and the
	// next export's ownership check compare against — before this round the
	// manifest only described media, so nothing could be reconciled.
	let fileList: FileRecord[] | null = null
	try {
		fileList = await buildFileList(adapter, targetDir)
	} catch (error) {
		throw stageError('生成文件清单', error, keepTmp)
	}
	if (!fileList || fileList.length === 0) {
		throw new ExportError(
			'生成文件清单失败：导出目录里没有任何文件',
			'manifest',
			keepTmp
		)
	}

	// Round 2A.2.2 (S4): a file name this plugin cannot express on Windows would
	// produce a manifest that the *next* export must refuse. Fail here, naming the
	// file, instead of writing a directory that can never be replaced.
	const illegal = findUnwritablePath(fileList)
	if (illegal) {
		throw new ExportError(
			`导出目录里存在无法在 Windows 上表达的文件名：${illegal}。` +
				'为避免写出一份下次无法验证的导出，本次没有提交。请先重命名该文件。',
			'manifest',
			keepTmp
		)
	}

	const manifest: Record<string, unknown> = {
		// Round 2A.2.2 (S3): version 2 is the signed format. An unsigned v1
		// manifest is refused by `inspectOwnership`, so writing one here would
		// produce a directory this build can never replace.
		manifestVersion: MANIFEST_VERSION_SIGNED,
		generatedAt: new Date().toISOString(),
		notePath: snap.notePath,
		noteTitle: snap.noteTitle,
		// The identity suffix is part of the directory name; recording it lets a
		// future round explain why two exports of similar titles differ. Round
		// 2A.2.2 (S3) also *verifies* it against the note being exported.
		identitySuffix: identitySuffixValue,
		captureWidth: snap.captureWidth,
		status,
		stats: snap.stats,
		resolution: {
			candidates: snap.resolution.candidates.length,
			excluded: snap.resolution.candidates
				.filter(c => c.excluded)
				.map(c => ({ index: c.index, className: c.className, reason: c.excluded })),
			selectedIndex:
				snap.resolution.candidates.find(c => c.selected)?.index ?? null,
			reason: snap.resolution.reason,
			ambiguity: snap.resolution.ambiguity
		},
		previewMetrics: snap.previewMetrics,
		warnings: snap.warnings,
		assets: {
			// Round 2A (R6/X8): `entries` publishes **only** files that reached
			// disk. A failed copy appears in `failed`, never here; `attempted`
			// keeps the total visible so a 0-of-3 run cannot look like "no
			// media in this note".
			written: assetReport.written,
			attempted: assetReport.attempted,
			entries: assetReport.writtenEntries,
			failed: assetReport.failed,
			missing: assetReport.missing,
			warnings: assetReport.warnings,
			remote: assetReport.remote,
			external: assetReport.external,
			contentFailed: assetReport.contentFailed,
			contentMissing: assetReport.contentMissing
		},
		// The complete file list — every file except this manifest. Both the
		// post-write verification and the next export's ownership check compare
		// against it, which is what makes "the directory is ours" provable.
		files: fileList,
		// Recorded so the manifest names the *actual* directory. A title that
		// sanitises differently from its raw form is now visible to the user
		// instead of silently landing somewhere unexpected.
		outputFolder,
		// Task 2: a user-chosen folder deliberately does NOT carry the note's
		// identity suffix in its name, and is never overwritten (it is
		// disambiguated instead). Recording which rule named the directory lets
		// `inspectOwnership` prove ownership for both kinds without weakening
		// the auto-folder overwrite rule. This field is covered by the signature.
		dirKind: explicitDir && explicitDir.trim() ? 'user-chosen' : 'auto',
		// `audit` is written to its own file; keeping it out of the manifest
		// avoids duplicating ~20 KB of measurements on every export.
		css: extra.css,
		pluginVersion: extra.pluginVersion
	}

	// The signature goes on last: it covers the projection of everything above
	// that can influence whether this directory may later be replaced.
	const signature = await signManifest(manifest, signingKey)
	if (!signature) {
		throw new ExportError(
			'为导出清单签名失败（密钥不可用或运行环境缺少 crypto.subtle），' +
				'本次没有提交导出。',
			'签名',
			keepTmp
		)
	}
	manifest.signature = signature

	const manifestPath = `${targetDir}/export-manifest.json`
	try {
		await adapter.write(manifestPath, JSON.stringify(manifest, null, 2))
		stages.push('manifest')
	} catch (error) {
		throw stageError('写入清单', error, keepTmp)
	}

	// --- verify on disk before anything is published ------------------------
	const expectedBody = measureBody(html)
	let verifiedResult: VerifyResult | null = null
	try {
		verifiedResult = await verifyExport(
			app,
			targetDir,
			assetReport,
			{
				body: expectedBody,
				signingKey,
				visibility: extra.visibility ?? null
			},
			adapter
		)
	} catch (error) {
		throw stageError('写入后校验', error, keepTmp)
	}
	if (!verifiedResult) {
		throw new ExportError('写入后校验没有返回结果', 'verify', keepTmp)
	}
	const verified: VerifyResult = verifiedResult
	if (!verified.ok) {
		const failedChecks = verified.checks.filter(c => !c.ok && !c.skipped)
		throw new ExportError(
			'写入后校验失败：' +
				failedChecks.map(c => `${c.name}（${c.detail}）`).join('；'),
			'verify',
			keepTmp,
			failedChecks
		)
	}
	stages.push('verify')

	// --- publish ------------------------------------------------------------
	let published: { leftover: string | null } | null = null
	try {
		published = await publish(adapter, targetDir, finalDir, stamp, snap.notePath, signingKey)
		stages.push('publish')
	} catch (error) {
		if (error instanceof ExportError) throw error
		throw stageError('发布', error, keepTmp)
	}

	/*
	 * The exclusive external publish materialises files rather than renaming a
	 * directory, so re-run the same integrity + signed-manifest verification on
	 * the *published* path. Only after this passes is the export reported as
	 * complete; a partially materialised directory is never labelled success.
	 * The vault path is unaffected (it has no `publishExclusive`).
	 */
	if (typeof adapter.publishExclusive === 'function') {
		let finalCheck: VerifyResult | null = null
		try {
			finalCheck = await verifyExport(
				app,
				finalDir,
				assetReport,
				{
					body: expectedBody,
					signingKey,
					visibility: extra.visibility ?? null
				},
				adapter
			)
		} catch (error) {
			throw stageError('发布后校验', error, finalDir)
		}
		if (!finalCheck?.ok) {
			const failed = (finalCheck?.checks ?? []).filter(
				c => !c.ok && !c.skipped && c.blocking !== false
			)
			throw new ExportError(
				'发布后校验失败：' +
					failed.map(c => `${c.name}（${c.detail}）`).join('；') +
					`\n发布目录 ${finalDir} 可能不完整，本次没有把它标记为成功导出，也没有删除任何文件。`,
				'发布后校验',
				finalDir,
				failed
			)
		}
		stages.push('published-verify')
	}

	return {
		dir: finalDir,
		// The staging directory was renamed away; reporting its old path would
		// hand callers a location that no longer exists (review B10).
		tmpDir: null,
		status,
		htmlBytes: byteLength(html),
		cssBytes: byteLength(cssText),
		assets: assetReport,
		manifestPath: `${finalDir}/export-manifest.json`,
		verified,
		stages,
		visibility: extra.visibility ?? null,
		leftoverBackup: published.leftover
	}
}

/**
 * Codes Windows returns for a *temporary* lock rather than a real refusal.
 *
 * `EPERM` covers "a handle is open inside this directory", `EBUSY` covers
 * "the volume is momentarily busy", `EACCES` shows up when an on-access virus
 * scanner is still reading the file. None of them say anything about ownership
 * or permissions, which is why retrying is not the same as ignoring a failure.
 */
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])
const RENAME_RETRY_DELAYS = [0, 120, 300, 600, 1000, 1500]

/**
 * Rename through the vault adapter, tolerating Windows' transient locks.
 *
 * Publishing is a **directory** rename, and on Windows that call returns EPERM
 * for as long as any process holds a handle inside the directory being moved.
 * Obsidian's own vault indexer opens the files of a freshly written directory
 * that it has just discovered, and Defender reads them too — so the export that
 * creates the most new files is the one most likely to lose the race. Measured
 * on this sandbox: `rename(p2-media-pkg-….tmp-…, p2-media-pkg-…)` failed with
 * `EPERM`, while the identical `fs.rename` from Node succeeded a minute later
 * against the same two paths, and no file had been touched in between.
 *
 * Retrying the same pair of paths is safe: the adapter itself refuses an
 * existing destination (`Destination file already exists!`), nothing is deleted
 * here, and a genuine permission problem still fails — just later, with the
 * original error preserved.
 */
async function renameWithRetry(
	adapter: { rename: (from: string, to: string) => Promise<void> },
	from: string,
	to: string
): Promise<void> {
	let lastError: unknown = null
	for (const delay of RENAME_RETRY_DELAYS) {
		if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay))
		try {
			await adapter.rename(from, to)
			return
		} catch (error) {
			const code = (error as { code?: string } | null)?.code ?? ''
			if (!TRANSIENT_RENAME_CODES.has(code)) throw error
			lastError = error
		}
	}
	throw lastError
}

/**
 * Swap the temp directory in, keeping the previous export recoverable.
 *
 * If the swap fails the backup is renamed back, so a failed run can never
 * destroy the last good export (review round 2, §5.1).
 *
 * Round 2A.1 (F-01) tightened two things:
 *
 *   - the previous export is only replaced when `inspectOwnership` can *prove*
 *     every file in it came from this plugin — a manifest alone is not proof;
 *   - the backup is verified again before the recursive delete, because a
 *     delete cannot be undone and the first check was one rename ago.
 */
async function publish(
	adapter: Adapter,
	tmpDir: string,
	finalDir: string,
	stamp: string,
	notePath: string,
	signingKey: string | null
): Promise<{ leftover: string | null }> {
	/*
	 * External (Node `fs`) destination: do not rename. Windows' `fs.rename`
	 * replaces an existing destination even when the caller checked a
	 * microsecond earlier, and no combination of `exists`/`lstat` closes that
	 * window. The facade instead atomically claims `finalDir` and creates every
	 * file exclusively; an existing name is an `EEXIST` refusal. Ownership,
	 * backup and restore are deliberately *not* attempted here — there is no
	 * race-free directory swap in Node's public API, so external exports never
	 * replace an earlier package at all. Vault-internal publishing below is
	 * untouched.
	 */
	if (typeof adapter.publishExclusive === 'function') {
		try {
			await adapter.publishExclusive(tmpDir, finalDir)
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error)
			throw new ExportError(
				`发布外部资源包失败：${reason}\n` +
					`本次没有覆盖任何已有文件。若 ${finalDir} 已被本次创建，它只是一个不完整的目录` +
					`（缺少有效的签名清单），不会被当作成功产物；确认内容后请手动删除再重试。\n` +
					`本次生成的内容保留在临时目录：${tmpDir}（插件不会自动删除它）。`,
				'publish',
				tmpDir
			)
		}
		return { leftover: null }
	}

	const backup = `${finalDir}.bak-${stamp}`

	// No previous export: nothing to back up, publish straight away.
	if (!(await adapter.exists(finalDir))) {
		await renameWithRetry(adapter, tmpDir, finalDir)
		return { leftover: null }
	}

	const verdict = await inspectOwnershipOn(adapter, finalDir, notePath, signingKey)
	if (!verdict.owned) {
		throw new ExportError(
			`目标目录 ${finalDir} 已存在，但无法证明它完全由本插件生成，因此没有覆盖。\n` +
				`原因：${verdict.reason}\n` +
				`该目录下的文件全部保留，未做任何改动。安全的做法：\n` +
				`  1) 在插件设置里换一个导出目录；\n` +
				`  2) 把 ${finalDir} 改名或移走，再重新导出；\n` +
				`  3) 确认其中没有你自己的文件后，手动删除它。\n` +
				`本次生成的内容保留在临时目录：${tmpDir}（插件不会自动删除它）。`,
			'publish',
			tmpDir
		)
	}

	// Round 2A.2.1 (S2): the cross-note comparison now lives inside
	// `inspectOwnership`, which refuses before this point. A second, weaker copy
	// here is how the original hole appeared — it was skipped whenever
	// `manifestNotePath` was null, i.e. exactly when `notePath` had been deleted.

	// Round 2A.2 (B5): never delete the previous export. Move it to a `.bak-`
	// directory and keep it. A recursive delete cannot be undone, and — as the
	// round 2A.1 review showed — left a TOCTOU window in which a user file
	// dropped into the backup between the two ownership checks was wiped.
	await renameWithRetry(adapter, finalDir, backup)

	// Round 2A.2.1 (S5): restoring and reporting are two separate steps.
	//
	// The old code threw the "restored successfully" error *inside* the try that
	// guarded the restore, so its own catch swallowed it and every recoverable
	// failure was reported as "无法恢复". Now only a failing `rename` reaches the
	// catch, and the two outcomes produce two different messages.
	try {
		await renameWithRetry(adapter, tmpDir, finalDir)
	} catch (publishError) {
		const cause =
			publishError instanceof Error ? publishError.message : String(publishError)

		try {
			await renameWithRetry(adapter, backup, finalDir)
		} catch (restoreError) {
			const restoreCause =
				restoreError instanceof Error ? restoreError.message : String(restoreError)
			throw new ExportError(
				`发布新导出失败（${cause}），恢复旧导出也失败（${restoreCause}）。\n` +
					`旧导出仍完整保留在备份目录：${backup}\n` +
					`把该目录改名回 ${finalDir} 即可恢复上一次导出；` +
					`本次生成的内容保留在临时目录。`,
				'publish',
				tmpDir
			)
		}

		throw new ExportError(
			`发布新导出失败（${cause}），已恢复上一次导出：旧目录已回到 ${finalDir}，内容未被改动。\n` +
				`本次生成的内容保留在临时目录。`,
			'publish',
			tmpDir
		)
	}

	// Success: the backup is retained so the user can recover or compare.
	return { leftover: backup }
}

/*
 * Round 2A.2.1 (S4): `safeRemoveBackup()` was removed.
 *
 * It could not be made safe in this round: the path check was a `.bak-`
 * substring test with no containment proof, ownership was re-established by
 * the same function that then deleted (a TOCTOU window between the verdict and
 * the unlink), the second enumeration did not re-validate every directory, an
 * empty user-created directory could be removed, and a failed delete could
 * still return `removed: true`.
 *
 * The only supported lifecycle is therefore:
 *
 *   successful export → old directory renamed to `.bak-*` → new directory
 *   published → the old backup is kept forever
 *
 * A cleanup feature needs its own user-initiated flow with its own threat
 * model. Keeping unsafe deletion code around "for the future" is not a
 * down-payment, it is an attack surface nobody is testing.
 */

export interface VerifyOptions {
	/**
	 * Body measurement taken on the HTML string we were about to write.
	 * `null` when the page carries no body markers at all.
	 */
	body: BodyMeasure | null
	/**
	 * Round 2A.2.2 (S3): when supplied, the freshly written manifest must carry a
	 * signature this vault can verify. `writeExport` always supplies it, so the
	 * production path never publishes an unsigned export; older call sites that
	 * only re-check a directory may omit it.
	 */
	signingKey?: string | null
	/**
	 * Round 3.3.1: pre-computed static CSS visibility audit. When present and it
	 * reports a blank risk, an advisory (non-blocking) check is recorded so the
	 * report reflects the risk without failing an otherwise valid export.
	 */
	visibility?: VisibilityAuditResult | null
}

export interface BodyMeasure {
	/** Characters between the markers, tags included. */
	chars: number
	/** True when the fragment holds a block, media node or real text. */
	hasContent: boolean
}

/** Tags that count as real body content on their own. */
const STRUCTURAL_TAG =
	/<(p|li|h[1-6]|blockquote|pre|table|hr|dt|dd|img|video|audio|iframe|embed|canvas|svg|mjx-container)\b/i

/**
 * Does this body fragment actually hold something?
 *
 * Length is not enough: `buildHtml` always emits `${sizer.outerHTML}`, so an
 * empty container still measures ~40–90 characters and a length check would
 * pass for exactly the case R7 produced (review B2). The fragment must contain
 * a block/media element, or text once the tags are stripped.
 */
export function bodyHasContent(fragment: string): boolean {
	if (STRUCTURAL_TAG.test(fragment)) return true
	const text = fragment
		.replace(/<[^>]*>/g, '')
		.replace(/&[a-zA-Z#0-9]+;/g, ' ')
		.trim()
	return text.length > 0
}

/** Measure the fragment between the body markers, or null when they are absent. */
export function measureBody(html: string): BodyMeasure | null {
	const start = html.indexOf(BODY_START)
	const end = html.indexOf(BODY_END)
	if (start < 0 || end < 0 || end <= start) return null
	const fragment = html.slice(start + BODY_START.length, end)
	return { chars: fragment.trim().length, hasContent: bodyHasContent(fragment) }
}

/* ------------------------------------------------------------------------- *
 * Round 2A.1 · F-01: prove the directory is ours before touching it
 * ------------------------------------------------------------------------- */

/**
 * Version of the manifest shape written by this build.
 *
 * Round 2A.2.2 (S3): 1 → 2. Version 1 was unsigned; a directory carrying it can
 * no longer be proven intact, so it is refused rather than trusted.
 */
export const MANIFEST_VERSION = MANIFEST_VERSION_SIGNED

/** One file the export wrote, relative to the export directory. */
export interface FileRecord {
	/** Path relative to the export directory, forward slashes. */
	path: string
	bytes: number
	/**
	 * Lowercase hex SHA-256.
	 *
	 * Round 2A.2.2 (S2): required. The old optional hash is what allowed a
	 * manifest to quietly downgrade one file to a size-only comparison while
	 * `basis` still claimed `manifest-hash`.
	 */
	sha256: string
}

interface DirListing {
	files: string[]
	dirs: string[]
}

/**
 * How an ownership verdict was reached.
 *
 * Only `manifest-hmac` can ever accompany `owned === true`: it is the one basis
 * that rests on a secret the manifest cannot produce by itself.
 */
export type OwnershipBasis = 'manifest-hmac' | 'none'

export interface OwnershipReport {
	owned: boolean
	reason: string
	basis: OwnershipBasis
	/** Files on disk the manifest does not account for — treated as user files. */
	foreignFiles: string[]
	/** Directories an export can never create. */
	foreignDirs: string[]
	/** Files the manifest promises but disk lacks. */
	missingFiles: string[]
	/** Files whose size or hash disagrees with the manifest. */
	changedFiles: string[]
	/** `notePath` recorded in the manifest, when it has one. */
	manifestNotePath: string | null
	/** `manifestVersion` recorded in the manifest, when it is a number. */
	manifestVersion: number | null
	/** True only when the HMAC over the manifest projection verified. */
	signatureVerified: boolean
	/** How many files were actually compared (not just listed). */
	checked: number
	/**
	 * Files the manifest declared a verification basis for, but which the
	 * runtime could not actually verify (no `crypto.subtle` / `stat`, or those
	 * calls failed). Such files must not be counted as `checked` (B3).
	 */
	unverified: number
	/** Total files the manifest accounts for. */
	expected: number
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
> & {
	/**
	 * Optional race-free publish used by the external (Node `fs`) facade.
	 *
	 * Absent on the vault adapter, whose own `rename` already refuses an
	 * existing destination. When present, `publish()` calls this instead of any
	 * rename: the facade atomically claims the destination with
	 * `mkdir(recursive:false)` and creates every file with `wx`. See
	 * `external/adapter.ts → materializeExclusive`.
	 */
	publishExclusive?: (from: string, to: string) => Promise<void>
}

function relativeTo(base: string, full: string): string {
	const prefix = `${base}/`
	return full.startsWith(prefix) ? full.slice(prefix.length) : full
}

/** Recursively list every file and directory under `dir`, relative to it. */
async function walkDir(adapter: Adapter, dir: string): Promise<DirListing | null> {
	const files: string[] = []
	const dirs: string[] = []
	const visit = async (current: string): Promise<void> => {
		const listed = await adapter.list(current)
		for (const f of listed.files) files.push(relativeTo(dir, f))
		for (const d of listed.folders) {
			dirs.push(relativeTo(dir, d))
			await visit(d)
		}
	}
	try {
		await visit(dir)
	} catch {
		return null
	}
	files.sort()
	dirs.sort()
	return { files, dirs }
}

/**
 * Record every file under `dir` with its size and SHA-256.
 *
 * `export-manifest.json` is excluded: the manifest cannot describe its own hash.
 *
 * Round 2A.2.2 (S2): `bytes` and `sha256` now come from **one** read of the same
 * bytes, and both are mandatory. The old version took the size from `stat` and
 * the hash from a separate read, which is how a record could end up with a size
 * but no hash (and then be verified by size alone). A file that cannot be read
 * or hashed fails the export instead of producing a weaker record.
 */
async function buildFileList(adapter: Adapter, dir: string): Promise<FileRecord[] | null> {
	const listing = await walkDir(adapter, dir)
	if (!listing) return null

	const out: FileRecord[] = []
	for (const path of listing.files) {
		if (path === 'export-manifest.json') continue
		const measured = await measureFile(adapter, `${dir}/${path}`)
		if (!measured) return null
		out.push({ path, bytes: measured.bytes, sha256: measured.sha256 })
	}
	return out
}

/** Read a file once and return both its byte length and its SHA-256. */
async function measureFile(
	adapter: Adapter,
	path: string
): Promise<{ bytes: number; sha256: string } | null> {
	const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle
	if (!subtle) return null
	try {
		const data = await adapter.readBinary(path)
		const digest = await subtle.digest('SHA-256', data)
		return {
			bytes: data.byteLength,
			sha256: [...new Uint8Array(digest)]
				.map(b => b.toString(16).padStart(2, '0'))
				.join('')
		}
	} catch {
		return null
	}
}

/** Lowercase hex SHA-256 of a file, or null when the runtime cannot hash. */async function hashFile(adapter: Adapter, path: string): Promise<string | null> {
	const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle
	if (!subtle) return null
	try {
		const data = await adapter.readBinary(path)
		const digest = await subtle.digest('SHA-256', data)
		return [...new Uint8Array(digest)]
			.map(b => b.toString(16).padStart(2, '0'))
			.join('')
	} catch {
		return null
	}
}

interface ManifestRead {
	manifest: Record<string, unknown> | null
	present: boolean
	error: string | null
}

async function readManifest(adapter: Adapter, dir: string): Promise<ManifestRead> {
	const path = `${dir}/export-manifest.json`
	if (!(await adapter.exists(path))) {
		return { manifest: null, present: false, error: null }
	}
	try {
		const parsed = JSON.parse(await adapter.read(path)) as unknown
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return { manifest: null, present: true, error: '清单不是一个 JSON 对象' }
		}
		return { manifest: parsed as Record<string, unknown>, present: true, error: null }
	} catch (error) {
		return {
			manifest: null,
			present: true,
			error: error instanceof Error ? error.message : String(error)
		}
	}
}

/**
 * Manifest versions whose shape this build can verify as owned.
 *
 * Round 2A.2.2 (S3): only `2`. Version 1 carried no signature, so "this
 * directory is ours" could not be proven for it — and a v1 manifest is
 * indistinguishable from a v2 one that had fields deleted.
 */
const SUPPORTED_MANIFEST_VERSIONS = new Set<number>([MANIFEST_VERSION_SIGNED])

/** True when the runtime can actually compute a SHA-256 of file contents. */
function hashCapable(): boolean {
	const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle
	return !!subtle
}

/** Windows device names, with or without an extension (`CON.txt` is reserved). */
const RESERVED_SEGMENT = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i

/** Characters Windows forbids inside a file name. `:` is included for NTFS ADS. */
const ILLEGAL_SEGMENT_CHARS = /[<>:"|?*\\/]/

/** C0 controls and DEL — legal on POSIX, hostile everywhere else. */
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/

/**
 * Is one path segment writable on Windows?
 *
 * Round 2A.2.2 (S4). The previous rule only rejected empty/`.`/`..` segments,
 * so `a:b.png` (NTFS alternate data stream), `CON`/`NUL.txt`/`COM1` (reserved
 * device names), `file.`/`file ` (Windows silently trims) and `*`/`|` all
 * passed. On this machine those names become real files through Node's `\\?\`
 * paths, which is why the earlier review saw them "work" — but they are not
 * portable, and `:` genuinely aliases another object on NTFS.
 */
function isLegalSegment(segment: string): boolean {
	if (segment === '' || segment === '.' || segment === '..') return false
	if (CONTROL_CHARS.test(segment)) return false
	if (ILLEGAL_SEGMENT_CHARS.test(segment)) return false
	if (RESERVED_SEGMENT.test(segment)) return false
	// Trailing dot or space: Windows drops them, so the on-disk name would
	// differ from the manifest and the diff would silently target another file.
	if (/[. ]$/.test(segment)) return false
	// A segment of nothing but spaces collapses to nothing.
	if (segment.trim().length === 0) return false
	return true
}

/**
 * Is this a legal **file** path inside the export directory, checked as written?
 *
 * Rejected: absolute (`/…`, `//server/share`), drive-qualified (`C:/…`),
 * backslashes, control characters, `:` (ADS), Windows-illegal characters,
 * reserved device names, trailing dots/spaces, and empty/`.`/`..` segments.
 *
 * Round 2A.2.1 (S3) already stopped cleaning the value before validating it;
 * round 2A.2.2 (S4) tightened what counts as legal. Cleaning must never turn an
 * illegal path into a legal one, so callers use the raw string verbatim.
 */
function isLegalRelativePath(raw: unknown): boolean {
	if (typeof raw !== 'string' || raw.length === 0) return false
	if (raw.length > 1024) return false
	if (raw.startsWith('/')) return false
	if (/^[A-Za-z]:/.test(raw)) return false
	if (raw.includes('\\')) return false
	if (CONTROL_CHARS.test(raw)) return false
	return raw.split('/').every(isLegalSegment)
}

/**
 * Is this a legal **note** identity (`manifest.notePath`)?
 *
 * Deliberately weaker than `isLegalRelativePath`: a note path is an identity
 * string, not a file this plugin creates. Applying the Windows file-name rules
 * here would make a note called `A:B.md` (legal on macOS/Linux) permanently
 * un-exportable, without closing any hole — the cross-note guard is the
 * equality check, not the character set.
 *
 * Traversal and absolute forms are still rejected: they are how a `notePath`
 * could pretend to be something it is not.
 */
function isLegalNotePath(raw: unknown): boolean {
	if (typeof raw !== 'string' || raw.length === 0) return false
	if (raw.length > 1024) return false
	if (raw.startsWith('/')) return false
	if (/^[A-Za-z]:/.test(raw)) return false
	if (raw.includes('\\')) return false
	if (CONTROL_CHARS.test(raw)) return false
	for (const segment of raw.split('/')) {
		if (segment === '' || segment === '.' || segment === '..') return false
	}
	return true
}

/**
 * A manifest path may only be a vault-relative, slash-joined file name with no
 * escapes. Anything absolute, with a drive/backslash, `..`, a control
 * character, or pointing at the manifest itself is rejected (B2 / path safety).
 */
function isLegalManifestPath(p: unknown): boolean {
	return isLegalRelativePath(p) && p !== 'export-manifest.json'
}

/**
 * Comparison key for "the same file on a case-insensitive, NFC-normalising
 * filesystem". Two records that fold to the same key can name one physical file.
 */
function pathCollisionKey(path: string): string {
	return path.normalize('NFC').toLowerCase()
}

/**
 * Round 2A.2.2 (S4): would this file list produce a manifest this plugin could
 * never verify? Returns the offending path, or null.
 *
 * Used on the write side so an unverifiable export is refused instead of being
 * published and then permanently un-replaceable.
 */
function findUnwritablePath(records: FileRecord[]): string | null {
	const seen = new Set<string>()
	for (const rec of records) {
		if (!isLegalManifestPath(rec.path)) return rec.path
		const key = pathCollisionKey(rec.path)
		if (seen.has(key)) return `${rec.path}（与另一条记录大小写或 Unicode 归一化后相同）`
		seen.add(key)
	}
	return null
}

/**
 * Parse the `files` array into a path → record map, strictly.
 *
 * Round 2A.2.2 (S2) makes every field mandatory and removes the size-only
 * fallback. A manifest that cannot state a SHA-256 for a file is not a weaker
 * manifest, it is an unusable one: the whole point of `files` is to prove the
 * bytes on disk are the bytes we wrote.
 */
function parseManifestFilesStrict(
	raw: unknown
): { ok: true; records: Map<string, FileRecord> } | { ok: false; reason: string } {
	if (raw === undefined) return { ok: false, reason: '清单缺少 files 字段' }
	if (!Array.isArray(raw)) return { ok: false, reason: 'files 字段类型错误：应为数组' }
	if (raw.length === 0) return { ok: false, reason: 'files 字段为空数组' }
	const records = new Map<string, FileRecord>()
	const seen = new Map<string, string>()
	for (const item of raw) {
		if (!item || typeof item !== 'object' || Array.isArray(item)) {
			return { ok: false, reason: 'files 中存在非对象记录' }
		}
		const rec = item as { path?: unknown; bytes?: unknown; sha256?: unknown }
		if (typeof rec.path !== 'string' || !rec.path) {
			return { ok: false, reason: 'files 中存在缺少 path 的记录' }
		}
		// Validate the raw value — no `replace(/^\.?\//, '')`, which would
		// launder `/index.html` into `index.html` (2A.2.1 S3).
		if (!isLegalManifestPath(rec.path)) {
			return { ok: false, reason: `files 含非法路径：${JSON.stringify(rec.path)}` }
		}
		const path = rec.path
		if (records.has(path)) return { ok: false, reason: `files 含重复路径：${path}` }
		// Round 2A.2.2 (S4): `A.png` and `a.png` are one file on Windows, and
		// two NFC-equivalent spellings are one file everywhere. Both would let a
		// single physical file satisfy two records.
		const key = pathCollisionKey(path)
		const twin = seen.get(key)
		if (twin !== undefined) {
			return {
				ok: false,
				reason: `files 含归一化后重复的路径：${JSON.stringify(path)} 与 ${JSON.stringify(twin)}`
			}
		}
		seen.set(key, path)

		// bytes: required, finite, non-negative integer. `-1` ("no size
		// recorded") is no longer legal — it was the size-only escape hatch.
		if (typeof rec.bytes !== 'number' || !Number.isInteger(rec.bytes) || rec.bytes < 0) {
			return { ok: false, reason: `files 记录 ${path} 缺少合法的 bytes` }
		}
		// sha256: required, 64 hex. No fallback (2A.2.2 S2).
		if (typeof rec.sha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(rec.sha256)) {
			return {
				ok: false,
				reason: `files 记录 ${path} 缺少合法的 64 位 sha256（不接受只比大小）`
			}
		}
		records.set(path, { path, bytes: rec.bytes, sha256: rec.sha256.toLowerCase() })
	}
	return { ok: true, records }
}

/** Lenient wrapper kept for the post-write verification of our own output. */
function parseFileRecords(raw: unknown): Map<string, FileRecord> | null {
	const parsed = parseManifestFilesStrict(raw)
	return parsed.ok ? parsed.records : null
}

/** Directories an export is allowed to contain, given its expected files. */
function allowedDirsFor(expected: Iterable<string>): Set<string> {
	const allowed = new Set(['assets', 'assets/media'])
	for (const path of expected) {
		const parts = path.split('/')
		for (let i = 1; i < parts.length; i++) allowed.add(parts.slice(0, i).join('/'))
	}
	return allowed
}

/**
 * Is `dir` a directory this plugin can safely replace?
 *
 * Round 2A.1 (F-01) removed the old short-circuit —
 *
 *     if (await adapter.exists(`${dir}/export-manifest.json`)) return true
 *
 * — which treated "a manifest exists" as proof of ownership. Any file the user
 * had put next to that manifest (a saved PDF, a screenshot, their own README)
 * was then renamed into a backup that `publish()` deleted recursively.
 *
 * Ownership now has to be *demonstrated*, not inferred:
 *
 *   1. enumerate the whole directory, recursively;
 *   2. read the manifest — an unparseable manifest is treated as tampering;
 *   2b. (2A.2.1 S2) prove the directory belongs to *this* note: `notePath` must
 *      be present, a legal vault-relative path, and exactly equal to the path
 *      being exported. v1 and legacy alike;
 *   2c. (2A.2.1 S1) refuse a manifest that has `files` but no `manifestVersion`
 *      instead of treating it as the old format;
 *   3. compare the on-disk file set against the manifest's `files` list
 *      (exact set, then size, then SHA-256);
 *   4. allow only the two directories an export creates;
 *   5. for manifests that predate `files` (round 2 and earlier), fall back to a
 *      structural proof: only plugin file names **and** `index.html` carries the
 *      body markers this plugin emits. The structural proof is additional to
 *      2b, never a replacement for it.
 *
 * Anything unexplained is treated as the user's and refuses the publish.
 *
 * `expectedNotePath` is required: making it optional would restore exactly the
 * hole S2 closed, because a caller could omit it and lose the cross-note guard.
 */
export async function inspectOwnership(
	app: App,
	dir: string,
	expectedNotePath: string,
	signingKey: string | null,
	/** Task 3: inspect the directory that lives on *this* adapter. */
	destination?: Adapter
): Promise<OwnershipReport> {
	return inspectOwnershipOn(
		destination ?? app.vault.adapter,
		dir,
		expectedNotePath,
		signingKey
	)
}

/**
 * The adapter-only form, used by `publish` — which no longer holds an `App` now
 * that the export root can live outside the vault.
 */
async function inspectOwnershipOn(
	adapter: Adapter,
	dir: string,
	expectedNotePath: string,
	signingKey: string | null
): Promise<OwnershipReport> {
	const empty = (
		reason: string,
		extra: Partial<OwnershipReport> = {}
	): OwnershipReport => ({
		owned: false,
		reason,
		basis: 'none',
		foreignFiles: [],
		foreignDirs: [],
		missingFiles: [],
		changedFiles: [],
		manifestNotePath: null,
		manifestVersion: null,
		signatureVerified: false,
		checked: 0,
		unverified: 0,
		expected: 0,
		...extra
	})

	if (typeof adapter.list !== 'function') {
		return empty('当前文件适配器不支持目录枚举，无法证明该目录完全由本插件生成')
	}

	const listing = await walkDir(adapter, dir)
	if (!listing) {
		return empty('目录枚举失败，无法证明该目录完全由本插件生成')
	}
	if (listing.files.length === 0) {
		return empty('目录为空，没有可核对的导出文件')
	}

	const read = await readManifest(adapter, dir)
	if (read.present && read.error) {
		// Illegal JSON in a manifest is treated as tampering: refuse (B4).
		return empty(
			`清单无法解析（${read.error}）——清单被改动过，不再认为该目录属于本插件`
		)
	}

	const manifest = read.manifest
	const manifestNotePath =
		manifest && typeof manifest.notePath === 'string' ? manifest.notePath : null
	const manifestVersion =
		manifest && typeof manifest.manifestVersion === 'number'
			? manifest.manifestVersion
			: null

	if (!manifest) {
		return empty(
			read.present
				? '清单存在但无法解析，无法确认该目录属于哪篇笔记'
				: `目录中没有 export-manifest.json，无法证明该目录属于本插件。${UNVERIFIABLE_DIR_MESSAGE}`,
			{ manifestNotePath }
		)
	}

	// --- S1 / S3: only a signed, current-format manifest can be owned --------
	//
	// Round 2A.2.1 tried to separate "real legacy" from "v2 with fields deleted"
	// by looking at which fields were present. The 2A.2.1 review proved that is
	// undecidable: deleting both `manifestVersion` and `files` produces a
	// manifest that is byte-for-byte the legacy shape. So the decision no longer
	// depends on field structure at all — a directory is replaceable only when
	// it carries a signature this vault can verify.
	if (!Object.prototype.hasOwnProperty.call(manifest, 'manifestVersion')) {
		return empty(
			`清单没有 manifestVersion，属于旧版导出。${UNVERIFIABLE_DIR_MESSAGE}`,
			{ manifestNotePath }
		)
	}
	if (typeof manifest.manifestVersion !== 'number') {
		return empty(
			`清单的 manifestVersion 不是数字（${JSON.stringify(
				manifest.manifestVersion
			)}），无法验证。${UNVERIFIABLE_DIR_MESSAGE}`,
			{ manifestNotePath }
		)
	}
	if (manifest.manifestVersion === 1) {
		return empty(
			`清单是未签名的 v1 格式，无法证明其完整性。${UNVERIFIABLE_DIR_MESSAGE}`,
			{ manifestNotePath, manifestVersion }
		)
	}
	if (!SUPPORTED_MANIFEST_VERSIONS.has(manifest.manifestVersion)) {
		return empty(
			`清单版本 ${manifest.manifestVersion} 不受支持（仅支持 ${[
				...SUPPORTED_MANIFEST_VERSIONS
			].join(', ')}）。${UNVERIFIABLE_DIR_MESSAGE}`,
			{ manifestNotePath, manifestVersion }
		)
	}

	// The key is checked before the signature: "no key" and "bad signature" are
	// different user problems (lost key vs. edited manifest) and must not be
	// reported as one.
	if (!isValidSigningKey(signingKey)) {
		return empty(
			'本 Vault 的签名密钥不可用（未生成、被清空或格式非法），' +
				'无法验证该目录的签名，因此不覆盖。' +
				'请到插件设置确认密钥状态；不要删除旧目录，先手动备份或移走它。',
			{ manifestNotePath, manifestVersion }
		)
	}

	const block = readSignature(manifest)
	if (!block.ok) {
		return empty(`${block.reason}。${UNVERIFIABLE_DIR_MESSAGE}`, {
			manifestNotePath,
			manifestVersion
		})
	}

	// Signature verification runs **before** any ownership decision: every other
	// field below is attacker-controlled until this passes.
	const signature = await verifyManifestSignature(manifest, signingKey)
	if (!signature.ok) {
		return empty(`${signature.reason}。${UNVERIFIABLE_DIR_MESSAGE}`, {
			manifestNotePath,
			manifestVersion
		})
	}

	// --- S2 / S3: the directory belongs to *this* note -----------------------
	if (typeof manifest.notePath !== 'string' || manifest.notePath.length === 0) {
		return empty(
			'清单缺少 notePath（或它不是非空字符串），无法确认该目录属于当前笔记，因此不覆盖',
			{ manifestNotePath, manifestVersion, signatureVerified: true }
		)
	}
	if (!isLegalNotePath(manifest.notePath)) {
		return empty(
			`清单的 notePath 不是合法的 Vault 相对路径：${JSON.stringify(
				manifest.notePath
			)}，因此不覆盖`,
			{ manifestNotePath, manifestVersion, signatureVerified: true }
		)
	}
	if (manifest.notePath !== expectedNotePath) {
		return empty(
			`清单记录的笔记是 ${manifest.notePath}，与本次导出的 ${expectedNotePath} 不一致——` +
				'该目录属于另一篇笔记，为避免两篇笔记互相覆盖，拒绝覆盖',
			{ manifestNotePath, manifestVersion, signatureVerified: true }
		)
	}

	// Round 2A.2.2 (S3.4/S3.5): the signature proves the manifest was written by
	// this vault; these two checks prove the directory it sits in is the one it
	// describes. Without them, a signed manifest copied into another note's
	// export folder would still verify.
	const dirName = dir.split('/').filter(Boolean).pop() ?? ''
	const expectedSuffix = identitySuffix(expectedNotePath)
	if (typeof manifest.identitySuffix !== 'string') {
		return empty(
			'清单缺少 identitySuffix，无法确认目录与笔记的对应关系，因此不覆盖',
			{ manifestNotePath, manifestVersion, signatureVerified: true }
		)
	}
	if (manifest.identitySuffix !== expectedSuffix) {
		return empty(
			`清单的 identitySuffix（${manifest.identitySuffix}）与当前笔记重新计算的结果` +
				`（${expectedSuffix}）不一致——该目录属于另一篇笔记，拒绝覆盖`,
			{ manifestNotePath, manifestVersion, signatureVerified: true }
		)
	}
	if (typeof manifest.outputFolder !== 'string' || manifest.outputFolder !== dirName) {
		return empty(
			`清单记录的 outputFolder（${JSON.stringify(
				manifest.outputFolder
			)}）与实际目录名（${dirName}）不一致，拒绝覆盖`,
			{ manifestNotePath, manifestVersion, signatureVerified: true }
		)
	}
	// Task 2: a user-chosen folder has a name the user picked, so it cannot
	// carry the identity suffix. That is safe because such a folder is never
	// replaced (writeExport disambiguates to `-2`, `-3`, …). For this one kind
	// the signed manifest itself is the ownership proof: at this point the HMAC,
	// `notePath`, `identitySuffix` and `outputFolder === dirName` have all been
	// verified against the note being exported, so a manifest copied from
	// another note's folder still fails. `dirKind` is inside the signature, so
	// it cannot be added or stripped by an attacker. Auto-named folders keep
	// the original, stricter directory-name rule unchanged.
	const userChosen = manifest.dirKind === 'user-chosen'
	if (!dirName.endsWith(`-${expectedSuffix}`) && !userChosen) {
		return empty(
			`目录名 ${dirName} 不带当前笔记的标识后缀（-${expectedSuffix}），` +
				'无法确认它属于当前笔记，拒绝覆盖',
			{ manifestNotePath, manifestVersion, signatureVerified: true }
		)
	}

	// --- S2: every record must be fully verifiable ---------------------------
	const parsed = parseManifestFilesStrict(manifest.files)
	if (!parsed.ok) {
		return empty(`清单 files 字段无效（${parsed.reason}），无法验证所有权`, {
			manifestNotePath,
			manifestVersion,
			signatureVerified: true
		})
	}
	const expected = parsed.records
	const format = 'v2' as const

	// --- decide manifest format & expected file set ---------------------------
	let basis: OwnershipBasis = 'none'

	// --- compare -------------------------------------------------------------
	const actual = new Set(listing.files.filter(p => p !== 'export-manifest.json'))
	const foreignFiles = [...actual].filter(p => !expected.has(p))
	const missingFiles = [...expected.keys()].filter(p => !actual.has(p))

	const changedFiles: string[] = []
	let checked = 0
	let unverified = 0

	// Round 2A.2.2 (S2): every record carries a size *and* a SHA-256, and both
	// are compared against one read of the file. There is no "declared method"
	// any more, so a manifest cannot ask for a weaker check than the one below.
	for (const [path, rec] of expected) {
		if (!actual.has(path)) continue // counted in missingFiles
		const measured = await measureFile(adapter, `${dir}/${path}`)
		if (!measured) {
			// readBinary / crypto failed: cannot verify, so cannot claim ownership.
			unverified++
			continue
		}
		if (measured.bytes !== rec.bytes) {
			changedFiles.push(`${path}（${measured.bytes} ≠ ${rec.bytes} 字节）`)
			continue
		}
		if (measured.sha256 !== rec.sha256) {
			changedFiles.push(`${path}（内容哈希不一致）`)
			continue
		}
		checked++
	}
	// `basis` is only ever "manifest-hmac" when the signature verified *and*
	// every promised file was actually hashed and matched.
	basis =
		checked === expected.size && unverified === 0 && missingFiles.length === 0
			? 'manifest-hmac'
			: 'none'

	const allowedDirs = allowedDirsFor(expected.keys())
	const foreignDirs = listing.dirs.filter(d => !allowedDirs.has(d))

	// Structural evidence that this really is one of our pages. It is no longer
	// load-bearing (the signature is), but it costs one read and catches a
	// signed manifest paired with a foreign index.html.
	let provenanceOk = true
	try {
		const html = await adapter.read(`${dir}/index.html`)
		provenanceOk = html.includes(BODY_START) && html.includes(BODY_END)
	} catch {
		provenanceOk = false
	}

	const problems: string[] = []
	if (foreignFiles.length > 0) {
		problems.push(
			`${foreignFiles.length} 个清单外文件（${foreignFiles.slice(0, 5).join(', ')}${
				foreignFiles.length > 5 ? ' …' : ''
			}）`
		)
	}
	if (foreignDirs.length > 0) {
		problems.push(`${foreignDirs.length} 个清单外目录（${foreignDirs.slice(0, 3).join(', ')}）`)
	}
	if (missingFiles.length > 0) {
		problems.push(
			`${missingFiles.length} 个清单登记但磁盘缺失（${missingFiles.slice(0, 5).join(', ')}）`
		)
	}
	if (changedFiles.length > 0) {
		problems.push(`${changedFiles.length} 个文件与清单不符（${changedFiles.slice(0, 3).join('；')}）`)
	}
	// A file the runtime could not read or hash is not a pass. Round 2A.2.2
	// removed the size-only fallback, so there is no weaker check to fall back to.
	if (unverified > 0) {
		problems.push(
			`${unverified} 个文件无法验证（读取或哈希失败），无法确认所有权`
		)
	}
	if (!provenanceOk) {
		problems.push('index.html 不含本插件的正文标记，无法证明由本插件生成')
	}

	const owned = problems.length === 0
	return {
		owned,
		reason: owned
			? `目录与清单完全一致（${expected.size} 个文件，签名有效，依据 ${basis}）`
			: problems.join('；'),
		basis,
		foreignFiles,
		foreignDirs,
		missingFiles,
		changedFiles,
		manifestNotePath,
		manifestVersion,
		signatureVerified: true,
		checked,
		unverified,
		expected: expected.size
	}
}

/**
 * The ten checks from the review, executed against the real filesystem.
 *
 * Reading back what we just wrote is the only way to tell "the write call
 * resolved" from "the file is there". The body check compares the file against
 * the string we handed to `write` — the manifest numbers alone come from the
 * capture step and therefore cannot prove the file has content (review B2).
 */
export async function verifyExport(
	app: App,
	dir: string,
	assetReport: AssetReport,
	options: VerifyOptions = { body: null },
	/** Task 3: verify the files that were written to *this* adapter. */
	destination?: Adapter
): Promise<VerifyResult> {
	const adapter = destination ?? app.vault.adapter
	const checks: VerifyCheck[] = []

	const existsCheck = async (name: string, path: string, minBytes = 0) => {
		const exists = await adapter.exists(path)
		if (!exists) {
			checks.push({ name, ok: false, detail: `不存在：${path}` })
			return false
		}
		const size = await sizeOf(adapter, path)
		if (size === null) {
			// Existence is confirmed; only the size check could not run.
			checks.push({
				name,
				ok: true,
				skipped: true,
				detail: `存在，适配器不提供 stat，大小未校验：${path}`
			})
			return true
		}
		const ok = size >= minBytes
		checks.push({
			name,
			ok,
			detail: ok ? `${size} 字节` : `仅 ${size} 字节（要求 ≥ ${minBytes}）`
		})
		return ok
	}

	for (const required of REQUIRED_FILES) {
		await existsCheck(
			`${required.path} 存在`,
			`${dir}/${required.path}`,
			required.minBytes
		)
	}
	await existsCheck('assets/media 目录存在', `${dir}/assets/media`)

	// 7) manifest parses, and its numbers agree with the disk.
	let manifest: Record<string, unknown> | null = null
	try {
		const raw = await adapter.read(`${dir}/export-manifest.json`)
		manifest = JSON.parse(raw) as Record<string, unknown>
		checks.push({ name: 'manifest 可解析', ok: true, detail: 'JSON 合法' })
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error)
		checks.push({ name: 'manifest 可解析', ok: false, detail: reason })
	}

	// 8) the *written file* must carry a body. This is the check that would
	// have caught R7: a full skeleton with an empty body passed every other
	// check, because every other input came from the capture that failed.
	//
	// "Non-empty" means structurally non-empty, not "has some characters" —
	// an empty sizer still renders its own opening and closing tags (review
	// B2, second pass).
	let writtenBody: BodyMeasure | null = null
	try {
		const html = await adapter.read(`${dir}/index.html`)
		writtenBody = measureBody(html)
		const expected = options.body
		const present = writtenBody !== null && writtenBody.hasContent
		const matches = expected === null || expected.chars === writtenBody?.chars
		checks.push({
			name: 'index.html 正文非空且与写入内容一致',
			ok: present && matches,
			detail:
				writtenBody === null
					? '正文标记缺失，无法确认正文是否写入'
					: !writtenBody.hasContent
						? `正文只有容器标签，没有任何块级/媒体节点或文本（${writtenBody.chars} 字符）`
						: !matches
							? `落盘正文 ${writtenBody.chars} 字符，与待写入的 ${expected?.chars} 字符不一致`
							: `正文 ${writtenBody.chars} 字符，含块级或媒体节点`
		})
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error)
		checks.push({ name: 'index.html 正文非空且与写入内容一致', ok: false, detail: reason })
	}

	if (manifest) {
		// 8b) Round 2A.2.2 (S3): the manifest we just wrote must be signed with a
		// key this vault can verify. This is the self-check that stops a build
		// with a broken key from ever publishing an unverifiable export.
		if (options.signingKey !== undefined) {
			const verdict = await verifyManifestSignature(
				manifest,
				options.signingKey ?? null
			)
			checks.push({
				name: 'manifest 签名有效',
				ok: verdict.ok,
				detail: verdict.reason
			})
		}

		// 9) the capture-side statistics must not be empty either: a manifest
		// claiming 0 blocks is a signal that capture went wrong even when the
		// file happens to contain something.
		const stats = (manifest.stats ?? {}) as Record<string, number>
		const hasBody =
			(stats.blocks ?? 0) > 0 ||
			(stats.images ?? 0) > 0 ||
			(stats.mermaid ?? 0) > 0 ||
			(stats.sidenotes ?? 0) > 0 ||
			(stats.bytesOfContent ?? 0) > 0
		checks.push({
			name: 'manifest 正文统计非空',
			ok: hasBody,
			detail: hasBody
				? `块 ${stats.blocks ?? 0} · 图 ${stats.images ?? 0} · 图元 ${stats.mermaid ?? 0} · 批注 ${stats.sidenotes ?? 0}`
				: '正文统计全为 0'
		})

		// 10) `written` must match the files actually present.
		const onDisk = await listFiles(adapter, `${dir}/assets/media`)
		const declared =
			(manifest.assets as { written?: number } | undefined)?.written ?? 0
		// An adapter without `list` cannot be enumerated; check 6b below still
		// verifies every expected file individually, so this is not a blind spot.
		checks.push(
			onDisk === null
				? {
						name: '媒体写入统计与实际一致',
						ok: false,
						skipped: true,
						detail: '适配器不支持枚举，已由逐文件校验覆盖'
					}
				: {
						name: '媒体写入统计与实际一致',
						ok: onDisk === declared && onDisk === assetReport.written,
						detail: `声明 ${declared} 个，实际 ${onDisk} 个，本次成功 ${assetReport.written} 个`
					}
		)
	}

	// 6b) every file we claim to have written really landed, and is not a
	// zero-byte stub left by a truncated write. `writtenEntries` is the claim
	// (round 2A: failed entries are not part of it), so this is the check that
	// ties the counter to the disk.
	if (assetReport.writtenEntries.length > 0 && typeof adapter.exists === 'function') {
		const expected = assetReport.writtenEntries
		const missingFiles: string[] = []
		for (const entry of expected) {
			const path = `${dir}/assets/media/${entry.name}`
			if (!(await adapter.exists(path))) {
				missingFiles.push(entry.name)
				continue
			}
			const size = await sizeOf(adapter, path)
			if (size !== null && size <= 0) missingFiles.push(`${entry.name}（0 字节）`)
		}
		checks.push({
			name: '登记的媒体文件全部落盘',
			ok: missingFiles.length === 0,
			detail:
				missingFiles.length === 0
					? `${expected.length} 个全部存在` +
						(assetReport.failed.length > 0
							? `（另有 ${assetReport.failed.length} 个已记录失败）`
							: '')
					: `缺失：${missingFiles.slice(0, 5).join(', ')}`
		})
	}

	// 11) the whole directory must contain exactly what the manifest promises.
	//
	// Round 2A enumerated `assets/media` only, so a stray file at the root,
	// under `assets/`, or in any subdirectory verified green (round 2A.1, F-02).
	// The comparison is now a full recursive diff against `manifest.files`:
	// extra files, missing files, changed contents and unknown directories all
	// fail the transaction instead of being published.
	if (manifest && typeof adapter.list === 'function') {
		const expected = parseFileRecords(manifest.files)
		if (!expected) {
			checks.push({
				name: '目录内容与清单一致',
				ok: false,
				detail: 'manifest 未记录文件清单（files），无法核对目录完整性'
			})
		} else {
			try {
				const listing = await walkDir(adapter, dir)
				if (!listing) {
					checks.push({
						name: '目录内容与清单一致',
						ok: false,
						detail: '目录枚举失败'
					})
				} else {
					const actual = new Set(listing.files.filter(p => p !== 'export-manifest.json'))
					const extra = [...actual].filter(p => !expected.has(p))
					const absent = [...expected.keys()].filter(p => !actual.has(p))

					const changed: string[] = []
					for (const [path, rec] of expected) {
						if (!actual.has(path)) continue
						// Round 2A.2.2 (S2): size and hash come from the same read,
						// exactly as they did when the record was written. Using
						// `stat` here let a filesystem that reports UTF-16 lengths
						// disagree with a manifest that records UTF-8 byte counts.
						const measured = await measureFile(adapter, `${dir}/${path}`)
						if (!measured) {
							changed.push(`${path}（无法读取）`)
							continue
						}
						if (measured.bytes !== rec.bytes) {
							changed.push(`${path}（${measured.bytes} ≠ ${rec.bytes} 字节）`)
							continue
						}
						if (measured.sha256 !== rec.sha256) changed.push(`${path}（哈希不符）`)
					}

					const allowedDirs = allowedDirsFor(expected.keys())
					const extraDirs = listing.dirs.filter(d => !allowedDirs.has(d))

					const ok =
						extra.length === 0 &&
						absent.length === 0 &&
						changed.length === 0 &&
						extraDirs.length === 0
					checks.push({
						name: '目录内容与清单一致',
						ok,
						detail: ok
							? `${actual.size} 个文件与清单一一对应`
							: `清单外多余 ${extra.length} 个${
									extra.length ? `（${extra.slice(0, 3).join(', ')}）` : ''
								}，清单内缺失 ${absent.length} 个${
									absent.length ? `（${absent.slice(0, 3).join(', ')}）` : ''
								}，内容不符 ${changed.length} 个${
									changed.length ? `（${changed.slice(0, 3).join('；')}）` : ''
								}，多余目录 ${extraDirs.length} 个${
									extraDirs.length ? `（${extraDirs.slice(0, 3).join(', ')}）` : ''
								}`
					})
				}
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error)
				checks.push({ name: '目录内容与清单一致', ok: false, detail: reason })
			}
		}
	}

	// 11b) the manifest's two records have to agree with each other.
	//
	// `assets.entries` is what the notice and the audit report show the user;
	// `files` is what ownership and integrity are judged on. A manifest that
	// claims three packaged images while `files` lists two is internally
	// inconsistent — and whichever of the two is wrong, the export cannot be
	// trusted (round 2A.1, F-02).
	if (manifest) {
		const declaredFiles = parseFileRecords(manifest.files)
		if (declaredFiles) {
			const entries = (manifest.assets as { entries?: unknown } | undefined)?.entries
			const listed = Array.isArray(entries)
				? entries
						.map(entry => (entry as { name?: unknown } | null)?.name)
						.filter((name): name is string => typeof name === 'string' && name.length > 0)
				: []
			const mediaPrefix = 'assets/media/'
			const inFiles = new Set(
				[...declaredFiles.keys()]
					.filter(path => path.startsWith(mediaPrefix))
					.map(path => path.slice(mediaPrefix.length))
			)
			const onlyInEntries = listed.filter(name => !inFiles.has(name))
			const onlyInFiles = [...inFiles].filter(name => !listed.includes(name))
			const ok = onlyInEntries.length === 0 && onlyInFiles.length === 0
			checks.push({
				name: 'manifest 资源记录自洽',
				ok,
				detail: ok
					? `${listed.length} 个媒体文件在 entries 与 files 中一致`
					: `entries 有而 files 无 ${onlyInEntries.length} 个${
							onlyInEntries.length ? `（${onlyInEntries.slice(0, 3).join(', ')}）` : ''
						}，files 有而 entries 无 ${onlyInFiles.length} 个${
							onlyInFiles.length ? `（${onlyInFiles.slice(0, 3).join(', ')}）` : ''
						}`
			})
		}
	}

	// Round 3.3.1: advisory visibility audit. It is deliberately NON-blocking —
	// a heuristic flag must never refuse to publish an otherwise valid export.
	if (options.visibility && options.visibility.blankRisk) {
		const detail =
			options.visibility.warnings
				.map(w => `${w.selector} { ${w.property}: ${w.value} }`)
				.slice(0, 5)
				.join('；') +
			(options.visibility.warnings.length > 5
				? ` …（共 ${options.visibility.warnings.length} 条）`
				: '')
		checks.push({
			name: 'CSS 可见性审计（正文未被隐藏）',
			ok: false,
			blocking: false,
			detail: `检测到可能隐藏正文的 CSS 规则：${detail}。导出文件已写入，但浏览器可能显示空白，请在真实宿主中确认。`
		})
	} else if (options.visibility) {
		checks.push({
			name: 'CSS 可见性审计（正文未被隐藏）',
			ok: true,
			blocking: false,
			detail: `未发现 hide 类规则（display:none / visibility:hidden / opacity:0）作用于正文容器`
		})
	}

	return {
		ok: checks.every(c => c.ok || c.skipped || c.blocking === false),
		checks
	}
}

async function sizeOf(adapter: Adapter, path: string): Promise<number | null> {
	if (typeof adapter.stat !== 'function') return null
	try {
		const stat = await adapter.stat(path)
		if (!stat) return null
		return stat.size
	} catch {
		return null
	}
}

async function listFiles(adapter: Adapter, dir: string): Promise<number | null> {
	if (typeof adapter.list !== 'function') return null
	try {
		const listed = await adapter.list(dir)
		return listed.files.length
	} catch {
		return null
	}
}

/**
 * Find a Vault-relative directory that does not yet exist, starting from `dir`
 * and appending `-2`, `-3`, … until `adapter.exists` returns false.
 *
 * Used for a *user-chosen* export folder: the whole point is to never overwrite
 * an existing export, so we move to the next free name instead of clobbering
 * (the transactional writer would otherwise back the old one up, which is still
 * "lost" from the user's point of view). Bounded so a pathological folder never
 * loops forever; if every slot is taken we fall back to a timestamped name.
 */
async function disambiguateDir(adapter: Adapter, dir: string): Promise<string> {
	if (typeof adapter.exists !== 'function') return dir
	if (!(await adapter.exists(dir))) return dir
	for (let i = 2; i <= 200; i++) {
		const candidate = `${dir}-${i}`
		if (!(await adapter.exists(candidate))) return candidate
	}
	return `${dir}-${Date.now().toString(36)}`
}

function byteLength(text: string): number {
	if (typeof TextEncoder === 'function') {
		return new TextEncoder().encode(text).length
	}
	return text.length
}

export async function ensureFolder(adapter: Adapter, path: string): Promise<void> {
	const parts = normalizePath(path).split('/').filter(Boolean)
	let current = ''
	for (const part of parts) {
		current = current ? `${current}/${part}` : part
		if (await adapter.exists(current)) continue
		try {
			await adapter.mkdir(current)
		} catch (error) {
			// Racing with another writer, or the folder already appeared: both
			// are fine as long as it exists now. When it really failed, keep the
			// adapter's own reason — "无法创建目录" alone is not actionable.
			if (!(await adapter.exists(current))) {
				const reason = error instanceof Error ? error.message : String(error)
				throw new Error(`无法创建目录: ${current}（${reason}）`)
			}
		}
	}
}
