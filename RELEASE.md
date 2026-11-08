# Release Notes — v0.1.2

Theme-compatibility patch. **No new features.** This release only fixes how
theme CSS is embedded in the HTML preview and in exported single-file pages.

## Fixed

- **Prevent theme CSS containing embedded SVG `<style>` markup from leaking
  into the HTML preview or exported single-file pages.** HTML parses `<style>`
  as a RAWTEXT element, so a literal `</style>` inside a theme's inline SVG
  data URI ended the style block early and every remaining rule was rendered
  as visible body text. The embedding boundary now writes that sequence as the
  CSS escape `<\/style>`: the CSS parser restores `/`, while the HTML
  tokenizer no longer sees a closing tag.
- **Preserve CSS mask rules while safely embedding theme styles.** Escaping
  happens only at the embedding boundary. SVG data URIs and `mask-image` /
  `-webkit-mask-image` rules keep their original meaning, and directory
  exports still write `assets/export.css` byte-for-byte unchanged because
  they load CSS through a `<link>` element rather than inline.
- **Avoid misleading warnings when special CSS has been handled
  successfully.** A stylesheet that was safely embedded is no longer counted
  as a CSS warning in the export report. CSS that genuinely cannot be
  embedded is still refused with an explicit reason instead of producing a
  page that displays its own stylesheet.

## Scope

This is a compatibility patch for themes that embed SVG markup in their CSS.
It adds no settings, no UI, no data migration and no change to the export
workflow. It does **not** claim compatibility with every Obsidian theme;
themes with other unusual CSS constructs may still need individual testing.
The regression suite added for this fix uses small, self-contained CSS
samples only; no third-party theme files or user notes are included in the
repository.

## Verification

- `tsc -noEmit`, the full `npm test` suite (including the CSS boundary
  regressions) and `npm run build` pass.
- Two consecutive production builds produce a byte-identical `main.js`, and a
  clean source tree rebuilt with the same commands used by GitHub Actions
  reproduces the same bundle.
- Real-browser DOM checks confirm that the style element is not terminated
  early, that no CSS appears as body text, and that the mask rules survive
  with the same computed values and CSSOM rule text as the unescaped
  stylesheet.

## Upgrade / downgrade

Replace `main.js`, `manifest.json` and `styles.css` in
`.obsidian/plugins/html-export-preview/` (keep `data.json`). No data
migration is performed automatically. `minAppVersion` remains `1.15.0`.
