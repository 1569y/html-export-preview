/**
 * A tiny DOM double for the offline tests.
 *
 * Scope is deliberately narrow: it supports exactly the surface the capture and
 * clone code touches — element trees, simple selectors (`tag`, `.class`,
 * `tag.class`, comma groups, descendant), `getBoundingClientRect`, attributes,
 * `cloneNode`, `remove`. It is not a browser and does not pretend to be.
 *
 * Keeping it small matters: a heavyweight fake (jsdom) would let code that
 * cannot run in Obsidian pass here. Every method below exists because some
 * production line calls it.
 */

const VOID_TAGS = new Set([
	'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
	'link', 'meta', 'param', 'source', 'track', 'wbr'
])

class ClassList {
	constructor(el) {
		this.el = el
	}

	get _set() {
		return new Set((this.el.attrs.get('class') ?? '').split(/\s+/).filter(Boolean))
	}

	contains(name) {
		return this._set.has(name)
	}

	add(...names) {
		const set = this._set
		for (const name of names) set.add(name)
		this.el.attrs.set('class', [...set].join(' '))
	}

	remove(...names) {
		const set = this._set
		for (const name of names) set.delete(name)
		this.el.attrs.set('class', [...set].join(' '))
	}
}

export class El {
	constructor(tag) {
		this.tagName = String(tag).toUpperCase()
		this.attrs = new Map()
		this.childNodes = []
		this.parentElement = null
		this.isConnected = true
		this._rect = { width: 0, height: 0, top: 0, left: 0 }
		this.style = { removeProperty() {} }
	}

	get className() {
		return this.attrs.get('class') ?? ''
	}

	set className(value) {
		this.attrs.set('class', value)
	}

	get classList() {
		if (!this._classList) this._classList = new ClassList(this)
		return this._classList
	}

	get children() {
		return this.childNodes.filter(n => n instanceof El)
	}

	get attributes() {
		return [...this.attrs].map(([name, value]) => ({ name, value }))
	}

	get dataset() {
		const out = {}
		for (const [name, value] of this.attrs) {
			if (!name.startsWith('data-')) continue
			const key = name
				.slice(5)
				.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
			out[key] = value
		}
		return out
	}

	/**
	 * Attribute access is case-insensitive, exactly as in the DOM.
	 *
	 * The parser stores lowercased names (as HTML parsers do), but the browser
	 * then applies the spec's "adjust SVG attributes" step, so `viewBox` is what
	 * production code reads. A case-sensitive double handed back `null` there
	 * and silently pushed Mermaid code down its "no viewBox" fallback.
	 */
	getAttribute(name) {
		const key = String(name).toLowerCase()
		return this.attrs.has(key) ? this.attrs.get(key) : null
	}

	hasAttribute(name) {
		return this.attrs.has(String(name).toLowerCase())
	}

	/** Obsidian's `toggleClass(cls, value?)`, used by the location rows. */
	toggleClass(name, value) {
		const on = value === undefined ? !this.classList.contains(name) : !!value
		if (on) this.classList.add(name)
		else this.classList.remove(name)
		return this
	}

	setAttribute(name, value) {
		this.attrs.set(String(name).toLowerCase(), String(value))
	}

	removeAttribute(name) {
		this.attrs.delete(String(name).toLowerCase())
	}

	get textContent() {
		let out = ''
		for (const node of this.childNodes) {
			out += node instanceof El ? node.textContent : node.text
		}
		return out
	}

	set textContent(value) {
		this.childNodes = [{ text: String(value) }]
	}

	get innerHTML() {
		return this.childNodes
			.map(node => (node instanceof El ? node.outerHTML : escapeText(node.text)))
			.join('')
	}

	get outerHTML() {
		const attrs = [...this.attrs].map(([k, v]) => ` ${k}="${v}"`).join('')
		if (VOID_TAGS.has(this.tagName.toLowerCase())) return `<${this.tagName.toLowerCase()}${attrs}>`
		return `<${this.tagName.toLowerCase()}${attrs}>${this.innerHTML}</${this.tagName.toLowerCase()}>`
	}

	append(...nodes) {
		for (const node of nodes) {
			// Text nodes are plain `{ text }` objects here, and moving one (already
			// created) must not stringify it — that is what the DOM does too.
			const child =
				node instanceof El
					? node
					: node && typeof node === 'object' && 'text' in node
						? node
						: { text: String(node) }
			if (child instanceof El) child.parentElement = this
			this.childNodes.push(child)
		}
		return this
	}

	appendChild(node) {
		this.append(node)
		return node
	}

	/** Insert before a sibling (P1: the sidenote holder has to sit where the
	 *  inline span was, not after it). */
	insertBefore(node, reference) {
		const index = reference ? this.childNodes.indexOf(reference) : -1
		const child =
			node instanceof El
				? node
				: node && typeof node === 'object' && 'text' in node
					? node
					: { text: String(node) }
		if (child instanceof El) child.parentElement = this
		if (index < 0) this.childNodes.push(child)
		else this.childNodes.splice(index, 0, child)
		return child
	}

	remove() {
		if (!this.parentElement) return
		const siblings = this.parentElement.childNodes
		const index = siblings.indexOf(this)
		if (index >= 0) siblings.splice(index, 1)
		this.parentElement = null
	}

	cloneNode(deep = false) {
		const copy = new El(this.tagName)
		copy.attrs = new Map(this.attrs)
		copy._rect = { ...this._rect }
		copy.style = this.style
		if (deep) {
			for (const node of this.childNodes) {
				const child = node instanceof El ? node.cloneNode(true) : { text: node.text }
				if (child instanceof El) child.parentElement = copy
				copy.childNodes.push(child)
			}
		}
		return copy
	}

	getBoundingClientRect() {
		return { ...this._rect }
	}

	get clientHeight() {
		return this._rect.height
	}

	matches(selector) {
		return matchCompound(this, selector.trim())
	}

	querySelector(selector) {
		return this.querySelectorAll(selector)[0] ?? null
	}

	querySelectorAll(selector) {
		const groups = splitGroups(selector)
		const out = []
		const walk = node => {
			for (const child of node.childNodes) {
				if (!(child instanceof El)) continue
				if (groups.some(group => matchesChain(child, group))) out.push(child)
				walk(child)
			}
		}
		walk(this)
		return out
	}

	closest(selector) {
		const groups = splitGroups(selector)
		let node = this
		while (node) {
			if (groups.some(group => matchesChain(node, group))) return node
			node = node.parentElement
		}
		return null
	}
}

function escapeText(text) {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;')
}

function splitGroups(selector) {
	return selector
		.split(',')
		.map(part => part.trim())
		.filter(Boolean)
		.map(part => part.split(/\s+/))
}

/** Right-to-left match of `div.a .b` style chains. */
function matchesChain(el, compounds) {
	let index = compounds.length - 1
	if (!matchCompound(el, compounds[index])) return false
	index--
	let node = el.parentElement
	while (index >= 0) {
		let found = false
		while (node) {
			if (matchCompound(node, compounds[index])) {
				found = true
				node = node.parentElement
				break
			}
			node = node.parentElement
		}
		if (!found) return false
		index--
	}
	return true
}

function matchCompound(el, compound) {
	if (!compound || compound === '*') return true
	const parts = compound.match(/^([a-zA-Z][\w-]*)?((?:\.[\w-]+)*)((?:\[[^\]]+\])*)$/)
	if (!parts) return false
	const tag = parts[1]
	const classes = (parts[2] ?? '').split('.').filter(Boolean)
	if (tag && el.tagName.toLowerCase() !== tag.toLowerCase()) return false
	const own = new Set((el.attrs.get('class') ?? '').split(/\s+/).filter(Boolean))
	for (const cls of classes) {
		if (!own.has(cls)) return false
	}
	// Attribute predicates: `[attr]`, `[attr="v"]`, `[attr*="v"]`, `[attr^="v"]`.
	// Needed because the exporter matches `[style*="url("]` (review C2).
	for (const raw of (parts[3] ?? '').match(/\[[^\]]+\]/g) ?? []) {
		const m = raw.match(
			/^\[\s*([\w-]+)\s*(?:([*^$]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+)))?\s*\]$/
		)
		if (!m) return false
		const [, name, op, dq, sq, bare] = m
		const expected = dq ?? sq ?? bare
		if (!el.attrs.has(name)) return false
		if (!op) continue
		const actual = el.attrs.get(name) ?? ''
		if (op === '=' && actual !== expected) return false
		if (op === '*=' && !actual.includes(expected)) return false
		if (op === '^=' && !actual.startsWith(expected)) return false
		if (op === '$=' && !actual.endsWith(expected)) return false
	}
	return true
}

/* ------------------------------------------------------------------ parse -- */

const TAG_RE = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*"([^"]*)"|\s*=\s*'([^']*)'|\s*=\s*([^\s"'=<>`]+))?/g

/** Parse an HTML fragment into a detached root element. */
export function parseHtml(html) {
	const root = new El('root')
	const stack = [root]
	let cursor = 0

	for (const match of html.matchAll(TAG_RE)) {
		if (match.index > cursor) {
			const text = html.slice(cursor, match.index)
			if (text.trim()) stack[stack.length - 1].childNodes.push({ text })
		}
		cursor = match.index + match[0].length

		const [, closing, rawTag, rawAttrs, selfClose] = match
		const tag = rawTag.toLowerCase()

		if (closing) {
			for (let i = stack.length - 1; i > 0; i--) {
				if (stack[i].tagName.toLowerCase() === tag) {
					stack.length = i
					break
				}
			}
			continue
		}

		const el = new El(tag)
		for (const attr of rawAttrs.matchAll(ATTR_RE)) {
			const value = attr[2] ?? attr[3] ?? attr[4] ?? ''
			el.attrs.set(attr[1].toLowerCase(), value)
		}
		stack[stack.length - 1].append(el)

		if (!selfClose && !VOID_TAGS.has(tag)) stack.push(el)
	}

	if (cursor < html.length) {
		const text = html.slice(cursor)
		if (text.trim()) stack[stack.length - 1].childNodes.push({ text })
	}

	return root
}

/** Give a node a layout box; the resolver reads these numbers. */
export function setRect(el, width, height, top = 0, left = 0) {
	el._rect = { width, height, top, left }
	return el
}

/** Install the globals the production code expects from a browser. */
export function installDomGlobals() {
	globalThis.HTMLElement = El
	globalThis.Element = El
}
