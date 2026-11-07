/**
 * Signed manifest — the only proof of ownership that the manifest cannot forge.
 *
 * Round 2A.2.1 tried to prove "this directory is my export" from the manifest's
 * own fields (a version number, a `files` list, a `notePath`). The round 2A.2.1
 * review showed why that cannot work: the manifest is a plain file inside the
 * directory being proven, so any field used as evidence can be deleted or
 * rewritten by the same actor who wants the directory replaced. Deleting two
 * fields turned a v1 manifest into a byte-identical copy of a legacy one.
 *
 * The fix is to introduce a secret that is **not** in the directory: a per-vault
 * HMAC key kept in the plugin's own configuration. A manifest now carries a
 * signature over a fixed projection of its security-relevant fields; without
 * the key the signature cannot be produced, and a downgraded or hand-edited
 * manifest simply fails verification.
 *
 * Deliberate limits (see `review/phase-1/fix-round-2a2-2/findings.md`):
 *
 *   - the signature covers *ownership* fields only. Cosmetic fields that cannot
 *     change whether a directory is replaced are left out on purpose:
 *     `noteTitle` (a display string), `stats`, `resolution`, `previewMetrics`,
 *     `css`, `pluginVersion`. Signing them would make an innocuous edit look
 *     like tampering, and tampering with them buys an attacker nothing;
 *   - `assets.entries[].vaultPath` is not signed: it is machine-specific and
 *     does not affect ownership. `name`, `bytes` and `role` are signed;
 *   - the signature is not a defence against an attacker who can read the
 *     plugin's `data.json`. It defends against *manifest* edits, which is the
 *     attack surface this round is about.
 */

/** Manifest shape written by this build. `1` was unsigned and is no longer accepted. */
export const MANIFEST_VERSION_SIGNED = 2

/** Signature algorithm name recorded in the manifest. */
export const SIGNATURE_ALG = 'HMAC-SHA256'

/** Signature envelope version, so the envelope can evolve without ambiguity. */
export const SIGNATURE_FORMAT = 1

/** 256-bit key. Hex-encoded, so it survives JSON round-trips unchanged. */
export const SIGNING_KEY_BYTES = 32
export const SIGNING_KEY_HEX_LENGTH = SIGNING_KEY_BYTES * 2

const HEX_64 = /^[0-9a-f]{64}$/i
const HEX_KEY = new RegExp(`^[0-9a-f]{${SIGNING_KEY_HEX_LENGTH}}$`, 'i')

export interface ManifestSignature {
	alg: string
	v: number
	value: string
}

/* ------------------------------------------------------------------ bytes -- */

function bytesToHex(bytes: Uint8Array): string {
	let out = ''
	for (const b of bytes) out += b.toString(16).padStart(2, '0')
	return out
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
	// Allocated from an explicit ArrayBuffer so the value is a `BufferSource`
	// for `crypto.subtle` without a cast (SharedArrayBuffer is not accepted).
	const out = new Uint8Array(new ArrayBuffer(hex.length / 2))
	for (let i = 0; i < out.length; i++) {
		out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
	}
	return out
}

function subtleCrypto(): SubtleCrypto | null {
	const c = (globalThis as { crypto?: Crypto }).crypto
	return c?.subtle ?? null
}

/**
 * Generate a fresh 256-bit key as lowercase hex.
 *
 * `crypto.getRandomValues` is the only source used: `Math.random` would make the
 * key guessable, and a guessable key is the same as no signature at all.
 */
export function generateSigningKeyHex(): string {
	const c = (globalThis as { crypto?: Crypto }).crypto
	if (!c || typeof c.getRandomValues !== 'function') {
		throw new Error('当前运行环境没有安全随机数，无法生成签名密钥')
	}
	const bytes = new Uint8Array(SIGNING_KEY_BYTES)
	c.getRandomValues(bytes)
	return bytesToHex(bytes)
}

/** Is this a usable key? Shape only — never logs the value. */
export function isValidSigningKey(raw: unknown): raw is string {
	return typeof raw === 'string' && HEX_KEY.test(raw)
}

/* ---------------------------------------------------- canonical serialising -- */

/**
 * Deterministic JSON: object keys sorted recursively, no whitespace, arrays keep
 * their order.
 *
 * Determinism is the whole point — `JSON.stringify` on an object literal follows
 * insertion order, so two runs that build the same manifest in a different order
 * would sign different bytes and every verification would fail.
 */
function sortDeep(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortDeep)
	if (value && typeof value === 'object') {
		const source = value as Record<string, unknown>
		const out: Record<string, unknown> = {}
		for (const key of Object.keys(source).sort()) out[key] = sortDeep(source[key])
		return out
	}
	return value
}

export function canonicalJson(value: unknown): string {
	return JSON.stringify(sortDeep(value))
}

function normalizeFile(raw: unknown): Record<string, unknown> {
	const rec = (raw ?? {}) as Record<string, unknown>
	return {
		path: rec.path ?? null,
		bytes: rec.bytes ?? null,
		sha256: typeof rec.sha256 === 'string' ? rec.sha256.toLowerCase() : null
	}
}

function normalizeEntry(raw: unknown): Record<string, unknown> {
	const rec = (raw ?? {}) as Record<string, unknown>
	return {
		name: rec.name ?? null,
		bytes: rec.bytes ?? null,
		role: rec.role ?? null
	}
}

/**
 * Code-unit ordering, not `localeCompare`.
 *
 * `localeCompare` depends on the ICU data shipped with the runtime, so two
 * machines (or an Electron update) can order the same list differently and every
 * signature would stop verifying. Code-unit comparison is fixed by the spec.
 */
function byKey(key: string): (a: Record<string, unknown>, b: Record<string, unknown>) => number {
	return (a, b) => {
		const left = String(a[key] ?? '')
		const right = String(b[key] ?? '')
		return left < right ? -1 : left > right ? 1 : 0
	}
}

/**
 * The exact bytes that get signed.
 *
 * Everything here can change whether a directory is replaceable; everything
 * outside it cannot. Adding a field here is a manifest-format change and must
 * bump `MANIFEST_VERSION_SIGNED`.
 */
export function signingPayload(manifest: Record<string, unknown>): string {
	const filesRaw = Array.isArray(manifest.files) ? manifest.files : null
	const files = filesRaw ? filesRaw.map(normalizeFile).sort(byKey('path')) : null

	const assets = (manifest.assets ?? {}) as { entries?: unknown }
	const entriesRaw = Array.isArray(assets.entries) ? assets.entries : null
	const entries = entriesRaw ? entriesRaw.map(normalizeEntry).sort(byKey('name')) : null

	const payload: Record<string, unknown> = {
		manifestVersion: manifest.manifestVersion ?? null,
		notePath: manifest.notePath ?? null,
		identitySuffix: manifest.identitySuffix ?? null,
		outputFolder: manifest.outputFolder ?? null,
		status: manifest.status ?? null,
		generatedAt: manifest.generatedAt ?? null,
		files,
		assets: { entries }
	}
	// Task 2: `dirKind` takes part in the ownership decision, so it must be
	// covered by the HMAC. The key is added only when present — a manifest
	// written before this field existed keeps its original payload and stays
	// verifiable. Removing or forging the field invalidates the signature.
	if (manifest.dirKind !== undefined) payload.dirKind = manifest.dirKind
	return canonicalJson(payload)
}

/* --------------------------------------------------------------- signing -- */

async function hmacHex(keyHex: string, message: string): Promise<string | null> {
	const subtle = subtleCrypto()
	if (!subtle) return null
	try {
		const key = await subtle.importKey(
			'raw',
			hexToBytes(keyHex),
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['sign']
		)
		const mac = await subtle.sign('HMAC', key, new TextEncoder().encode(message))
		return bytesToHex(new Uint8Array(mac))
	} catch {
		return null
	}
}

/** Build the signature block for a manifest that is otherwise complete. */
export async function signManifest(
	manifest: Record<string, unknown>,
	keyHex: string
): Promise<ManifestSignature | null> {
	if (!isValidSigningKey(keyHex)) return null
	const value = await hmacHex(keyHex, signingPayload(manifest))
	if (!value) return null
	return { alg: SIGNATURE_ALG, v: SIGNATURE_FORMAT, value }
}

/** Structural check of the signature block, before any crypto runs. */
export function readSignature(
	manifest: Record<string, unknown>
): { ok: true; value: string } | { ok: false; reason: string } {
	const raw = manifest.signature
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return { ok: false, reason: '清单缺少 signature 字段（未签名）' }
	}
	const sig = raw as Record<string, unknown>
	if (sig.alg !== SIGNATURE_ALG) {
		return { ok: false, reason: `签名算法不受支持：${JSON.stringify(sig.alg)}` }
	}
	if (sig.v !== SIGNATURE_FORMAT) {
		return { ok: false, reason: `签名信封版本不受支持：${JSON.stringify(sig.v)}` }
	}
	if (typeof sig.value !== 'string' || !HEX_64.test(sig.value)) {
		return { ok: false, reason: '签名的 value 不是 64 位十六进制' }
	}
	return { ok: true, value: sig.value.toLowerCase() }
}

/** Constant-time compare; a length mismatch short-circuits but leaks only length. */
function timingSafeEqualHex(a: string, b: string): boolean {
	if (a.length !== b.length) return false
	let diff = 0
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
	return diff === 0
}

export interface SignatureVerdict {
	ok: boolean
	reason: string
}

/**
 * Verify the manifest's signature. **Must** run before any ownership decision:
 * every other field in the manifest is attacker-controlled until this passes.
 */
export async function verifyManifestSignature(
	manifest: Record<string, unknown>,
	keyHex: string | null
): Promise<SignatureVerdict> {
	if (!isValidSigningKey(keyHex)) {
		return { ok: false, reason: '本 Vault 的签名密钥不可用，无法验证清单签名' }
	}
	const block = readSignature(manifest)
	if (!block.ok) return { ok: false, reason: block.reason }
	if (!subtleCrypto()) {
		return { ok: false, reason: '当前运行环境没有 crypto.subtle，无法验证签名' }
	}
	const expected = await hmacHex(keyHex, signingPayload(manifest))
	if (!expected) return { ok: false, reason: '签名计算失败，无法验证清单' }
	if (!timingSafeEqualHex(expected, block.value)) {
		return { ok: false, reason: '清单签名与内容不匹配（清单被改动，或来自另一个 Vault）' }
	}
	return { ok: true, reason: '签名有效' }
}
