/**
 * Preview view lifecycle — resource release (2026-11-05).
 *
 * The performance audit found the only real defect: `onClose()` used to just
 * null two fields, leaving the iframe (with a full second copy of the export in
 * `srcdoc`) attached, and `main.ts` kept a long-lived `previewView` reference.
 *
 * These tests bundle the real `preview-view.ts` against a minimal `obsidian`
 * stub and a tiny DOM double, then verify:
 *   - close removes the srcdoc payload *and* detaches the iframe;
 *   - it never assigns the literal string "about:blank" to `srcdoc`;
 *   - every listener the view attached is detached;
 *   - teardown is idempotent (Obsidian calls onClose *and* onunload);
 *   - a visible preview is untouched, and a closed view buffers no new HTML;
 *   - repeated open/close does not accumulate listeners;
 *   - `main.ts` no longer retains a `PreviewView` field.
 *
 * Run with: node tests/unit/run-preview-lifecycle.mjs
 */
import { build } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const tmp = path.join(here, '.tmp')

let passed = 0
const failures = []
const check = async (name, fn) => {
	try {
		await fn()
		passed++
		console.log(`  ok   ${name}`)
	} catch (error) {
		failures.push({ name, message: error.message })
		console.log(`  FAIL ${name}\n       ${error.message}`)
	}
}
const assert = (v, m) => { if (!v) throw new Error(m) }
const equal = (a, b, label) => {
	if (a !== b) throw new Error(`${label}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)
}

/* --------------------------------------------------------------- DOM double -- */

class El {
	constructor(tag) {
		this.tagName = String(tag).toUpperCase()
		this.attrs = new Map()
		this.childNodes = []
		this.parentElement = null
		this.style = {}
		this.textContent = ''
		this.listeners = new Map()
		this._srcdoc = ''
		this.setAttributeCalls = []
		this.removeAttributeCalls = []
		this.removed = false
		this.setTextCalls = []
	}
	setAttribute(name, value) {
		this.setAttributeCalls.push([name, String(value)])
		this.attrs.set(name, String(value))
	}
	removeAttribute(name) {
		this.removeAttributeCalls.push(name)
		this.attrs.delete(name)
		if (name === 'srcdoc') this._srcdoc = ''
	}
	getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null }
	get srcdoc() { return this._srcdoc }
	set srcdoc(value) {
		this._srcdoc = String(value)
		this.attrs.set('srcdoc', this._srcdoc)
	}
	addEventListener(type, handler) {
		if (!this.listeners.has(type)) this.listeners.set(type, new Set())
		this.listeners.get(type).add(handler)
	}
	removeEventListener(type, handler) {
		this.listeners.get(type)?.delete(handler)
	}
	listenerCount() {
		let n = 0
		for (const set of this.listeners.values()) n += set.size
		return n
	}
	empty() {
		for (const child of this.childNodes) child.parentElement = null
		this.childNodes = []
	}
	addClass(cls) { this.className = this.className ? `${this.className} ${cls}` : cls }
	removeClass(cls) {
		if (!this.className) return
		this.className = this.className.split(/\s+/).filter(c => c && c !== cls).join(' ')
	}
	/** Obsidian's `toggleClass(cls, value?)`; the location rows use it. */
	toggleClass(cls, value) {
		const has = this.className.split(/\s+/).includes(cls)
		const on = value === undefined ? !has : !!value
		if (on) this.addClass(cls)
		else this.removeClass(cls)
		return this
	}
	createDiv(opts = {}) { return this.createEl('div', opts) }
	createEl(tag, opts = {}) {
		const el = new El(tag)
		if (opts.cls) el.className = opts.cls
		if (opts.text != null) el.textContent = String(opts.text)
		this.appendChild(el)
		return el
	}
	appendChild(el) {
		el.parentElement = this
		this.childNodes.push(el)
		return el
	}
	/** `Element.append` with the text-node case the panel uses for labels. */
	append(...nodes) {
		for (const node of nodes) {
			if (node instanceof El) this.appendChild(node)
			else this.textContent = `${this.textContent}${String(node)}`
		}
		return this
	}
	remove() {
		if (this.parentElement) {
			const i = this.parentElement.childNodes.indexOf(this)
			if (i >= 0) this.parentElement.childNodes.splice(i, 1)
			this.parentElement = null
		}
		this.removed = true
	}
	/** 简化版：测试里只关心"这个 style 还在文档里"，统一算作已连接。 */
	get isConnected() { return true }
	setText(text) {
		this.setTextCalls.push(String(text))
		this.textContent = String(text)
	}
	querySelectorAll(selector) {
		const cls = selector.replace(/^\./, '')
		const out = []
		const walk = node => {
			for (const child of node.childNodes) {
				if (String(child.className).split(/\s+/).includes(cls)) out.push(child)
				walk(child)
			}
		}
		walk(this)
		return out
	}
}

function collect(node, predicate, out = []) {
	for (const child of node.childNodes) {
		if (predicate(child)) out.push(child)
		collect(child, predicate, out)
	}
	return out
}

function iframes(root) { return collect(root, n => n.tagName === 'IFRAME') }
function buttons(root) { return collect(root, n => n.tagName === 'BUTTON') }

/* ------------------------------------------------------------- obsidian stub -- */

const OBSIDIAN_STUB = `
export class ItemView {
	constructor(leaf) {
		this.leaf = leaf
		this.contentEl = globalThis.__heContentEl
		this.superUnloaded = false
	}
	onunload() { this.superUnloaded = true }
}
export class WorkspaceLeaf {}
// Task 2 在导出位置不安全时调用 new Notice(...)，这里提供一个最小桩以满足测试构建。
export class Notice {
	constructor(msg) {
		this.message = msg
		;(globalThis.__heNotices ??= []).push(String(msg))
	}
}
`

async function loadView() {
	fs.mkdirSync(tmp, { recursive: true })
	const outfile = path.join(tmp, 'preview-view.mjs')
	await build({
		entryPoints: [path.join(root, 'src/view/preview-view.ts')],
		outfile,
		bundle: true,
		format: 'esm',
		platform: 'node',
		target: 'es2020',
		logLevel: 'silent',
		plugins: [{
			name: 'obsidian-stub',
			setup(b) {
				b.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'stub' }))
				b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: OBSIDIAN_STUB, loader: 'js' }))
			}
		}]
	})
	return import(`${pathToFileURL(outfile).href}?t=${Date.now()}`)
}

async function makeView(mod) {
	const contentEl = new El('div')
	globalThis.__heContentEl = contentEl
	const view = new mod.PreviewView({})
	await view.onOpen()
	return { view, contentEl }
}

// ~130 kB, representative of a real export with inlined fonts.
const BIG_HTML = '<!doctype html><html><body>' + '<p>复杂导出内容</p>'.repeat(10000) + '</body></html>'

const mod = await loadView()
console.log('Preview lifecycle checks')

await check('1. 打开预览创建 iframe、工具栏与设置面板，每个按钮只挂 1 个监听', async () => {
	const { view, contentEl } = await makeView(mod)
	const frames = iframes(contentEl)
	equal(frames.length, 1, 'iframe 数')
	// 按语义断言，不写死按钮总数：新增控件（例如 Task 2 的「恢复默认目录」）
	// 是 UI 合理性的改进，测试不应反过来要求砍掉按钮。
	const btns = buttons(contentEl)
	const labels = btns.map(b => b.textContent)
	for (const text of ['桌面', '平板', '手机', '自适应', '刷新', '恢复默认排版', '恢复默认目录', '确认导出']) {
		assert(labels.includes(text), `缺少控件：${text}`)
	}
	equal(labels.filter(t => t === '恢复默认目录').length, 1, '恢复默认目录按钮唯一')
	equal(btns.reduce((n, b) => n + b.listenerCount(), 0), btns.length,
		'每个按钮恰好挂 1 个监听（总数随 UI 控件数变化）')
	equal(view.frame, frames[0], 'view.frame 指向 iframe')
	assert(contentEl.querySelectorAll('.he-preview-panel').length === 1, '设置面板在视图内')
	assert(contentEl.querySelectorAll('.he-preview-holder').length === 1, '页面容器存在')
})

await check('1b. iframe 用 sandbox 隔离，且不允许脚本', async () => {
	const { contentEl } = await makeView(mod)
	const frame = iframes(contentEl)[0]
	equal(frame.getAttribute('sandbox'), 'allow-same-origin', 'sandbox 值')
	assert(!/allow-scripts/.test(frame.getAttribute('sandbox')), '不得允许脚本')
	equal(frame.getAttribute('title'), 'HTML 导出预览', '可访问名称')
})

await check('2. setHtml 将完整导出写入 srcdoc，可见预览不受清理影响', async () => {
	const { view, contentEl } = await makeView(mod)
	view.setHtml(BIG_HTML, '笔记 · 900px')
	const frame = iframes(contentEl)[0]
	equal(frame.srcdoc, BIG_HTML, 'srcdoc 内容')
	equal(frame.parentElement !== null, true, 'iframe 仍在 DOM 中')
	equal(view.previewTitleEl.setTextCalls[0], '笔记 · 900px', '标题文本')
	assert(frame.srcdoc.length > 100000, 'srcdoc 应是完整大文档')
})

await check('2b. 不得覆盖 ItemView 自带的 titleEl（否则 Obsidian load 会抛错）', async () => {
	// 模拟真实 ItemView：父类构造时已建立一个 tab 标题元素。
	const parentTitle = new El('div')
	parentTitle.textContent = '父类标签标题'
	const contentEl = new El('div')
	globalThis.__heContentEl = contentEl
	const view = new mod.PreviewView({})
	view.titleEl = parentTitle
	await view.onOpen()
	equal(view.titleEl, parentTitle, '父类 titleEl 保持不变')
	equal(view.titleEl.textContent, '父类标签标题', '父类标题未被污染')
	assert(!Object.prototype.hasOwnProperty.call(view, 'titleEl') || view.titleEl === parentTitle,
		'视图不得把父类 titleEl 置空')
	equal(view.previewTitleEl?.className, 'he-preview-title', '自己的标题栏使用独立字段')
})

await check('3. onClose 移除 srcdoc 属性并解除 iframe 挂载（不是 about:blank 文本）', async () => {
	const { view, contentEl } = await makeView(mod)
	view.setHtml(BIG_HTML, 'title')
	const frame = iframes(contentEl)[0]
	await view.onClose()
	equal(frame.srcdoc, '', 'srcdoc 已清空')
	equal(frame.removeAttributeCalls.includes('srcdoc'), true, '调用了 removeAttribute(srcdoc)')
	equal(frame.removed, true, 'iframe 调用了 remove()')
	equal(frame.parentElement, null, 'iframe 已脱离 DOM')
	equal(iframes(contentEl).length, 0, 'DOM 中不再有 iframe')
	assert(!frame.removeAttributeCalls.includes('about:blank'), '不得把 about:blank 当 srcdoc 值')
	equal(view.frame, null, 'frame 引用置空')
	equal(view.previewTitleEl, null, 'previewTitleEl 引用置空')
	equal(view.pendingHtml, null, 'pendingHtml 置空')
})

await check('4. 所有按钮监听在关闭时解绑', async () => {
	const { view, contentEl } = await makeView(mod)
	const btns = buttons(contentEl)
	await view.onClose()
	equal(btns.reduce((n, b) => n + b.listenerCount(), 0), 0, '残留监听数')
	equal(view.disposers.length, 0, 'disposers 已清空')
})

await check('5. 二次 onClose / onunload 幂等，不抛错', async () => {
	const { view, contentEl } = await makeView(mod)
	view.setHtml(BIG_HTML)
	const frame = iframes(contentEl)[0]
	await view.onClose()
	await view.onClose()
	view.onunload()
	view.onunload()
	equal(frame.removed, true, 'iframe 仍已移除')
	equal(iframes(contentEl).length, 0, 'DOM 中仍无 iframe')
	equal(view.superUnloaded, true, 'super.onunload() 被调用')
	equal(view.disposers.length, 0, 'disposers 仍为空')
})

await check('6. onunload 单独触发也能完整释放', async () => {
	const { view, contentEl } = await makeView(mod)
	view.setHtml(BIG_HTML)
	const frame = iframes(contentEl)[0]
	view.onunload()
	equal(frame.srcdoc, '', 'srcdoc 已清空')
	equal(frame.parentElement, null, 'iframe 已脱离 DOM')
	equal(view.frame, null, 'frame 置空')
	equal(buttons(contentEl).reduce((n, b) => n + b.listenerCount(), 0), 0, '监听已解绑')
})

await check('7. 关闭后 setHtml 不再缓存新副本', async () => {
	const { view } = await makeView(mod)
	await view.onClose()
	view.setHtml(BIG_HTML, 'late')
	equal(view.pendingHtml, null, 'pendingHtml 未被重新赋值')
	equal(view.frame, null, '未重建 iframe')
})

await check('8. 重复 open/close 不累积监听、不残留 iframe', async () => {
	const contentEl = new El('div')
	globalThis.__heContentEl = contentEl
	const view = new mod.PreviewView({})
	const listenerTotals = []
	for (let i = 0; i < 12; i++) {
		await view.onOpen()
		view.setHtml(BIG_HTML)
		await view.onClose()
		view.onunload()
		listenerTotals.push(buttons(contentEl).reduce((n, b) => n + b.listenerCount(), 0))
		equal(iframes(contentEl).length, 0, `第 ${i + 1} 轮后 DOM 中 iframe 数`)
	}
	equal(listenerTotals.every(n => n === 0), true, '每轮关闭后监听数为 0')
	equal(view.disposers.length, 0, 'disposers 不累积')
})

await check('9. 打开前缓存的 HTML 在 onOpen 时写入且不留第二份', async () => {
	const contentEl = new El('div')
	globalThis.__heContentEl = contentEl
	const view = new mod.PreviewView({})
	view.setHtml(BIG_HTML)
	equal(view.pendingHtml.length, BIG_HTML.length, 'pendingHtml 缓存')
	await view.onOpen()
	equal(iframes(contentEl)[0].srcdoc, BIG_HTML, 'srcdoc 已写入')
	equal(view.pendingHtml, null, 'pendingHtml 已清空')
})

await check('10. 源码不含 srcdoc="about:blank" 反模式，且不残留插件级字段', async () => {
	const viewSrc = fs.readFileSync(path.join(root, 'src/view/preview-view.ts'), 'utf8')
	const mainSrc = fs.readFileSync(path.join(root, 'src/main.ts'), 'utf8')
	assert(!/srcdoc\s*=\s*['"]about:blank['"]/.test(viewSrc), '不得把 about:blank 赋给 srcdoc')
	assert(/removeAttribute\(['"]srcdoc['"]\)/.test(viewSrc), '应使用 removeAttribute 清空')
	assert(/frame\.remove\(\)/.test(viewSrc), '应移除 iframe 元素')
	assert(!/private titleEl\s*:/.test(viewSrc), 'preview-view 不得再声明 titleEl 覆盖父类')
	assert(!/this\.titleEl/.test(viewSrc), 'preview-view 不得再写 this.titleEl')
	assert(!/private previewView\s*:/.test(mainSrc), 'main.ts 不应再持有 previewView 字段')
	assert(!/this\.previewView/.test(mainSrc), 'main.ts 不应再访问 this.previewView')
	// P2: 编辑器在主工作区开标签页，不再挤进右侧边栏
	assert(/getLeaf\(['"]tab['"]\)/.test(mainSrc), '应在主工作区开标签页')
	assert(!/getRightLeaf/.test(mainSrc), '不得再用右侧边栏')
	assert(/ensurePreviewView\(\): Promise<PreviewView \| null>/.test(mainSrc), '视图引用应是局部的')
	assert(/exportNow\(\s*kind: ExportKind,\s*layout: ExportLayoutOptions/.test(mainSrc),
		'确认导出才写盘（kind + layout，第三个可选 location 用于 Task 2 的导出位置）')
})

await check('11. 生产构建不含 about:blank 赋值', async () => {
	const bundle = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
	assert(!/srcdoc\s*=\s*["']about:blank["']/.test(bundle), '构建产物中不得出现该反模式')
})

/* ------------------------------------------------------- P2 编辑器行为 -- */

function makeHost() {
	return {
		layoutCalls: [],
		exports: [],
		released: 0,
		liveCss(layout) {
			this.layoutCalls.push({ ...layout })
			return `/* live zoom=${layout.zoom} width=${layout.contentMaxWidth} */`
		},
		async refresh() { this.refreshed = (this.refreshed ?? 0) + 1 },
		async exportNow(kind, layout, location, external) {
			this.exports.push({
				kind,
				layout: { ...layout },
				location: location ?? null,
				external: external ?? null
			})
		},
		targetHint(kind, location, external) {
			if (external) return `hint:${kind}:external:${external.path}`
			return `hint:${kind}:${location ?? 'default'}`
		},
		defaultExportFolder() { return 'html-export' },
		// Task 3: the external mode is offered unless a test says otherwise;
		// `nextExternal` is what the "system dialog" hands back.
		externalSupport() { return this.support ?? { available: true, reason: null } },
		async pickExternalTarget(kind) {
			this.picks = (this.picks ?? 0) + 1
			this.lastPickKind = kind
			return this.nextExternal ?? null
		},
		releaseSession() { this.released++ }
	}
}

/** 只实现 liveCss 用到的那几个 API 的假文档。 */
function fakeDocument() {
	const doc = {
		styleCount: 0,
		head: new El('head'),
		createElement(tag) {
			if (tag === 'style') doc.styleCount++
			const el = new El(tag)
			return el
		}
	}
	return doc
}

await check('12. 调整排版只重写 iframe 内的 <style>，不重建文档', async () => {
	const contentEl = new El('div')
	globalThis.__heContentEl = contentEl
	const host = makeHost()
	const view = new mod.PreviewView({}, host)
	await view.onOpen()
	view.setHtml(BIG_HTML)
	const frame = iframes(contentEl)[0]
	const doc = fakeDocument()
	frame.contentDocument = doc

	view.setLayout({ zoom: 1.25 })
	equal(doc.styleCount, 1, '第一次改动创建 1 个 <style>')
	const style = doc.head.childNodes[0]
	equal(style.getAttribute('id'), 'he-live-layout', '注入的 style 有稳定 id')
	assert(style.textContent.includes('zoom=125%') || style.textContent.includes('zoom=1.25'),
		`注入内容应反映新缩放，实际：${style.textContent}`)

	view.setLayout({ contentMaxWidth: 900 })
	equal(doc.styleCount, 1, '第二次改动复用同一个 <style>')
	assert(style.textContent.includes('width=900'), '内容宽度已更新')
	equal(frame.srcdoc, BIG_HTML, 'srcdoc 未被重建（没有重新抓取/重设文档）')
})

await check('13. 只有「确认导出」会写文件，并且带上当前排版与所选格式', async () => {
	const contentEl = new El('div')
	globalThis.__heContentEl = contentEl
	const host = makeHost()
	const view = new mod.PreviewView({}, host)
	await view.onOpen()
	view.setHtml(BIG_HTML)

	const confirmBtn = buttons(contentEl).find(b => b.textContent === '确认导出')
	assert(confirmBtn, '存在确认导出按钮')
	equal(host.exports.length, 0, '打开预览不写任何文件')
	confirmBtn.listeners.get('click').forEach(fn => fn())
	equal(host.exports.length, 1, '点击后调用一次导出')
	equal(host.exports[0].kind, 'share', '默认格式为单文件分享')

	view.setLayout({ zoom: 1.5 })
	confirmBtn.listeners.get('click').forEach(fn => fn())
	equal(host.exports[1].layout.zoom, 1.5, '导出使用当前排版（内容大小写入文档）')
})

await check('14. 关闭标签把会话还给插件，且不再缓冲新文档', async () => {
	const contentEl = new El('div')
	globalThis.__heContentEl = contentEl
	const host = makeHost()
	const view = new mod.PreviewView({}, host)
	await view.onOpen()
	view.setHtml(BIG_HTML)
	await view.onClose()
	equal(host.released, 1, 'releaseSession 被调用一次')
	view.setDocument({ html: BIG_HTML })
	equal(view.pendingHtml, null, '关闭后不缓存新文档')
	await view.onClose()
	equal(host.released, 1, '重复关闭不重复释放')
})

await check('15. 刷新按钮交给插件重新抓取，不自行重置排版', async () => {
	const contentEl = new El('div')
	globalThis.__heContentEl = contentEl
	const host = makeHost()
	const view = new mod.PreviewView({}, host)
	await view.onOpen()
	const refreshBtn = buttons(contentEl).find(b => b.textContent === '刷新')
	refreshBtn.listeners.get('click').forEach(fn => fn())
	equal(host.refreshed, 1, '调用了一次刷新')
	equal(host.layoutCalls.length, 0, '刷新本身不改排版')
})


/* -------------------------------------------- Task 2 导出位置 UI 行为 -- */

const fire = (el, type) => {
	const handlers = el.listeners.get(type)
	assert(handlers && handlers.size > 0, `缺少 ${type} 监听`)
	for (const fn of handlers) fn()
}
const locationInputOf = root => root.querySelectorAll('.he-location-input')[0]
const locationHintOf = root => root.querySelectorAll('.he-preview-loc-hint')[0]
const buttonByText = (root, text) => buttons(root).find(b => b.textContent === text)

await check('16. 非法导出位置拒绝写盘；「恢复默认目录」一键修复后可再次导出', async () => {
	globalThis.__heNotices = []
	const contentEl = new El('div')
	globalThis.__heContentEl = contentEl
	const host = makeHost()
	const view = new mod.PreviewView({}, host)
	await view.onOpen()
	const input = locationInputOf(contentEl)
	const reset = buttonByText(contentEl, '恢复默认目录')
	const confirm = buttonByText(contentEl, '确认导出')
	assert(input && reset && confirm, '导出位置输入框、恢复按钮、确认按钮都在')

	for (const bad of ['../escape', 'C:\\Temp\\x', '/absolute', 'html-export/../evil']) {
		input.value = bad
		fire(input, 'input')
		assert(String(input.className).includes('he-invalid'), `${bad} 应标记为不安全`)
		assert(/路径不安全/.test(locationHintOf(contentEl).textContent), `${bad} 应给出诊断提示`)
		fire(confirm, 'click')
	}
	equal(host.exports.length, 0, '非法路径下一次都没有写盘')
	assert(globalThis.__heNotices.some(m => m.includes('恢复默认目录')),
		'错误提示必须指向界面上真实存在的按钮')

	fire(reset, 'click')
	equal(input.value, 'html-export', '恢复默认目录把输入框填回默认文件夹')
	assert(!String(input.className).includes('he-invalid'), '恢复后清除不安全标记')
	assert(/将导出到 Vault 内/.test(locationHintOf(contentEl).textContent), '恢复后提示已更新')
	fire(confirm, 'click')
	equal(host.exports.length, 1, '恢复后可以正常导出')
	equal(host.exports[0].location, 'html-export', '导出带上恢复后的目录')
})

await check('17. 路径为空回落默认目录，自定义 Vault 内子目录原样传入导出入口', async () => {
	const contentEl = new El('div')
	globalThis.__heContentEl = contentEl
	const host = makeHost()
	const view = new mod.PreviewView({}, host)
	await view.onOpen()
	const input = locationInputOf(contentEl)
	const confirm = buttonByText(contentEl, '确认导出')

	input.value = ''
	fire(input, 'input')
	assert(/使用默认文件夹/.test(locationHintOf(contentEl).textContent), '空值提示使用默认文件夹')
	fire(confirm, 'click')
	equal(host.exports[0].location, null, '空路径 = 不覆盖插件默认目录')

	input.value = 'agent-a-ui/share-1'
	fire(input, 'input')
	assert(/将导出到 Vault 内：agent-a-ui\/share-1/.test(locationHintOf(contentEl).textContent),
		'自定义目录提示正确')
	fire(confirm, 'click')
	equal(host.exports[1].location, 'agent-a-ui/share-1', '自定义子目录作为第三参数传入')
})

await check('18. 只输入不确认 / 关闭预览都不写盘，且位置控件引用被释放', async () => {
	const contentEl = new El('div')
	globalThis.__heContentEl = contentEl
	const host = makeHost()
	const view = new mod.PreviewView({}, host)
	await view.onOpen()
	const input = locationInputOf(contentEl)
	input.value = 'agent-a-ui/not-written'
	fire(input, 'input')
	equal(host.exports.length, 0, '只改输入框不写盘')
	await view.onClose()
	equal(host.exports.length, 0, '关闭预览不写盘')
	equal(view.locationInput, null, '输入框引用已释放')
	equal(view.locationHintEl, null, '位置提示引用已释放')
	equal(host.released, 1, '会话已归还插件')
})

console.log(`\n${failures.length === 0 ? '✓' : '✗'} ${passed} 项通过${failures.length ? `，${failures.length} 项失败` : ''}`)
if (failures.length) {
	for (const f of failures) console.log(`  - ${f.name}: ${f.message}`)
	process.exitCode = 1
}
