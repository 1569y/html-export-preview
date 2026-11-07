# Release Notes — v0.1.1

Maintenance release for the Obsidian plugin review. **No new features** and no
change to the exported HTML compared with v0.1.0.

## What changed

- **Fixed the Source Code Error reported by the official Obsidian automated
  review.** The preview editor applied the selection outline on images,
  Mermaid diagrams and tables with inline `style.setProperty('outline', ...)`
  calls. The outline now comes from a `he-media-selected` CSS class defined in
  the preview's live stylesheet, toggled with standard `classList` add/remove.
  This rule is editor-only: `responsiveCss()` and `buildHtml()` were not
  modified, so exported HTML gains no editor styling and is otherwise
  unchanged.
- **Restructured the documentation into two languages.** `README.md` is now
  the English default and contains explicit `Installation` and `How to Use`
  sections. Installation documents only the two real paths (BRAT with
  `1569y/html-export-preview`, and manual installation of the three Release
  assets); it states that the plugin is not yet in the Obsidian community
  plugin directory. The existing Simplified Chinese edition is preserved as
  `README.zh-CN.md`, and both editions link to each other at the top.
  `README.en.md` is now a short redirect stub so old links keep working, and
  a second copy of the English text is no longer maintained.
- **Version metadata:** `manifest.json` and `package.json` are `0.1.1`.
  `minAppVersion` remains `1.15.0`. `versions.json` remains
  `{"0.1.0": "1.15.0"}` — the official Versions documentation says a new
  entry is only required when `minAppVersion` changes, so no duplicate
  `0.1.1` record was added.

Across the whole `0.1.0`..`0.1.1` range the only changed source file is
`src/view/preview-view.ts` (+32 / -12). `styles.css` is byte-identical to the
v0.1.0 asset, the export pipeline is untouched, and `main.js` differs only by
the selection-outline fix above. No settings, no data migration and no
user-visible workflow changed.

## Verification

- `tsc -noEmit` passes; `npm test` passes (the full offline unit suite,
  including the preview lifecycle case covering the CSS-class selection
  highlight).
- `npm run build` reproduces the committed `main.js` byte-for-byte; a clean
  `git archive` source tree rebuilt with the same commands used by GitHub
  Actions produces an identical bundle.
- The official pre-review on `fix/obsidian-review-0.1.1` at commit `67aba2b`
  completed with **Source Code: no Error** and **Dependencies: Pass**. Two
  README warnings remain even though the English default README contains
  real `Installation` and `How to Use` sections. They are recorded as a
  likely scanner false positive; no further README rewrites were made and the
  bilingual documentation is left intact.

## Known limitations

- Desktop-only (`isDesktopOnly: true`). Requires Obsidian 1.15.0 or later.
- Export captures the rendered reading view, not raw markdown; some
  scripted/interactive embeds may not capture perfectly.
- Not yet listed in the Obsidian community plugin directory. Install with
  BRAT or manually from the Release assets (see `README.md`).

## Upgrade / downgrade

Replace `main.js`, `manifest.json` and `styles.css` in
`.obsidian/plugins/html-export-preview/` (keep `data.json`). No data
migration is performed automatically.
