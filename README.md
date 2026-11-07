# HTML Export Preview

Export the current Obsidian **reading view** (the already-rendered page) as a standalone HTML file you can open anywhere — then tune images, Mermaid diagrams, and tables on the exported copy **before** saving.

Unlike "export markdown as HTML" tools, this plugin captures what you actually see: the active theme, your CSS snippets, media, and Side Notes, all resolved into a self-contained file.

> Status: **v0.1.0** — first public release. Desktop-only (see [Limitations](#limitations)).

## Features

- **Preview before you write.** A built-in editor shows the rendered page with responsive presets (Desktop / Tablet / Phone / Fluid) so you confirm the result before any file is written.
- **Standalone HTML.** Export the current note as a single self-contained `.html` file (images, fonts, and styles inlined) that opens offline in any browser.
- **Asset-bundle export.** Alternatively export a folder with an `assets/` directory, keeping media external (handy for large media or for hosting the folder).
- **Theme & snippets preserved.** The active theme and your CSS snippets are collected so the export looks like your vault.
- **Side Notes aware.** Margin / side-note content is laid out into the exported page.
- **Single-element tuning.** Select an image, a Mermaid diagram, or a **table** in the right-hand panel and adjust width (original / percent / px) and alignment (left / center / right), or reset to defaults. Changes apply to the export, not your note.
- **Same-article anchors.** In-page `#heading` links jump inside the preview/export instead of opening a new tab.
- **Export anywhere.** Write to any directory your OS account can write — including outside the vault.
- **Safe overwrite.** When the target exists, you get an explicit **Replace / Save-as / Cancel** choice; cancel never touches the old file, and replace only affects the exact file you confirmed.
- **Locate after export.** On desktop, the output is revealed in the system file manager (toggle in settings).
- **Local integrity signing.** A per-vault HMAC manifest is written alongside exports so you can verify they were produced by this vault (no network involved).

## Opening the preview

1. Open a note in **reading view**.
2. Run the command **HTML Export Preview: Open HTML preview & layout editor** from the command palette, or click the ribbon icon.
   - A second command, **Re-capture and open HTML preview**, forces a fresh capture of the current note.
3. Review the preview with the responsive presets. Nothing is written to disk until you confirm an export.

## Adjusting images, Mermaid diagrams & tables

- In the right-hand panel, click an **image**, a **Mermaid diagram**, or a **table** to select it, then set its **width** (original / percent / px) and **alignment** (left / center / right), or reset to defaults.
- These adjustments apply to the **export only** — your original note is never modified.
- Blocks you have not individually tuned follow the panel's global defaults.

## Single-file export

Export the current note as one self-contained `.html` file. Images, fonts, and styles are inlined so the file opens offline in any browser with no sibling files.

## Asset-bundle export

Export a folder that contains an `index.html` plus an `assets/` directory holding the media externally. Choose this when you prefer to keep large media out of the HTML, or when you want to publish/host the folder as a unit.

## Directories outside the vault

You may write exports to **any directory your OS account can write**, including locations outside the vault. The default export folder lives inside the vault (recommended, because Obsidian indexes it and plugin updates won't overwrite it), but you can point the export path anywhere.

## Overwrite confirmation

When the export target already exists, the plugin asks explicitly:

- **Cancel** — keeps the existing file untouched; nothing is written.
- **Replace** — swaps only the exact file you confirmed, via an atomic rename with a backup-recovery fallback.
- **Save-as** — writes a new file under a different name.

No file is ever overwritten without this explicit confirmation.

## Anchors: same-article supported, cross-note not guaranteed

- **Same-article anchors work.** In-page `#heading` links jump within the preview/export instead of opening a new browser tab.
- **Cross-note / wiki-link navigation is NOT guaranteed.** Links to other notes generally do not resolve in a standalone export and may not work offline. If you rely on in-file navigation, keep the related content within the same note.

## Privacy & network access

This plugin is **desktop-only** and performs **no telemetry, analytics, advertising, auto-update, or phone-home** behavior.

- **File system.** It reads the active note's media from your vault and writes exported HTML (and assets) to a directory **you choose**, which may be outside the vault. No files are read or written without an explicit user action.
- **Network (at export time only).** To make an export truly offline/self-contained, the plugin `fetch`es **remote `http(s)` URLs that appear in the note's own CSS or fonts** (for example web-hosted fonts) and inlines them into the file. It never contacts the plugin author, an analytics service, or any third party, and there is no background network activity. Because of this, an export is **not** "completely offline" at the moment it references remote assets — the fetch happens once, during export, and only for URLs already present in your own note's styles.
- **Local secrets.** The integrity-signing key is a per-vault HMAC key derived and stored locally in the plugin's `data.json`. It is never transmitted and never leaves your machine.
- **Electron.** On desktop it uses `electron.shell.showItemInFolder` solely to reveal the exported file in your file manager (toggleable in settings).

## Limitations

- **Desktop only.** Relies on Node `fs` and Electron; will not run on mobile (declared `isDesktopOnly`).
- **Rendered view, not source.** Export reflects the reading view as Obsidian renders it; some dynamically scripted or externally-embedded interactive content may not capture perfectly.
- **Remote assets need network at export time.** Notes referencing web-hosted fonts/CSS fetch them once during export (see [Privacy](#privacy--network-access)).
- **Element tuning targets the export**, not the original note.
- Requires Obsidian **1.5.0** or newer. (External-settings auto-adoption is fully realized on 1.5.7+, but the plugin runs from 1.5.0.)

## Installation

### Option A — Obsidian community plugin (once approved)

Search **HTML Export Preview** in *Settings → Community plugins* and enable it.

### Option B — BRAT (beta)

1. Install the **BRAT** plugin.
2. *BRAT → Add a beta plugin* and paste the repository URL `https://github.com/1569y/html-export-preview`.
3. Enable **HTML Export Preview** in *Community plugins*.

## Feedback

- **Bug reports & feature requests:** open an issue at <https://github.com/1569y/html-export-preview/issues>.
- Please include your Obsidian version, the plugin version (`0.1.0`), and the steps to reproduce.

## Screenshots

> Add public demo screenshots here (preview editor, layout panel, export dialog). Use only demo content that contains no real vault data or personal paths.

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
