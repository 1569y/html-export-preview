/**
 * P0 — 离屏宿主释放回归测试（离线）
 *
 * 复现三条失败路径，证明宿主节点与 Component 都被释放：
 *   1) MarkdownRenderer.render 抛错；
 *   2) render 永不完成（超时预算到点）；
 *   3) 捕获结束后的收尾里 restoreScroll 抛错。
 *
 * 用极简 DOM 与 obsidian 桩，不启动 Obsidian。
 *
 * Run with: node tests/unit/run-p0-host-release.mjs
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

async function check(name, fn) {
	try {
		await fn()
		passed++
		console.log(`  ok   ${name}`)
	} catch (error) {
		failures.push({ name, message: error.message })
		console.log(`  FAIL ${name}`)
		console.log(`       ${error.message}`)
	}
}

function assert(condition, message) {
	if (!condition) throw new Error(message)
}

/** The smallest DOM the capture path actually touches. */
class FakeNode {
	constructor(tag) {
		this.tagName = String(tag).toUpperCase()
		this.className = ''
		this.children = []
		this.attrs = {}
		this.parent = null
	}
	setAttribute(name, value) {
		this.attrs[name] = String(value)
	}
	getAttribute(name) {
		return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null
	}
	get attributes() {
		return Object.entries(this.attrs).map(([name, value]) => ({ name, value }))
	}
	appendChild(child) {
		child.parent = this
		this.children.push(child)
		return child
	}
	remove() {
		if (!this.parent) return
		this.parent.children = this.parent.children.filter(node => node !== this)
		this.parent = null
	}
	querySelector() {
		return null
	}
	querySelectorAll() {
		return []
	}
	get innerText() {
		return ''
	}
}

function installDom() {
	const body = new FakeNode('body')
	globalThis.document = {
		createElement: tag => new FakeNode(tag),
		body,
		fonts: { ready: Promise.resolve() },
		scrollingElement: null
	}
	globalThis.window = {
		requestAnimationFrame: cb => setTimeout(cb, 0),
		setTimeout,
		clearTimeout,
		getComputedStyle: () => ({ overflowY: 'visible' })
	}
	return body
}

async function loadCapture() {
	fs.mkdirSync(tmp, { recursive: true })
	const outfile = path.join(tmp, 'dom-capture.mjs')
	const stub = `
export class Component {
	constructor() { this.loaded = false; this.unloaded = false; (globalThis.__components ||= []).push(this) }
	load() { this.loaded = true }
	unload() { this.unloaded = true }
}
export class MarkdownView {}
export const MarkdownRenderer = {
	render: (...args) => globalThis.__render(...args)
}
`
	await build({
		entryPoints: [path.join(root, 'src/capture/dom-capture.ts')],
		bundle: true,
		format: 'esm',
		platform: 'node',
		target: 'es2020',
		outfile,
		logLevel: 'silent',
		plugins: [
			{
				name: 'obsidian-stub',
				setup(pluginBuild) {
					pluginBuild.onResolve({ filter: /^obsidian$/ }, () => ({
						path: 'obsidian',
						namespace: 'stub'
					}))
					pluginBuild.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
						contents: stub,
						loader: 'js'
					}))
				}
			}
		]
	})
	return import(`${pathToFileURL(outfile).href}?t=${Date.now()}`)
}

function makeArgs() {
	const sizer = new FakeNode('div')
	sizer.className = 'markdown-preview-sizer markdown-preview-section'
	const readingRoot = new FakeNode('div')
	readingRoot.className = 'markdown-reading-view'
	return {
		app: { vault: { read: async () => '# 标题\n\n正文内容足够长，用于渲染测试。\n' } },
		view: { file: { path: 'docs/x.md' } },
		liveSizer: sizer,
		readingRoot,
		warnings: []
	}
}

async function main() {
	const mod = await loadCapture()
	const body = installDom()

	console.log('P0 host release checks')

	await check('render 抛错 → 宿主被移除、Component 被卸载', async () => {
		globalThis.__components = []
		globalThis.__render = async () => {
			throw new Error('boom')
		}
		const { app, view, liveSizer, readingRoot, warnings } = makeArgs()
		let error = null
		try {
			await mod.renderWholeNote(app, view, liveSizer, null, readingRoot, 890, warnings, 2000)
		} catch (e) {
			error = e
		}
		assert(error, 'must throw')
		assert(error.name === 'CaptureError', `error=${error.name}`)
		assert(String(error.message).includes('整篇渲染失败'), error.message)
		assert(body.children.length === 0, `host left behind: ${body.children.length}`)
		assert(globalThis.__components.length === 1, 'component not created')
		assert(globalThis.__components[0].unloaded === true, 'component not unloaded')
	})

	await check('render 永不完成 → 超时后宿主被移除、Component 被卸载', async () => {
		globalThis.__components = []
		globalThis.__render = () => new Promise(() => {})
		const { app, view, liveSizer, readingRoot, warnings } = makeArgs()
		let error = null
		try {
			await mod.renderWholeNote(app, view, liveSizer, null, readingRoot, 890, warnings, 80)
		} catch (e) {
			error = e
		}
		assert(error, 'must throw on timeout')
		assert(String(error.message).includes('超过 80 ms'), error.message)
		assert(String(error.message).includes('已移除离屏宿主'), error.message)
		assert(body.children.length === 0, `host left behind: ${body.children.length}`)
		assert(globalThis.__components[0].unloaded === true, 'component not unloaded')
	})

	await check('render 成功 → 返回后由调用方释放，dispose 可重复调用', async () => {
		globalThis.__components = []
		globalThis.__render = async () => undefined
		const { app, view, liveSizer, readingRoot, warnings } = makeArgs()
		const offscreen = await mod.renderWholeNote(
			app,
			view,
			liveSizer,
			null,
			readingRoot,
			890,
			warnings,
			2000
		)
		assert(body.children.length === 1, `host should be attached: ${body.children.length}`)
		assert(globalThis.__components[0].unloaded === false, 'must stay loaded while in use')
		offscreen.dispose()
		assert(body.children.length === 0, 'dispose must remove the host')
		assert(globalThis.__components[0].unloaded === true, 'dispose must unload')
		offscreen.dispose()
		assert(body.children.length === 0, 'dispose must be idempotent')
	})

	await check('restoreScroll 抛错 → 仍然 dispose，且不覆盖捕获异常', async () => {
		const warnings = []
		let disposed = 0
		const target = {
			el: {
				get scrollTop() {
					return 0
				},
				set scrollTop(_value) {
					throw new Error('scroll write failed')
				}
			},
			top: 1200,
			label: 'div.markdown-preview-view'
		}
		await mod.releaseAfterCapture(target, warnings, {
			dispose: () => {
				disposed++
			}
		})
		assert(disposed === 1, `dispose calls=${disposed}`)
		assert(
			warnings.some(w => w.includes('滚动位置还原失败')),
			`warnings=${JSON.stringify(warnings)}`
		)
	})

	await check('dispose 自身抛错也不影响收尾', async () => {
		const warnings = []
		await mod.releaseAfterCapture(
			{ el: null, top: 0, label: '(none)' },
			warnings,
			{
				dispose: () => {
					throw new Error('dispose failed')
				}
			}
		)
		assert(true, 'no throw expected')
	})

	console.log(`\n${passed} passed, ${failures.length} failed`)
	if (failures.length > 0) process.exit(1)
}

main().catch(error => {
	console.error(error)
	process.exit(1)
})
