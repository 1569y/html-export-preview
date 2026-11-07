/**
 * Path safety for export output.
 *
 * Review round 2A (X-extra): `noteTitle` goes straight into the output directory
 * name. The old helper was one line —
 *
 *     name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)
 *
 * — which leaves `..`, `.`, Windows device names (`CON`, `NUL`, `COM1`…) and
 * trailing dots/spaces untouched. `noteTitle = ".."` therefore produced
 * `html-export/..`, i.e. files written *above* the export root.
 *
 * Two rules this module enforces, both testable without a filesystem:
 *
 *   1. A folder name is always exactly one path segment: no separators, no
 *      `.`/`..`, no leading/trailing dots or spaces (Windows silently drops
 *      them, which would make the on-disk name differ from the manifest).
 *   2. The joined output path always stays under the configured root. The
 *      check runs on the *normalised* path, so `a/../..` cannot sneak through.
 *
 * Length is limited by **UTF-8 bytes**, not UTF-16 units: a 255-character
 * Chinese title is ~765 bytes, well past the 255-byte limit most filesystems
 * enforce. Truncation never splits a code point.
 */

/**
 * Windows reserved device names, with or without an extension, case-insensitive
 * (`CON`, `con.txt`, `NUL.tar.gz` are all reserved — Microsoft's rule is "avoid
 * these names followed immediately by an extension; for example, NUL.txt and
 * NUL.tar.gz are both equivalent to NUL").
 *
 * Source: «Naming Files, Paths, and Namespaces» —
 * https://learn.microsoft.com/windows/win32/fileio/naming-a-file
 *
 * **The published reserved list (all rejected here):**
 *   `CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `COM¹`, `COM²`, `COM³`,
 *   `LPT1`–`LPT9`, `LPT¹`, `LPT²`, `LPT³`.
 *
 * The superscript forms are **not** a local embellishment: Microsoft lists them
 * in the same sentence as `COM1`–`COM9`, and the page's note explains why —
 * "Windows recognizes the 8-bit ISO/IEC 8859-1 superscript digits ¹, ², and ³
 * as digits and treats them as valid parts of COM# and LPT# device names,
 * making them reserved in every directory. For example, `echo test > COM¹`
 * fails to create a file." So `COM¹` is a genuinely reserved name, not merely a
 * look-alike; rejecting it is part of following the standard, which is also why
 * this table is *not* ASCII-only.
 *
 * **Not on that list — accepted (avoiding over-rejection):**
 *   `COM0` / `LPT0` — Microsoft's list starts at 1; Windows does not reserve a
 *   0 device, so such a name is legal and portable, and rejecting it would
 *   wrongly block a legitimate note title.
 *
 * **Extra compatibility restriction — NOT part of Microsoft's list:**
 *   `CLOCK$` is rejected as defence-in-depth only. It is a legacy NT device
 *   alias and Microsoft does **not** list it among the reserved names above, so
 *   it is deliberately kept in a separate group: an extra safety net, not a
 *   correctness requirement, and it must not be read as part of the standard
 *   set. Removing it would not violate the Microsoft rule; keeping it costs a
 *   note titled `CLOCK$` a leading underscore.
 */
const RESERVED_NAME =
	/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9]|COM[\u00B9\u00B2\u00B3]|LPT[\u00B9\u00B2\u00B3]|CLOCK\$)(\..*)?$/i

/** Characters Windows forbids in a file name. */
const ILLEGAL_CHARS = /[\\/:*?"<>|]/g

/** C0 controls and DEL — legal on disk, hostile everywhere else. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g

/** Fallback when nothing usable survives sanitising. */
export const FALLBACK_FOLDER = 'note'

/** Default cap on the folder name, in UTF-8 bytes. */
export const MAX_FOLDER_BYTES = 120

/** Thrown when an output path would leave the configured root. */
export class PathEscapeError extends Error {
	constructor(
		readonly attempted: string,
		readonly root: string
	) {
		super(`导出路径越界：${attempted} 不在 ${root} 之内`)
		this.name = 'PathEscapeError'
	}
}

function utf8Length(input: string): number {
	return new TextEncoder().encode(input).length
}

/** Cut to `maxBytes` UTF-8 bytes without splitting a code point. */
function truncateBytes(input: string, maxBytes: number): string {
	if (utf8Length(input) <= maxBytes) return input
	let out = ''
	let used = 0
	// `for…of` iterates code points, so surrogate pairs stay intact.
	for (const ch of input) {
		const size = utf8Length(ch)
		if (used + size > maxBytes) break
		out += ch
		used += size
	}
	return out
}

/**
 * Turn a note title into a single safe path segment.
 *
 * Never throws: an unusable title becomes `note` rather than failing the export,
 * because a note called `..` is user data, not a programming error.
 */
export function safeFolderName(raw: string, maxBytes = MAX_FOLDER_BYTES): string {
	let name = String(raw ?? '')
		.normalize('NFC')
		.replace(CONTROL_CHARS, '')
		.replace(ILLEGAL_CHARS, '_')

	// Collapse whitespace (including NBSP and friends) so the name cannot carry
	// an invisible tail that Windows trims on write.
	name = name.replace(/\s+/g, ' ').trim()

	// Strip leading/trailing dots and spaces. This alone handles `.`, `..`, `...`
	// and `name.` — all of which Windows would normalise behind our back.
	name = name.replace(/^[. ]+/, '').replace(/[. ]+$/, '')

	if (!name) return FALLBACK_FOLDER

	// Reserved device names are reserved regardless of extension or case.
	if (RESERVED_NAME.test(name)) name = `_${name}`

	name = truncateBytes(name, maxBytes)
	// Truncation can expose a trailing dot/space that was previously interior.
	name = name.replace(/[. ]+$/, '')

	if (!name) return FALLBACK_FOLDER

	// Belt and braces: after every transform the result must still be one plain
	// segment. If a future rule breaks that, we fail loudly rather than write
	// outside the root.
	if (name === '.' || name === '..' || /[\\/]/.test(name)) return FALLBACK_FOLDER

	return name
}

/**
 * Normalise a vault-relative path without `obsidian.normalizePath`.
 *
 * Kept dependency-free so the unit tests can exercise it directly (the Obsidian
 * stub in tests is not a real path implementation).
 */
export function normalizeVaultPath(input: string): string {
	const raw = String(input ?? '').replace(/\\/g, '/')
	const absolute = raw.startsWith('/')
	const segments: string[] = []

	for (const segment of raw.split('/')) {
		if (!segment || segment === '.') continue
		if (segment === '..') {
			if (segments.length === 0) {
				throw new PathEscapeError(raw, absolute ? '/' : '.')
			}
			segments.pop()
			continue
		}
		segments.push(segment)
	}

	const joined = segments.join('/')
	if (absolute) return `/${joined}`
	return joined || '.'
}

/**
 * Resolve the final export directory for a note, refusing to leave `outputRoot`.
 *
 * Returns the folder too, so the manifest can record what was actually used
 * rather than re-deriving it later.
 *
 * **Low-level primitive.** It does not make the folder name unique: two notes
 * whose titles sanitise to the same string land in the same directory. Callers
 * that decide where an export goes must use `resolveExportDir` (round 2A.1,
 * F-03). Kept exported because the existing tests exercise the sanitising and
 * containment rules directly.
 */
export function resolveOutputDir(
	outputRoot: string,
	title: string
): { dir: string; folder: string; root: string } {
	const root = normalizeVaultPath(outputRoot || '.')
	const folder = safeFolderName(title)
	const dir = root === '.' ? folder : `${root}/${folder}`

	// Structural guarantee: `folder` has no separator, so `dir` must be a direct
	// child. Re-check anyway — this is the assertion the old code lacked.
	const contained =
		root === '.' ? !dir.startsWith('/') && !dir.includes('/../') : dir.startsWith(`${root}/`)
	if (!contained) throw new PathEscapeError(dir, root)

	return { dir, folder, root }
}

/* ------------------------------------------------------------------------- *
 * Round 2A.1 · F-03: stable identity for the output directory
 * ------------------------------------------------------------------------- */

/** Hex characters appended to the readable slug (48 bits of hash). */
export const IDENTITY_SUFFIX_LENGTH = 12

/** FNV-1a over UTF-16 code units, seeded so two calls give independent halves. */
function hash32(input: string, seed: number): number {
	let h = seed >>> 0
	for (let i = 0; i < input.length; i++) {
		h ^= input.charCodeAt(i)
		h = Math.imul(h, 0x01000193) >>> 0
	}
	return h >>> 0
}

/**
 * Stable suffix derived from the note's identity (its vault path).
 *
 * The readable slug alone is not an identity: `A:B`, `A?B` and `A_B` all
 * sanitise to `A_B`, and two long titles that share their first 120 bytes
 * truncate to the same name. Both would put two different notes in one folder,
 * so the second export silently replaced the first (round 2A.1, F-03).
 *
 * Two independent 32-bit FNV-1a passes give 64 bits; 12 hex characters (48
 * bits) are kept. At 10,000 notes the birthday probability is ~2e-7.
 *
 * The identity is hashed **exactly**, not lowercased: on a case-insensitive
 * filesystem `Report` and `report` are the same directory name, but their
 * hashes differ, so the two folders stay distinct.
 */
export function identitySuffix(identity: string): string {
	const normalised = String(identity ?? '')
		.normalize('NFC')
		.replace(/\\/g, '/')
	const a = hash32(normalised, 0x811c9dc5)
	const b = hash32(normalised, 0x9e3779b9)
	const hex = a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0')
	return hex.slice(0, IDENTITY_SUFFIX_LENGTH)
}

/** Refuse an output root that is not a plain vault-relative path. */
export function assertVaultRelativeRoot(outputRoot: string): string {
	const raw = String(outputRoot ?? '')
	if (/^[A-Za-z]:/.test(raw)) {
		throw new PathEscapeError(raw, '.')
	}
	if (raw.startsWith('//') || raw.startsWith('\\\\')) {
		throw new PathEscapeError(raw, '.')
	}
	if (raw.startsWith('/') || raw.startsWith('\\')) {
		throw new PathEscapeError(raw, '.')
	}
	return raw
}

/**
 * Task 2: validate a *user-typed*, one-off export location.
 *
 * Deliberately stricter than `assertVaultRelativeRoot`, which is also used for
 * the configured `outputFolder` and therefore still normalises an interior
 * `a/../b` for backwards compatibility. A value typed into the preview editor
 * must match what the UI promises ("不能含 … “..”"), so every `..` segment is
 * refused outright instead of being silently collapsed. `normalizeVaultPath`
 * remains the final guard against a path escaping above the Vault root.
 */
export function assertVaultRelativeLocation(input: string): string {
	const raw = assertVaultRelativeRoot(input)
	if (raw.replace(/\\/g, '/').split('/').includes('..')) {
		throw new PathEscapeError(raw, '.')
	}
	return normalizeVaultPath(raw)
}

/**
 * Resolve the export directory for one note: readable slug + identity suffix.
 *
 * Guarantees, in order:
 *
 *   1. the same note always maps to the same folder (stable across exports);
 *   2. two different notes never share a folder, even when their titles are
 *      identical, sanitise identically, or differ only by case;
 *   3. the result is one path segment directly under `outputRoot`;
 *   4. `outputRoot` is a vault-relative path — drive letters, UNC and absolute
 *      paths are refused instead of silently normalised away (round 2A.1, F-04).
 *
 * Renaming or moving a note changes its identity and therefore its folder. That
 * is deliberate: the old folder is never migrated, overwritten or deleted, so
 * the user keeps both exports until they remove one themselves.
 */
export function resolveExportDir(
	outputRoot: string,
	title: string,
	identity: string
): { dir: string; folder: string; root: string; suffix: string } {
	assertVaultRelativeRoot(outputRoot)
	const root = normalizeVaultPath(outputRoot || '.')
	const slug = safeFolderName(title)
	const suffix = identitySuffix(identity || title)
	const folder = `${slug}-${suffix}`
	const dir = root === '.' ? folder : `${root}/${folder}`

	const contained =
		root === '.'
			? !dir.startsWith('/') && !dir.includes('/../')
			: dir.startsWith(`${root}/`)
	if (!contained) throw new PathEscapeError(dir, root)

	return { dir, folder, root, suffix }
}
