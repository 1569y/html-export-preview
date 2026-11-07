/**
 * Share mode, round 2: safe publishing + strict self-containment + privacy.
 *
 * The first suite (`run-share-single.mjs`) pins *what the file contains*. This
 * one pins the three things that decide whether the file may be handed to
 * someone else at all:
 *
 *   1. **Publishing never destroys a file.** A real filesystem is used here on
 *      purpose — the guarantee rests on an exclusive create (`open(…, "wx")`),
 *      and a mocked adapter would happily "pass" an implementation that
 *      overwrites. The suite also fakes the two failures that matter: bytes
 *      that change between write and read-back, and a name that is taken
 *      between the decision and the publish.
 *   2. **A document that needs the network is refused, not written.** Remote
 *      images, remote iframes and missing vault files abort the build; remote
 *      *stylesheet* resources are neutralised and reported. Nothing third-party
 *      is fetched while exporting.
 *   3. **Nothing local survives.** `obsidian://`, `data-href`, executable
 *      attributes and `srcdoc` are removed or refused — with the note's text,
 *      highlights, sidenotes and formulas untouched.
 *
 * Run with: node tests/unit/run-share-safe.mjs
 */
import { build } from 'esbuild'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
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
	if (!regex.test(String(value))) throw new Error(`${label}: ${regex} 未匹配`)
}

async function expectThrow(fn, label) {
	try {
		await fn()
	} catch (error) {
		return error
	}
	throw new Error(`${label}: 期望抛错，实际成功`)
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

/**
 * The ESM test bundle has no `require`, but the share publisher resolves
 * `node:fs` lazily through it (so a mobile load never pays for a feature that
 * has not been run). Supplying a real `require` here exercises the production
 * code path instead of replacing it.
 */
globalThis.require = createRequire(import.meta.url)

const stubUrl = prepareObsidianStub()
const stub = await import(stubUrl)

const single = await bundle('src/export/single-file.ts', 'safe-single')
const publish = await bundle('src/export/share-publish.ts', 'safe-publish')
const sanitize = await bundle('src/export/share-sanitize.ts', 'safe-sanitize')
const audit = await bundle('src/export/share-audit.ts', 'safe-audit')
const srcset = await bundle('src/export/srcset.ts', 'safe-srcset')
const cssMod = await bundle('src/css/css-collector.ts', 'safe-css')
const dom = await import(pathToFileURL(path.join(here, 'dom-double.mjs')).href)

function sha256(buffer) {
	return crypto.createHash('sha256').update(buffer).digest('hex')
}

/* ------------------------------------------------------- real filesystem -- */

const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'he-share-safe-'))

function workDir(name) {
	const dir = path.join(workRoot, name)
	fs.mkdirSync(dir, { recursive: true })
	return dir
}

/** A vault adapter over a real directory, matching Obsidian's desktop shape. */
function makeFsAdapter(base) {
	const abs = p => path.join(base, ...String(p).split('/').filter(Boolean))
	const adapter = {
		getBasePath: () => base,
		exists: async p => {
			try {
				await fs.promises.access(abs(p))
				return true
			} catch {
				return false
			}
		},
		mkdir: async p => {
			await fs.promises.mkdir(abs(p), { recursive: true })
		},
		read: async p => fs.promises.readFile(abs(p), 'utf8'),
		write: async (p, text) => {
			await fs.promises.mkdir(path.dirname(abs(p)), { recursive: true })
			await fs.promises.writeFile(abs(p), text, 'utf8')
		},
		readBinary: async p => {
			const buffer = await fs.promises.readFile(abs(p))
			return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
		},
		writeBinary: async (p, data) => {
			const bytes = data instanceof ArrayBuffer ? Buffer.from(new Uint8Array(data)) : Buffer.from(data)
			await fs.promises.mkdir(path.dirname(abs(p)), { recursive: true })
			await fs.promises.writeFile(abs(p), bytes)
		},
		remove: async p => fs.promises.unlink(abs(p)),
		rmdir: async (p, recursive) =>
			fs.promises.rm(abs(p), { recursive: Boolean(recursive), force: false }),
		list: async p => {
			const entries = await fs.promises.readdir(abs(p), { withFileTypes: true })
			return {
				files: entries.filter(e => e.isFile()).map(e => `${p}/${e.name}`),
				folders: entries.filter(e => e.isDirectory()).map(e => `${p}/${e.name}`)
			}
		},
		stat: async p => {
			const s = await fs.promises.stat(abs(p))
			return { size: s.size, mtime: s.mtimeMs, ctime: s.ctimeMs }
		}
	}
	return { adapter, abs }
}

function appFor(adapter, files = {}) {
	const vaultFiles = Object.entries(files).map(([p, size]) => ({
		path: p,
		name: p.split('/').pop(),
		stat: { size }
	}))
	return {
		vault: {
			adapter,
			getAbstractFileByPath: p => vaultFiles.find(f => f.path === p) ?? null,
			getFiles: () => vaultFiles
		}
	}
}

function listHtml(dir) {
	if (!fs.existsSync(dir)) return []
	return fs
		.readdirSync(dir)
		.filter(name => name.endsWith('.html'))
		.sort()
}

/* -------------------------------------------------------- build fixtures -- */

const VAULT_ID = 'v1abc'
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

function memoryApp(files) {
	const bytes = new Map(Object.entries(files))
	const writes = new Map()
	const adapter = {
		writes,
		exists: async p => bytes.has(p) || writes.has(p),
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
		mkdir: async () => undefined
	}
	return appFor(adapter, Object.fromEntries(Object.entries(files).map(([p, v]) => [p, v.length])))
}

function makeSnapshot(children, extra = {}) {
	const sizer = new dom.El('div')
	sizer.setAttribute('class', 'markdown-preview-sizer')
	for (const child of children) sizer.append(child)
	return {
		sizer,
		captureWidth: 900,
		noteTitle: '安全分享测试',
		notePath: 'notes/safe-share.md',
		root: {
			className: 'theme-dark',
			style: '--file-line-width: 700px',
			data: {},
			bodyClassName: 'theme-dark',
			bodyStyle: '--accent-h: 200',
			bodyData: {}
		},
		reading: { className: 'markdown-reading-view', style: '', data: {} },
		preview: { className: 'markdown-preview-view', style: '', data: {} },
		sidenotes: { margin: 1, inline: 0, room: 280 },
		stats: { math: 1, images: 1, mermaid: 0, sidenotes: 1, blocks: 3 },
		...extra
	}
}

function makeCss(text = 'body { color: #222; }', extra = {}) {
	return {
		chunks: [{ origin: `app://${VAULT_ID}/.obsidian/themes/T.css`, text }],
		inlineFonts: new Map(),
		sheets: [],
		warnings: [],
		theme: { name: 'T', version: '1', snippets: [] },
		remoteImports: [],
		offline: true,
		...extra
	}
}

/* ======================================================================== *
 * 1. Publishing on a real filesystem
 * ======================================================================== */

console.log('\n安全发布（真实文件系统）')

await check('路径规则：同级目录，越界/绝对/盘符一律拒绝', () => {
	equal(publish.resolveShareDir('html-export').dir, 'html-export-share', '默认')
	equal(publish.resolveShareDir('a/b').dir, 'a/b-share', '多级')
	equal(publish.resolveShareDir('.').dir, 'html-export-share', 'Vault 根')

	for (const bad of ['..', '../outside', 'a/../../b', '/abs', 'C:/example/test', '\\\\server\\share']) {
		const error = (() => {
			try {
				publish.resolveShareDir(bad)
				return null
			} catch (e) {
				return e
			}
		})()
		assert(error, `${bad} 应被拒绝`)
		equal(error.name, 'PathEscapeError', `${bad} 的错误类型`)
	}
})

await check('首写：临时文件 → 读回校验 → 独占创建 → 再读回；字节与 SHA-256 一致', async () => {
	const base = workDir('first')
	const { adapter } = makeFsAdapter(base)
	const app = appFor(adapter)
	const html = '<!doctype html><p>你好，世界</p>'
	const result = await publish.writeShareFile(app, html, 'html-export', '安全分享测试', 'notes/safe-share.md')

	match(result.path, /^html-export-share\/安全分享测试-[0-9a-f]{12}\.html$/, '路径形状')
	equal(result.renamed, false, '未改名')
	const disk = fs.readFileSync(path.join(base, ...result.path.split('/')))
	equal(disk.toString('utf8'), html, '内容逐字节一致')
	equal(result.sha256, sha256(disk), 'SHA-256 与实际文件一致')
	equal(result.bytes, Buffer.byteLength(html), '字节数按 UTF-8 计')
	const leftovers = fs
		.readdirSync(path.join(base, 'html-export-share'))
		.filter(name => name.startsWith('.he-tmp-'))
	equal(leftovers.length, 0, '临时目录已清理')
	equal(result.leftoverTemp, null, '没有未清理的临时目录')
})

await check('同名已存在：写入 -2，旧文件字节完全不变', async () => {
	const base = workDir('second')
	const { adapter } = makeFsAdapter(base)
	const app = appFor(adapter)
	const first = await publish.writeShareFile(app, 'one', 'html-export', '笔记', 'a.md')
	const originalBytes = fs.readFileSync(path.join(base, ...first.path.split('/')))
	const second = await publish.writeShareFile(app, 'two', 'html-export', '笔记', 'a.md')

	equal(second.path, first.path.replace(/\.html$/, '-2.html'), '改用 -2')
	equal(second.renamed, true, '标记为改名')
	equal(
		fs.readFileSync(path.join(base, ...first.path.split('/'))).equals(originalBytes),
		true,
		'旧文件没有被改写'
	)
	equal(listHtml(path.join(base, 'html-export-share')).length, 2, '两个文件都在')
})

await check('竞态：即使 exists() 撒谎说"名字空着"，也不会覆盖已存在的文件', async () => {
	// 这正是旧实现（exists + write）的漏洞：TOCTOU。now-exists 永远返回
	// false，模拟"检查之后、写入之前"文件被别人创建。独占创建必须兜住。
	const base = workDir('race')
	const { adapter } = makeFsAdapter(base)
	const app = appFor(adapter)
	const first = await publish.writeShareFile(app, 'original', 'html-export', '笔记', 'a.md')

	const before = fs.readFileSync(path.join(base, ...first.path.split('/')))
	adapter.exists = async () => false
	const second = await publish.writeShareFile(app, 'intruder', 'html-export', '笔记', 'a.md')

	assert(second.path !== first.path, '不得复用已占用的名字')
	equal(second.path, first.path.replace(/\.html$/, '-2.html'), '改用 -2')
	equal(
		fs.readFileSync(path.join(base, ...first.path.split('/'))).toString('utf8'),
		before.toString('utf8'),
		'原文件内容未被覆盖'
	)
})

await check('并发：两次同时发布得到两个文件，内容各自完整', async () => {
	const base = workDir('concurrent')
	const { adapter } = makeFsAdapter(base)
	const app = appFor(adapter)
	const a = '<p>A</p>'.repeat(500)
	const b = '<p>B</p>'.repeat(500)
	const [ra, rb] = await Promise.all([
		publish.writeShareFile(app, a, 'html-export', '笔记', 'a.md'),
		publish.writeShareFile(app, b, 'html-export', '笔记', 'a.md')
	])
	assert(ra.path !== rb.path, '两个路径必须不同')
	equal(fs.readFileSync(path.join(base, ...ra.path.split('/')), 'utf8'), a, 'A 完整')
	equal(fs.readFileSync(path.join(base, ...rb.path.split('/')), 'utf8'), b, 'B 完整')
	equal(listHtml(path.join(base, 'html-export-share')).length, 2, '两个文件')
})

await check('临时文件读回不一致：中止，且没有任何正式文件', async () => {
	const base = workDir('temp-mismatch')
	const { adapter } = makeFsAdapter(base)
	const app = appFor(adapter)
	const original = adapter.readBinary
	adapter.readBinary = async p =>
		p.includes('.he-tmp-') ? new Uint8Array([1, 2, 3]).buffer : original(p)

	const error = await expectThrow(
		() => publish.writeShareFile(app, '<p>x</p>', 'html-export', '笔记', 'a.md'),
		'临时文件校验'
	)
	equal(error.name, 'ShareWriteError', '错误类型')
	equal(error.stage, '写入校验', '失败阶段')
	match(error.message, /没有发布任何文件/, '明确说明未发布')
	equal(listHtml(path.join(base, 'html-export-share')).length, 0, '目录里没有 .html')
	const leftovers = fs
		.readdirSync(path.join(base, 'html-export-share'))
		.filter(name => name.startsWith('.he-tmp-'))
	equal(leftovers.length, 0, '临时目录已清理')
})

await check('发布后校验失败：删除刚创建的文件并报错，不把半成品当成功', async () => {
	const base = workDir('publish-mismatch')
	const { adapter } = makeFsAdapter(base)
	const app = appFor(adapter)
	const original = adapter.readBinary
	adapter.readBinary = async p => {
		if (p.includes('.he-tmp-')) return original(p)
		if (p.endsWith('.html')) return new Uint8Array([9, 9]).buffer
		return original(p)
	}

	const error = await expectThrow(
		() => publish.writeShareFile(app, '<p>x</p>', 'html-export', '笔记', 'a.md'),
		'发布后校验'
	)
	equal(error.stage, '发布', '失败阶段')
	match(error.message, /已删除该文件/, '说明已清理')
	equal(listHtml(path.join(base, 'html-export-share')).length, 0, '没有留下半成品')
})

await check('临时目录清理失败：结果里如实报告，不静默忽略', async () => {
	const base = workDir('temp-leftover')
	const { adapter } = makeFsAdapter(base)
	const app = appFor(adapter)
	adapter.rmdir = async () => {
		throw new Error('EBUSY')
	}
	const result = await publish.writeShareFile(app, '<p>x</p>', 'html-export', '笔记', 'a.md')
	assert(result.leftoverTemp, '应报告残留目录')
	match(result.leftoverTemp, /\.he-tmp-/, '残留路径形状')
	assert(fs.existsSync(path.join(base, ...result.leftoverTemp.split('/'))), '目录确实还在')
	// 文件本身已经校验通过，仍然可用。
	equal(
		fs.readFileSync(path.join(base, ...result.path.split('/')), 'utf8'),
		'<p>x</p>',
		'正式文件仍然完整'
	)
})

await check('名称用尽：报错并且不再写第 N+1 个', async () => {
	const base = workDir('exhausted')
	const { adapter } = makeFsAdapter(base)
	const app = appFor(adapter)
	await publish.writeShareFile(app, 'one', 'html-export', '笔记', 'a.md')
	await publish.writeShareFile(app, 'two', 'html-export', '笔记', 'a.md')
	const error = await expectThrow(
		() => publish.writeShareFile(app, 'three', 'html-export', '笔记', 'a.md', 1),
		'名称用尽'
	)
	equal(error.stage, '发布', '失败阶段')
	match(error.message, /为避免覆盖/, '说明原因')
	equal(listHtml(path.join(base, 'html-export-share')).length, 2, '没有新增文件')
})

await check('没有独占创建能力：拒绝，且不创建目录', async () => {
	const base = workDir('no-exclusive')
	const adapter = { exists: async () => false, mkdir: async () => undefined }
	const error = await expectThrow(
		() => publish.writeShareFile(appFor(adapter), '<p>x</p>', 'html-export', '笔记', 'a.md'),
		'适配器拒绝'
	)
	equal(error.stage, '适配器', '失败阶段')
	match(error.message, /绝不覆盖/, '拒绝理由')
	equal(fs.existsSync(path.join(base, 'html-export-share')), false, '没有创建目录')
})

/* ======================================================================== *
 * 2. Strict self-containment
 * ======================================================================== */

console.log('\n严格自包含（远程 / 缺失资源）')

const cssOk = () => makeCss()
const baseImg = () => new dom.El('img')
baseImg().setAttribute('src', `app://${VAULT_ID}/media/pic.png`)

function localImage() {
	const img = new dom.El('img')
	img.setAttribute('src', `app://${VAULT_ID}/media/pic.png`)
	img.setAttribute('alt', '图')
	return img
}

await check('远程图片：拒绝发布，并指出是哪一处（不写文件）', async () => {
	const img = new dom.El('img')
	img.setAttribute('src', 'https://example.com/a.png')
	const app = memoryApp({ 'media/pic.png': PNG_BYTES })
	const error = await expectThrow(
		() =>
			single.buildSingleFile(app, makeSnapshot([localImage(), img]), cssOk(), {}),
		'远程图片'
	)
	equal(error.name, 'ShareRefusedError', '错误类型')
	assert(error.blockers.some(b => b.kind === 'remote'), '远程资源被记录为阻断项')
	match(error.message, /没有写入任何文件/, '明确说明未写入')
	match(error.message, /example\.com/, '指出具体 URL')
	equal(app.vault.adapter.writes?.size ?? 0, 0, '构建不写盘')
})

await check('协议相对图片 (//cdn)：同样视为远程并阻断', async () => {
	const img = new dom.El('img')
	img.setAttribute('src', '//cdn.example.com/a.png')
	const error = await expectThrow(
		() =>
			single.buildSingleFile(
				memoryApp({ 'media/pic.png': PNG_BYTES }),
				makeSnapshot([img]),
				cssOk(),
				{}
			),
		'协议相对'
	)
	assert(error.blockers.some(b => b.kind === 'remote'), '记为远程')
})

await check('缺失的 Vault 图片：not-found 阻断', async () => {
	const img = new dom.El('img')
	img.setAttribute('src', `app://${VAULT_ID}/media/missing.png`)
	const error = await expectThrow(
		() =>
			single.buildSingleFile(
				memoryApp({ 'media/pic.png': PNG_BYTES }),
				makeSnapshot([img]),
				cssOk(),
				{}
			),
		'缺失文件'
	)
	assert(error.blockers.some(b => b.kind === 'not-found'), '记为 not-found')
})

await check('远程 iframe：阻断（展示依赖，不是超链接）', async () => {
	const frame = new dom.El('iframe')
	frame.setAttribute('src', 'https://www.youtube.com/embed/abc')
	const error = await expectThrow(
		() =>
			single.buildSingleFile(
				memoryApp({ 'media/pic.png': PNG_BYTES }),
				makeSnapshot([frame]),
				cssOk(),
				{}
			),
		'远程 iframe'
	)
	assert(error.blockers.some(b => b.kind === 'remote'), '记为远程')
})

await check('远程 CSS 资源：不阻断，但置空并计数（输出里没有 http）', async () => {
	const css = makeCss(
		'@font-face { font-family: X; src: url("https://fonts.example.com/x.woff2"); }\n' +
			'body { background: url(https://cdn.example.com/bg.png); }'
	)
	const built = await single.buildSingleFile(
		memoryApp({ 'media/pic.png': PNG_BYTES }),
		makeSnapshot([localImage()]),
		css,
		{}
	)
	assert(built.stats.remoteEnvironment >= 2, `远程样式资源计数，实际 ${built.stats.remoteEnvironment}`)
	assert(!/https?:\/\//.test(built.html), '正文/样式里不得残留 http(s) 引用')
	match(built.html, /url\("data:,"\)/, '置为惰性占位')
})

await check('远程 @import：不抓取，记录在 remoteImports 并给出警告', async () => {
	// 样式表收集层：`offline: true` 时不发请求。
	const styleEl = { tagName: 'STYLE', textContent: '@import url("https://cdn.example.com/x.css");\nbody{color:red}' }
	const sheet = { href: null, cssRules: null, ownerNode: styleEl }
	const previousDocument = globalThis.document
	const previousFetch = globalThis.fetch
	let fetched = 0
	globalThis.fetch = async () => {
		fetched++
		throw new Error('不允许在导出期间抓取第三方资源')
	}
	globalThis.document = {
		styleSheets: [sheet],
		adoptedStyleSheets: [],
		baseURI: `app://${VAULT_ID}/`
	}
	try {
		const collection = await cssMod.collectCss(memoryApp({}), { offline: true })
		equal(fetched, 0, '没有发起任何网络请求')
		equal(collection.remoteImports, ['https://cdn.example.com/x.css'], '记录远程 @import')
		assert(
			collection.warnings.some(w => w.includes('离线模式')),
			'给出明确警告'
		)
		assert(
			collection.chunks[0].text.includes('remote @import not fetched'),
			'用惰性注释替换，不静默丢弃'
		)
	} finally {
		globalThis.document = previousDocument
		globalThis.fetch = previousFetch
	}
})

await check('srcset：data URL 里的逗号不被当成分隔符（2 个候选都保住）', async () => {
	const parsed = srcset.parseSrcset(
		'data:image/png;base64,AAAA 1x, data:image/png;base64,BBBB 2x'
	)
	equal(parsed.length, 2, '候选数')
	equal(parsed[0].url, 'data:image/png;base64,AAAA', '候选 1 URL')
	equal(parsed[0].descriptor, '1x', '候选 1 描述符')
	equal(parsed[1].url, 'data:image/png;base64,BBBB', '候选 2 URL')
	equal(parsed[1].descriptor, '2x', '候选 2 描述符')
})

await check('srcset 内嵌：正文候选变成 data URL 且仍是两条', async () => {
	const img = new dom.El('img')
	img.setAttribute('src', `app://${VAULT_ID}/media/pic.png`)
	img.setAttribute(
		'srcset',
		`app://${VAULT_ID}/media/pic.png 1x, app://${VAULT_ID}/media/pic.png 2x`
	)
	const built = await single.buildSingleFile(
		memoryApp({ 'media/pic.png': PNG_BYTES }),
		makeSnapshot([img]),
		cssOk(),
		{}
	)
	const value = /srcset="([^"]*)"/.exec(built.html)?.[1] ?? ''
	const candidates = srcset.parseSrcset(value.replace(/&amp;/g, '&'))
	equal(candidates.length, 2, '两个候选')
	for (const candidate of candidates) {
		assert(candidate.url.startsWith('data:image/png;base64,'), '每个候选都是 data URL')
	}
})

await check('srcset 含远程候选：该候选被丢弃并阻断', async () => {
	const img = new dom.El('img')
	img.setAttribute('src', `app://${VAULT_ID}/media/pic.png`)
	img.setAttribute(
		'srcset',
		`app://${VAULT_ID}/media/pic.png 1x, https://example.com/a.png 2x`
	)
	const error = await expectThrow(
		() =>
			single.buildSingleFile(
				memoryApp({ 'media/pic.png': PNG_BYTES }),
				makeSnapshot([img]),
				cssOk(),
				{}
			),
		'srcset 远程'
	)
	assert(error.blockers.some(b => b.kind === 'remote'), '远程候选阻断')
})

/* ======================================================================== *
 * 3. Privacy and executable content
 * ======================================================================== */

console.log('\n隐私与可执行内容')

await check('内部链接：去掉 href / data-href，保留文字；https 链接保留', async () => {
	const internal = new dom.El('a')
	internal.setAttribute('href', `obsidian://open?file=${encodeURIComponent('Notes/A.md')}`)
	internal.setAttribute('class', 'internal-link')
	internal.setAttribute('data-href', 'Notes/A.md')
	internal.append({ text: '另一篇笔记' })

	const external = new dom.El('a')
	external.setAttribute('href', 'https://example.com/paper')
	external.append({ text: '参考文献' })

	const built = await single.buildSingleFile(
		memoryApp({ 'media/pic.png': PNG_BYTES }),
		makeSnapshot([localImage(), internal, external]),
		cssOk(),
		{}
	)

	assert(built.html.includes('另一篇笔记'), '保留可读文字')
	assert(!built.html.includes('obsidian://'), '不得残留 obsidian://')
	assert(!built.html.includes('data-href'), '不得残留 data-href')
	assert(!built.html.includes('Notes/A.md'), '不得泄露笔记路径')
	assert(built.html.includes('https://example.com/paper'), 'HTTPS 参考链接保留')
	assert(built.html.includes('data-he-unresolved="1"'), '标记为不可点击')
	equal(built.stats.privacy.internalLinks, 1, '内部链接计数')
	equal(built.stats.privacy.externalLinks, 1, '外部链接计数')
})

await check('脚本 / 事件属性：被移除并计数；srcdoc 被阻断', async () => {
	const script = new dom.El('script')
	script.append({ text: 'alert(1)' })
	const div = new dom.El('div')
	div.setAttribute('onclick', 'alert(2)')
	div.append({ text: '正文' })

	const ok = await single.buildSingleFile(
		memoryApp({ 'media/pic.png': PNG_BYTES }),
		makeSnapshot([localImage(), script, div]),
		cssOk(),
		{}
	)
	equal(ok.stats.privacy.scripts, 1, '移除 1 个脚本')
	equal(ok.stats.privacy.handlers, 1, '移除 1 个事件属性')
	assert(!ok.html.includes('alert(1)'), '脚本内容不得进入产物')
	assert(!ok.html.includes('onclick'), '事件属性不得进入产物')
	assert(ok.html.includes('正文'), '文字保留')

	const frame = new dom.El('iframe')
	frame.setAttribute('srcdoc', '<script>alert(3)</script>')
	const error = await expectThrow(
		() =>
			single.buildSingleFile(
				memoryApp({ 'media/pic.png': PNG_BYTES }),
				makeSnapshot([localImage(), frame]),
				cssOk(),
				{}
			),
		'srcdoc'
	)
	assert(error.blockers.some(b => b.kind === 'srcdoc'), 'srcdoc 记为阻断')
})

await check('产物不含本机路径 / Vault 标识 / 可执行标记', async () => {
	const built = await single.buildSingleFile(
		memoryApp({ 'media/pic.png': PNG_BYTES }),
		makeSnapshot([localImage()]),
		cssOk(),
		{}
	)
	const check1 = audit.auditShareDocument(built.html)
	equal(check1.display.length, 0, '没有未内嵌的展示依赖')
	equal(check1.localState.length, 0, '没有本机路径')
	equal(check1.executable.length, 0, '没有可执行内容')
	assert(!built.html.includes(VAULT_ID), '不得泄露 vault id')
	assert(!built.html.includes('app://'), '不得出现 app://')
	assert(!/file:\/\//i.test(built.html), '不得出现 file://')
	assert(!/[A-Za-z]:[\\/](?:Users|Obsidian)/.test(built.html), '不得出现盘符路径')
	// 反过来：审计必须真的能发现问题，否则"0 项"没有意义。
	const dirty = audit.auditShareDocument(
		'<img src="https://x/a.png"><a href="obsidian://open?file=A.md">A</a>' +
			'<p onclick="x()">t</p><style>p{background:url(app://v1/x.png)}</style>'
	)
	assert(dirty.display.length >= 2, `审计应发现展示依赖，实际 ${dirty.display.length}`)
	assert(dirty.executable.length >= 1, '审计应发现事件属性')
	assert(dirty.localState.length >= 1, '审计应发现 obsidian://')
})

await check('正文、高亮、侧注、公式全部保留（净化不删内容）', async () => {
	const p = new dom.El('p')
	p.append({ text: '正文 ' })
	const mark = new dom.El('mark')
	mark.setAttribute('class', 'ch-reading-highlight-yellow')
	mark.append({ text: '高亮' })
	p.append(mark)
	const note = new dom.El('span')
	note.setAttribute('class', 'sidenote-number')
	note.setAttribute('data-sidenote-num', '1')
	note.append({ text: '句子' })
	const side = new dom.El('span')
	side.setAttribute('class', 'sidenote')
	side.append({ text: '侧注内容' })
	note.append(side)
	p.append(note)
	const math = new dom.El('mjx-container')
	math.setAttribute('jax', 'CHTML')
	math.append({ text: '公式' })

	const built = await single.buildSingleFile(
		memoryApp({ 'media/pic.png': PNG_BYTES }),
		makeSnapshot([p, math, localImage()]),
		cssOk(),
		{}
	)
	for (const needle of ['正文', '高亮', 'ch-reading-highlight-yellow', '侧注内容', 'data-sidenote-num="1"', 'mjx-container']) {
		assert(built.html.includes(needle), `应保留：${needle}`)
	}
	match(built.html, /<!--he-body-start-->[\s\S]+<!--he-body-end-->/, '正文标记完整')
})

/* ------------------------------------------------------- 构建期不得发请求 -- */

/**
 * 回归：`buildHtml` 必须把 sizer 克隆进**没有浏览上下文**的文档。
 *
 * 克隆进主文档时，游离的 `<img>` 依然会加载（`src` 一赋值就发请求，基准 URL
 * 取 ownerDocument），于是改写引用会把 `%HE-INLINE-<n>%` 送去解析成
 * `app://obsidian.md/%HE-INLINE-0%`；`%HE` 不是合法百分号转义，Obsidian 主进程
 * 的 app:// 处理器解码时抛 `URIError: URI malformed`（main.js:38:3857）。
 */
await check('构建把 DOM 克隆进惰性文档，占位符不会被当成 URL 发出', async () => {
	let importCalls = 0
	const inert = {
		importNode(node, deep) {
			importCalls++
			return node.cloneNode(deep)
		}
	}
	const snap = makeSnapshot([localImage()])
	snap.sizer.ownerDocument = { implementation: { createHTMLDocument: () => inert } }

	const built = await single.buildSingleFile(
		memoryApp({ 'media/pic.png': PNG_BYTES }),
		snap,
		cssOk(),
		{}
	)
	equal(importCalls, 1, '克隆走 importNode（惰性文档），不走主文档 cloneNode')
	assert(!built.html.includes('%HE-INLINE-'), '成品里不残留占位符')
	assert(built.html.includes('data:image/png;base64,'), '惰性克隆后图片仍被内联')
})

await check('无 DOM 实现的主机退回普通克隆，行为不变', async () => {
	const built = await single.buildSingleFile(
		memoryApp({ 'media/pic.png': PNG_BYTES }),
		makeSnapshot([localImage()]),
		cssOk(),
		{}
	)
	assert(built.html.includes('data:image/png;base64,'), '没有 ownerDocument 时仍能构建')
	assert(!built.html.includes('%HE-INLINE-'), '占位符仍被替换')
})

/* ---------------------------------------------------------------- cleanup -- */

fs.rmSync(workRoot, { recursive: true, force: true })

console.log(
	`\n${failures.length === 0 ? '✓' : '✗'} ${passed} 项通过${
		failures.length ? `，${failures.length} 项失败` : ''
	}`
)
if (failures.length) {
	for (const failure of failures) console.log(`  · ${failure.name}: ${failure.message}`)
	process.exit(1)
}
