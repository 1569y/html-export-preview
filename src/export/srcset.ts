/**
 * `srcset` parsing that does not break `data:` URLs.
 *
 * A `srcset` is a comma-separated candidate list, **except** that a URL may
 * itself contain commas — and every embedded image we produce is
 * `data:image/png;base64,…`, i.e. exactly the case a naive
 * `value.split(',')` destroys. Splitting there yields
 * `data:image/png;base64` + `iVBORw0…` as two "URLs": the first is not a valid
 * image, the second is not a URL at all, and the picture silently disappears.
 *
 * The algorithm below follows the HTML "parse a srcset attribute" steps
 * closely enough for our purposes:
 *
 *   1. skip whitespace and commas;
 *   2. read the URL up to the next whitespace (commas are part of the URL);
 *   3. if the URL ends with a comma, that comma was the separator — strip it
 *      and the candidate has no descriptor;
 *   4. otherwise read descriptors up to the next unnested comma.
 *
 * Descriptors (`1x`, `2x`, `640w`) are kept verbatim: this module never
 * interprets them, it only has to put them back unchanged.
 */

export interface SrcsetCandidate {
	url: string
	/** `""`, `640w`, `2x`, … — everything after the URL, trimmed. */
	descriptor: string
}

function isSpace(ch: string): boolean {
	return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f'
}

export function parseSrcset(value: string): SrcsetCandidate[] {
	const text = String(value ?? '')
	const out: SrcsetCandidate[] = []
	let i = 0

	while (i < text.length) {
		while (i < text.length && (isSpace(text[i]) || text[i] === ',')) i++
		if (i >= text.length) break

		const start = i
		while (i < text.length && !isSpace(text[i])) i++
		let url = text.slice(start, i)
		let closedByComma = false
		// `url,` — the comma terminates the candidate (spec step 7).
		while (url.endsWith(',')) {
			url = url.slice(0, -1)
			closedByComma = true
		}

		let descriptor = ''
		if (!closedByComma) {
			const descriptorStart = i
			let depth = 0
			while (i < text.length) {
				const ch = text[i]
				if (ch === '(') depth++
				else if (ch === ')') depth = Math.max(0, depth - 1)
				else if (ch === ',' && depth === 0) break
				i++
			}
			descriptor = text
				.slice(descriptorStart, i)
				.trim()
				.replace(/,$/, '')
				.trim()
		}

		if (url) out.push({ url, descriptor })
	}

	return out
}

export function serializeSrcset(candidates: readonly SrcsetCandidate[]): string {
	return candidates
		.filter(candidate => candidate.url.length > 0)
		.map(candidate =>
			candidate.descriptor ? `${candidate.url} ${candidate.descriptor}` : candidate.url
		)
		.join(', ')
}
