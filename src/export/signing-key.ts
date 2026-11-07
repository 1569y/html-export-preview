/**
 * Signing-key lifecycle — the vault-side *management* of the HMAC key.
 *
 * This module deliberately does NOT sign or verify anything; that stays in
 * `manifest-signing.ts` and is untouched by this round (Round 2A.2.2 Review
 * Fix Round 3). What it owns is the *policy* around the key's existence:
 *
 *   - when a key may be created,
 *   - when an existing key must NOT be silently replaced,
 *   - what the user must be told when the key is missing or corrupted,
 *   - how the init marker survives migration (F-07) and ordinary saves (F-09).
 *
 * History of the findings this module answers:
 *
 *   S1 (Round 2)  Init / loss state
 *   -------------------------------
 *   1. An independent init-state marker is tracked.
 *   2. First install and "existing key lost" are distinct states.
 *   3. Initialised-but-missing key → `lost`.
 *   4. When history cannot be determined (e.g. the whole config file is
 *      gone) → `unknown`, never impersonating `first-init`.
 *   5. Compatible with an existing 2A.2.2 config.
 *   6. `lost` / `unknown` get explicit warnings and a strict (two-step)
 *      confirmation in the UI.
 *   7. A key is never silently generated.
 *
 *   S2 (Round 2)  Persistence ordering
 *   ----------------------------------
 *   1. The new key is written to persistent storage FIRST.
 *   2. The in-memory key is updated only AFTER the persist succeeds.
 *   3. A save failure preserves the original in-memory key, *including* a
 *      corrupted one.
 *   4. A save failure never clears the original key.
 *   5/6. Rotation and export are made mutually exclusive by the caller
 *        (main.ts holds a key mutex); the export always signs with a stable
 *        snapshot.
 *   7. Success and failure produce different user messages.
 *   8. A failure never logs "key generated successfully".
 *
 *   F-07 (Round 3)  Legacy config migration
 *   ---------------------------------------
 *   A 2A.2.2 `data.json` can hold a valid `signingKey` with **no** init
 *   marker. The boolean `signingKeyInitialized` from Round 2 cannot express
 *   "history unknown" and, worse, the merged default of `false` made such a
 *   config look like a first install — so a later key loss resolved to
 *   `first-init` instead of `lost`. Round 3 replaces the boolean with an
 *   explicit three-valued marker (`KeyInitState`) and reports a
 *   `migration: 'needed'` verdict when the marker has to be written out.
 *
 *   F-09 (Round 3)  `unknown` must survive ordinary saves
 *   ----------------------------------------------------
 *   `resolveKeyOnLoad` returns the marker that *should* be persisted
 *   (`initState`). The caller stores it and writes it on every later save, so
 *   editing `outputFolder` can never downgrade `unknown` to `uninitialized`,
 *   and a restart re-derives the same state.
 *
 *   R3-01 (Round 3.1)  A *present but invalid* marker must fail closed
 *   -----------------------------------------------------------------
 *   `readInitMarker` used to fall through to the Round-2 boolean whenever the
 *   new field failed its type check. A config such as
 *   `{"signingKey":"", "signingKeyInitState":"invalid", "signingKeyInitialized":false}`
 *   therefore downgraded to `uninitialized` → `first-init`, which is precisely
 *   the confusion the marker exists to prevent. Presence is now decided by
 *   `hasOwnProperty`, not by the value's type:
 *
 *     - field absent                    → legacy boolean may be read
 *     - field present and one of the 3  → that value
 *     - field present and anything else → `unknown` (no fallback, ever)
 *
 *   R3-06 (Round 3.1)  `unknown` does not imply a missing config
 *   ------------------------------------------------------------
 *   `unknown` covers two different situations — no config file at all, and a
 *   config whose marker is unreadable. The wording is derived from
 *   `configPresent` so the UI can never claim the opposite of the real state.
 */

import { generateSigningKeyHex, isValidSigningKey } from './manifest-signing'

/** Derivable state of the vault's signing key. */
export type KeyState =
	| 'ready' // a valid key is present
	| 'first-init' // config present, never initialised, key empty
	| 'lost' // was initialised, key now missing
	| 'corrupted' // key present but malformed
	| 'unknown' // history cannot be determined (e.g. config absent)
	| 'unavailable' // rotation failed to persist and no prior key existed

/**
 * Persisted init marker (Round 3, F-07).
 *
 * `undefined` — *not* one of these values — is the fourth, meaningful case:
 * the marker is absent from the stored config (a 2A.2.2 config, or a config
 * that never recorded one). It must never be silently read as
 * `uninitialized`, because that is what turned a lost key into a first
 * install.
 */
export type KeyInitState = 'uninitialized' | 'initialized' | 'unknown'

/**
 * Why the key's history cannot be confirmed (R3.1-02, extended in Round 4).
 * This is a *reason*, not a state: `KeyInitState` says what the current marker
 * is, `UnknownReason` says *why* we had to fall back to `unknown`. The two must
 * never be conflated — an `uninitialized` marker, a missing marker and a corrupt
 * root are three different situations and the UI wording must reflect each
 * precisely.
 *
 *   - config-missing        `adapter.exists()` confirmed the file is really
 *                            absent — the *only* state that may enter the
 *                            first-install path (F-01). It is no longer inferred
 *                            from `loadData() === null`, which also covers a
 *                            literal-`null` file and an unparsable one.
 *   - config-shape-invalid  data.json exists but its root is not an object
 *                            (string / number / false / array / literal `null`),
 *                            or its JSON cannot be parsed. Fail closed.
 *   - config-exists-check-failed  `adapter.exists()` itself threw, so presence is
 *                            unknowable (F-01). Fail closed.
 *   - config-read-failed    the file exists but could not be read (F-01). Fail
 *                            closed — an unreadable file is never "no file".
 *   - marker-missing        root is a valid object but carries neither the new
 *                            marker nor the legacy boolean.
 *   - marker-invalid        marker field exists but holds an unusable value.
 *   - marker-explicit-unknown  marker is the literal string "unknown" — a
 *                            deliberate, recorded state, not a file we lost.
 *   - marker-conflict       (Round 4 / F-07 #3) the new marker and the legacy
 *                            boolean are both present, both individually legal,
 *                            and contradict each other (`initialized` + `false`,
 *                            `uninitialized` + `true`). Neither side may win.
 *   - marker-legacy-false   (Round 4 / F-07 #1) only the Round-2 boolean is
 *                            stored, and its value is `false`. That is *not*
 *                            evidence of a first install: the value may be the
 *                            merged default, or a Round-2 build's placeholder.
 */
export type UnknownReason =
	| 'config-missing'
	| 'config-shape-invalid'
	/** F-01: `adapter.exists()` itself threw — presence is unknowable. */
	| 'config-exists-check-failed'
	/** F-01: the file exists but could not be read. */
	| 'config-read-failed'
	| 'marker-missing'
	| 'marker-invalid'
	| 'marker-explicit-unknown'
	| 'marker-conflict'
	| 'marker-legacy-false'

export interface KeyLifecycleResult {
	state: KeyState
	/**
	 * The key that should now be held in memory. On a save failure this is the
	 * previous key (valid, corrupted, or empty) — never a freshly
	 * generated-but-unpersisted value, and never cleared to ''.
	 */
	key: string
	/** Whether the in-memory key changed as a result of this call. */
	changed: boolean
	/** Human-readable summary; never contains key material. */
	message: string
	/**
	 * The marker that *should* be persisted for this config (F-09). The caller
	 * keeps it in memory and writes it with every save, so `unknown` and
	 * `first-init` survive a restart and an `outputFolder` edit.
	 */
	initState: KeyInitState
	/**
	 * `'needed'` when what is on disk does not yet record `initState` — i.e. a
	 * legacy config that still has to be migrated (F-07 #2/#3). `'none'` when
	 * the stored marker already agrees.
	 */
	migration: 'none' | 'needed'
	/**
	 * Why history could not be confirmed, set whenever `state` is `unknown`
	 * (R3.1-02). Lets the Settings tab show a cause-accurate message instead of
	 * a one-size-fits-all "config missing" line.
	 */
	unknownReason?: UnknownReason
}

/** Inputs needed to *resolve* the key on load (no persistence happens here). */
export interface ResolveDeps {
	/** Persisted marker, or `undefined` when the stored config had none. */
	initState?: KeyInitState
	/** Whether a config file (data.json) was present at load time. */
	configPresent?: boolean
	/**
	 * Whether the stored config root was a readable object (R3.1-01). `false`
	 * means the root was a scalar/array/`null`-content, so it must fail closed to
	 * `unknown` and never pretend to be a first install.
	 */
	configShapeValid?: boolean
	/**
	 * Whether the stored marker field was present AND a valid `KeyInitState`
	 * (R3.1-02). When `false`, the on-disk marker is absent or unusable, so it
	 * can never count as "already persisted".
	 */
	storedMarkerValid?: boolean
	/**
	 * Whether the config may receive a marker at all (Round 4). `false` means the
	 * new field already exists, so the resolver must not overwrite it — an
	 * unreadable or contradictory marker is evidence the user needs.
	 *
	 * Defaults to "writable" when the caller does not say, which keeps the pure
	 * unit API (`resolveKeyOnLoad(key, { initState })`) behaving as before.
	 */
	storedMarkerWritable?: boolean
	/** Override for the `unknown` reason when the caller already knows it. */
	unknownReason?: UnknownReason
	/**
	 * Legacy Round-2 boolean marker. Only consulted when `initState` is absent,
	 * so every existing caller keeps working unchanged.
	 */
	initialized?: boolean
}

/** Inputs needed to *rotate* (generate + persist) the key. */
export interface RotateDeps extends ResolveDeps {
	/**
	 * Persist `signingKey` together with `initialized`. MUST throw if the write
	 * fails, so callers can distinguish a persisted key from a lost one.
	 */
	save: (signingKey: string, initialized: boolean) => Promise<void>
}

const INIT_STATES: readonly KeyInitState[] = ['uninitialized', 'initialized', 'unknown']

/**
 * Key material is 64 hex chars. Anything this long (or a fragment of it) must
 * never reach a Notice or a console line (F-10 #6, R3-01 addendum). 16 is used
 * as the threshold so a *partial* key is redacted too, not only the full value.
 */
const KEY_LIKE = /[0-9a-fA-F]{16,}/g

/** Placeholder used when an exception's own text cannot be read at all (F-02). */
const UNREADABLE_ERROR_TEXT = '[无法读取异常信息]'

/**
 * `String(error)` that cannot itself throw (F-02).
 *
 * `String()` runs the value's `toString` and/or `Symbol.toPrimitive`, and both
 * belong to the object we are trying to *describe* — a hostile or merely broken
 * one can throw from either. Letting that escape would replace one diagnostic
 * with a second, unrelated failure: in `rotateKey` it would abort the "the old
 * key stays, nothing was adopted" path that the failure semantics depend on.
 *
 * Handled inputs:
 *   - `Symbol`          → `String()` handles it natively ("Symbol(x)");
 *   - `null`/`undefined` → the caller substitutes `''`, never reaches here;
 *   - plain objects     → `[object Object]`;
 *   - throwing `toString` / `Symbol.toPrimitive` / revoked-Proxy style objects
 *     → the fixed placeholder below.
 *
 * The result is still untrusted text: every caller must pass it through
 * `redactKeyMaterial()` before it reaches a Notice or a log line.
 */
export function safeErrorText(error: unknown): string {
	try {
		return String(error)
	} catch {
		return UNREADABLE_ERROR_TEXT
	}
}


/**
 * Strip anything that looks like signing-key material out of a free-form text
 * (an error message, a stack line) before it is shown to the user or logged.
 *
 * Two passes (R3.1-03):
 *   1. precise literal replacement of the *actual* keys involved in the current
 *      operation (`knownSecrets`), so a key that is not pure hex, or only
 *      appears as a fragment, is still removed;
 *   2. a generic long-hex filter that catches anything we did not know about.
 *
 * Deliberately over-eager: an error line that loses a long hex id is a cosmetic
 * problem, a key that reaches a Notice or a log file is not.
 */
export function redactKeyMaterial(text: unknown, knownSecrets: string[] = []): string {
	// F-02: the coercion itself must be safe. `redactKeyMaterial` is the last
	// step before a log line, so a throwing `toString` here would be exactly the
	// case where a diagnostics call crashes while trying to *report* a failure.
	let out = text == null ? '' : safeErrorText(text)
	for (const secret of knownSecrets) {
		if (secret) out = out.split(secret).join('[密钥已隐去]')
	}
	return out.replace(KEY_LIKE, '[密钥已隐去]')
}

/**
 * Error *types* that may appear verbatim in a diagnostic line (F-02).
 *
 * An explicit allow-list of the **eight** built-in `Error` types, not a pattern:
 * `error.name` is caller-controlled and an attacker (or a broken loader) can put
 * anything in it — including the signing key itself. Only these eight names are
 * ever echoed; any other value is replaced by the generic `Error`.
 */
const SAFE_ERROR_TYPES: readonly string[] = [
	'Error',
	'EvalError',
	'RangeError',
	'ReferenceError',
	'SyntaxError',
	'TypeError',
	'URIError',
	'AggregateError'
]

/**
 * Error *codes* that may appear verbatim (F-02).
 *
 * Also an allow-list: these are the well-known Node filesystem codes for which
 * the operator has a concrete remedy. A regex such as `/^[A-Z][A-Z0-9]*$/` was
 * the previous gate and is not sufficient — an upper-case hex key matches it.
 */
const SAFE_ERROR_CODES: readonly string[] = [
	'EACCES',
	'EPERM',
	'ENOENT',
	'EEXIST',
	'ENOSPC',
	'EIO'
]

/** Read a property without trusting the object: a getter may throw. */
function safeRead(source: unknown, key: string): unknown {
	if (source == null) return undefined
	try {
		return (source as Record<string, unknown>)[key]
	} catch {
		return undefined
	}
}

/**
 * Upper bound for one free-form field in a diagnostic line (F-02).
 *
 * `message`/`stack` are attacker-/loader-controlled sizes too: a 5 000-character
 * `error.name` ends up in `stack` and would produce a multi-kilobyte log line.
 * Truncation happens *after* redaction, so it can never cut a secret in half and
 * leave a readable fragment behind.
 */
const MAX_DIAG_FIELD = 400
function clampDiagnostic(text: string): string {
	return text.length <= MAX_DIAG_FIELD
		? text
		: `${text.slice(0, MAX_DIAG_FIELD)}…（已截断，原长 ${text.length}）`
}

/** `error.name`, but only when it is one of the recognised built-in types. */
function safeErrorType(error: unknown): string {
	const name = safeRead(error, 'name')
	if (typeof name !== 'string') return 'Error'
	return SAFE_ERROR_TYPES.includes(name) ? name : 'Error'
}

/** `error.code`, but only when it is one of the recognised filesystem codes. */
function safeErrorCode(error: unknown): string | undefined {
	const code = safeRead(error, 'code')
	if (typeof code !== 'string') return undefined
	return SAFE_ERROR_CODES.includes(code) ? code : undefined
}

/**
 * Build a safe, *diagnosable* one-line summary of a key-write failure (R3.1-03).
 *
 * The goal is to keep the real fault type (e.g. `EACCES`, `ENOSPC`) visible in
 * the console while guaranteeing that no key material — full value, fragment, or
 * anything in `error.stack` — can leak:
 *
 *   - the Node error `code` and `name` are emitted ONLY when they are on an
 *     explicit allow-list (F-02): both fields are caller-/loader-controlled
 *     metadata and may carry the signing key, so a regex is not a safe gate;
 *   - the free-form `message` is first precisely stripped of the operation's real
 *     keys, then passed through the generic long-hex filter;
 *   - the stack, if present and distinct from the message, is likewise redacted;
 *   - every coercion of the error itself goes through `safeErrorText()`, so a
 *     throwing `toString` / `Symbol.toPrimitive` / `Proxy` trap cannot make this
 *     function throw (F-02, Round 3.2.2). It never throws for any input.
 *
 * The raw `Error` object is NEVER logged as-is.
 */
export function extractKeyDiagnostics(
	error: unknown,
	knownSecrets: string[] = []
): string {
	// F-02: the string form of the error is computed **at most once**, and only
	// when no readable `message` exists. Calling `String(error)` per field would
	// run the same untrusted `toString` twice and could return two different
	// answers — or throw on the second call after the first succeeded.
	let textForm: string | undefined
	const asText = (): string => {
		if (textForm === undefined) textForm = safeErrorText(error)
		return textForm
	}
	const message = safeRead(error, 'message')
	const messageText = typeof message === 'string' ? message : asText()
	const parts: string[] = []
	// F-02: `code` and `name` go through allow-lists. Their raw values are never
	// echoed, because both fields are attacker-/loader-controlled metadata that
	// may carry the signing key (e.g. `name = <64 hex chars>`).
	const code = safeErrorCode(error)
	if (code) parts.push(`code=${code}`)
	parts.push(`type=${safeErrorType(error)}`)
	// message 是自由文本，可能含密钥 → 先精确替换真实密钥，再做通用长 hex 过滤。
	parts.push(`message=${clampDiagnostic(redactKeyMaterial(messageText, knownSecrets))}`)
	const stack = safeRead(error, 'stack')
	// Skip `stack` when it merely repeats the stringified error: for a non-Error
	// object the two are usually the same text, and printing it twice adds no
	// information while doubling the log line.
	if (typeof stack === 'string' && stack.length > 0 && stack !== asText()) {
		parts.push(`stack=${clampDiagnostic(redactKeyMaterial(stack, knownSecrets))}`)
	}
	return parts.join(' ')
}

/**
 * The single safe entry point for turning an arbitrary thrown value into text
 * that may be shown to the user or written to a log (F-02, Round 3.2.3).
 *
 * Why this exists separately from `extractKeyDiagnostics`
 * ---------------------------------------------------------------------------
 * `extractKeyDiagnostics` is a *diagnostic* line (code/type/message/stack) meant
 * for the console. User-facing text — a Notice, a warning line, an error the
 * settings tab echoes back — needs just the message, and every call site used to
 * write that expression by hand:
 *
 *     error instanceof Error ? error.message : safeErrorText(error)
 *
 * That idiom is not safe, and Round 3.2.3 was opened precisely because it was
 * still in the tree. `instanceof` walks the prototype chain through the object's
 * own traps, so a `Proxy` can make it return `true` while the `message` getter
 * it then dereferences throws — the handler crashes while reporting a failure,
 * which is the worst possible moment. Reading `.message` unguarded also hands a
 * hostile object a second chance to place key material in the output.
 *
 * Every property access here goes through `safeRead()`, and the text is redacted
 * and clamped exactly like a diagnostic field. It never throws.
 *
 * This does NOT replace `extractKeyDiagnostics`: use that when the operator needs
 * the error `code`/`type` to act on, and this one for text a human reads.
 */
export function describeErrorSafely(
	error: unknown,
	knownSecrets: string[] = []
): string {
	const message = safeRead(error, 'message')
	const text = typeof message === 'string' ? message : safeErrorText(error)
	return clampDiagnostic(redactKeyMaterial(text, knownSecrets))
}

/** Own-property check — a *present* field is a different fact from a missing one. */
function hasOwn(record: Record<string, unknown>, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(record, key)
}

function isValidInitState(value: unknown): value is KeyInitState {
	return typeof value === 'string' && (INIT_STATES as string[]).includes(value)
}

/**
 * A config *root* must be a plain object — not `null`, not an array, not a
 * scalar. This is the fail-closed gate for R3.1-01: a root such as `"corrupted"`,
 * `false`, `0` or `["unexpected"]` is not a config we can read fields from.
 */
export function isConfigRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/* -------------------------------------------------- config file presence -- */
/**
 * The *real* on-disk state of the plugin's `data.json` (F-01).
 *
 * `loadData()` alone cannot answer "does the file exist?": Obsidian returns
 * `null` for a missing file, for a file whose literal content is `null`, **and**
 * (after logging) for a file whose JSON is unparsable. Collapsing those three
 * into "no config yet" is exactly what allowed an ordinary settings save to
 * overwrite a real, anomalous file. `adapter.exists()` + `adapter.read()` can
 * tell them apart, so the caller probes the file and passes the result here.
 */
export type ConfigFileState =
	| 'missing'
	| 'object'
	| 'null-content'
	| 'non-object'
	| 'invalid-json'
	| 'exists-check-failed'
	| 'read-failed'

/** What the filesystem probe actually observed (no interpretation). */
export interface ConfigFileProbe {
	/** `adapter.exists()` result; `null` means the check itself threw. */
	exists: boolean | null
	/** Raw text, present only when the file was read successfully. */
	text?: string
	/** Parsed JSON value, present only when parsing succeeded. */
	parsed?: unknown
	/** Whether `text` parsed as JSON (meaningful only when `text` is defined). */
	parseOk: boolean
}

/** Interpretation of a probe: what may be merged, and what must be refused. */
export interface ConfigFileClassification {
	state: ConfigFileState
	/** May this be treated as "a config file is there"? Fail-closed on doubt. */
	present: boolean
	/** Is the root a readable object that may be merged into the settings? */
	shapeValid: boolean
	/** The parsed root when `shapeValid`, otherwise `null`. */
	root: unknown
	/** Why the config cannot be trusted, when it cannot (`object` has none). */
	unknownReason?: UnknownReason
}

/**
 * Decide, from a real probe, whether the config is usable (F-01 §2.2).
 *
 * Only `missing` may enter the first-install path. Every other non-object state
 * — including the two I/O faults — is reported as *present but unknown*, so the
 * write guards keep refusing ordinary saves. An unreadable file is never
 * evidence that there is no file.
 */
export function classifyConfigFile(
	probe: ConfigFileProbe
): ConfigFileClassification {
	const refused = (
		state: ConfigFileState,
		unknownReason: UnknownReason
	): ConfigFileClassification => ({
		state,
		present: true,
		shapeValid: false,
		root: null,
		unknownReason
	})
	// Existence could not be determined at all → fail closed.
	if (probe.exists === null) {
		return refused('exists-check-failed', 'config-exists-check-failed')
	}
	if (probe.exists === false) {
		// The only state that may be treated as a first install.
		return {
			state: 'missing',
			present: false,
			shapeValid: false,
			root: null,
			unknownReason: 'config-missing'
		}
	}
	if (typeof probe.text !== 'string') {
		return refused('read-failed', 'config-read-failed')
	}
	if (!probe.parseOk) {
		return refused('invalid-json', 'config-shape-invalid')
	}
	if (probe.parsed === null) {
		return refused('null-content', 'config-shape-invalid')
	}
	if (!isConfigRecord(probe.parsed)) {
		return refused('non-object', 'config-shape-invalid')
	}
	return {
		state: 'object',
		present: true,
		shapeValid: true,
		root: probe.parsed
	}
}

/** The full reading of a stored config's init marker (R3.1-01 / R3.1-02 / R4). */
export interface MarkerReading {
	/** Marker value to feed `resolveKeyOnLoad` (undefined when none is determinable). */
	marker: KeyInitState | undefined
	/** Is the stored config root a readable object? */
	shapeValid: boolean
	/**
	 * Is the stored marker **trustworthy as it stands** — i.e. present, a valid
	 * `KeyInitState`, and not contradicted by the legacy boolean?
	 *
	 * Round 4: this is what decides `initStatePersisted`. A conflict is *not*
	 * persisted-good even though both fields are individually legal, because
	 * writing the resolved `unknown` over it is the only honest repair.
	 */
	fieldValid: boolean
	/** Why history cannot be confirmed, when it cannot. */
	unknownReason?: UnknownReason
	/** New/legacy markers are both present and contradict each other (Round 4). */
	conflict?: boolean
	/**
	 * May the resolver **add** a marker to this config (Round 4)?
	 *
	 * True only when the config is a readable object whose new marker field is
	 * *absent* — i.e. writing the derived value adds information. It is false
	 * when the field already exists, because overwriting an unreadable or
	 * self-contradictory marker would destroy the very evidence the user needs
	 * to repair their `data.json`. Such a config stays `unknown` on every load,
	 * deterministically, until a human fixes it.
	 */
	writable: boolean
}

/**
 * Read the init marker out of the *raw* stored config (F-07 #1 / R3.1-01 /
 * R3.1-02 / Round 4).
 *
 * The caller must pass the **raw stored root** — what the F-01 probe read out of
 * `data.json` — and **not** the merged settings:
 * `Object.assign({}, DEFAULT_SETTINGS, root)` fills a missing
 * `signingKeyInitialized` with `false`, which is exactly the false signal this
 * function exists to avoid.
 *
 * R3.1-01: the *shape* of the root is decided first. A non-object root
 * (`"corrupted"`, `false`, `0`, an array) is a present-but-anomalous file — it
 * must fail closed to `unknown` and must **not** be read as "marker missing"
 * (which would later resolve to `first-init`). A `null` root yields
 * `shapeValid: false` with no reason of its own: the *classification* supplies
 * it, because `classifyConfigFile()` (F-01) is the only place that can tell a
 * really-missing file from a literal-`null` one — it is the only caller holding
 * the probe.
 *
 * R3-01: presence of the new field is decided by `hasOwnProperty`. When it is
 * present but not one of the three valid states the answer is `unknown` and the
 * legacy boolean is **not** consulted.
 *
 * ---------------------------------------------------------------------------
 * Round 4 (F-07 #1/#2/#3) — the full combination table. The legacy boolean is
 * no longer allowed to speak on its own when it says `false`, and the two
 * markers are now cross-checked instead of the new one silently winning:
 *
 *   | new marker    | legacy boolean | history       |
 *   |---------------|----------------|---------------|
 *   | initialized   | true           | initialized   |
 *   | uninitialized | false          | uninitialized |
 *   | unknown       | any            | unknown       |
 *   | initialized   | false          | unknown       |  ← conflict
 *   | uninitialized | true           | unknown       |  ← conflict
 *   | invalid value | any            | unknown       |
 *   | absent        | true           | initialized   |
 *   | absent        | false          | unknown       |  ← NOT first-init
 *   | absent        | absent         | unknown       |  ← NOT first-init
 *
 * Rows outside the table (e.g. a legal new marker next to a *non-boolean*
 * legacy value) fail closed to `unknown` for the same reason: an unreadable
 * second opinion cannot corroborate the first.
 *
 * Why `absent + false` must not mean `uninitialized`: `false` is what
 * `DEFAULT_SETTINGS` contains, so any code path that merged defaults and wrote
 * the result back leaves a `false` that means nothing. Treating it as history
 * is exactly the F-07 defect this module exists to prevent.
 */
export function readConfigMarker(raw: unknown): MarkerReading {
	if (!isConfigRecord(raw)) {
		const reason: UnknownReason | undefined =
			raw === null ? undefined : 'config-shape-invalid'
		return {
			marker: undefined,
			shapeValid: false,
			fieldValid: false,
			unknownReason: reason,
			writable: false
		}
	}
	const record = raw as Record<string, unknown>
	const hasNew = hasOwn(record, 'signingKeyInitState')
	const hasOld = hasOwn(record, 'signingKeyInitialized')
	const newValue = record.signingKeyInitState
	const oldValue = record.signingKeyInitialized
	const newValid = hasNew && isValidInitState(newValue)
	const oldValid = hasOld && typeof oldValue === 'boolean'
	// A field that already exists is never overwritten, whatever it says: the
	// user needs the original bytes to repair `data.json` (see MarkerReading).
	const writable = !hasNew

	// --- new marker present -------------------------------------------------
	if (hasNew) {
		if (!newValid) {
			// Present but unusable: fail closed. Never fall back to the legacy field.
			return {
				marker: 'unknown',
				shapeValid: true,
				fieldValid: false,
				unknownReason: 'marker-invalid',
				writable
			}
		}
		const marker = newValue as KeyInitState
		// A legal new marker may stand alone when the legacy field is absent —
		// that is a config written by a Round-3+ build.
		if (!hasOld) {
			return {
				marker,
				shapeValid: true,
				fieldValid: true,
				unknownReason: marker === 'unknown' ? 'marker-explicit-unknown' : undefined,
				writable
			}
		}
		if (!oldValid) {
			// Second opinion exists but is unreadable: cannot corroborate.
			return {
				marker: 'unknown',
				shapeValid: true,
				fieldValid: false,
				unknownReason: 'marker-invalid',
				writable
			}
		}
		if (marker === 'unknown') {
			// An explicit `unknown` outranks whatever the boolean claims.
			return {
				marker: 'unknown',
				shapeValid: true,
				fieldValid: true,
				unknownReason: 'marker-explicit-unknown',
				writable
			}
		}
		const agrees =
			(marker === 'initialized' && oldValue === true) ||
			(marker === 'uninitialized' && oldValue === false)
		if (!agrees) {
			// Both sides legal, both sides disagreeing → neither may win.
			return {
				marker: 'unknown',
				shapeValid: true,
				fieldValid: false,
				unknownReason: 'marker-conflict',
				conflict: true,
				writable
			}
		}
		return { marker, shapeValid: true, fieldValid: true, writable }
	}

	// --- new marker absent: the legacy boolean may speak, but only when true --
	if (!hasOld) {
		return {
			marker: 'unknown',
			shapeValid: true,
			fieldValid: false,
			unknownReason: 'marker-missing',
			writable
		}
	}
	if (!oldValid) {
		return {
			marker: 'unknown',
			shapeValid: true,
			fieldValid: false,
			unknownReason: 'marker-invalid',
			writable
		}
	}
	if (oldValue === true) {
		// Round-2 `true` is real evidence: nothing writes it by default.
		return {
			marker: 'initialized',
			shapeValid: true,
			fieldValid: false,
			unknownReason: 'marker-missing',
			writable
		}
	}
	// Round-2 `false`: indistinguishable from a merged default. Not history.
	return {
		marker: 'unknown',
		shapeValid: true,
		fieldValid: false,
		unknownReason: 'marker-legacy-false',
		writable
	}
}

/**
 * Thin backward-compatible wrapper: returns just the marker value (F-07 #1).
 * Round 3.2 callers that need the shape/field validity should use
 * `readConfigMarker` directly.
 */
export function readInitMarker(raw: unknown): KeyInitState | undefined {
	return readConfigMarker(raw).marker
}

/** Normalise the two accepted dependency shapes into one marker (or `undefined`). */
function markerOf(deps: ResolveDeps | undefined): KeyInitState | undefined {
	if (!deps) return undefined
	if (deps.initState !== undefined) return deps.initState
	if (typeof deps.initialized === 'boolean') {
		return deps.initialized ? 'initialized' : 'uninitialized'
	}
	return undefined
}

/**
 * Wording for `unknown`, derived from the *specific* reason it was reached
 * (R3.1-02). Each reason gets a cause-accurate line so the UI can never show the
 * opposite of the real state — e.g. an explicit `unknown` marker must not be
 * described as a missing config.
 */
function unknownMessage(reason: UnknownReason): string {
	switch (reason) {
		case 'config-missing':
			return (
				'警告：无法确认本 Vault 的密钥历史状态（配置文件缺失或不可读）。' +
				'为避免误生成导致既有导出失效，请确认后再操作（旧导出可能因密钥缺失而失效）。'
			)
		case 'config-shape-invalid':
			return (
				'警告：配置文件根结构异常（不是合法的对象，可能被手工改动或写入了非 JSON 对象），' +
				'无法确认密钥历史状态。已拒绝普通写入以免覆盖原配置；请先手动恢复或删除 data.json，' +
				'再由插件重新初始化。'
			)
		case 'config-exists-check-failed':
			return (
				'警告：无法确认配置文件是否存在（文件存在性检查失败），因此无法确认密钥历史状态。' +
				'已按最保守的方式拒绝普通写入以免覆盖可能存在的配置；请检查 Vault 目录权限后重启 Obsidian。'
			)
		case 'config-read-failed':
			return (
				'警告：配置文件存在但读取失败，无法确认密钥历史状态。' +
				'已拒绝普通写入以免覆盖原文件；请检查文件权限或磁盘状态后重试。'
			)
		case 'marker-missing':
			return (
				'警告：无法确认本 Vault 的密钥历史状态（配置中缺少初始化标记）。' +
				'为避免误生成导致既有导出失效，请确认后再操作（旧导出可能因密钥缺失而失效）。'
			)
		case 'marker-invalid':
			return (
				'警告：配置文件中的初始化标记无法识别（非法值），无法确认密钥历史状态。' +
				'为避免误生成导致既有导出失效，请确认后再操作（旧导出可能因密钥缺失而失效）。'
			)
		case 'marker-explicit-unknown':
			return (
				'警告：本 Vault 的密钥历史状态记录为「未知」（配置已明确记录，并非文件缺失）。' +
				'为避免误生成导致既有导出失效，请确认后再操作（旧导出可能因密钥缺失而失效）。'
			)
		case 'marker-conflict':
			return (
				'警告：配置中的新旧初始化标记互相矛盾（新标记与旧布尔值不一致），无法确认密钥历史状态。' +
				'这通常意味着配置被手工改动过，或新旧版本交替写入过。已按「未知」处理且不做任何自动初始化；' +
				'请确认后再操作（旧导出可能因密钥缺失而失效）。'
			)
		case 'marker-legacy-false':
			return (
				'警告：配置中只有旧版布尔标记且其值为 false。该值可能是旧版写入的默认值，' +
				'不能作为「从未初始化过」的证据，因此无法确认密钥历史状态。' +
				'为避免误生成导致既有导出失效，请确认后再操作（旧导出可能因密钥缺失而失效）。'
			)
	}
}

/**
 * Resolve the signing key when the plugin loads.
 *
 * Returns one of six states, deliberately distinct (F-07, S1 #2/#3/#4):
 *
 *   - `ready`      a valid key is present → keep it. If the stored marker does
 *                  not say `initialized`, a migration is requested: a valid key
 *                  proves the vault was initialised (F-07 #2).
 *   - `first-init` the stored marker says `uninitialized` and the config file
 *                  exists → fail closed and wait for the user's explicit
 *                  "生成密钥" click (S1 #7). We do NOT auto-generate.
 *   - `lost`       was initialised, key now missing → explicit warning and
 *                  strict confirmation before re-initialising (S1 #3, #6).
 *   - `corrupted`  a key is present but malformed → keep the bad value in
 *                  memory (so `writeExport` / `inspectOwnership` keep refusing)
 *                  and never overwrite it.
 *   - `unknown`    history cannot be determined → we refuse to impersonate
 *                  `first-init` and ask the user to confirm explicitly
 *                  (S1 #4, F-07 note, F-09).
 *   - `unavailable` is produced by `rotateKey` only, never here.
 *
 * `unknown` is returned when the marker itself says so, when the marker is
 * unreadable (present but not one of the three valid states, R3-01), when the
 * new and legacy markers contradict each other (Round 4), when only a legacy
 * `false` is stored (Round 4 — a merged default is not history), when no marker
 * is stored at all, or when the marker is absent *and* the config file is
 * missing (nothing to tell first install from a deleted config). Defensively it
 * is also returned when an `uninitialized` marker is combined with a missing
 * config file, which no writer of ours can produce.
 *
 * `first-init` is therefore reachable **only** from an explicit, self-consistent
 * `uninitialized` marker. That is what "`confirmTwice` may only be relaxed on
 * trustworthy evidence of a first install" means in code.
 *
 * A *valid* key outranks an `unknown` marker: the key is proof that the vault
 * was initialised, so the marker is migrated to `initialized` rather than
 * leaving the vault in a permanent unknown limbo (documented behaviour, IM-10).
 * A *malformed* key does **not** get that treatment — it only proves that
 * something was written, not that initialisation completed (Round 4, MG-17).
 */
export function resolveKeyOnLoad(
	current: string | undefined,
	deps: ResolveDeps = {}
): KeyLifecycleResult {
	const value = current == null ? '' : String(current).trim()
	const marker = markerOf(deps)
	const configPresent = deps.configPresent !== false
	const configShapeValid = deps.configShapeValid !== false
	/**
	 * Is the *stored* marker already the one we are about to report? Round 4
	 * makes this the single definition of "nothing to migrate": a marker that is
	 * merely inferable (legacy boolean) is not persisted, and a marker the
	 * resolver had to downgrade is not persisted either.
	 *
	 * `storedMarkerValid` defaults to "assume yes" for the pure API, but a config
	 * whose marker field exists and is unusable/contradictory is never rewritten
	 * (`storedMarkerWritable === false`), so `unknown` stays on disk verbatim.
	 */
	const persistedAlready = (desired: KeyInitState): boolean =>
		deps.storedMarkerValid !== false && marker === desired
	const migrationFor = (desired: KeyInitState, repair = false): 'none' | 'needed' => {
		if (deps.storedMarkerWritable === false && !repair) return 'none'
		return persistedAlready(desired) ? 'none' : 'needed'
	}

	// Non-empty key first: a key's validity is the strongest evidence there is,
	// and it outranks whatever the marker claims.
	if (value.length > 0) {
		if (isValidSigningKey(value)) {
			// A valid key proves the vault *was* initialised. When the marker has
			// not caught up (legacy 2A.2.2 config, a contradiction, or an
			// inconsistent one), ask the caller to persist `initialized`
			// (F-07 #2/#3, Round 4 MG-16). `repair: true` because the key is
			// positive proof, not an inference — unlike an unreadable marker next
			// to a *missing* key, this one may be corrected.
			const migration = migrationFor('initialized', true)
			return {
				state: 'ready',
				key: value,
				changed: false,
				initState: 'initialized',
				migration,
				unknownReason: undefined,
				message:
					migration === 'needed'
						? '签名密钥已就绪（旧配置缺少初始化标记，正在迁移）'
						: '签名密钥已就绪'
			}
		}
		// Present but invalid: corrupted, truncated, or hand-edited. Refuse to
		// touch it (S1 #7). Keeping the bad value in memory preserves fail-closed.
		//
		// Round 4 (MG-17): key material that exists contradicts "never
		// initialised", so an `uninitialized` marker is NOT carried forward —
		// the history becomes `unknown` and the user has to confirm. Only an
		// explicit `initialized` marker survives, because a corrupt key is
		// perfectly consistent with "a key was created and later damaged".
		const corruptInit: KeyInitState = marker === 'initialized' ? 'initialized' : 'unknown'
		return {
			state: 'corrupted',
			key: value,
			changed: false,
			initState: corruptInit,
			migration: migrationFor(corruptInit),
			unknownReason: marker === 'initialized' ? undefined : 'marker-missing',
			message:
				'签名密钥存在但格式非法（可能已损坏或被改动）。已停止自动覆盖；' +
				'请到插件设置「重新生成」（注意：重新生成会使所有既有导出无法通过验证）。'
		}
	}

	// Empty key — the marker decides, and its *absence* is a state of its own.
	if (marker === 'initialized') {
		// We KNOW a key existed before. Its absence now is a loss, not a first
		// install, and must not be silently "fixed".
		return {
			state: 'lost',
			key: '',
			changed: false,
			initState: 'initialized',
			migration: migrationFor('initialized'),
			unknownReason: undefined,
			message:
				'警告：本 Vault 曾生成过清单签名密钥，但当前配置中缺失。' +
				'为避免误生成导致既有导出失效，请确认后重新初始化（旧导出将无法通过验证）。'
		}
	}

	// R3.1-01: the stored config root is not a readable object (string / number /
	// false / array). This is NOT "marker missing" and must never downgrade to
	// `first-init` or auto-migrate to `uninitialized`. Fail closed to `unknown`.
	if (!configShapeValid) {
		const reason = deps.unknownReason ?? 'config-shape-invalid'
		return {
			state: 'unknown',
			key: '',
			changed: false,
			initState: 'unknown',
			migration: migrationFor('unknown'),
			unknownReason: reason,
			message: unknownMessage(reason)
		}
	}

	if (marker === 'unknown' || (marker === 'uninitialized' && !configPresent)) {
		const reason =
			deps.unknownReason ??
			(marker === 'unknown' ? 'marker-explicit-unknown' : 'marker-missing')
		return {
			state: 'unknown',
			key: '',
			changed: false,
			initState: 'unknown',
			migration: migrationFor('unknown'),
			unknownReason: reason,
			message: unknownMessage(reason)
		}
	}

	if (marker === undefined && !configPresent) {
		// The whole config is gone, so we cannot tell a brand-new vault from a
		// vault whose config was deleted. Per S1 #4 / F-07 we must NOT impersonate
		// `first-init`; the desired marker is `unknown` (F-09).
		const reason = deps.unknownReason ?? 'config-missing'
		return {
			state: 'unknown',
			key: '',
			changed: false,
			initState: 'unknown',
			migration: migrationFor('unknown'),
			unknownReason: reason,
			message: unknownMessage(reason)
		}
	}

	// Round 4 (F-07 #4): `first-init` now requires *explicit* evidence —
	// `uninitialized` is only reachable when the stored config says so and the
	// legacy boolean agrees. A missing marker never lands here any more: it
	// resolves to `unknown` in `readConfigMarker`, and the defensive tail below
	// keeps that true even if a future caller bypasses that function.
	if (marker === 'uninitialized') {
		return {
			state: 'first-init',
			key: '',
			changed: false,
			initState: 'uninitialized',
			migration: migrationFor('uninitialized'),
			unknownReason: undefined,
			message:
				'尚未生成本 Vault 的清单签名密钥。导出已暂停：请在插件设置中点击「生成密钥」。'
		}
	}

	// Nothing we can act on: never impersonate `first-init`.
	const fallback = deps.unknownReason ?? 'marker-missing'
	return {
		state: 'unknown',
		key: '',
		changed: false,
		initState: 'unknown',
		migration: migrationFor('unknown'),
		unknownReason: fallback,
		message: unknownMessage(fallback)
	}
}

/**
 * User-initiated key (re)generation: first creation or rotation.
 *
 * F-07/S2 #1/#2: the new key is persisted FIRST; only if that succeeds do we
 * report `changed: true` (the caller then updates the in-memory key and the
 * init marker). S2 #3/#4: if `save` throws, the previously held key — valid,
 * corrupted, or empty — is preserved and returned unchanged; we never adopt a
 * key we could not persist, and never clear the original.
 *
 * S2 #5/#6 (mutual exclusion, stable snapshot) are enforced by the caller in
 * main.ts, not here.
 */
export async function rotateKey(
	current: string | undefined,
	deps: RotateDeps
): Promise<KeyLifecycleResult> {
	const previous = current == null ? '' : String(current)
	const fresh = generateSigningKeyHex()

	try {
		// S2 #1: persist before anything else. Throws on failure.
		await deps.save(fresh, true)
	} catch (error) {
		// R3.1-03: the write failed, but the *reason* must not be swallowed.
		// We extract a fixed, safe diagnostic (error type + code + redacted
		// message) for the console, so a real fault such as EACCES / ENOSPC stays
		// diagnosable — without ever echoing the (old or new) key to the log, and
		// without dumping the raw Error object. The user-facing message stays a
		// fixed string that never contains key material.
		const valid = isValidSigningKey(previous)
		const state: KeyState = valid ? 'ready' : previous ? 'corrupted' : 'unavailable'
		const diag = extractKeyDiagnostics(error, [fresh, previous])
		console.error(
			'[html-export-preview] 密钥持久化写入失败（已脱敏）：' + diag
		)
		return {
			state,
			key: previous,
			changed: false,
			// The marker on disk is unchanged, so the *desired* marker is whatever
			// was already there; a failed write must not claim `initialized`.
			initState: markerOf(deps) ?? (valid ? 'initialized' : 'unknown'),
			migration: 'none',
			unknownReason: undefined,
			message: valid
				? '重新生成失败：插件配置未能写入，已保留原有效密钥。'
				: previous
					? '重新生成失败：插件配置未能写入，已保留损坏的原密钥（导出仍会被拒绝）。'
					: '生成密钥失败：插件配置未能写入，未采纳未持久化的新密钥。'
		}
	}

	// Persisted successfully — the caller may now adopt the new key.
	return {
		state: 'ready',
		key: fresh,
		changed: true,
		initState: 'initialized',
		migration: 'none',
		unknownReason: undefined,
		message:
			'清单签名密钥已生成 / 替换。注意：既有导出将无法通过验证，需手动处理后重新导出。'
	}
}

export interface KeyStatusLine {
	/** Short status shown next to the setting. */
	label: string
	/** Longer explanation / recovery hint. */
	detail: string
	/** Whether the action button reads "生成密钥" (create) or "重新生成" (rotate). */
	action: 'generate' | 'rotate' | 'none'
	/** Whether the user must confirm twice before the key is replaced (S1 #6). */
	confirmTwice: boolean
}

/**
 * Describe the key's state for the Settings tab. Centralises the loss / recovery
 * messaging required by S1 #6 so it cannot drift between code and UI.
 *
 * For an empty key it distinguishes `first-init` (never initialised, normal
 * first creation, no strict confirm), `lost` (was initialised, now gone —
 * strict confirm) and `unknown` (history indeterminate — strict confirm). The
 * caller must pass the real marker it observed on load, otherwise `first-init`
 * would be wrongly assumed.
 *
 * Round 3 (F-07 #5): `migrationFailed` appends an explicit warning when the
 * init marker could not be written, so a failed migration is never presented as
 * a completed one.
 */
export function describeKey(
	current: string | undefined,
	opts: ResolveDeps & { migrationFailed?: boolean } = {}
): KeyStatusLine {
	const value = current == null ? '' : String(current).trim()
	const resolved = resolveKeyOnLoad(value, opts)
	const base = describeResolved(resolved, value)
	if (opts.migrationFailed) {
		return {
			...base,
			detail:
				base.detail +
				'\n\n⚠️ 初始化标记尚未写入配置文件（迁移失败）：密钥本身未受影响，' +
				'下次保存设置时会重试写入。'
		}
	}
	return base
}

/** State → wording. Split out so `describeKey` stays a pure projection. */
function describeResolved(result: KeyLifecycleResult, value: string): KeyStatusLine {
	if (value.length > 0) {
		if (result.state === 'ready') {
			return {
				label: '已生成（本 Vault 独有，保存在本 Vault 的插件配置里）',
				detail:
					'导出目录里的 export-manifest.json 用它对关键字段签名，插件据此证明「这个目录确实由本插件写出」。' +
					'密钥不会写进导出目录，也不会显示在界面上。\n' +
					'密钥丢失、被清空，或在另一台设备上没同步到本 Vault 的插件配置时，已有导出目录将无法通过验证——' +
					'插件会拒绝覆盖它们（不会删除），需要手动备份或移走旧目录后重新导出。',
				action: 'rotate',
				confirmTwice: true
			}
		}
		return {
			label: '存在但格式非法（可能已损坏或被改动）',
			detail:
				'插件已停止自动覆盖这把异常密钥。点击「重新生成」会写入一把新密钥，' +
				'但所有既有导出将因签名不符而被视为「无法验证」并被拒绝覆盖——请先手动备份或移走旧目录。',
			action: 'rotate',
			confirmTwice: true
		}
	}

	if (result.state === 'lost') {
		return {
			label: '密钥丢失：本 Vault 曾初始化但当前配置缺失',
			detail:
				'⚠️ 严格确认：本 Vault 之前已生成过签名密钥，但当前配置中找不到它。' +
				'重新生成会写入新密钥，所有既有导出将因签名不符而失效（插件会拒绝覆盖，不会删除旧目录）。' +
				'若你只是换设备/未同步配置，请先恢复旧的 data.json，而非重新生成。',
			action: 'generate',
			confirmTwice: true
		}
	}

	if (result.state === 'unknown') {
		// R3.1-02: the label and detail are driven by the *specific* reason, never
		// by a coarse config-present boolean — an explicit `unknown` marker must
		// not be described as a missing file, and a shape anomaly must not be
		// described as a missing marker.
		const reason = result.unknownReason ?? 'marker-missing'
		const label = unknownLabel(reason)
		return {
			label,
			detail: unknownMessage(reason),
			action: 'generate',
			confirmTwice: true
		}
	}

	// Config present, never initialised → normal first creation.
	return {
		label: '尚未生成，导出会在生成前中止',
		detail:
			'本插件不会在后台静默创建密钥（那会让密钥在重启后丢失并悄悄破坏之后的每次导出）。' +
			'点击「生成密钥」即可为当前 Vault 创建一把，此后导出才能签名。',
		action: 'generate',
		confirmTwice: false
	}
}

/** Short status label for each `unknown` reason (R3.1-02). */
function unknownLabel(reason: UnknownReason): string {
	switch (reason) {
		case 'config-missing':
			return '无法确认密钥历史状态（配置文件缺失）'
		case 'config-shape-invalid':
			return '无法确认密钥历史状态（配置文件结构异常）'
		case 'config-exists-check-failed':
			return '无法确认密钥历史状态（无法确认配置文件是否存在）'
		case 'config-read-failed':
			return '无法确认密钥历史状态（配置文件读取失败）'
		case 'marker-missing':
			return '无法确认密钥历史状态（缺少初始化标记）'
		case 'marker-invalid':
			return '无法确认密钥历史状态（初始化标记无法识别）'
		case 'marker-explicit-unknown':
			return '密钥历史状态为「未知」（配置已记录）'
		case 'marker-conflict':
			return '无法确认密钥历史状态（新旧初始化标记矛盾）'
		case 'marker-legacy-false':
			return '无法确认密钥历史状态（旧版 false 不足以证明首次安装）'
	}
}
