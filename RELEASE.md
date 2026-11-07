# Release Notes — v0.1.0

First public release candidate of **HTML Export Preview**.

## What's in this release

- Preview-then-export workflow: nothing is written until the user confirms.
- Standalone single-file HTML export (images / fonts / styles inlined, offline-openable).
- Directory / asset-bundle export.
- Theme, CSS snippets, and Side Notes preserved in the output.
- Right-hand single-element panel: image, Mermaid, and **table** tuning (width: original / percent / px; alignment: left / center / right; reset to defaults).
- Same-article anchor navigation inside the preview/export.
- Export to any writable directory (including outside the vault).
- Safe overwrite flow: explicit **Replace / Save-as / Cancel**; cancel never overwrites, replace affects only the confirmed target.
- Desktop "reveal in file manager" after export (toggleable; no effect on hosts without shell support).
- Local per-vault HMAC manifest signing for export integrity (offline, no network).

## Verification done before tagging

- `tsc -noEmit` passes.
- Production build is deterministic (rebuild reproduces the committed `main.js` byte-for-byte).
- Unit suites green (offline, Node): `run-unit` 32/32, `run-preview-lifecycle` 20/20, `run-share-startup` 4/4, `run-p2-media` 20/20, `run-p3-external` 26/26, `run-share-safe` 25/25, `run-share-single` 20/20, `run-share-replace` 5/5.
- Code-level review of startup path: `onload()` performs only config load + per-vault key resolution + view/command/ribbon/settings registration (no CSS scan, no markdown render, no HTML build, no font collection, no large disk I/O at load). Restored preview leaves do not re-capture the note at startup. View teardown is idempotent and releases the iframe context and all listeners.
- Policy review: no telemetry / analytics / auto-update / phone-home; network use is limited to inlining the note's own remote CSS/font assets at export time (disclosed in README).

## Known limitations

- Desktop-only (`isDesktopOnly: true`); requires Obsidian 1.5.0+ (1.5.7+ recommended for full external-settings adoption).
- Export captures the rendered reading view, not raw markdown; some scripted/interactive embeds may not capture perfectly.
- Real Obsidian UI acceptance (panel visibility, reveal-in-folder, overwrite dialog) was performed by the maintainer on their machine; the automated suites cover the underlying logic.

## Upgrade / downgrade

Replace `main.js` and `styles.css` (keep `manifest.json` and `data.json`). No data migration is performed automatically.
