/**
 * Single-file share mode (2026-11-05).
 *
 * The share command must produce **one** `.html` a recipient can open with no
 * Obsidian, no vault, no network and no sidecar directory. These tests bundle
 * the real modules and pin the properties that make that true — and, just as
 * important, pin what must *not* be in the file:
 *
 *   - no `<link rel="stylesheet" href="assets/…">` (a sidecar that cannot travel);
 *   - no `app://` / `file://` / drive-letter path anywhere (local state);
 *   - no `data-he-original-src` (it exists only to record those paths);
 *   - no `/* ==== app://<vault-id>/… ==== *\/` sheet-origin comments;
 *   - no signing key, no manifest, no audit file (the directory export keeps
 *     those, and this path never writes them).
 *
 * And what must survive: the note body itself, its images (as `data:` URLs),
 * the collected CSS, MathJax fonts already inlined, sidenote markup, and the
 * `<!--he-body-start-->` markers the integrity checks rely on.
 *
 * Run with: node tests/unit/run-share-single.mjs
 */
import { build } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Buffer } from 'node:buffer'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const tmp = path.join(here, '.tmp')

/* --------------------------------------------------------------- harness -- */

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

function equal(actual, expected, label) {
	const a = JSON.stringify(actual)
	const e = JSON.stringify(expected)
	if (a !== e) throw new Error(`${label}: expected ${e}, got ${a}`)
}

function match(value, regex, label) {
	if (!regex.test(String(value))) {
		throw new Error(`${label}: ${regex} 未匹配`)
	}
}

/* ---------------------------------------------------------- bundling glue -- */

function prepareObsidianStub() {
	const dir = path.join(tmp, 'node_modules', 'obsidian')
	fs.mkdirSync(dir, { recursive: true })
	fs.copyFileSync(path.join(here, 'obsidian-stub.mjs'), path.join(dir, 'index.mjs'))
	fs.writeFileSync(
		path.join(dir, 'package.json'),
		JSON.stringify(
			{
				name: 'obsidian',
				version: '0.0.0-stub',
				type: 'module',
				main: 'index.mjs',
				exports: './index.mjs'
			},
			null,
			2
		)
	)
	return pathToFileURL(path.join(dir, 'index.mjs')).href
}

async function bundle(entry, name) {
	const outfile = path.join(tmp, `${name}.mjs`)
	await build({
		entryPoints: [path.join(root, entry)],
		outfile,
		bundle: true,
		format: 'esm',
		platform: 'node',
		target: 'node18',
		external: ['obsidian'],
		logLevel: 'silent'
	})
	return import(`${pathToFileURL(outfile).href}?v=${Date.now()}`)
}

/* ------------------------------------------------------------ DOM double -- */

/**
 * Just enough DOM for `buildHtml` + `rewriteMedia`.
 *
 * The exporter clones the sizer, walks `querySelectorAll` for media and for
 * inline `url()` styles, and reads `outerHTML`. Everything else in the double
 * is text, so a dropped paragraph cannot hide behind a fake node type.
 */
class FakeEl {
	constructor(tag, attrs = {}, inner = '') {
		this.tag = tag
		this.attrs = { ...attrs }
		this.inner = inner
		this.children = []
	}

	append(child) {
		this.children.push(child)
		return child
	}

	/** The exporter branches on `el.tagName === 'IMG'`; keep that honest. */
	get tagName() {
		return this.tag.toUpperCase()
	}

	get outerHTML() {
		const attrs = Object.entries(this.attrs)
			.map(([name, value]) => ` ${name}="${String(value).replace(/"/g, '&quot;')}"`)
			.join('')
		const kids = this.children.map(child => child.outerHTML).join('')
		return `<${this.tag}${attrs}>${this.inner}${kids}</${this.tag}>`
	}

	cloneNode() {
		const copy = new FakeEl(this.tag, this.attrs, this.inner)
		copy.children = this.children.map(child => child.cloneNode())
		return copy
	}

	getAttribute(name) {
		return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null
	}

	setAttribute(name, value) {
		this.attrs[name] = String(value)
	}

	removeAttribute(name) {
		delete this.attrs[name]
	}

	querySelectorAll(selector) {
		const wanted = selector
			.split(',')
			.map(part => part.trim())
			.filter(Boolean)
		const matches = el =>
			wanted.some(rule => {
				if (rule.startsWith('[') && rule.includes('style*="url("')) {
					return typeof el.attrs.style === 'string' && el.attrs.style.includes('url(')
				}
				return el.tag.toLowerCase() === rule.toLowerCase()
			})
		const out = []
		const walk = el => {
			for (const child of el.children) {
				if (matches(child)) out.push(child)
				walk(child)
			}
		}
		walk(this)
		return out
	}
}

/* ------------------------------------------------------------- fixtures -- */

const VAULT_ID = 'v1abc'
const CSS_ORIGIN = `app://${VAULT_ID}/.obsidian/themes/Test.css`
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

function makeApp(files) {
	const writes = new Map()
	const mkdirs = []
	const bytes = new Map(Object.entries(files))
	const adapter = {
		exists: async p => writes.has(p) || mkdirs.includes(p) || bytes.has(p),
		write: async (p, text) => {
			writes.set(p, text)
		},
		read: async p => {
			if (!writes.has(p)) throw new Error(`no such file: ${p}`)
			return writes.get(p)
		},
		readBinary: async p => {
			if (!bytes.has(p)) throw new Error(`no such file: ${p}`)
			return bytes.get(p).buffer.slice(0)
		},
		mkdir: async p => {
			mkdirs.push(p)
		}
	}
	const vaultFiles = Object.keys(files).map(
		p =>
			new (class {
				constructor() {
					this.path = p
					this.name = p.split('/').pop()
					this.basename = this.name.replace(/\.[^.]+$/, '')
					this.stat = { size: files[p].length }
				}
			})()
	)
	return {
		writes,
		mkdirs,
		vault: {
			adapter,
			getAbstractFileByPath: p => vaultFiles.find(f => f.path === p) ?? null,
			getFiles: () => vaultFiles
		}
	}
}

/** A sizer that carries every shape the exporter has to preserve. */
function makeSnapshot() {
	const sizer = new FakeEl('div', { class: 'markdown-preview-sizer' })
	sizer.append(new FakeEl('h1', {}, '开篇大标题'))
	sizer.append(new FakeEl('h4', { class: 'heading-h4-center' }, 'A) 第一步'))
	sizer.append(
		new FakeEl(
			'p',
			{},
			'正文 <mark class="ch-reading-highlight-yellow">高亮</mark> 与 ' +
				'<span class="sidenote-number" data-sidenote-num="1">句子' +
				'<span class="sidenote">侧注内容</span>' +
				'<small class="sidenote-margin">侧注内容</small></span> 结尾'
		)
	)
	sizer.append(new FakeEl('img', { src: `app://${VAULT_ID}/media/pic.png`, alt: '图' }))
	sizer.append(
		new FakeEl('img', { src: 'app://obsidian.md/lib/icon.svg', alt: '应用图标' })
	)
	sizer.append(
		new FakeEl('div', { style: 'background-image:url("app://' + VAULT_ID + '/media/bg.png")' })
	)
	sizer.append(
		new FakeEl('mjx-container', { jax: 'CHTML' }, '<mjx-c>公式</mjx-c>')
	)

	return {
		sizer,
		captureWidth: 900,
		noteTitle: '分享测试笔记',
		notePath: 'notes/share-test.md',
		root: {
			className: 'theme-dark',
			style: '--file-line-width: 700px',
			data: { 'data-ch-highlight-style': 'rounded' },
			bodyClassName: 'theme-dark',
			bodyStyle: '--accent-h: 200',
			bodyData: { 'data-ch-color-mode': 'native' }
		},
		reading: {
			className: 'markdown-reading-view',
			style: '--sidenote-width: 200px',
			data: { 'data-sidenote-mode': 'hidden' }
		},
		preview: {
			className: 'markdown-preview-view is-readable-line-width',
			style: '',
			data: {}
		},
		sidenotes: { margin: 1, inline: 0, room: 280 },
		stats: { math: 1, images: 2, mermaid: 0, sidenotes: 1, blocks: 5 }
	}
}

function makeCss() {
	return {
		chunks: [
			{
				origin: CSS_ORIGIN,
				text:
					'body { background: url("app://' +
					VAULT_ID +
					'/media/bg.png"); }\n' +
					'mark.ch-reading-highlight-yellow { background: #ffd700; }\n' +
					'@font-face { font-family: MJX; src: url("/lib/mathjax/MathJax_Main-Regular.woff") format("woff"); }'
			}
		],
		inlineFonts: new Map([
			['/lib/mathjax/MathJax_Main-Regular.woff', 'data:font/woff;base64,QUJD']
		]),
		sheets: [{ origin: CSS_ORIGIN }],
		warnings: [],
		theme: { name: 'Test', version: '1.0', snippets: [] }
	}
}

/* ------------------------------------------------------------------ run -- */

prepareObsidianStub()

const rm = await bundle('src/assets/resource-manager.ts', 'share-rm')
const single = await bundle('src/export/single-file.ts', 'share-single')
const exporter = await bundle('src/export/exporter.ts', 'share-exporter')

console.log('\n单文件分享模式（share）')

/* --- base64 / data URL -------------------------------------------------- */

await check('base64Of 与 Buffer 逐字节一致（含 1/2 字节余数）', () => {
	for (const length of [0, 1, 2, 3, 4, 5, 255, 1000]) {
		const bytes = new Uint8Array(length)
		for (let i = 0; i < length; i++) bytes[i] = (i * 37) & 0xff
		const expected = Buffer.from(bytes).toString('base64')
		const actual = rm.base64Of(bytes)
		assert(actual === expected, `长度 ${length}: 期望 ${expected.slice(0, 24)}… 实际 ${actual.slice(0, 24)}…`)
	}
})

await check('toDataUrl 按扩展名给出 MIME（未知扩展名不猜成图片）', () => {
	assert(
		rm.toDataUrl(PNG_BYTES, 'media/pic.PNG').startsWith('data:image/png;base64,'),
		'png（大写扩展名）'
	)
	assert(
		rm.toDataUrl(PNG_BYTES, 'a/b/c.jpg').startsWith('data:image/jpeg;base64,'),
		'jpg → image/jpeg'
	)
	assert(
		rm.toDataUrl(PNG_BYTES, 'a/pic').startsWith('data:application/octet-stream;base64,'),
		'无扩展名不能伪装成图片'
	)
})

/* --- inline collector --------------------------------------------------- */

await check('inline 模式返回标记而不是文件名，且不写盘', async () => {
	const app = makeApp({ 'media/pic.png': PNG_BYTES })
	const collector = new rm.AssetCollector(app, { inline: true })
	assert(collector.isInline === true, 'isInline')
	const value = collector.resolve(`app://${VAULT_ID}/media/pic.png`, 'assets/media/', 'html', 'content')
	assert(
		typeof value === 'string' && value.startsWith(rm.INLINE_TOKEN_PREFIX),
		`应返回标记，实际 ${value}`
	)
	assert(!String(value).includes('assets/media/'), 'inline 模式不应带路径前缀')
	assert(app.writes.size === 0, 'resolve 不应写盘')
	equal(collector.registered.length, 1, '登记 1 个文件')
})

await check('inline 模式 flush() 明确失败，不会偷偷建 assets 目录', async () => {
	const app = makeApp({ 'media/pic.png': PNG_BYTES })
	const collector = new rm.AssetCollector(app, { inline: true })
	collector.resolve(`app://${VAULT_ID}/media/pic.png`, '', 'html', 'content')
	let threw = false
	try {
		await collector.flush('share/assets/media')
	} catch {
		threw = true
	}
	assert(threw, 'flush 应抛错')
	assert(app.writes.size === 0, '不应写任何文件')
})

await check('materializeInline 读文件并给出 data URL；读取失败记 missing 且不产生 URL', async () => {
	const flaky = makeApp({ 'media/pic.png': PNG_BYTES, 'media/broken.png': PNG_BYTES })
	// 文件存在（能登记），但读取时失败——这才是"登记了却没内嵌"的真实路径。
	const original = flaky.vault.adapter.readBinary
	flaky.vault.adapter.readBinary = async p => {
		if (p === 'media/broken.png') throw new Error('EACCES')
		return original(p)
	}
	const collector = new rm.AssetCollector(flaky, { inline: true })
	const marker = collector.resolve(`app://${VAULT_ID}/media/pic.png`, '', 'html', 'content')
	const broken = collector.resolve(`app://${VAULT_ID}/media/broken.png`, '', 'html', 'content')
	assert(broken && broken !== marker, '第二个有自己的标记')
	const map = await collector.materializeInline()
	assert(map.get(marker).startsWith('data:image/png;base64,'), 'png 已转 data URL')
	assert(!map.has(broken), '读取失败不产生 data URL')
	const failed = collector.missing.filter(m => m.kind === 'copy-failed')
	equal(failed.length, 1, '记 1 条失败')
	assert(failed[0].reason.includes('EACCES'), '失败原因应保留原始错误')
})

/* --- buildSingleFile ---------------------------------------------------- */

const app = makeApp({
	'media/pic.png': PNG_BYTES,
	'media/bg.png': PNG_BYTES
})
const built = await single.buildSingleFile(app, makeSnapshot(), makeCss(), {})

await check('样式表内联，没有指向 assets/ 的 <link>', () => {
	match(built.html, /<style>[\s\S]*markdown-preview-sizer[\s\S]*<\/style>|<style>/, '存在 <style>')
	assert(!/<link[^>]+rel="stylesheet"/i.test(built.html), '不得有 stylesheet link')
	assert(!built.html.includes('assets/export.css'), '不得引用 export.css')
})

await check('图片与 CSS 背景都变成 data URL', () => {
	match(built.html, /<img src="data:image\/png;base64,[A-Za-z0-9+/=]+" alt="图">/, '正文图片已内嵌')
	match(built.html, /background: url\("data:image\/png;base64,[A-Za-z0-9+/=]+"\)/, 'CSS 背景已内嵌')
	equal(built.stats.mediaEmbedded, 2, '内嵌 2 个文件（正文图 + 背景图）')
})

await check('MathJax 字体保持 data URL，公式离线可用', () => {
	match(built.html, /@font-face[\s\S]*data:font\/woff;base64,QUJD/, '字体已内联')
	assert(built.stats.inlineFonts === 1, `inlineFonts 应为 1，实际 ${built.stats.inlineFonts}`)
	assert(!built.html.includes('/lib/mathjax'), '不得残留 app 内置路径')
})

await check('不泄露本机路径：app:// / file:// / 盘符 / 样式表来源注释', () => {
	assert(!built.html.includes('app://'), '不得出现 app://')
	assert(!/file:\/\//i.test(built.html), '不得出现 file://')
	assert(!/[A-Za-z]:[\\/](?:Users|Obsidian)/.test(built.html), '不得出现盘符路径')
	assert(!built.html.includes('data-he-original-src'), '不得保留原始本地 URL 备份属性')
	assert(!/\/\* ==== app:\/\//.test(built.html), '不得带 sheet origin 注释')
	assert(!built.html.includes(VAULT_ID), '不得泄露 vault id')
})

await check('不写清单、不写审计、不带密钥', () => {
	assert(!built.html.includes('export-manifest'), '不得含 manifest 字样')
	assert(!built.html.includes('runtime-audit'), '不得含 audit 字样')
	assert(!built.html.includes('signature'), '不得含签名块')
	assert(app.writes.size === 0, 'buildSingleFile 不应写任何文件')
})

await check('正文、标题、高亮、侧注、公式全部保留', () => {
	assert(built.html.includes('开篇大标题'), '大标题')
	assert(built.html.includes('A) 第一步'), 'A/B/C 小标题')
	assert(built.html.includes('ch-reading-highlight-yellow'), '高亮 class')
	assert(built.html.includes('class="sidenote"'), '侧注行内副本')
	assert(built.html.includes('sidenote-margin'), '侧注栏副本')
	assert(built.html.includes('data-sidenote-num="1"'), '侧注编号')
	assert(built.html.includes('mjx-container'), '公式容器')
	assert(built.html.includes('data-he-sidenotes="1"'), '侧注栏标记')
	match(built.html, /<!--he-body-start-->[\s\S]+<!--he-body-end-->/, '正文标记完整')
})

await check('应用内置资源记为 external，不算正文缺失', () => {
	// `app://obsidian.md/lib/icon.svg` 属于 app.asar，永远不在 vault 里。
	assert(built.html.includes('data:image/gif;base64,'), '缺失图标用占位图，不产生破图请求')
	equal(built.stats.missingContent, 0, '应用内置资源不计入正文缺失')
})

await check('残留标记会让构建失败，而不是发出坏文件', async () => {
	// 一个 note 恰好包含标记文本 → 替换后仍有残留 → 必须中止。
	const trap = makeSnapshot()
	trap.sizer.append(new FakeEl('p', {}, `含字面量 ${rm.INLINE_TOKEN_PREFIX}9% 的段落`))
	let threw = null
	try {
		await single.buildSingleFile(
			makeApp({ 'media/pic.png': PNG_BYTES, 'media/bg.png': PNG_BYTES }),
			trap,
			makeCss(),
			{}
		)
	} catch (error) {
		threw = error
	}
	assert(threw, '应抛错')
	match(String(threw.message), /残留未解析的资源标记/, '错误信息应说明原因')
})

/* --- writing ------------------------------------------------------------ */

await check('shareRootFor 始终是导出目录的同级目录', () => {
	equal(single.shareRootFor('html-export'), 'html-export-share', '默认')
	equal(single.shareRootFor('html-export/'), 'html-export-share', '去尾斜杠')
	equal(single.shareRootFor(''), 'html-export-share', '空值回退')
	equal(single.shareRootFor('.'), 'html-export-share', '根目录不产生 ".-share"')
	equal(single.shareRootFor('a/b'), 'a/b-share', '多级目录保持同级')
})

await check('适配器没有独占创建能力：拒绝写入，且不创建目录、不降级覆盖', async () => {
	// 这条把"安全发布"固定成硬约束：任何不能保证"绝不覆盖"的适配器都必须
	// 被拒绝，而不是退回 `exists()` + `write()`（那正是可以覆盖同名文件的写法）。
	// 真实文件系统上的发布流程见 run-share-safe.mjs。
	const fresh = makeApp({})
	let threw = null
	try {
		await single.writeShareFile(fresh, '<html>x</html>', 'html-export', '笔记', 'a.md')
	} catch (error) {
		threw = error
	}
	assert(threw, '应抛错')
	equal(threw.name, 'ShareWriteError', '错误类型')
	equal(threw.stage, '适配器', '失败阶段')
	match(threw.message, /绝不覆盖/, '说明拒绝原因')
	assert(!/[一-龥]*-share/.test([...fresh.mkdirs].join(',')), '拒绝发生在创建目录之前')
	equal(fresh.writes.size, 0, '没有写入任何字节')
})

/* --- export mode unchanged ---------------------------------------------- */

await check('目录导出模式仍然链接样式表（未被 share 改动）', () => {
	const html = exporter.buildHtml(makeSnapshot(), {
		mode: 'export',
		cssText: '',
		assets: new rm.AssetCollector(makeApp({ 'media/pic.png': PNG_BYTES }))
	})
	assert(
		html.includes('<link rel="stylesheet" href="assets/export.css">'),
		'export 模式应保留 <link>'
	)
	assert(!html.includes('mark.ch-reading-highlight-yellow'), 'export 模式不应把样式表正文内联')
})

await check('目录导出仍然保留 data-he-original-src（诊断需要）', () => {
	const app2 = makeApp({ 'media/pic.png': PNG_BYTES })
	const html = exporter.buildHtml(makeSnapshot(), {
		mode: 'export',
		cssText: '',
		assets: new rm.AssetCollector(app2)
	})
	assert(html.includes('data-he-original-src'), 'export 模式保留原始 URL 以便排查')
})

/* --- P2：用户在编辑器里设的排版必须写进最终 HTML -------------------------- */

await check('目录导出：内容大小 / 正文宽度 / 背景写入生成的 <style>', () => {
	const app3 = makeApp({ 'media/pic.png': PNG_BYTES })
	const html = exporter.buildHtml(makeSnapshot(), {
		mode: 'export',
		cssText: '',
		assets: new rm.AssetCollector(app3),
		layout: {
			zoom: 1.5,
			contentMaxWidth: 900,
			background: 'white',
			pageLayout: 'adaptive-center',
			imageAlign: 'center',
			mermaidAlign: 'center',
			mermaidScale: 1
		}
	})
	match(html, /--he-zoom:\s*1\.5/, '内容大小写入文档')
	match(html, /--he-content-max-width:\s*900px/, '正文宽度写入文档')
	match(html, /background:\s*#ffffff\s*!important/, '背景写入文档')
	match(html, /data-he-zoom="1\.5"/, '根元素带缩放标记')
	// 该 fixture 是深色主题：白底必须同时给出深色文字调色，否则不可读。
	match(html, /--text-normal:\s*#1b1b1b/, '深色主题 + 浅色背景时重述文字颜色')
})

await check('单文件分享：同一套排版同样写入（两条管线不漂移）', async () => {
	const layout = {
		zoom: 1.25,
		contentMaxWidth: 800,
		background: 'custom',
		backgroundColor: '#f5f0e6',
		pageLayout: 'adaptive-center',
		imageAlign: 'as-is',
		mermaidAlign: 'as-is',
		mermaidScale: 1
	}
	const built = await single.buildSingleFile(
		makeApp({ 'media/pic.png': PNG_BYTES, 'media/bg.png': PNG_BYTES }),
		makeSnapshot(),
		makeCss(),
		{ layout }
	)
	match(built.html, /--he-zoom:\s*1\.25/, '分享文件也带内容大小')
	match(built.html, /--he-content-max-width:\s*800px/, '分享文件也带正文宽度')
	match(built.html, /#f5f0e6/, '分享文件也带自定义背景')
	equal(built.layout.zoom, 1.25, 'buildSingleFile 回报的 layout 与入参一致')
})

await check('非法背景色不能注入声明（只接受 hex）', () => {
	const html = exporter.buildHtml(makeSnapshot(), {
		mode: 'export',
		cssText: '',
		assets: new rm.AssetCollector(makeApp({ 'media/pic.png': PNG_BYTES })),
		layout: {
			background: 'custom',
			backgroundColor: 'red;}</style><script>alert(1)</script>'
		}
	})
	assert(!html.includes('alert(1)'), '注入内容不得进入产物')
	assert(!html.includes('red;}'), '非法颜色被丢弃')
	match(html, /background:\s*#ffffff/, '非法值退化为白色')
})

/* --- summary ------------------------------------------------------------ */

console.log(
	`\n${failures.length === 0 ? '✓' : '✗'} ${passed} 项通过${
		failures.length ? `，${failures.length} 项失败` : ''
	}`
)
if (failures.length) {
	for (const failure of failures) console.log(`  · ${failure.name}: ${failure.message}`)
	process.exit(1)
}
