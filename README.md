# HTML Export Preview

Export the current Obsidian **reading view** (already-rendered content) as a standalone HTML file you can open anywhere — then tweak images, Mermaid diagrams, and tables on the exported copy before saving.

Unlike "export markdown as HTML" tools, this plugin captures what you actually see: theme, CSS snippets, media, and Side Notes, all resolved into a self-contained file.

> Status: `0.1.0` — first public release candidate.

## Features

- **Preview before you write.** A built-in editor shows the rendered page with responsive presets (Desktop / Tablet / Phone / Fluid) so you confirm the result before any file is written.
- **Standalone HTML.** Export the current note as a single self-contained `.html` file (images, fonts, and styles inlined) that opens offline in any browser.
- **Directory / asset-bundle export.** Alternatively export a folder with an `assets/` directory, keeping media external.
- **Theme & snippets preserved.** The active theme and your CSS snippets are collected so the export looks like your vault.
- **Side Notes aware.** Margin / side-note content is laid out into the exported page.
- **Single-element tuning.** Select an image, a Mermaid diagram, or a **table** on the right-hand panel and adjust width (original / percent / px) and alignment (left / center / right), or reset to defaults. Changes apply to the export, not your note.
- **Same-article anchors.** In-page `#heading` links jump inside the preview/export instead of opening a new tab.
- **Export anywhere.** Write to any directory your OS account can write — including outside the vault.
- **Safe overwrite.** When the target exists, you get an explicit **Replace / Save-as / Cancel** choice; cancel never touches the old file, and replace only affects the exact file you confirmed.
- **Locate after export.** On desktop, the output is revealed in the system file manager (toggle in settings).
- **Local integrity signing.** A per-vault HMAC manifest is written alongside exports so you can verify they were produced by this vault (no network involved).

## Installation

### Option A — Obsidian community plugin (once approved)
Search **HTML Export Preview** in *Settings → Community plugins* and enable it.

### Option B — BRAT (beta)
1. Install the **BRAT** plugin.
2. *BRAT → Add a beta plugin* and paste the repository URL.
3. Enable **HTML Export Preview** in *Community plugins*.

## Usage

1. Open a note in reading view.
2. Run the command **HTML Export Preview: 打开 HTML 预览与排版编辑器** (ribbon icon or command palette).
3. Review the preview; optionally tune individual images / diagrams / tables from the right panel.
4. Choose an output location and format, then confirm. Nothing is written until you confirm.

## Permissions & Privacy (disclosure)

This plugin is **desktop-only** and needs the following capabilities. It does **not** perform telemetry, analytics, advertising, auto-update, or any phone-home behavior.

- **File system.** It reads the active note's media from your vault and writes exported HTML (and assets) to a directory **you choose**, which may be outside the vault. No files are read or written without an explicit user action.
- **Network.** To make an export truly offline/self-contained, the plugin `fetch`es **remote `http(s)` URLs that appear in the note's own CSS or fonts** (for example web-hosted fonts) and inlines them into the file. It never contacts the plugin author, a analytics service, or any third party. There is no background network activity.
- **Local secrets.** The integrity-signing key is a per-vault HMAC key derived and stored locally in the plugin's `data.json`. It is never transmitted and never leaves your machine.
- **Electron.** On desktop it uses `electron.shell.showItemInFolder` solely to reveal the exported file in your file manager (toggleable).

## Limitations

- **Desktop only.** Relies on Node `fs` and Electron; will not run on mobile (declared `isDesktopOnly`).
- **Rendered view, not source.** Export reflects the reading view as Obsidian renders it; some dynamically scripted or externally-embedded interactive content may not capture perfectly.
- **Remote assets require network at export time.** Notes that reference web-hosted fonts/CSS will fetch them once during export (see above).
- **Element tuning targets the export**, not the original note.
- Requires Obsidian `1.5.0` or newer (recommended `1.5.7`+ for full external-settings adoption).

## Development

```bash
npm install
npm run typecheck   # tsc -noEmit -skipLibCheck
npm run build       # esbuild production bundle -> main.js
npm test            # unit suites (run under Node, no Obsidian required)
```

End-to-end UI verification requires a real Obsidian desktop instance and is performed manually / via the `tests/e2e` harness on the developer's machine.

## License

MIT — see [LICENSE](./LICENSE).
