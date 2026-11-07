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
- **Local integrity signing (folder export).** The **asset-bundle / folder export** writes a sidecar `export-manifest.json` carrying a per-file SHA-256 and an HMAC-SHA256 signature under a per-vault key, so you can verify a folder was produced by this vault. The single-file export is self-contained and does **not** include this manifest.

## Opening the preview

1. Open a note in **reading view or edit view** — both work. From edit mode the plugin briefly switches the note to reading view to capture, then restores your original mode.
2. Run the command **HTML Export Preview: Open HTML preview & layout editor** from the command palette, or click the ribbon icon.
   - A second command, **Re-capture and open HTML preview**, forces a fresh capture of the current note.
3. In the preview, **click an image, a Mermaid diagram, or a table** to select it; its width and alignment become editable in the right-hand panel.
4. Review the preview with the responsive presets. Nothing is written to disk until you confirm an export.

## Adjusting images, Mermaid diagrams & tables

- Select an element by **clicking it in the preview** — an **image**, a **Mermaid diagram**, or a **table**. The right-hand panel then shows its **width** (original / percent / px) and **alignment** (left / center / right) controls, plus a reset-to-defaults option.
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
- **Replace** — the plugin first re-checks the existing file's SHA-256, writes an exclusive backup of it, performs the final file swap as a single atomic rename, then re-verifies the result. The swap itself is atomic: your original file is never altered except by that rename. The backup and post-swap verification exist to detect a bad swap and restore the old file, but they are separate steps rather than one atomic transaction. If the operation is **interrupted abnormally** (for example a crash or power loss mid-swap), a `.he-backup-*.html` file may be left on disk and could require **manual recovery** — the plugin does not guarantee automatic recovery after an abnormal termination. On an ordinary (non-interrupted) failure the old file is preserved or restored automatically.
- **Save-as** — writes a new file under a different name.

No file is ever overwritten without this explicit confirmation.

## Anchors: same-article supported, cross-note not guaranteed

- **Same-article anchors work.** In-page `#heading` links jump within the preview/export instead of opening a new browser tab.
- **Cross-note / wiki-link navigation is NOT guaranteed.** Links to other notes generally do not resolve in a standalone export and may not work offline. If you rely on in-file navigation, keep the related content within the same note.

## Privacy & network access

This plugin is **desktop-only** and performs **no telemetry, analytics, advertising, auto-update, or phone-home** behavior. It makes **no network requests unless you export** a note that references remote resources.

- **File system.** It reads the active note's media from your vault and writes exported HTML (and assets) to a directory **you choose**, which may be outside the vault. No files are read or written without an explicit user action.
- **No telemetry or background traffic.** There is no telemetry, analytics, advertising, auto-update, or phone-home, and no periodic or background network activity of any kind.
- **Network requests at export time (user-initiated).** To make an export self-contained, when your note's own CSS or fonts reference **remote `http(s)` URLs** (for example web-hosted fonts), the plugin `fetch`es exactly those URLs and inlines their contents. These requests are triggered by your export action and scoped to URLs already present in your note's styles. There is **no telemetry sent to the plugin author or any analytics service** — the plugin never reports your activity anywhere. Note, however, that the **third-party servers hosting those fonts/CSS do receive ordinary HTTP requests** (and the associated metadata such as your IP address, the requested URL, and a standard User-Agent). An export that references such remote assets is therefore not produced "completely offline"; the fetches happen once, during that export.
- **Local secrets.** The integrity-signing key is a per-vault HMAC key derived and stored locally in the plugin's `data.json`. It is never transmitted and never leaves your machine.
- **Electron.** On desktop it uses `electron.shell.showItemInFolder` solely to reveal the exported file in your file manager (toggleable in settings).

## Limitations

- **Desktop only.** Relies on Node `fs` and Electron; will not run on mobile (declared `isDesktopOnly`).
- **Rendered view, not source.** Export reflects the reading view as Obsidian renders it; some dynamically scripted or externally-embedded interactive content may not capture perfectly.
- **Remote assets need network at export time.** Notes referencing web-hosted fonts/CSS fetch them once during export (see [Privacy](#privacy--network-access)).
- **Element tuning targets the export**, not the original note.
- Requires Obsidian **1.15.0** or newer. This floor reflects the version on which the plugin has actually been run and tested; earlier versions are not claimed as supported because they have not been verified.

## Plugin interface language

This README is in English, but the plugin's **in-app interface** — the settings tab, the overwrite-confirmation dialog, and the layout/tuning panel — is currently written in **Chinese**. For this first release only the command names and this documentation have been localized to English; localizing the in-app UI is planned but not yet done. Do not be surprised to see Chinese text inside the plugin.

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
