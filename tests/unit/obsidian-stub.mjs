/**
 * Minimal stand-in for the `obsidian` module, used only by the offline unit
 * tests. The tested modules touch a tiny slice of the real API: `TFile` for
 * `instanceof` checks and `normalizePath` for folder creation. Everything else
 * is a type-only import and gets erased at compile time.
 *
 * Plain JavaScript on purpose — this file is loaded by Node, not by esbuild.
 */

export class TFile {
	constructor(path, size = 1) {
		this.path = path
		this.name = path.split('/').pop() ?? path
		this.basename = this.name.replace(/\.[^.]+$/, '')
		this.stat = { size }
	}
}

export class TFolder {}
export class App {}
export class Plugin {}
export class MarkdownView {}
export class Notice {}
/** Only needed so `src/settings.ts` can be bundled for `inspectOutputFolder`. */
export class PluginSettingTab {}
export class Setting {}

export function normalizePath(path) {
	return path
		.replace(/\\/g, '/')
		.replace(/\/{2,}/g, '/')
		.replace(/^\/+/, '')
		.replace(/\/+$/, '')
}
