/**
 * Boundary between collected CSS and the HTML `<style>` element.
 *
 * HTML parses `<style>` as a RAWTEXT element: the first `</style` (case
 * insensitive, followed by whitespace, `/` or `>`) ends the element no matter
 * where it appears — inside a CSS string, a comment, or a `data:` URI. Obsidian
 * themes legitimately embed inline SVG in `-webkit-mask-image:
 * url('data:image/svg+xml;utf8,<svg><defs><style>…</style></defs>…')`. The
 * Border theme contains 19 such `<style>…</style>` pairs.
 *
 * `collectCss` normally reads `sheet.cssRules`, whose `cssText` percent-encodes
 * `<` inside `url()` values (so no literal `</style>` survives). But it also has
 * two raw-text paths — `readSheetText()` when `cssRules` is unreadable, and the
 * `@import` inliner's `readByUrl()` — which return the stylesheet file verbatim.
 * When one of those feeds the page, the style element ends at the first
 * `</style>` and every rule after it is parsed as visible body text. That is the
 * "Border 主题下正文出现大量原始 CSS" report.
 *
 * The fix belongs at the embedding boundary, not in the collector: `renderCss`
 * output is also written verbatim to `assets/export.css` for the directory
 * export, where it is a CSS file and must stay byte-identical.
 *
 * `\/` is a CSS escape for `/`, so `<\/style` is tokenised back into `</style`
 * by the CSS parser (the SVG data URI is unchanged) while remaining invisible to
 * the HTML tokenizer. This is the same technique used to embed `</script>` in
 * inline JavaScript. It is idempotent: `<\/style` does not match the pattern.
 *
 * A successful neutralisation is an ordinary, silent success: it must not add
 * a `collectCss().warnings` entry, because `reportSuccess()` renders that count
 * as "CSS 警告 N 条" and a clean export would look degraded. Only a stylesheet
 * that cannot be embedded is reported — `assertEmbeddableCss()` aborts the
 * build with an explicit user-facing reason instead of emitting a page that
 * shows the theme CSS as body text.
 */

/** Fresh regex on purpose — a shared /g regex has stateful `lastIndex`. */
function styleEndPattern(): RegExp {
	return /<\/style/gi
}

/** Number of sequences that would terminate an HTML `<style>` element. */
export function countStyleEndTags(css: string): number {
	return (String(css ?? '').match(styleEndPattern()) ?? []).length
}

/** Neutralise end-tag sequences without changing the CSS the browser applies. */
export function neutralizeStyleEndTags(css: string): {
	text: string
	count: number
} {
	const text = String(css ?? '')
	const count = countStyleEndTags(text)
	if (count === 0) return { text, count: 0 }
	return {
		text: text.replace(styleEndPattern(), m => `${m[0]}\\${m.slice(1)}`),
		count
	}
}

/**
 * Refuse a stylesheet that still contains an HTML style end tag. Called after
 * neutralisation as a defence-in-depth guard: a failure must abort the build
 * with a named reason, never produce a page that shows the CSS as body text
 * while reporting success.
 */
export function assertEmbeddableCss(css: string): void {
	const count = countStyleEndTags(css)
	if (count > 0) {
		throw new Error(
			`样式表中仍有 ${count} 处无法安全嵌入的 </style> 序列，已中止生成：` +
				'继续输出会把主题 CSS 显示为正文。请改用目录导出或停用该主题/片段后重试。'
		)
	}
}

