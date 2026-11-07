import { MarkdownView, Notice, Plugin, WorkspaceLeaf } from 'obsidian'
import { captureReadingView } from './capture/dom-capture'
import { CaptureError } from './capture/dom-resolver'
import { buildRuntimeAudit, type RuntimeAudit } from './capture/runtime-audit'
import type { CaptureSnapshot } from './capture/types'
import {
	collectCss,
	referencedDataAttributes,
	renderCss,
	type CssCollection
} from './css/css-collector'
import { auditCssVisibility } from './css/visibility-audit'
import { AssetCollector } from './assets/resource-manager'
import { buildHtml } from './export/exporter'
import { responsiveCss, themeOf } from './export/layout-css'
import {
	DEFAULT_LAYOUT,
	normalizeLayout,
	type ExportLayoutOptions
} from './export/layout-settings'
import { ExportError, writeExport, type ExportReport } from './export/writer'
import { assertVaultRelativeLocation, safeFolderName } from './export/path-safety'
import {
	createExternalHost,
	hostCapabilities,
	revealInFolder,
	type ExternalHost
} from './export/external/host'
import { createExternalAdapter, type ExternalAdapter } from './export/external/adapter'
import {
	resolveExternalTarget,
	type ExternalRequest,
	type ExternalTarget
} from './export/external/target'

/** A validated external destination: the facade, what it is rooted at, and where. */
interface ExternalDestination {
	host: ExternalHost
	adapter: ExternalAdapter
	target: ExternalTarget
}
import {
	buildSingleFile,
	writeShareFile,
	ShareRefusedError,
	ShareWriteError,
	sha256Hex,
	type ShareReplacePlan,
	type ShareStats,
	type ShareWriteResult
} from './export/single-file'
import { askExportConflict } from './view/conflict-modal'
import {
	classifyConfigFile,
	describeErrorSafely,
	describeKey,
	extractKeyDiagnostics,
	readConfigMarker,
	redactKeyMaterial,
	resolveKeyOnLoad,
	rotateKey,
	type ConfigFileClassification,
	type ConfigFileProbe,
	type ConfigFileState,
	type KeyInitState,
	type KeyLifecycleResult,
	type KeyState,
	type KeyStatusLine,
	type MarkerReading,
	type UnknownReason
} from './export/signing-key'
import {
	PreviewView,
	VIEW_TYPE_HTML_EXPORT_PREVIEW,
	type ExportKind,
	type PreviewViewHost
} from './view/preview-view'

import {
	DEFAULT_SETTINGS,
	HtmlExportSettingTab,
	inspectOutputFolder,
	normalizeOutputFolder,
	showInFolderEnabled,
	type HtmlExportSettings
} from './settings'

/**
 * Everything one capture produced.
 *
 * Held for the lifetime of the preview tab so switching the output format, or
 * pressing 确认导出 twice, never re-captures the note: the snapshot is a
 * detached clone, `buildHtml` copies it again, so both pipelines can read the
 * same session in any order without mutating it.
 */
interface PreviewSession {
	snapshot: CaptureSnapshot
	css: CssCollection
	audit: RuntimeAudit
	rootDataAllow: ReadonlySet<string>
}

/**
 * P2 — preview-first export.
 *
 * The former flow (click → capture → write, with a preview panel bolted on the
 * side) is gone: the entry point now opens a **main-area tab** that renders the
 * finished page, lets the user adjust the global layout, and only writes files
 * when 确认导出 is pressed. Closing the tab cancels without touching disk.
 *
 * Everything expensive — capture, stylesheet collection, runtime audit — runs
 * once per open/refresh and is held in `session`, not per slider move: the
 * editor's live feedback is one `<style>` write inside the preview iframe.
 *
 * Review round 2 changed the success contract: the Notice is only allowed to
 * say "完成" after `writeExport()` has written, verified and published every
 * required file. Anything else reports the failing stage and leaves the
 * previous export untouched.
 */
export default class HtmlExportPlugin extends Plugin implements PreviewViewHost {
	settings: HtmlExportSettings = { ...DEFAULT_SETTINGS }

	/**
	 * Everything the two output pipelines need, captured once.
	 *
	 * Released the moment the preview tab closes (`releaseSession()`), because a
	 * snapshot is a full clone of the note DOM plus every stylesheet — keeping
	 * it alive for a closed tab is exactly the leak the P1b lifecycle work
	 * removed.
	 */
	private session: PreviewSession | null = null
	/** Layout the next build uses; the editor is the only writer. */
	private previewLayout: ExportLayoutOptions = { ...DEFAULT_LAYOUT }
	/** Format the editor preselects on open. */
	private previewKind: ExportKind = 'share'

	/** Absolute path of the last successful export, for the copy command. */
	private lastExportPath: string | null = null
	/**
	 * P1: the note the last attempt captured. Exporting reveals the preview
	 * panel, which takes the active leaf with it — this is what lets the next
	 * export find the note again instead of failing with "没有活动的 Markdown 视图".
	 */
	private lastNotePath: string | null = null
	/** Guards against a second run while one is still capturing/writing. */
	private running = false
	/** Derived state of the vault signing key; surfaced for diagnostics only. */
	private keyState: KeyState = 'first-init'
	/**
	 * Whether a config file (`data.json`) was present when `loadSettings` ran.
	 * `false` means the file was absent — we then cannot tell a brand-new vault
	 * from a vault whose config was deleted, so the key resolves to `unknown`
	 * rather than `first-init` (S1 #4, #7).
	 */
	private configPresent = false
	/**
	 * The *real* on-disk state of `data.json` as reported by the vault adapter
	 * (F-01). `configPresent` alone cannot distinguish "no file" from "file whose
	 * content is `null`"; this field records which probe state produced the
	 * decision, so the settings tab and the tests can tell them apart.
	 */
	private configFileState: ConfigFileState = 'missing'
	/**
	 * Whether a `data.json` has been observed at least once **during this
	 * session** (F-01 §3.3).
	 *
	 * `configPresent === false` alone cannot tell the two very different
	 * situations apart:
	 *
	 *   - a brand-new vault that has never had a config → the first save is
	 *     supposed to create one (F-09 / R3-05);
	 *   - a vault whose config existed a moment ago and was deleted by something
	 *     else → recreating it would resurrect stale in-memory settings and
	 *     report a "first install" that never happened.
	 *
	 * Reset only by a process restart, because the only record of the file is the
	 * file itself.
	 */
	private configEverPresent = false
	/**
	 * The config root that the in-memory settings are currently **in sync with**
	 * (Round 3.2.3, F-01 §3.2).
	 *
	 * `rawConfig` cannot serve this purpose: it is overwritten by *every* probe,
	 * so after a probe it describes the file as it is now — including a change
	 * another program just made. Comparing memory against it would therefore
	 * always agree, which is precisely the defect this field fixes: a valid
	 * external rewrite was detected as "shape is an object" and then silently
	 * overwritten by the stale in-memory settings.
	 *
	 * This snapshot is only advanced by the three events that legitimately make
	 * memory and disk agree again: a load, a successful write, and an accepted
	 * external adoption.
	 */
	private syncedRoot: unknown = undefined
	/**
	 * Whether `syncedRoot` is a real baseline (a probe produced a usable root,
	 * or a write succeeded). While `false` there is nothing to compare against,
	 * so any object found on disk counts as an external appearance.
	 */
	private syncedRootKnown = false
	/**
	 * Why the config cannot be trusted, as decided by the *probe* (F-01).
	 *
	 * Kept separately from `markerReading` because `resolveCurrentKey()` re-reads
	 * the marker on every resolve; without this the two I/O reasons
	 * (`config-exists-check-failed` / `config-read-failed`) would be overwritten
	 * by the generic `config-shape-invalid`.
	 */
	private configUnknownReason: UnknownReason | undefined
	/**
	 * Whether the config *root* obtained from the F-01 probe was a readable
	 * object (R3.1-01). `false` means the root was a scalar / array / `null` /
	 * unparsable, or that the probe could not determine presence at all, so the
	 * config cannot be trusted: it must fail closed (`unknown`) and must not be
	 * silently overwritten by an ordinary settings save.
	 */
	private configShapeValid = true
	/** Last `readConfigMarker` reading, kept so UI wording can cite the real reason. */
	private markerReading: MarkerReading = {
		marker: undefined,
		shapeValid: true,
		fieldValid: false,
		writable: true
	}
	/**
	 * Serialises key rotation against exports (S2 #5). Both `rotateSigningKey`
	 * and the export's key read go through this single chain, so an export can
	 * never observe a key while a rotation is mid-flight.
	 */
	private keyLock: Promise<void> = Promise.resolve()
	/**
	 * Depth of *authorised* settings-mutation regions (P1, Round 3.2.4).
	 *
	 * This is deliberately NOT "is anybody holding keyLock?". An export holds
	 * the mutex via `enterKeyLock()` directly; if that alone authorised writes,
	 * a second task running during the export could replace `this.settings`
	 * and still pass the check. Only `withKeyLock()` opens a mutation region,
	 * and only while it owns the mutex. `mutateSettings()` checks this counter,
	 * so a path that skipped the lock cannot mutate the key even by accident.
	 */
	private keyLockOwnerDepth = 0
	/**
	 * The single write queue for **every** settings persistence (F-08).
	 *
	 * Round 2 only serialised key rotation; an ordinary `saveSettings()` could
	 * therefore interleave with it and write a snapshot that still held the old
	 * key. Every write — ordinary settings and key rotation alike — now goes
	 * through `enqueue()`, and the write itself reads `this.settings` at
	 * *execution* time, so a queued write can never persist a stale snapshot
	 * (F-08 §2.2).
	 *
	 * Lock order is fixed and one-way: `keyLock` → `settingsQueue`. A queued task
	 * never waits on the queue again (`writeSettingsNow` is the queue-internal
	 * writer), which is what keeps this from deadlocking (F-08 §2.4).
	 */
	private settingsQueue: Promise<unknown> = Promise.resolve()
	/**
	 * The raw stored root as last *observed* — what the F-01 probe read from
	 * `data.json` (or `undefined` when it could not be read) — kept verbatim so
	 * the init marker is read from the *stored* config rather than from the merged
	 * defaults (F-07 #1). `Object.assign({}, DEFAULT_SETTINGS, data)` would
	 * otherwise invent `signingKeyInitialized: false` for a legacy config.
	 *
	 * R3-05: it is refreshed by `commitPersisted()` after every successful write
	 * and by every probe (`applyConfigOutcome`), so `ensureSigningKey()` never
	 * re-reads a snapshot that is older than the file on disk (which re-triggered
	 * an already-finished migration).
	 */
	private rawConfig: unknown = null
	/**
	 * Whether the desired init marker (`settings.signingKeyInitState`) is known
	 * to be on disk. `false` after a failed migration, so the settings tab can
	 * say so instead of pretending the migration finished (F-07 #5).
	 */
	private initStatePersisted = true
	/**
	 * Set when a migration write failed and no later write has succeeded
	 * (F-07 #5 / R3-04). Cleared by `commitPersisted()`, i.e. only by a write
	 * that really persisted the marker — never by merely re-resolving.
	 */
	private migrationFailed = false

	async onload(): Promise<void> {
		await this.loadSettings()
		// Round 2A.2.2 Review Fix (F-01): the signing key is *resolved* on load,
		// never silently created. A missing key fails closed (the export path
		// refuses to sign) and a malformed key is never overwritten — the user
		// must explicitly initialise or regenerate it from Settings.
		await this.ensureSigningKey()

		this.registerView(
			VIEW_TYPE_HTML_EXPORT_PREVIEW,
			(leaf: WorkspaceLeaf) => new PreviewView(leaf, this)
		)

		// P2: the ribbon no longer exports. It opens the editor, because the
		// whole point of the new flow is that nothing is written until the user
		// has seen the page and confirmed a format.
		this.addRibbonIcon('file-code-2', 'HTML 导出：预览与排版', () => {
			void this.openPreviewEditor()
		})

		this.addCommand({
			id: 'capture-and-export',
			name: 'Open HTML preview & layout editor',
			callback: () => void this.openPreviewEditor()
		})

		this.addCommand({
			id: 'open-preview',
			name: 'Re-capture and open HTML preview',
			callback: () => void this.openPreviewEditor(undefined, { refresh: true })
		})

		this.addCommand({
			id: 'copy-last-export-path',
			name: 'Copy last export path',
			callback: () => void this.copyLastPath()
		})

		this.addCommand({
			id: 'share-single-file',
			name: 'Share as single HTML file (preview, then confirm)',
			callback: () => void this.openPreviewEditor('share')
		})

		this.addSettingTab(new HtmlExportSettingTab(this.app, this))
	}

	/**
	 * Host lifecycle callback: `data.json` was rewritten *outside* Obsidian — a
	 * Sync service, an editor, a script (Obsidian ≥ 1.5.7; typed in
	 * `obsidian.d.ts` as `onExternalSettingsChange?(): any`).
	 *
	 * This has to be a **real method by this name**: the app invokes the hook
	 * itself, so an identically-behaved private helper under another name would
	 * simply never run and the plugin would keep acting on a stale config.
	 *
	 * Lock order stays the documented one-way order `keyLock` → `settingsQueue`
	 * (F-08 §2.4). The queued task below never acquires `keyLock` again, so this
	 * cannot deadlock against a rotation or an in-flight export.
	 *
	 * P1 (Round 3.2.4): the hook goes through `withKeyLock()` like every other
	 * operation that can replace the in-memory signing key. Adopting a valid
	 * external config rewrites `this.settings`, so it must not be allowed to
	 * land while an export holds the key mutex.
	 */
	async onExternalSettingsChange(): Promise<void> {
		await this.withKeyLock(() =>
			this.enqueueWrite(async () => this.adoptExternalConfig())
		)
	}

	/**
	 * Re-read the file and make memory match it — without writing anything.
	 *
	 * Valid config → adopt it (values, marker reading and key state). No
	 * migration: an external edit is not a request to write back, and a migration
	 * here would turn a Sync event into an unexpected disk write.
	 *
	 * Anomalous config → keep the last known in-memory settings and only
	 * downgrade the derived state. Rebuilding them from `DEFAULT_SETTINGS` is
	 * precisely what would later overwrite the user's file.
	 *
	 * Round 3.2.3 (F-01 §3.3): a *valid* external change is not adopted blindly
	 * either. If memory holds edits the user has not saved yet, adopting would
	 * discard them — the mirror image of the defect being fixed. In that case
	 * both sides are left untouched and the conflict surfaces at the next write
	 * as `CONFIG_CONFLICT`, so nobody's data is silently replaced.
	 */
	private async adoptExternalConfig(): Promise<void> {
		const classified = await this.probeAndApply()
		if (!classified.shapeValid) {
			// The proof for the in-memory key is gone, so the state must say so —
			// but the key itself is left untouched until the user decides.
			this.keyState = 'unknown'
			this.initStatePersisted = false
			return
		}
		if (this.hasUnsavedSettingsChanges()) {
			console.warn(
				'[html-export-preview] 检测到外部配置更新，但内存中还有未保存的本地修改：' +
					'已保留本地修改，暂不覆盖（下次保存会明确报冲突）'
			)
			return
		}
		this.adoptConfigRoot(classified.root)
	}

	/**
	 * Make the given config root the current in-memory state, and record it as
	 * the new synchronisation baseline (Round 3.2.3, F-01).
	 *
	 * No I/O, no writes, no migration — only `this.settings` and the derived
	 * key state move. The caller decides *whether* adoption is allowed
	 * (`adoptExternalConfig` refuses while local edits are pending).
	 */
	private adoptConfigRoot(root: unknown): void {
		// P1: this replaces `this.settings.signingKey`, so it MUST be inside the
		// key mutex. All four callers (external-change hook, write-time adoption,
		// load, migration) now hold it; the assertion here is what makes a future
		// shortcut impossible to add silently.
		this.mutateSettings(() => {
			this.settings = Object.assign({}, DEFAULT_SETTINGS, root)
			// Re-derives the key state from the root just adopted. No I/O, and
			// deliberately no migration (Round 4 / F-07 #7).
			this.applyResolved(this.resolveCurrentKey())
			this.syncedRoot = root
			this.syncedRootKnown = true
		})
	}

	async loadSettings(): Promise<void> {
		// P1 (Round 3.2.4): the initial assignment replaces `signingKey`, so it
		// is a key mutation like any other. Nothing else can hold the mutex while
		// `onload()` is running, but routing it through the same gate keeps the
		// rule absolute instead of "true except at start-up".
		await this.withKeyLock(async () => {
			// Never rewrite the user's stored value here: a migration must be an
			// explicit choice in the settings tab (review round 2, §6.3).
			//
			// F-01: the config is read through the *probe* — `adapter.exists()` +
			// `adapter.read()` + `JSON.parse` — instead of `loadData()`, because
			// `loadData()` collapses "file missing", "file whose literal content is
			// `null`" and "unparsable file" into the same `null`. The probe reads
			// the same bytes and can tell the three apart, which is the precondition
			// for refusing a save instead of silently overwriting the user's file.
			await this.probeAndApply()
			const mergeable = this.configShapeValid ? this.rawConfig : undefined
			// An anomalous config must not be "laundered" through the defaults: they
			// are a display fallback only, while every write guard keeps reading
			// `configShapeValid` / `configPresent` / `configFileState` (F-01 §2.3 #5).
			this.mutateSettings(() => {
				this.settings = Object.assign({}, DEFAULT_SETTINGS, mergeable)
			})
			// Round 3.2.3 (F-01 §3.2): the state loaded here *is* the baseline that
			// a later write is compared against. Recording it only when the root was
			// usable keeps "there is nothing trustworthy to compare with" explicit
			// instead of pretending a broken file equals the defaults.
			this.syncedRoot = this.configShapeValid ? this.rawConfig : undefined
			this.syncedRootKnown = this.configShapeValid
		})
	}

	/* ------------------------------------------------ config fingerprints -- */
	/**
	 * The exact object an ordinary write would persist (Round 3.2.3, F-01).
	 *
	 * One builder for both sides of the comparison: memory is compared with the
	 * baseline through *this* shape, never through `this.settings` directly,
	 * because the baseline is a raw file root that has not been merged with
	 * `DEFAULT_SETTINGS`. Building both through the same function cancels the
	 * defaults out and makes the comparison about content, not about which keys
	 * happen to be present.
	 */
	private settingsPayload(): HtmlExportSettings {
		return {
			...this.settings,
			signingKeyInitialized: this.settings.signingKeyInitState === 'initialized'
		}
	}

	/** The payload that a *stored root* would correspond to, read the same way. */
	private payloadOf(root: unknown): HtmlExportSettings {
		// `Object.assign` ignores `null`/`undefined` sources at runtime; the cast
		// is only needed because a raw JSON root is untyped by definition.
		const base = Object.assign(
			{},
			DEFAULT_SETTINGS,
			root as Record<string, unknown>
		) as HtmlExportSettings
		return {
			...base,
			signingKeyInitialized: base.signingKeyInitState === 'initialized'
		}
	}

	/**
	 * Deterministic JSON for comparison (Round 3.2.3, F-01 §3.3).
	 *
	 * Key order is normalised because JSON object order is not semantic: a Sync
	 * client or a formatter may reorder or re-indent `data.json` without changing
	 * a single value, and treating that as a conflict would block every save for
	 * no reason. Values are compared exactly — no coercion, no fuzzy matching —
	 * so a real change is never mistaken for cosmetics.
	 *
	 * Input always comes from `JSON.parse`, so it is plain data; the cycle guard
	 * exists so a hand-built fixture in a test can never hang this function.
	 */
	private stableJson(value: unknown): string {
		const seen = new Set<object>()
		const walk = (node: unknown): unknown => {
			if (node === null) return null
			const type = typeof node
			if (type === 'undefined' || type === 'function' || type === 'symbol') return null
			if (type !== 'object') return node
			const obj = node as object
			if (seen.has(obj)) return '[circular]'
			seen.add(obj)
			if (Array.isArray(obj)) {
				const mapped = obj.map(walk)
				seen.delete(obj)
				return mapped
			}
			const out: Record<string, unknown> = {}
			for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
				out[key] = walk((obj as Record<string, unknown>)[key])
			}
			seen.delete(obj)
			return out
		}
		try {
			return JSON.stringify(walk(value)) ?? 'null'
		} catch {
			return '[unserializable]'
		}
	}

	/**
	 * Does memory hold edits that were never persisted? (Round 3.2.3, F-01)
	 *
	 * Compared against the *synchronised* baseline, not against the disk: after
	 * an external rewrite the two differ for a reason that has nothing to do
	 * with the user, and that difference must not be read as "the user edited
	 * something".
	 */
	private hasUnsavedSettingsChanges(): boolean {
		if (!this.syncedRootKnown) return false
		return (
			this.stableJson(this.settingsPayload()) !==
			this.stableJson(this.payloadOf(this.syncedRoot))
		)
	}

	/** Does the root just read from disk differ from the synchronisation baseline? */
	private diskDiffersFromSynced(root: unknown): boolean {
		if (!this.syncedRootKnown) return true
		return (
			this.stableJson(this.payloadOf(root)) !==
			this.stableJson(this.payloadOf(this.syncedRoot))
		)
	}

	/**
	 * Ask the filesystem whether `data.json` exists and what it contains (F-01).
	 *
	 * Uses the vault adapter — the same API Obsidian itself uses — so the answer
	 * is about the real file, not about what `loadData()` collapsed it into. The
	 * plugin directory is derived from `manifest.dir` (vault-relative) with a
	 * `configDir + plugins + manifest.id` fallback; no plugin name is hardcoded.
	 *
	 * Every failure is reported as a *distinct* probe state, never as "no file":
	 * that distinction is the whole point of this method.
	 */
	private async probeConfigFile(): Promise<ConfigFileProbe> {
		const target = this.configFilePath()
		const adapter = this.app?.vault?.adapter as
			| { exists?: (p: string) => Promise<boolean>; read?: (p: string) => Promise<string> }
			| undefined
		// Unknown location, or a host without the adapter methods: we cannot
		// prove anything, so report a failed existence check (→ unknown, refuse
		// ordinary writes) rather than guessing "missing".
		if (!target || !adapter || typeof adapter.exists !== 'function') {
			return { exists: null, parseOk: false }
		}
		let exists: boolean
		try {
			exists = Boolean(await adapter.exists(target))
		} catch {
			return { exists: null, parseOk: false }
		}
		if (!exists) return { exists: false, parseOk: false }
		let text: unknown
		try {
			if (typeof adapter.read !== 'function') return { exists: true, parseOk: false }
			text = await adapter.read(target)
		} catch {
			return { exists: true, parseOk: false }
		}
		if (typeof text !== 'string') return { exists: true, parseOk: false }
		try {
			return { exists: true, text, parsed: JSON.parse(text), parseOk: true }
		} catch {
			// Present but unparsable: still a real file, still not writable.
			return { exists: true, text, parseOk: false }
		}
	}

	/**
	 * Vault-relative path of this plugin's `data.json`.
	 *
	 * `manifest.dir` is provided by Obsidian and is vault-relative, so it is used
	 * as-is. When it is absent (older manifests / a stub host) the path is
	 * rebuilt from `vault.configDir` + `manifest.id` — never from a literal
	 * plugin-directory name.
	 */
	private configFilePath(): string | null {
		const join = (base: string): string =>
			`${base}/data.json`.replace(/\/{2,}/g, '/')
		const dir = this.manifest?.dir
		if (typeof dir === 'string' && dir.trim().length > 0) return join(dir)
		const configDir = (this.app?.vault as { configDir?: unknown } | undefined)?.configDir
		const id = this.manifest?.id
		if (typeof configDir === 'string' && configDir.length > 0 && typeof id === 'string' && id) {
			return join(`${configDir}/plugins/${id}`)
		}
		return null
	}

	/**
	 * Probe the file, classify what was found and adopt the verdict (F-01).
	 *
	 * The single entry point for "look at the real file again": `loadSettings()`,
	 * the write-time re-check and the external-change handler all use it, so the
	 * classification and the state update can never be run with mismatched
	 * arguments at one site and not another.
	 */
	private async probeAndApply(): Promise<ConfigFileClassification> {
		const probe = await this.probeConfigFile()
		const classified = classifyConfigFile(probe)
		this.applyConfigOutcome(probe, classified)
		return classified
	}

	/**
	 * Adopt one probe verdict as the current derived state (F-01).
	 *
	 * Pure state sync: no I/O, no writes, no key resolution. `loadSettings()`,
	 * the write-time re-check and the external-change handler all go through
	 * here, so "what the file looks like right now" has exactly one
	 * representation and the three call sites cannot drift apart.
	 */
	private applyConfigOutcome(
		probe: ConfigFileProbe,
		classified: ConfigFileClassification
	): void {
		this.configFileState = classified.state
		// F-01: `present` is *not* `root != null`. Only a confirmed-absent file
		// yields `false`; an unreadable one stays "present" so every write guard
		// keeps refusing (fail-closed).
		this.configPresent = classified.present
		this.configShapeValid = classified.shapeValid
		// The merge source must stay the *raw* root: `readConfigMarker()` is
		// re-run on it by `resolveCurrentKey()`, so substituting a clean object
		// here would silently turn a refused config back into a usable one.
		this.rawConfig = classified.shapeValid
			? classified.root
			: probe.parseOk
				? probe.parsed
				: undefined
		this.configUnknownReason = classified.unknownReason
		// F-07 #1 / R3.1-01: read the *stored* marker, not the merged defaults,
		// so the default `signingKeyInitialized: false` cannot invent history.
		const reading = readConfigMarker(this.rawConfig)
		// F-01: the probe — not the root alone — decides whether the shape is
		// usable, and it supplies the precise reason when it is not.
		if (!classified.shapeValid) {
			reading.shapeValid = false
			reading.writable = false
			if (classified.unknownReason) reading.unknownReason = classified.unknownReason
		}
		this.markerReading = reading
		// §3.3: once a file has been seen, a later disappearance must not be read
		// as a first install.
		if (classified.present) this.configEverPresent = true
	}

	/**
	 * Persist the current settings through the shared queue (F-08 §2.1).
	 *
	 * This is the *only* public persistence entry for the whole settings object.
	 * It never mutates any state before the write succeeds and it re-reads
	 * `this.settings` inside the queue, so a write queued earlier still persists
	 * whatever the user has changed by the time it runs.
	 *
	 * R3.1-01: an ordinary save refuses to run while the stored config root is
	 * structurally broken. Overwriting a corrupted `data.json` with a clean object
	 * would silently destroy the user's original config; the user must recover it
	 * explicitly. Key *rotation* is the explicit recovery path and is therefore
	 * not gated here.
	 */
	async saveSettings(): Promise<void> {
		this.assertWritableConfig()
		// P1: the write-time re-check can *adopt* an external config, which
		// replaces the in-memory signing key. Hold the key mutex for the whole
		// queued task so that cannot happen while an export is signing.
		await this.withKeyLock(() => this.writeSettingsGuarded())
	}

	/**
	 * Queue a settings write that re-probes `data.json` at execution time
	 * (F-01 §3.2).
	 *
	 * Every ordinary write funnels through here, so the re-check cannot be
	 * forgotten at one of them. `writeSettingsNow()` stays queue-internal, and
	 * key rotation deliberately does *not* use this path: rotation is the
	 * explicit recovery route and must still be able to replace a broken config.
	 *
	 * Round 3.2.3 (F-01): the task now distinguishes "the write happened" from
	 * "there was nothing of ours left to write". When an external rewrite was
	 * accepted just now, memory already equals the file, so writing would only
	 * re-serialise someone else's bytes — the caller is told instead of being
	 * left to assume a write that never needed to happen.
	 */
	private async writeSettingsGuarded(): Promise<'written' | 'adopted'> {
		// P1: this task may end up calling adoptConfigRoot(). It must run while
		// the caller owns keyLock, never inside the queue waiting for it (that
		// would invert the lock order and deadlock).
		this.assertKeyLockHeld()
		return this.enqueueWrite(async () => {
			const adopted = await this.recheckConfigBeforeWrite()
			if (adopted) return 'adopted'
			await this.writeSettingsNow()
			return 'written'
		})
	}

	/**
	 * Ask the *real file* whether an ordinary write is still allowed
	 * (F-01 §3.2, F-01 §3.1 of Round 3.2.3).
	 *
	 * The cached verdict is a hint, not a fact: a sync client, an editor or a
	 * script can rewrite or delete `data.json` between `loadSettings()` and a
	 * later save, and a guard that consulted only memory would happily overwrite
	 * the result. This runs *inside* the write queue — as late as the queue
	 * allows — and throws before `saveData()` is ever reached.
	 *
	 * Three questions are answered here, in this order, because each is strictly
	 * weaker than the next:
	 *
	 *   1. is the file still there, and is it still a config? (Round 3.2.2)
	 *   2. does its *content* still match what memory was synchronised with?
	 *   3. if not, did the user also change something locally? (Round 3.2.3)
	 *
	 * Round 3.2.2 only answered (1). A valid object therefore always passed, and
	 * a legitimate external rewrite — a `synced-folder` and a new key written by
	 * a Sync client — was silently replaced by the stale in-memory values. (2)
	 * and (3) are what separate the three real cases:
	 *
	 *   - disk changed, memory clean  → adopt the disk values, write nothing
	 *                                   (there is nothing of ours to persist);
	 *   - disk changed, memory dirty  → refuse: neither side may be overwritten
	 *                                   without a merge policy we do not have;
	 *   - disk unchanged              → ordinary write, as before.
	 *
	 * @returns `true` when an external change was adopted and the caller should
	 *          therefore skip its own write.
	 *
	 * This is NOT a compare-and-swap: the probe and the write are two separate
	 * adapter calls, so an external writer can still land in between. The adapter
	 * exposes no atomic primitive; the window is reported, not hidden.
	 */
	private async recheckConfigBeforeWrite(): Promise<boolean> {
		const classified = await this.probeAndApply()
		if (classified.state === 'missing') {
			// §3.3: the file was here a moment ago and is gone now, so something
			// else deleted it. Recreating it would resurrect stale in-memory
			// settings over whatever replaced it, and would report a first
			// install that never happened.
			if (!this.configEverPresent) return false
			throw new Error(
				'CONFIG_MISSING_AFTER_DELETE: 配置文件在本次会话中曾存在，现已被外部删除，' +
					'已拒绝普通写入（避免把旧的内存设置写回成「首次安装」）；' +
					'请恢复 data.json，或在设置中显式重新生成密钥。'
			)
		}
		if (classified.state !== 'object' || !classified.shapeValid) {
			const reason = classified.unknownReason ?? 'config-shape-invalid'
			throw new Error(
				`CONFIG_SHAPE_INVALID: 配置文件根结构异常或无法确认（${reason}），已拒绝普通写入以免覆盖原文件；` +
					'请手动恢复或删除 data.json，再由插件重新初始化。'
			)
		}
		return this.settleExternalChange(classified.root)
	}

	/**
	 * Decide what to do when the config on disk is a valid object but no longer
	 * the one memory was synchronised with (Round 3.2.3, F-01 §3.3).
	 *
	 * Deliberately *not* a field-level merge: there is no reliable way to know
	 * which side owns a field that both changed, and a wrong guess destroys one
	 * of them. The three outcomes above are the only ones this plugin can defend,
	 * so anything ambiguous is refused and handed back to the user.
	 *
	 * @returns `true` if the disk values were adopted (caller must not write).
	 * @throws when the file and memory both changed.
	 */
	private settleExternalChange(diskRoot: unknown): boolean {
		if (!this.diskDiffersFromSynced(diskRoot)) return false
		if (this.hasUnsavedSettingsChanges()) {
			throw new Error(
				'CONFIG_CONFLICT: data.json 在本次会话期间被外部修改，同时内存中还有未保存的本地修改，' +
					'两者都已保留、均未写入。为了避免任一方被静默覆盖，本次保存已取消。' +
					'请重新加载插件以采用磁盘上的配置（未保存的本地修改将丢失），' +
					'或先确认磁盘配置后再重试。'
			)
		}
		// Memory holds no unsaved work, so adopting cannot lose anything the user
		// typed. The caller skips its write: memory now equals the file.
		this.adoptConfigRoot(diskRoot)
		console.info(
			'[html-export-preview] 已采用外部更新的配置（本次未写入，磁盘内容保持不变）'
		)
		return true
	}

	/**
	 * Fast-fail gate on the **cached** verdict (R3.1-01 / F-01).
	 *
	 * This is the first of two layers, not the authority. It rejects immediately
	 * when the config is *present but not a readable object*, which since F-01
	 * also covers the states `loadData() === null` used to hide:
	 *
	 *   - a file whose literal content is `null`  (used to look like "no file")
	 *   - a file containing a string / array / `false` / `0`
	 *   - a file with unparsable JSON
	 *   - a *failed* existence check or a failed read → treated as present, so
	 *     doubt always fails closed instead of becoming "first install".
	 *
	 * Only a confirmed-absent file (`configPresent === false`) reaches the
	 * legitimate "create on first save" path (F-09 / R3-05).
	 *
	 * The authoritative check is `recheckConfigBeforeWrite()`, which re-probes the
	 * real file inside the write queue: the cache can be stale the moment another
	 * program touches `data.json`. That second layer is also what catches the
	 * "existed, then was deleted" case — there `configPresent` is `false`, so this
	 * gate lets the attempt through and the recheck is what refuses it.
	 */
	private assertWritableConfig(): void {
		if (this.configShapeValid === false && this.configPresent) {
			const reason = this.markerReading.unknownReason ?? 'config-shape-invalid'
			throw new Error(
				`CONFIG_SHAPE_INVALID: 配置文件根结构异常或无法确认（${reason}），已拒绝普通写入以免覆盖原文件；` +
					'请手动恢复或删除 data.json，再由插件重新初始化。'
			)
		}
	}

	/**
	 * Change `outputFolder` transactionally (R3-02).
	 *
	 * The old flow mutated `this.settings.outputFolder` *before* saving, so a
	 * failed write left memory ahead of disk and a later export could publish
	 * into a folder that was never persisted. Here the candidate is written
	 * first and the in-memory value is committed only after `saveData` resolves.
	 *
	 * Concurrent edits are safe by construction: the payload is built *inside*
	 * the queued task from the settings as they are at execution time, and a
	 * failure changes nothing — so an older failure can neither roll back a
	 * newer success nor overwrite a newer input.
	 *
	 * R3.1-01: also gated by `assertWritableConfig`, so a broken config is never
	 * silently rewritten by an output-folder edit.
	 */
	async updateOutputFolder(next: string): Promise<void> {
		this.assertWritableConfig()
		const normalized = normalizeOutputFolder(next)
		// P1: same reason as saveSettings — the re-check below can adopt an
		// external config (and therefore replace the signing key) before this
		// edit is persisted.
		await this.withKeyLock(() =>
			this.enqueueWrite(async () => {
				// F-01 §3.2: an output-folder edit is an ordinary write. Re-probe
				// first, so it cannot slip past a config that changed on disk while
				// the user was typing in the field.
				//
				// Round 3.2.3 (F-01): the return value is deliberately ignored here.
				// A folder edit is an explicit intent to change exactly one field, so
				// when an external rewrite is adopted first, the write that follows
				// still has to happen — it persists the adopted values with only
				// `outputFolder` replaced (F01-17). Skipping it, as `saveSettings`
				// does, would silently drop the user's edit.
				await this.recheckConfigBeforeWrite()
				const payload: HtmlExportSettings = {
					...this.settings,
					outputFolder: normalized,
					signingKeyInitialized:
						this.settings.signingKeyInitState === 'initialized'
				}
				await this.writeConfig(payload)
				this.mutateSettings(() => {
					this.settings.outputFolder = normalized
				})
			})
		)
	}

	/**
	 * Persist the "show in folder" preference through the same transactional
	 * writer as `outputFolder`.
	 *
	 * It is an *optional* key: `undefined` means default-on, so an existing
	 * `data.json` is never rewritten on load. Only an explicit click here adds
	 * the member. A failed write leaves both memory and disk untouched.
	 */
	async setShowInFolder(value: boolean): Promise<void> {
		this.assertWritableConfig()
		await this.withKeyLock(() =>
			this.enqueueWrite(async () => {
				await this.recheckConfigBeforeWrite()
				const payload: HtmlExportSettings = {
					...this.settings,
					showInFolder: !!value,
					signingKeyInitialized:
						this.settings.signingKeyInitState === 'initialized'
				}
				await this.writeConfig(payload)
				this.mutateSettings(() => {
					this.settings.showInFolder = !!value
				})
			})
		)
	}

	/** Queue a write; the queue keeps running even when a task rejects. */
	private enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
		const run = this.settingsQueue.then(task, task)
		// The chain must survive a rejected task, otherwise every later write
		// would reject with the same error and no further save could ever land.
		this.settingsQueue = run.then(
			() => undefined,
			() => undefined
		)
		return run
	}

	/**
	 * The single writer (R3-04/R3-05). MUST only be called from inside
	 * `enqueueWrite` — calling it directly would bypass serialisation
	 * (F-08 §2.4). The write happens first; every derived state is updated only
	 * after it resolved, so a failure leaves all of it untouched.
	 */
	private async writeConfig(payload: HtmlExportSettings): Promise<void> {
		await this.saveData(payload)
		this.commitPersisted(payload)
	}

	/**
	 * The single place that records "this config is now on disk".
	 *
	 * R3-05: `rawConfig` used to be written once in `loadSettings()` and never
	 * again, so `ensureSigningKey()` kept reading a stale snapshot and could
	 * re-run a migration that had already succeeded. It now mirrors the payload
	 * that was just persisted.
	 *
	 * Round 4 (F-07 #5): "persisted" is *not* a synonym for "`saveData`
	 * resolved". It means the marker is actually readable back from the shape
	 * that will be on disk. Two ways that can fail even on a successful write:
	 *
	 *   - `signingKeyInitState` is `undefined` → JSON serialisation drops the
	 *     member, so the file carries no marker at all;
	 *   - the payload's two markers contradict each other → reading it back
	 *     yields `unknown` with `fieldValid: false`.
	 *
	 * Neither may clear `migrationFailed`, because in both cases the marker the
	 * plugin wants is still absent from disk.
	 */
	private commitPersisted(payload: HtmlExportSettings): void {
		this.rawConfig = this.persistedShape(payload)
		// Round 3.2.3 (F-01 §3.2): a successful write is the second event that
		// legitimately makes memory and disk agree, so it re-baselines the
		// conflict check. Without this, every later save would compare against
		// the pre-write snapshot and report a conflict with itself.
		this.syncedRoot = this.rawConfig
		this.syncedRootKnown = true
		this.configPresent = true
		// A write that reached the disk proves the file exists from now on, so a
		// later external deletion is not mistaken for a first install (§3.3).
		this.configEverPresent = true
		this.configShapeValid = true
		// F-01: a successful write replaced whatever the probe refused, so the
		// probe's verdict no longer describes the file on disk.
		this.configFileState = 'object'
		this.configUnknownReason = undefined
		// The persisted object is by definition a valid config root, so re-read its
		// marker so the UI reason stays accurate after a successful write.
		this.markerReading = readConfigMarker(this.rawConfig)
		const desired = payload.signingKeyInitState
		const recorded =
			desired !== undefined &&
			this.markerReading.fieldValid &&
			this.markerReading.marker === desired
		this.initStatePersisted = recorded
		if (recorded) this.migrationFailed = false
	}

	/**
	 * The payload as it will actually be readable after a restart.
	 *
	 * `saveData` JSON-serialises, which drops members whose value is
	 * `undefined`; `rawConfig` has to match that shape or `readInitMarker()`
	 * would see a present-but-undefined marker where the file simply has none.
	 */
	private persistedShape(payload: HtmlExportSettings): unknown {
		try {
			return JSON.parse(JSON.stringify(payload))
		} catch {
			return { ...payload }
		}
	}

	/**
	 * The queue-internal writer. MUST only be called from inside `enqueueWrite`
	 * — calling it directly would bypass serialisation (F-08 §2.4).
	 */
	private async writeSettingsNow(): Promise<void> {
		await this.writeConfig({
			...this.settings,
			// Keep the Round-2 boolean mirror consistent with the Round-3 marker,
			// otherwise a rollback to the previous build would read a config whose
			// two markers disagree (F-07 #5, rollback compatibility).
			signingKeyInitialized: this.settings.signingKeyInitState === 'initialized'
		})
	}

	/**
	 * Resolve the signing key on load without ever creating or overwriting one
	 * silently (Round 2A.2.2 Review Fix Round 2, S1). A missing key fails
	 * closed; a malformed key is left in place so the export path keeps refusing.
	 * The `lost` / `unknown` states are surfaced with explicit warnings (S1 #6).
	 *
	 * Round 3 (F-07): the marker is read from the *stored* config, and a config
	 * that predates the marker is migrated — a valid key is proof that the vault
	 * was initialised, so the marker is written as `initialized`. The migration
	 * only ever writes the marker: the key itself is untouched, no key is
	 * generated, and a failed write is reported rather than assumed (F-07
	 * #3/#4/#5/#6/#7).
	 */
	async ensureSigningKey(): Promise<void> {
		// P1: the resolved result is committed to `this.settings` below and the
		// migration may adopt an external config. One lock covers both.
		await this.withKeyLock(async () => {
			const result = this.resolveCurrentKey()
			this.applyResolved(result)

			if (result.state === 'first-init') {
				console.warn(
					'[html-export-preview] 尚未生成清单签名密钥，导出将暂停，等待用户在设置中初始化'
				)
			} else if (result.state === 'corrupted') {
				console.warn(
					'[html-export-preview] 清单签名密钥格式非法，已停止自动覆盖，等待用户重新生成'
				)
			} else if (result.state === 'lost') {
				console.warn(
					'[html-export-preview] 检测到密钥曾初始化但当前缺失（lost）：等待用户在设置中严格确认后重新初始化'
				)
			} else if (result.state === 'unknown') {
				// R3.1-02 / Round 4: cite the real reason rather than a generic "unknown".
				console.warn(
					`[html-export-preview] 无法确认密钥历史状态（unknown，原因：${result.unknownReason ?? 'marker-missing'}）：等待用户严格确认后操作`
				)
			}

			await this.runInitMigration(result)
		})
	}

	/**
	 * Re-derive the key state from the *persisted* snapshot. Performs no I/O and
	 * — critically — no migration.
	 *
	 * Round 4 (F-07 #7): this is the only re-resolution a failed rotation is
	 * allowed to use. `ensureSigningKey()` also *writes* when it decides a
	 * migration is needed, so calling it from a failure path conflated two
	 * different faults ("the key could not be persisted" vs "the init marker is
	 * not on disk") and could issue a second write against a disk that had just
	 * rejected one.
	 */
	private resolveCurrentKey(): KeyLifecycleResult {
		const reading = readConfigMarker(this.rawConfig)
		// F-01: re-reading the raw value cannot recover *why* the probe refused
		// the file (a failed `exists()` and an unparsable file both read as
		// `undefined` here), so carry the probe's reason forward.
		if (!this.configShapeValid) {
			reading.shapeValid = false
			reading.writable = false
			if (this.configUnknownReason) reading.unknownReason = this.configUnknownReason
		}
		this.markerReading = reading
		return resolveKeyOnLoad(this.settings.signingKey, {
			initState: reading.marker,
			configPresent: this.configPresent,
			configShapeValid: reading.shapeValid,
			storedMarkerValid: reading.fieldValid,
			storedMarkerWritable: reading.writable,
			unknownReason: reading.unknownReason
		})
	}

	/** Adopt a resolved result in memory. Never writes. */
	private applyResolved(result: KeyLifecycleResult): void {
		this.mutateSettings(() => {
			this.settings.signingKey = result.key
			this.settings.signingKeyInitState = result.initState
			this.keyState = result.state
			// R3.1-02: a marker is only "persisted" when the *stored field was a valid
			// value and matches the resolved state*. A field whose raw value is an
			// illegal string — e.g. `"invalid"` — is normalised to `unknown` by the
			// resolver but must NOT be mistaken for a successfully written `unknown`;
			// `fieldValid` is false there, so `initStatePersisted` stays false and the
			// migration will correct it.
			this.initStatePersisted =
				this.markerReading.fieldValid && this.markerReading.marker === result.initState
			// R3-04: a previous migration failure is a fact about the *disk*, so it
			// may only be cleared once the stored marker actually agrees. Resetting it
			// unconditionally here would make the warning disappear after a re-resolve
			// that wrote nothing.
			if (this.initStatePersisted) this.migrationFailed = false
		})
	}

	/** Re-derive from disk without ever attempting a migration (Round 4). */
	private refreshKeyStateFromDisk(): void {
		this.applyResolved(this.resolveCurrentKey())
	}

	/**
	 * Persist the init marker for a legacy config (F-07 #2/#3).
	 *
	 * Deliberately narrow: it writes **only** the marker, never the key, and it
	 * never calls the generator. A failure leaves the in-memory key and state
	 * exactly as they were and is reported through `migrationFailed`, so the
	 * settings tab can say the marker is still missing instead of claiming the
	 * migration completed (F-07 #5).
	 *
	 * When no config file exists there is nothing to migrate yet: creating a
	 * `data.json` behind the user's back during `onload` would be a silent write
	 * to their vault. The desired marker is kept in memory and written by the
	 * first explicit save instead (F-09).
	 */
	private async runInitMigration(result: KeyLifecycleResult): Promise<void> {
		// P1: the only caller is ensureSigningKey(), which already owns keyLock.
		// Assert rather than acquire — acquiring here would deadlock the chain.
		this.assertKeyLockHeld()
		// Do not auto-write a broken config (R3.1-01): overwriting a structurally
		// anomalous `data.json` with a clean object would silently destroy the
		// user's original file. The user must recover it explicitly; key rotation
		// is the explicit path that is allowed to write.
		if (result.migration !== 'needed' || !this.configPresent || !this.configShapeValid) return
		try {
			// F-01 §3.2: the migration is an ordinary write too — re-probe inside
			// the queue so it cannot resurrect a config that changed meanwhile.
			//
			// Round 3.2.3 (F-01): when an external rewrite was adopted instead of
			// written, nothing was migrated by *this* call. Claiming otherwise in
			// the log would be the same kind of false success the marker logic is
			// careful to avoid.
			const outcome = await this.writeSettingsGuarded()
			if (outcome === 'adopted') return
			// `writeSettingsNow` → `writeConfig` → `commitPersisted` has already
			// refreshed rawConfig / configPresent / initStatePersisted and cleared
			// migrationFailed (R3-04/R3-05); nothing left to set here.
			console.info(
				'[html-export-preview] 已迁移旧配置：写入密钥初始化标记（密钥本身未改动）'
			)
		} catch (error) {
			this.initStatePersisted = false
			this.migrationFailed = true
			// F-02 (Round 3.2.3): one central, non-throwing conversion. The old
			// `error instanceof Error ? error.message : safeErrorText(error)` read
			// `.message` **after** trusting `instanceof`, which a `Proxy` can
			// satisfy while making the getter throw — the failure handler would
			// then crash instead of reporting. `describeErrorSafely` reads the
			// property defensively and redacts anything key-shaped.
			console.error(
				'[html-export-preview] 初始化标记迁移失败（未假装完成，密钥保持原值）：' +
					describeErrorSafely(error, [this.settings.signingKey])
			)
		}
	}

	/**
	 * Replace the key (user-initiated, settings tab only; the second confirmation
	 * lives in the Settings UI). S2 #1/#2: the new key is persisted FIRST; only
	 * after that succeeds do we update the in-memory key and the init flag. S2
	 * #3/#4: on a persistence failure the previously held key (even a corrupted
	 * one) is preserved and no success is reported (S2 #8).
	 */
	async rotateSigningKey(): Promise<KeyLifecycleResult> {
		// S2 #5: hold the key mutex for the whole rotation so an in-flight export
		// cannot read a key while we are replacing it. P1: use the same guarded
		// helper as every other key-mutating operation, so the release happens
		// in `finally` even when `rotateKey` throws.
		return this.withKeyLock(async () => {
			let result: KeyLifecycleResult
			try {
				result = await rotateKey(this.settings.signingKey, {
					// F-08 §2.3: the candidate key is persisted through the SAME queue as
					// every other setting, and the in-memory key is committed inside that
					// queued task — so a later queued save cannot resurrect the old key.
					save: (candidate, initialized) =>
						this.persistKey(candidate, initialized),
					initState: this.settings.signingKeyInitState,
					configPresent: this.configPresent
				})
			} catch (error) {
				// `rotateKey` handles its own save failures, so reaching here means a
				// defect. It must still never be reported as success, and it must not
				// start a migration: re-derive only.
				this.refreshKeyStateFromDisk()
				// F-02 (Round 3.2.3): same central conversion as everywhere else —
				// no `instanceof`-then-`.message`, no raw object in the log.
				console.error(
					'[html-export-preview] 密钥轮换异常（已脱敏）：' +
						describeErrorSafely(error, [this.settings.signingKey])
				)
				throw error
			}

			if (result.changed) {
				// S2 #2: only now adopt the new key in memory. `persistKey` already
				// committed the same values inside the queued task (so a later queued
				// write cannot resurrect the old key); this repeats it for the
				// reader's sake and stays harmless. `commitPersisted` has already
				// refreshed `rawConfig` and cleared `migrationFailed`.
				this.mutateSettings(() => {
					this.settings.signingKey = result.key
					this.settings.signingKeyInitialized = true
					this.settings.signingKeyInitState = 'initialized'
					this.keyState = 'ready'
				})
				// S2 #8: success gets an info log, never a failure one.
				console.info('[html-export-preview] 清单签名密钥已生成 / 替换')
			} else {
				// S2 #3/#4: preserve the original in-memory key (incl. corrupted).
				this.mutateSettings(() => {
					this.settings.signingKey = result.key
				})
				// Round 4 (F-07 #7): re-derive WITHOUT migrating. The old code called
				// `ensureSigningKey()` here, which re-read `rawConfig` and — on a
				// legacy config — re-ran the init-marker migration. That merged two
				// distinct faults into one and could write again to a disk that had
				// just refused the key. `migrationFailed` is deliberately untouched:
				// a key-write failure says nothing about the marker's history.
				this.refreshKeyStateFromDisk()
				// S2 #8: a failure must not be reported as success.
				console.warn('[html-export-preview] 密钥生成/替换失败：' + result.message)
			}
			return result
		})
	}

	/**
	 * Queue-internal write of a candidate key (F-08 §2.3).
	 *
	 * The candidate is written first; the in-memory settings are only mutated
	 * *inside the same queued task*, after `saveData` resolved. That is what makes
	 * the ordering guarantee independent of microtask scheduling: any queued write
	 * that runs later reads the already-committed key, so it cannot persist a
	 * stale one (the F-08 order-B regression).
	 */
	private async persistKey(candidate: string, initialized: boolean): Promise<void> {
		const marker: KeyInitState = initialized ? 'initialized' : 'uninitialized'
		await this.enqueueWrite(async () => {
			const payload: HtmlExportSettings = {
				...this.settings,
				signingKey: candidate,
				signingKeyInitialized: initialized,
				signingKeyInitState: marker
			}
			// `writeConfig` refreshes rawConfig/configPresent/initStatePersisted and
			// clears a stale migrationFailed (R3-04/R3-05).
			await this.writeConfig(payload)
			// Commit only after the write resolved (S2 #2). P1: this is the one
			// place that actually installs the new key in memory — it must be
			// covered by the caller's keyLock, never run bare.
			this.mutateSettings(() => {
				this.settings.signingKey = candidate
				this.settings.signingKeyInitialized = initialized
				this.settings.signingKeyInitState = marker
			})
		})
	}

	/** A stable snapshot of the current key for an export. */
	async snapshotSigningKey(): Promise<string> {
		const release = await this.enterKeyLock()
		const snap = this.settings.signingKey
		release()
		return snap
	}

	/**
	 * The key an export must sign with, read while the caller already holds the
	 * key mutex. Synchronous on purpose: `snapshotSigningKey()` would await the
	 * very lock the export already holds.
	 */
	private currentKeySnapshot(): string {
		return this.settings.signingKey
	}

	/** Status line for the Settings tab (S1 #6, F-07 #5, R3.1-02). */
	getKeyStatusLine(): KeyStatusLine {
		return describeKey(this.settings.signingKey, {
			initState: this.settings.signingKeyInitState,
			configPresent: this.configPresent,
			configShapeValid: this.configShapeValid,
			unknownReason: this.markerReading.unknownReason,
			migrationFailed: this.migrationFailed
		})
	}

	/**
	 * Acquire the key mutex; resolves when no rotation/export holds it.
	 *
	 * P1 (Round 3.2.4): the idempotent guard matters — a double release must
	 * not unblock a later task twice. Authorisation to *mutate* settings is a
	 * separate, stricter step taken only by `withKeyLock()` below; holding the
	 * chain (as an export does) is not by itself permission to write the key.
	 */
	private async enterKeyLock(): Promise<() => void> {
		let release!: () => void
		const next = new Promise<void>(r => {
			release = r
		})
		const prev = this.keyLock
		this.keyLock = next
		await prev
		let released = false
		return () => {
			if (released) return
			released = true
			release()
		}
	}

	/**
	 * Run `task` while owning the key mutex (P1).
	 *
	 * Lock order is *fixed*: callers take `keyLock` here and only then enter
	 * `settingsQueue`. Nothing inside the queue ever waits on `keyLock`, so the
	 * two locks can never be held in the opposite order.
	 *
	 * The `finally` is the point of requirement E: a rejected task must still
	 * release the mutex, or the next export would wait forever.
	 */
	private async withKeyLock<T>(task: () => Promise<T>): Promise<T> {
		const release = await this.enterKeyLock()
		// Open the one authorised mutation region. Nested `withKeyLock` calls
		// (none today) would simply increase the depth; the outermost `finally`
		// removes its own level, so the counter can never go stale.
		this.keyLockOwnerDepth++
		try {
			return await task()
		} finally {
			this.keyLockOwnerDepth--
			release()
		}
	}

	/** Fail closed if a mutation site is reached without the key mutex. */
	private assertKeyLockHeld(): void {
		if (this.keyLockOwnerDepth <= 0) {
			throw new Error(
				'KEY_LOCK_REQUIRED: 试图在 keyLock 之外改变内存签名密钥，已拒绝（锁序 keyLock → settingsQueue）'
			)
		}
	}

	/**
	 * The only gateway for writing `this.settings` (P1).
	 *
	 * Round 3.2.3 added an adoption path that replaced the whole settings object
	 * — including `signingKey` — without taking the key mutex. An export that
	 * already held the mutex could therefore sign one part of the manifest with
	 * the old key and read the new key from memory a moment later. Routing every
	 * mutation through here turns that class of bug into a loud failure instead
	 * of a silent race, without changing what any caller does when the lock is
	 * actually held.
	 */
	private mutateSettings<T>(change: () => T): T {
		this.assertKeyLockHeld()
		return change()
	}

	/** Absolute path of a vault-relative path, when the adapter can provide one. */
	private absolutePath(relative: string): string {
		// Task 3: an external export already reports an absolute path. Prefixing
		// the vault root onto it produced "D:/vault/D:/elsewhere/file.html" in the
		// failure notice.
		if (/^(?:[A-Za-z]:[\\/]|[\\/]{2})/.test(relative)) return relative.replace(/\\/g, '/')
		const adapter = this.app.vault.adapter as unknown as {
			getBasePath?: () => string
		}
		try {
			const base = adapter.getBasePath?.()
			if (base) return `${base}/${relative}`.replace(/\\/g, '/')
		} catch {
			// Fall through to the relative path: a truthful path is better than
			// a fabricated absolute one.
		}
		return relative
	}

	private async copyLastPath(): Promise<void> {
		if (!this.lastExportPath) {
			new Notice('还没有成功的导出记录。')
			return
		}
		try {
			await navigator.clipboard.writeText(this.lastExportPath)
			new Notice(`已复制导出路径：\n${this.lastExportPath}`, 8000)
		} catch (error) {
			// F-02 (Round 3.2.3): a clipboard failure is a plain user-facing
			// message, but it is still an arbitrary thrown value.
			const message = describeErrorSafely(error, [this.settings.signingKey])
			new Notice(`复制失败：${message}\n路径：${this.lastExportPath}`, 12000)
		}
	}

	/**
	 * P2 entry point — open the editor; capture only when there is nothing to
	 * show yet.
	 *
	 * `refresh: true` forces a fresh capture even with a live session (the
	 * "重新抓取并打开" command). Without it, an already-open editor is simply
	 * revealed: re-capturing a note the user is looking at would throw away the
	 * layout they just set.
	 */
	private async openPreviewEditor(
		kind?: ExportKind,
		options: { refresh?: boolean } = {}
	): Promise<void> {
		if (this.running) {
			new Notice('HTML 导出正在进行中，请等待当前任务结束。', 4000)
			return
		}
		this.previewKind = kind ?? this.previewKind

		if (this.session && !options.refresh) {
			const existing = await this.ensurePreviewView()
			if (existing) {
				existing.setPreferredKind(this.previewKind)
				this.app.workspace.revealLeaf(existing.leaf)
				return
			}
		}

		this.running = true
		let notice: Notice | null = null
		try {
			notice = new Notice('正在抓取阅读视图…', 0)
			// Capture first, while the note is still the active leaf — that is
			// the state the capture pipeline was verified in. The tab (and any
			// stale dock copy) is created afterwards, and the new session is
			// assigned only once that is done: closing a stale leaf runs its
			// teardown, which releases the session it belonged to.
			const session = await this.captureSession()
			const view = await this.ensurePreviewView()
			this.session = session
			this.deliverPreview(view, session, this.previewLayout)
		} catch (error) {
			this.reportFailure(error)
		} finally {
			notice?.hide()
			this.running = false
		}
	}

	/* ------------------------------------------------------------- capture -- */

	/**
	 * Capture + stylesheet + runtime audit, once.
	 *
	 * Both output pipelines read this one object, so the page the user approved
	 * in the preview is built from exactly the DOM the export will use.
	 */
	private async captureSession(): Promise<PreviewSession> {
		const snapshot = await this.captureNote()
		// Remembered so a later run can find the note again even if the editor
		// tab took the active leaf in the meantime.
		this.lastNotePath = snapshot.notePath
		const css = await collectCss(this.app)
		const audit = await buildRuntimeAudit(this.app, snapshot)
		return {
			snapshot,
			css,
			audit,
			rootDataAllow: referencedDataAttributes(css.chunks)
		}
	}

	/**
	 * Capture the note **whatever mode its view is in**.
	 *
	 * `captureReadingView` needs a mounted reading view, and demanding that the
	 * user switch modes first was a papercut worth removing. In editing (source
	 * / live preview) mode the leaf is switched to reading mode for the
	 * duration of the capture and put back afterwards — in `finally`, so a
	 * failed capture cannot leave the note in the wrong mode.
	 */
	private async captureNote(): Promise<CaptureSnapshot> {
		const view = this.resolveNoteView()
		if (!view) {
			throw new CaptureError('没有活动的 Markdown 视图。请先打开一篇笔记。', 'no-view')
		}
		// A tab that is not the visible one keeps an **unpainted** reading view
		// (mounted sizer, 0 blocks). Revealing it is what makes Obsidian
		// actually render the note, and it is the user's own note either way.
		if (this.app.workspace.getActiveViewOfType(MarkdownView) !== view) {
			try {
				this.app.workspace.revealLeaf(view.leaf)
			} catch {
				// A leaf that cannot be revealed is still worth capturing.
			}
		}
		if (view.getMode() === 'preview') {
			await this.settleReadingView(view)
			return captureReadingView(this.app, view)
		}
		return this.captureFromEditMode(view)
	}

	/**
	 * Give a reading view a moment to actually render.
	 *
	 * `.markdown-preview-sizer` is created before its content is — and right
	 * after a mode switch it holds a placeholder with *some* text but **zero
	 * content blocks** (measured 574×353, 0 blocks, 0 characters of body), which
	 * made `assertResolved` report “正文为空” for a note that was fine.
	 * After the budget we proceed anyway, so a genuinely empty note still
	 * reaches capture and is reported as empty instead of as a hang.
	 */
	private async settleReadingView(view: MarkdownView, budgetMs = 6000): Promise<void> {
		const deadline = Date.now() + budgetMs
		for (;;) {
			const sizer = readingSizerOf(view)
			if (sizer && readingViewHasContent(sizer)) return
			if (Date.now() > deadline) return
			await new Promise<void>(resolve => window.setTimeout(resolve, 50))
		}
	}

	private async captureFromEditMode(view: MarkdownView): Promise<CaptureSnapshot> {
		const path = view.file?.path
		if (!path) throw new CaptureError('当前视图没有关联文件。', 'no-view')
		const leaf = view.leaf
		const previous = view.getState()

		try {
			// A **hidden or collapsed** leaf can be switched to reading mode
			// without Obsidian ever painting it: the sizer mounts empty
			// (measured: 0 blocks, 0 characters, 574×353) and the capture then
			// reports an empty body. Revealing the leaf is what makes the
			// content actually render; it stays the user's own note either way.
			try {
				this.app.workspace.revealLeaf(leaf)
			} catch {
				// A leaf that cannot be revealed is still worth capturing.
			}
			await leaf.setViewState({
				type: 'markdown',
				state: { ...previous, mode: 'preview' }
			})
			const reading = await this.waitForReadingView(path)
			if (!reading) {
				throw new CaptureError(
					'切换到阅读视图超时，未执行抓取（笔记仍是你的原始模式）。',
					'not-reading'
				)
			}
			return await captureReadingView(this.app, reading)
		} finally {
			try {
				await leaf.setViewState({ type: 'markdown', state: previous })
			} catch {
				// Putting the mode back must never mask the capture result.
			}
		}
	}

	/**
	 * Poll until the note's leaf is in reading mode **with content rendered**.
	 *
	 * The sizer existing is not readiness; content blocks are. A note that is
	 * genuinely empty is handed back at the deadline so capture can say “正文为空”.
	 */
	private async waitForReadingView(path: string): Promise<MarkdownView | null> {
		const deadline = Date.now() + 6000
		for (;;) {
			const view = this.app.workspace
				.getLeavesOfType('markdown')
				.filter(leaf => this.isMainAreaLeaf(leaf))
				.map(leaf => leaf.view)
				.find(
					(candidate): candidate is MarkdownView =>
						candidate instanceof MarkdownView && candidate.file?.path === path
				)
			const sizer = view ? readingSizerOf(view) : null
			if (view && view.getMode() === 'preview' && sizer) {
				if (readingViewHasContent(sizer) || Date.now() > deadline) return view
			}
			if (Date.now() > deadline + 2000) return view ?? null
			await new Promise<void>(resolve => window.setTimeout(resolve, 50))
		}
	}

	/* -------------------------------------------------------------- preview -- */

	private buildPreviewHtml(
		session: PreviewSession,
		layout: ExportLayoutOptions
	): string {
		// Preview keeps `app://` URLs — they resolve inside Obsidian — so the
		// CSS is rendered without an asset collector, and no placeholder exists
		// for a URL parser to trip over.
		return buildHtml(session.snapshot, {
			mode: 'preview',
			cssText: renderCss(session.css),
			layout,
			rootDataAllow: session.rootDataAllow
		})
	}

	/**
	 * Hand a finished document to the view.
	 *
	 * The `%HE-INLINE-` check is defence in depth, not a feature: those markers
	 * only exist in the share pipeline, and one of them reaching a rendered
	 * document is what used to produce `app://obsidian.md/%HE-INLINE-0%` and an
	 * uncaught `URIError` in the main process.
	 */
	private deliverPreview(
		view: PreviewView | null,
		session: PreviewSession,
		layout: ExportLayoutOptions
	): void {
		if (!view) return
		const html = this.buildPreviewHtml(session, layout)
		if (html.includes('%HE-INLINE-')) {
			throw new Error(
				'预览内容里残留了内部资源占位符，已中止（这不是可以打开的页面）。'
			)
		}
		const snapshot = session.snapshot
		view.setPreferredKind(this.previewKind)
		view.setDocument({
			html,
			tabTitle: `${snapshot.noteTitle} · ${snapshot.captureWidth}px`,
			noteTitle: snapshot.noteTitle,
			notePath: snapshot.notePath
		})
	}

	/* ---------------------------------------------------- PreviewViewHost -- */

	/** Live layout CSS for the already-loaded preview document. */
	liveCss(layout: ExportLayoutOptions): string {
		const session = this.session
		const room = session?.snapshot.sidenotes?.room ?? 0
		const frameWidth = (session?.snapshot.captureWidth ?? 0) + room
		return responsiveCss(layout, {
			frameWidth,
			room,
			theme: session ? themeOf(session.snapshot.root.className) : 'unknown'
		})
	}

	/** Re-capture and re-render, keeping the layout the user already chose. */
	async refresh(): Promise<void> {
		if (this.running) {
			new Notice('HTML 导出正在进行中，请等待当前任务结束。', 3000)
			return
		}
		this.running = true
		const view = this.currentPreviewView()
		// 刷新按钮在预览面板里，所以按下它的那一刻活动叶子就是预览页。但
		// `captureNote()` 为了让未显示的阅读视图真正绘制，会 `revealLeaf` 笔记
		// 所在叶子；当预览与笔记同属一个标签组时，这一步会把标签组切到笔记，
		// 于是刚生成的新页面在隐藏状态下被塞进 iframe（实测宽度 0），用户按下
		// 刷新反而离开了自己正在调整的预览面板。记住来时的叶子，抓取结束后放
		// 回去。
		const returnLeaf = this.app.workspace.activeLeaf
		let notice: Notice | null = null
		try {
			notice = new Notice('正在重新抓取阅读视图…', 0)
			let session: PreviewSession
			try {
				session = await this.captureSession()
			} finally {
				// 在把新文档交给 iframe *之前* 回到原标签：隐藏的 iframe 照样解析
				// `srcdoc`，但按 0 宽度排版，首帧就会是错的。抓取失败时这一句同样
				// 执行，错误提示才会出现在用户原本看着的面板旁边。
				this.restoreLeaf(returnLeaf)
			}
			this.session = session
			// The *view* owns the layout; a refresh must not reset it.
			const layout = view?.getLayout() ?? this.previewLayout
			this.previewLayout = normalizeLayout(layout)
			this.deliverPreview(view, session, this.previewLayout)
		} catch (error) {
			this.reportFailure(error)
		} finally {
			notice?.hide()
			this.running = false
		}
	}

	/**
	 * 把抓取过程中被迫切走的标签放回来。
	 *
	 * 只恢复仍然挂在界面上的叶子：抓取期间被关掉的标签不能复活，否则会凭空
	 * 弹出一个空面板。失败只影响观感，不能让一次成功的刷新报错。
	 */
	private restoreLeaf(leaf: WorkspaceLeaf | null): void {
		if (!leaf) return
		const container = leaf.view?.containerEl
		if (!container || !container.isConnected) return
		try {
			void this.app.workspace.revealLeaf(leaf)
		} catch {
			// 恢复焦点是外观行为，失败不应影响这次刷新已经拿到的结果。
		}
	}

	/**
	 * The only place that writes files, and only from the confirm button.
	 *
	 * The two formats share the session and the layout but keep their own
	 * packaging rules: the package path signs a manifest with this vault's key
	 * and writes a directory; the share path embeds everything into one file and
	 * never receives a key. Neither is produced unless it was asked for.
	 */
	async exportNow(
		kind: ExportKind,
		layout: ExportLayoutOptions,
		/**
		 * User-chosen, Vault-relative export folder for *this* export only. Never
		 * persisted to `data.json` (Task 2): the global `outputFolder` stays put.
		 * `null`/empty falls back to the configured folder. Validation refuses any
		 * path that would leave the Vault.
		 */
		location?: string | null,
		/**
		 * Task 3: write outside the Vault instead.
		 *
		 * Only ever produced by the system dialog; the path is validated again
		 * here (absolute, no `..`, no symlink/junction ancestor, not the plugin
		 * install directory, not `.obsidian`) because the view is not the
		 * security boundary. `null` keeps the vault-internal behaviour.
		 */
		external?: ExternalRequest | null
	): Promise<void> {
		if (this.running) {
			new Notice('已有导出任务在进行中，请等待当前任务结束。', 3000)
			return
		}
		const session = this.session
		if (!session) {
			new Notice('预览数据已释放，请重新打开预览后再导出。', 6000)
			return
		}
		// Resolve and validate the user's location *before* any file is touched.
		let explicitDir: string | null = null
		if (!external && location && location.trim()) {
			try {
				// Same rule the preview editor used, re-applied at the one point
				// that actually writes — the view is never the security boundary.
				explicitDir = assertVaultRelativeLocation(location.trim())
			} catch {
				new Notice(
					'导出位置不安全：必须为当前 Vault 内的相对路径（不能包含驱动器号、绝对路径或 “..”）。本次没有写入任何文件。',
					6000
				)
				return
			}
		}

		let destination: ExternalDestination | null = null
		if (external) {
			const host = this.externalHost()
			if (!host) {
				new Notice(
					hostCapabilities().reason ??
						'当前运行环境无法访问电脑上的文件夹，只能在 Vault 内导出。',
					6000
				)
				return
			}
			try {
				const target = await resolveExternalTarget(host, external.path, external.kind)
				destination = {
					host,
					target,
					adapter: createExternalAdapter(host, target.base)
				}
			} catch (error) {
				this.reportFailure(error)
				return
			}
		}

		this.running = true
		const view = this.currentPreviewView()
		view?.setBusy(true)
		try {
			this.previewLayout = normalizeLayout(layout)
			this.previewKind = kind
			if (kind === 'share') await this.exportShare(session, explicitDir, destination)
			else await this.exportPackage(session, explicitDir, destination)
		} catch (error) {
			this.reportFailure(error)
		} finally {
			view?.setBusy(false)
			this.running = false
		}
	}

	/** Default safe output folder, shown as the starting point for Task 2's picker. */
	defaultExportFolder(): string {
		return this.settings.outputFolder
	}

	/**
	 * Open the OS file manager at an already-finished export.
	 *
	 * Public so a UI harness can observe/replace the call without opening a real
	 * Explorer window. It never throws and never opens a browser: Electron's
	 * `shell.showItemInFolder` only reveals the item. A `false` result is a
	 * degraded convenience, not a failed export — callers only log it.
	 */
	showInFolder(fullPath: string): boolean {
		try {
			return revealInFolder(fullPath)
		} catch {
			return false
		}
	}

	/**
	 * The *only* place that may reveal an export.
	 *
	 * Both callers are success reporters reached after `writeShareFile()` /
	 * `writeExport()` returned with their SHA-256 and integrity checks already
	 * passed. Opening the preview, cancelling, or throwing anywhere in the
	 * pipeline never reaches this method. Failures here are swallowed: a
	 * successful export must not be reported as a failure just because the file
	 * manager could not be launched.
	 */
	private revealExported(absolute: string, kind: ExportKind): void {
		if (!showInFolderEnabled(this.settings)) return
		if (!absolute) return
		const target =
			kind === 'share' ? absolute : `${absolute.replace(/[\\/]+$/, '')}/index.html`
		let shown = false
		try {
			shown = this.showInFolder(target)
		} catch {
			shown = false
		}
		if (!shown) {
			console.info(
				'[html-export-preview] 导出文件已写入，但当前环境未能打开文件资源管理器（不影响导出结果）'
			)
		}
	}

	/* ------------------------------------------------- Task 3: 外部目录 -- */

	/**
	 * Build the desktop host, or null when this runtime cannot write outside
	 * the Vault. Cached per call rather than stored: the vault can be relocated
	 * and the answer is cheap, and a stored one would outlive a rename.
	 */
	private externalHost(): ExternalHost | null {
		const adapter = this.app.vault.adapter as unknown as {
			getBasePath?: () => string
		}
		let vaultBase = ''
		try {
			vaultBase = String(adapter.getBasePath?.() ?? '')
		} catch {
			vaultBase = ''
		}
		if (!vaultBase) return null
		const { host } = createExternalHost({
			vaultBase,
			pluginDirRelative: this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`,
			configDirRelative: this.app.vault.configDir
		})
		return host
	}

	/** What the preview footer needs to know before offering the option. */
	externalSupport(): { available: boolean; reason: string | null } {
		const caps = hostCapabilities()
		if (!caps.desktop) return { available: false, reason: caps.reason }
		if (!this.externalHost()) {
			return {
				available: false,
				reason: '当前 Vault 没有可供外部写入的磁盘路径，只能在 Vault 内导出。'
			}
		}
		return { available: true, reason: null }
	}

	/**
	 * Open the system dialog for this export kind.
	 *
	 * 单文件 → "另存为"（用户可改文件名和文件夹）；完整资源包 → 选文件夹，
	 * 插件在其中新建专用子目录。取消返回 `null`，调用方保持原选择不变，并且
	 * 一个字节都不会写。
	 */
	async pickExternalTarget(
		kind: ExportKind,
		current: ExternalRequest | null
	): Promise<ExternalRequest | null> {
		const host = this.externalHost()
		if (!host) {
			new Notice(
				this.externalSupport().reason ?? '当前运行环境无法访问电脑上的文件夹。',
				6000
			)
			return null
		}
		const title = this.session?.snapshot.noteTitle ?? 'note'
		const lastFolder =
			current && current.path ? host.path.dirname(current.path) : host.vaultBase
		try {
			if (kind === 'share') {
				const chosen = await host.savePath({
					title: '选择单文件 HTML 的保存位置',
					defaultPath:
						current && current.kind === 'file' ? lastFolder : host.vaultBase,
					defaultName: `${safeFolderName(title)}.html`
				})
				if (!chosen) return null
				return { kind: 'file', path: chosen }
			}
			const chosen = await host.pickFolder({
				title: '选择完整资源包的目标文件夹（插件会在其中新建专用子目录）',
				defaultPath:
					current && current.kind === 'folder' ? current.path : host.vaultBase
			})
			if (!chosen) return null
			return { kind: 'folder', path: chosen }
		} catch (error) {
			this.reportFailure(error)
			return null
		}
	}

	/** One line in the editor footer: what pressing 确认导出 will write. */
	targetHint(
		kind: ExportKind,
		location?: string | null,
		external?: ExternalRequest | null
	): string {
		const title = this.session?.snapshot.noteTitle ?? '笔记名'
		if (external && external.path) {
			return kind === 'share'
				? `${external.path}（单文件，用这个文件名；同名文件不会被覆盖）`
				: `${external.path} / ${title}-<标识> / index.html + assets/（含签名清单，用于归档）`
		}
		const folder = location && location.trim() ? location.trim() : this.settings.outputFolder
		return kind === 'share'
			? `${folder} / ${title}-share / ${title}-<标识>.html（单文件，可直接发送）`
			: `${folder} / ${title}-<标识> / index.html + assets/（含签名清单，用于归档）`
	}

	/** Closing the tab drops the snapshot, the CSS and the audit. */
	releaseSession(): void {
		this.session = null
	}

	/* ------------------------------------------------------------- output -- */

	private async exportPackage(
		session: PreviewSession,
		explicitDir?: string | null,
		destination?: ExternalDestination | null
	): Promise<void> {
		// S2 #5: hold the key mutex so a concurrent rotation cannot replace the
		// key between reading it and signing the manifest.
		const releaseKey = await this.enterKeyLock()
		try {
			// Order is load-bearing: the HTML pass and the CSS pass both register
			// assets on the same collector, and nothing is copied to disk until
			// `writeExport` flushes it.
			const assets = new AssetCollector(this.app)
			const exportHtml = buildHtml(session.snapshot, {
				mode: 'export',
				cssText: '',
				assets,
				layout: this.previewLayout,
				rootDataAllow: session.rootDataAllow
			})
			const exportCss = renderCss(session.css, { assets, prefix: 'media/' })
			const visibility = auditCssVisibility(exportCss)
			const signingKey = this.currentKeySnapshot()

			const report = await writeExport(
				this.app,
				session.snapshot,
				exportHtml,
				exportCss,
				assets,
				// An external destination is rooted at the folder the user picked,
				// so the export root is that folder itself and the note's own
				// `slug-suffix` directory is created inside it.
				destination ? '' : this.settings.outputFolder,
				{
					css: {
						bytes: exportCss.length,
						sheets: session.css.sheets,
						warnings: session.css.warnings,
						theme: session.css.theme,
						bodyStyle: session.snapshot.root.bodyStyle
					},
					pluginVersion: this.manifest.version,
					audit: { ...session.audit, visibility },
					visibility
				},
				signingKey,
				destination ? null : explicitDir,
				destination?.adapter
			)

			this.reportSuccess(
				report,
				session.snapshot.stats.math,
				session.css.warnings.length,
				session.css.fontsInlined.length,
				destination
					? destination.host.path.join(destination.target.base, report.dir)
					: undefined
			)
		} finally {
			releaseKey()
		}
	}

	/**
	 * Single-file export with the P2 使用反馈 #3 conflict flow.
	 *
	 * The share publisher is strictly create-only: when the *exact* name the user
	 * picked already exists it refuses (never overwrites). That refusal is turned
	 * here into a modal offering 替换现有文件 / 另存为 / 取消. Only an explicit
	 * 替换 click produces a `ShareReplacePlan`, and only the adapter's dedicated
	 * `replaceVerified` consumes it — the safe-swap path that re-checks the old
	 * file's SHA-256, keeps an exclusive backup, and restores it on failure.
	 *
	 * The modal's focused (safe) button is 取消, so Esc / Enter never replaces.
	 * Vault-internal shares never reach this: they use numbered names and cannot
	 * collide, so `destination` being null keeps `allowReplace` false too.
	 */
	private async exportShare(
		session: PreviewSession,
		explicitDir?: string | null,
		destination?: ExternalDestination | null
	): Promise<void> {
		const built = await buildSingleFile(this.app, session.snapshot, session.css, {
			layout: this.previewLayout,
			rootDataAllow: session.rootDataAllow
		})

		// `destination` is re-derived when the user picks 另存为.
		let chosen: ExternalDestination | null = destination ?? null

		for (;;) {
			const exactName = chosen ? chosen.target.relative : null
			try {
				const result = await writeShareFile(
					this.app,
					built.html,
					chosen ? '' : this.settings.outputFolder,
					session.snapshot.noteTitle,
					session.snapshot.notePath,
					200,
					chosen ? null : explicitDir,
					chosen?.adapter,
					exactName,
					null
				)
				this.reportShareSuccess(
					result,
					built.stats,
					session.snapshot.stats.math,
					chosen
						? chosen.host.path.join(chosen.target.base, result.path)
						: undefined
				)
				return
			} catch (error) {
				if (!this.isShareConflict(error)) throw error

				const conflict = error as ShareWriteError
				const target = conflict.leftover ?? ''
				const allowReplace =
					!!chosen && typeof (chosen.adapter as { replaceVerified?: unknown }).replaceVerified === 'function'

				const choice = await askExportConflict(this.app, {
					title: '导出目标已存在',
					heading: '已存在同名文件',
					detail:
						'该位置已经有一个同名文件。可以选择替换它、换个名字另存，' +
						'或取消本次导出（原文件保持不变）。默认不会覆盖。',
					target,
					allowReplace,
					ownership: allowReplace
						? '替换会先为旧文件创建一份独占备份，再原子替换；若导出后的文件校验失败会自动恢复旧文件。'
						: '当前写入方式无法安全替换已有文件，请选择「另存为」换一个文件名。',
					saveAsLabel: '另存为…'
				})

				if (choice === 'cancel') {
					// Nothing written or changed; the old file is untouched.
					return
				}
				if (choice === 'save-as') {
					const current: ExternalRequest | null = chosen
						? { kind: 'file', path: chosen.target.absolute }
						: null
					const repick = await this.pickExternalTarget('share', current)
					if (!repick || repick.kind !== 'file') return
					const host = this.externalHost()
					if (!host) {
						new Notice('当前运行环境无法访问电脑上的文件夹，未写入任何文件。', 6000)
						return
					}
					let resolved: ExternalTarget
					try {
						resolved = await resolveExternalTarget(host, repick.path, 'file')
					} catch (err) {
						this.reportFailure(err)
						return
					}
					chosen = {
						host,
						target: resolved,
						adapter: createExternalAdapter(host, resolved.base)
					}
					continue
				}
				// choice === 'replace'
				const plan = await this.makeReplacePlan(chosen, target)
				try {
					const result = await writeShareFile(
						this.app,
						built.html,
						chosen ? '' : this.settings.outputFolder,
						session.snapshot.noteTitle,
						session.snapshot.notePath,
						200,
						chosen ? null : explicitDir,
						chosen?.adapter,
						exactName,
						plan
					)
					this.reportShareSuccess(
						result,
						built.stats,
						session.snapshot.stats.math,
						chosen
							? chosen.host.path.join(chosen.target.base, result.path)
							: undefined
					)
					return
				} catch (replaceError) {
					if (this.isShareConflict(replaceError)) {
						// TARGET_CHANGED / REPLACE_UNSUPPORTED: surface again so the
						// user can re-confirm or pick 另存为. Anything else falls
						// through to the outer handler below.
						continue
					}
					throw replaceError
				}
			}
		}
	}

	/**
	 * Fingerprint the existing target so `replaceVerified` can prove nothing
	 * changed between the user's confirmation and the actual swap.
	 *
	 * Reads the file the publisher will replace (the same relative path the
	 * adapter resolves), never trusts the modal's string beyond showing it.
	 */
	private async makeReplacePlan(
		destination: ExternalDestination | null,
		target: string
	): Promise<ShareReplacePlan> {
		if (!destination) {
			throw new ShareWriteError(
				'Vault 内分享暂不支持替换已有文件，请选择「另存为」。',
				'发布',
				target,
				'REPLACE_UNSUPPORTED'
			)
		}
		const name = destination.target.relative
		const data = await destination.adapter.readBinary(name)
		const bytes = new Uint8Array(data)
		return { bytes: bytes.byteLength, sha256: await sha256Hex(bytes) }
	}

	/** A refusal that should become the conflict modal rather than a hard failure. */
	private isShareConflict(error: unknown): boolean {
		return (
			this.isKindOf(error, ShareWriteError) &&
			['TARGET_EXISTS', 'REPLACE_UNSUPPORTED', 'TARGET_CHANGED'].includes(
				(error as ShareWriteError).code ?? ''
			)
		)
	}

	/**
	 * Report a share file. Deliberately separate from `reportSuccess()`: that
	 * one talks about manifests, media written to disk and verified stages, none
	 * of which exist here. Honesty about what still needs the network matters
	 * more than a reassuring "complete".
	 */
	private reportShareSuccess(
		result: ShareWriteResult,
		stats: ShareStats,
		mathNodes: number,
		/** Task 3: the file already has an absolute path outside the Vault. */
		absoluteOverride?: string
	): void {
		const absolute = absoluteOverride ?? this.absolutePath(result.path)
		this.lastExportPath = absolute

		const lines: string[] = []
		const incomplete = stats.missingContent > 0
		lines.push(incomplete ? '单文件分享已写入，但有资源未能内嵌' : '单文件分享完成（已校验 SHA-256）')
		lines.push(absolute)
		lines.push(
			`${formatBytes(stats.htmlBytes)} · 媒体 ${stats.mediaEmbedded} 个已内嵌` +
				(stats.inlineFonts > 0 ? ` · 字体 ${stats.inlineFonts} 个已内嵌` : '') +
				` · 校验 ${result.sha256.slice(0, 12)}…`
		)
		if (result.renamed) {
			lines.push('同名文件已存在，本次写入新文件名（未覆盖任何旧文件）')
		}
		if (result.replaced) {
			lines.push('已替换同名文件（替换前已为旧文件创建备份，校验通过后才生效）')
		}
		if (result.leftoverTemp) {
			lines.push(`提示：临时目录未能删除，可手动移除：${result.leftoverTemp}`)
		}
		const privacy = stats.privacy
		if (privacy.internalLinks > 0) {
			lines.push(
				`${privacy.internalLinks} 个 Vault 内部链接已改为不可点击（保留文字），分享文件中不再包含笔记路径`
			)
		}
		if (privacy.scripts + privacy.handlers + privacy.base > 0) {
			lines.push(
				`已移除可执行内容：脚本 ${privacy.scripts} 个 · 事件属性 ${privacy.handlers} 个 · base ${privacy.base} 个`
			)
		}
		if (stats.remoteEnvironment > 0 || stats.remoteImports.length > 0) {
			lines.push(
				`主题样式中有 ${stats.remoteEnvironment + stats.remoteImports.length} 个远程资源未内嵌，已置空（不影响正文）`
			)
		}
		if (privacy.dynamic.length > 0) {
			const tags = Array.from(new Set(privacy.dynamic.map(item => item.tag))).join('、')
			lines.push(`注意：笔记含 ${privacy.dynamic.length} 处动态内容（${tags}），静态文件中可能显示为空白`)
		}
		if (stats.placeholders > 0) {
			lines.push(
				`提示：${stats.placeholders} 处主题字体在导出环境中不可得，已留空占位（不影响正文）`
			)
		}
		if (mathNodes > 0 && stats.inlineFonts === 0) {
			lines.push(`注意：本笔记含 ${mathNodes} 处公式，但字体未能内联，字形将回退`)
		}
		new Notice(lines.join('\n'), incomplete ? 0 : 15000)
		// Only a verified publish reaches this reporter. `showItemInFolder`
		// failures are contained inside `revealExported()`.
		this.revealExported(absolute, 'share')
		console.error('[html-export-preview] share report', {
			path: result.path,
			sha256: result.sha256,
			stats: {
				...stats,
				embedded: stats.embedded.length,
				audit: {
					display: stats.audit.display.length,
					localState: stats.audit.localState.length,
					executable: stats.audit.executable.length
				}
			}
		})
	}

	/**
	 * Single source of layout options for every `buildHtml` call.
	 *
	 * P2: the preview editor is the only writer. It is deliberately **not**
	 * persisted to `data.json`: that file has a strict key set which the
	 * upgrade/rollback tooling checks byte for byte, and a layout that changes
	 * the exported document belongs with the document, not with the vault's
	 * settings. The value lives as long as the session does.
	 */
	private layoutOptions(): ExportLayoutOptions {
		return { ...this.previewLayout }
	}


	/** The only place allowed to say "完成", and only for a verified export. */
	private reportSuccess(
		report: ExportReport,
		mathNodes: number,
		cssWarnings: number,
		inlinedFonts = 0,
		/** Task 3: the directory already has an absolute path outside the Vault. */
		absoluteOverride?: string
	): void {
		const absolute = absoluteOverride ?? this.absolutePath(report.dir)
		this.lastExportPath = absolute

		const stats = report.assets
		const lines: string[] = []

		// `contentMissing` already includes copy failures (review C1), so adding
		// `contentFailed` here would report one lost image as two.
		const blankRisk = report.visibility?.blankRisk ?? false
		const headline =
			report.status !== 'ok'
				? `HTML 导出不完整：${stats.contentMissing} 个必要资源未写入`
				: blankRisk
					? 'HTML 导出：文件已写入，但检测到 CSS 可能隐藏正文（空白风险）'
					: 'HTML 导出完成'
		lines.push(headline)
		lines.push(absolute)

		lines.push(
			`媒体 ${stats.written}/${stats.entries.length} 个已写入 · 事务提交`
		)

		if (stats.missing.length > 0) {
			lines.push(`缺失资源 ${stats.missing.length} 个（详见 export-manifest.json）`)
		}
		if (report.status !== 'ok') {
			lines.push('产物不完整：修复缺失资源后重新导出即可覆盖本次结果')
		}
		if (stats.external.length > 0) {
			lines.push(
				`跳过应用内置资源 ${stats.external.length} 个（不属于知识库，未打包）`
			)
		}
		if (inlinedFonts > 0) {
			lines.push(`应用内置字体 ${inlinedFonts} 个已内联到导出 CSS（公式离线可用）`)
		}
		if (mathNodes > 0) {
			const mathFonts = stats.external.filter(e =>
				e.ref.toLowerCase().includes('mathjax')
			).length
			if (mathFonts > 0) {
				lines.push(
					`注意：本笔记含 ${mathNodes} 处公式，MathJax 字体未随导出打包，字形将回退`
				)
			}
		}
		if (cssWarnings > 0) {
			lines.push(`CSS 警告 ${cssWarnings} 条（详见 export-manifest.json）`)
		}
		if (blankRisk && report.visibility) {
			lines.push('CSS 可见性风险（正文可能被隐藏，建议浏览器打开确认）：')
			for (const w of report.visibility.warnings.slice(0, 5)) {
				lines.push(`  · ${w.selector} { ${w.property}: ${w.value} }`)
			}
			if (report.visibility.warnings.length > 5) {
				lines.push(`  · 其余 ${report.visibility.warnings.length - 5} 条见 runtime-audit.json`)
			}
		}
		const skipped = report.verified.checks.filter(c => c.skipped).length
		if (skipped > 0) {
			lines.push(
				`校验有 ${skipped} 项因适配器能力不足未执行（不计为通过，详见控制台）`
			)
		}

		// Round 2A.1 (F-01): the old export is only deleted when it can be
		// proven safe to delete. When it cannot, say where it is instead of
		// quietly leaving a directory the user will find later.
		if (report.leftoverBackup) {
			lines.push(
				`上一次导出已移动到备份目录：${this.absolutePath(
					report.leftoverBackup
				)}（旧版默认保留，确认无需后可手动删除）`
			)
		}

		const issue = inspectOutputFolder(this.settings.outputFolder)
		if (issue && issue.kind === 'typo') {
			lines.push('提示：导出目录包含拼写错误 pluagins，设置里可一键改为推荐目录')
		}

		new Notice(
			lines.join('\n'),
			report.status === 'ok' && !blankRisk ? 15000 : 0
		)
		// A partial export (missing assets / failed verification) is NOT a
		// completed, integrity-checked artefact, so it must not open Explorer.
		if (report.status === 'ok' && report.verified.ok) {
			this.revealExported(absolute, 'package')
		}
		console.error('[html-export-preview] export report', report.verified.checks)
	}

	/**
	 * `instanceof`, but an exception cannot escape it (F-02, Round 3.2.3).
	 *
	 * `instanceof` is not a pure function: it consults the right operand's
	 * `Symbol.hasInstance` and walks the left operand's prototype chain through
	 * its own traps, so a revoked or hostile `Proxy` can throw from the check
	 * itself — before any property is even read. In a failure handler that would
	 * replace the real error with a second, unrelated one.
	 */
	private isKindOf(
		error: unknown,
		ctor:
			| typeof CaptureError
			| typeof ExportError
			| typeof ShareRefusedError
			| typeof ShareWriteError
	): boolean {
		try {
			return error instanceof ctor
		} catch {
			return false
		}
	}

	/** Read one property without letting a getter / `Proxy` trap abort the caller. */
	private readField(source: unknown, key: string): unknown {
		if (source == null) return undefined
		try {
			return (source as Record<string, unknown>)[key]
		} catch {
			return undefined
		}
	}

	/**
	 * An error metadata field is NOT safe just because it happens to be a string
	 * (P2, Round 3.2.4).
	 *
	 * `ExportError.stage` and `.tmpDir` are produced by our own writer today, but
	 * `reportFailure()` accepts *any* thrown value: a loader, another plugin or a
	 * hostile `Proxy` can pass `instanceof ExportError` while those fields carry
	 * the signing key, control characters that forge extra Notice lines, or a
	 * getter that throws. Round 3.2.3 guarded the *reads* but still interpolated
	 * the results verbatim — a full key in `tmpDir` went straight into a Notice.
	 *
	 * Four gates before a value can reach a Notice or the console:
	 *   1. `readField()` — traps/getters cannot abort the failure handler;
	 *   2. type + length — non-strings and absurdly long values are dropped;
	 *   3. control characters — reject values that could forge extra lines;
	 *   4. `redactKeyMaterial()` — exact key + generic long-hex filter, then clamp.
	 *
	 * This deliberately does NOT touch `describeErrorSafely` or
	 * `extractKeyDiagnostics`: their core redaction algorithms are unchanged.
	 */
	private safeMetadataText(error: unknown, field: string, key: string): string {
		const value = this.readField(error, field)
		if (typeof value !== 'string' || value.length === 0 || value.length > 4096) return ''
		if (/[\u0000-\u001f\u007f]/u.test(value)) return ''
		const redacted = redactKeyMaterial(value, [key])
		return redacted.length <= 200 ? redacted : `${redacted.slice(0, 200)}…（已截断）`
	}

	/**
	 * Every failure names the stage, and never claims the export succeeded.
	 *
	 * Round 3.2.3 (F-02): nothing here reads a property off the thrown value
	 * directly any more. Each branch used `error instanceof X` and then
	 * `error.message` / `error.stage` / `error.tmpDir`; a `Proxy` can pass the
	 * `instanceof` check and throw from the getter that follows, and the raw
	 * object was additionally handed straight to `console.error`, which
	 * serialises whatever the object chooses to expose (including a signing key).
	 * The message now comes from the one safe conversion and the log line from
	 * the redacted diagnostic builder; the object itself is never logged.
	 */
	private reportFailure(error: unknown): void {
		const key = this.settings.signingKey

		if (this.isKindOf(error, ShareRefusedError)) {
			// A refusal is a *result*: the note cannot be made self-contained, and
			// writing a file that silently loses pictures would be worse than
			// saying so. The message already names every blocker, so it is shown
			// as-is (redacted, not length-clamped — a truncated list of reasons is
			// exactly what makes a refusal unactionable).
			const message = redactKeyMaterial(
				String((error as Error).message ?? ''),
				[key]
			)
			new Notice(message, 0)
			const blockers = (error as ShareRefusedError).blockers ?? []
			console.error(
				'[html-export-preview] share refused: ' +
					`blockers=${blockers.length} ` +
					blockers.map(b => `${b.kind}:${b.where}`).slice(0, 8).join(' ')
			)
			return
		}

		if (this.isKindOf(error, ShareWriteError)) {
			const stage = (error as ShareWriteError).stage
			const leftover = (error as ShareWriteError).leftover
			const message = redactKeyMaterial(
				String((error as Error).message ?? ''),
				[key]
			)
			new Notice(
				`单文件分享失败（${stage} 阶段）\n${message}` +
					(leftover ? `\n已生成的文件：${this.absolutePath(leftover)}` : ''),
				0
			)
			console.error(
				'[html-export-preview] share write failed: ' +
					`stage=${stage} ` +
					extractKeyDiagnostics(error, [key])
			)
			return
		}

		if (this.isKindOf(error, CaptureError)) {
			const message = describeErrorSafely(error, [key])
			new Notice(`HTML 导出已中止（未写入任何文件）\n${message}`, 0)
			console.error(
				'[html-export-preview] capture failed: ' +
					extractKeyDiagnostics(error, [key])
			)
			return
		}

		if (this.isKindOf(error, ExportError)) {
			// A publish refusal is not a half-finished export: everything was
			// written and verified, we simply refuse to touch a directory we
			// cannot prove is ours. Telling the user that gives them a safe
			// "save as" route instead of only an error (round 2A.1, F-01).
			//
			// P2: `stage` / `tmpDir` are untrusted metadata. Both are read through
			// the guarded getter, validated and redacted BEFORE interpolation;
			// the composed absolute path is redacted a second time so a key that
			// came from the adapter's base path cannot slip through either.
			const stageValue = this.readField(error, 'stage')
			const stageText = this.safeMetadataText(error, 'stage', key) || 'unknown'
			const tmpDirText = this.safeMetadataText(error, 'tmpDir', key)
			const displayPath = tmpDirText
				? redactKeyMaterial(this.absolutePath(tmpDirText), [key])
				: ''
			const message = describeErrorSafely(error, [key])
			const tail =
				displayPath.length > 0
					? stageValue === 'publish'
						? `\n本次生成的内容已完整保留在：${displayPath}\n把该目录名末尾的 .tmp-… 去掉，即可直接当成本次导出使用。`
						: `\n未完成的临时目录已保留：${displayPath}`
					: ''
			new Notice(
				`HTML 导出失败（${stageText} 阶段）\n${message}${tail}`,
				0
			)
			console.error(
				'[html-export-preview] export failed: ' +
					extractKeyDiagnostics(error, [key]) +
					` stage=${stageText} tmpDir=${displayPath || '-'}`
			)
			return
		}

		const message = describeErrorSafely(error, [key])
		new Notice(`HTML 导出失败：${message}`, 0)
		console.error(
			'[html-export-preview] ' + extractKeyDiagnostics(error, [key])
		)
	}

	/**
	 * P1: which note to capture.
	 *
	 * The active Markdown view when there is one. When there is not — because
	 * the previous export revealed the preview panel, or the user clicked it —
	 * fall back to the note we exported last (then to any Markdown leaf) and
	 * make it active, so the capture measures the view the user is looking at
	 * rather than whatever happened to hold the focus.
	 */
	private resolveNoteView(): MarkdownView | null {
		const active = this.app.workspace.getActiveViewOfType(MarkdownView)
		// A markdown leaf in a side dock is a backlink / hover pane, not the
		// note being exported: it is narrow and, when the dock is collapsed, it
		// holds a mounted-but-unpainted reading view (measured: 0 blocks,
		// 574×353). Capturing it produced "正文为空" for a note that was fine.
		if (active && this.isMainAreaLeaf(active.leaf)) return active

		const views = this.app.workspace
			.getLeavesOfType('markdown')
			.filter(leaf => this.isMainAreaLeaf(leaf))
			.map(leaf => leaf.view)
			.filter((view): view is MarkdownView => view instanceof MarkdownView)
		if (views.length === 0) return active ?? null

		const target =
			views.find(view => view.file?.path === this.lastNotePath) ?? views[0]
		this.app.workspace.setActiveLeaf(target.leaf, { focus: false })
		return target
	}

	/**
	 * Create or reuse the editor tab **in the main area**.
	 *
	 * P2 moved it out of the right sidebar: a page that has to be inspected at
	 * desktop width, with its own settings panel, does not fit in a side dock —
	 * and squeezing the panel in there was explicitly ruled out.
	 *
	 * Returns a local reference; the plugin never stores the view. A stored view
	 * outlives its leaf and keeps a closed iframe document reachable.
	 */
	private async ensurePreviewView(): Promise<PreviewView | null> {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_HTML_EXPORT_PREVIEW)
		let leaf = leaves.find(candidate => this.isMainAreaLeaf(candidate)) ?? null

		if (!leaf) {
			// `'tab'`: a new tab in the main area, never a side dock.
			const created = this.app.workspace.getLeaf('tab')
			await created.setViewState({
				type: VIEW_TYPE_HTML_EXPORT_PREVIEW,
				active: true
			})
			// A workspace saved by an older build still carries the view in the
			// right dock, and Obsidian restores it there on startup. Reusing it
			// would put the editor back in the sidebar, so the stale copy is
			// closed and the tab created above becomes the only one.
			for (const stale of leaves) {
				if (stale === created) continue
				try {
					stale.detach()
				} catch {
					// Closing a foreign leaf must never abort the export.
				}
			}
			leaf = created
		}
		this.app.workspace.revealLeaf(leaf)
		return leaf.view instanceof PreviewView ? leaf.view : null
	}

	/** Main editor area, as opposed to the left/right side docks. */
	private isMainAreaLeaf(leaf: WorkspaceLeaf): boolean {
		try {
			return leaf.getRoot() === this.app.workspace.rootSplit
		} catch {
			return false
		}
	}

	/** The live editor, if one is open. Never retained between calls. */
	private currentPreviewView(): PreviewView | null {
		const leaf = this.app.workspace.getLeavesOfType(
			VIEW_TYPE_HTML_EXPORT_PREVIEW
		)[0]
		return leaf && leaf.view instanceof PreviewView ? leaf.view : null
	}
}

/**
 * Human-readable byte size for the share notice.
 *
 * A single-file export is routinely several megabytes (inlined fonts + images),
 * and "4218392 字节" is not something a user can sanity-check at a glance.
 */
function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`
	const units = ['KB', 'MB', 'GB']
	let value = bytes / 1024
	let unit = 0
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024
		unit++
	}
	return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`
}

/** The reading view's body container, if this view currently has one. */
function readingSizerOf(view: MarkdownView): HTMLElement | null {
	return view.containerEl.querySelector<HTMLElement>(
		'.markdown-reading-view .markdown-preview-sizer'
	)
}

/**
 * Has the reading view rendered actual content?
 *
 * `textContent` is **not** a reliable signal: before the first block is
 * mounted the sizer already holds placeholder text, so a text-based check
 * declared "ready" on a body with 0 blocks and capture reported 正文为空.
 * The block list is the same one `CaptureStats` counts; media is added because
 * a note that is only an image is not empty.
 */
function readingViewHasContent(sizer: HTMLElement): boolean {
	if (
		sizer.querySelector('p, li, pre, table, blockquote, h1, h2, h3, h4, h5, h6')
	) {
		return true
	}
	return !!sizer.querySelector('img, video, canvas, .mermaid, mjx-container')
}
