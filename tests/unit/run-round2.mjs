/**
 * Fix-round-2 offline tests — 38 cases covering the four P0 findings.
 *
 *   9.1 DOM Resolver (11)      — the decoy must never win, and ambiguity must fail
 *   9.2 导出可靠性 (14)         — every write stage can fail and must say so
 *   9.3 资源与 CSS (12)         — classification, exact-path matching, inline style
 *   9.4 设置诊断 (1)            — the four output-folder diagnoses are reachable
 *
 * These are *failure-path* tests: most of them make a write or a copy fail on
 * purpose, because the bug under review was that failures were invisible.
 *
 * Run with: npm run test:round2
 */
import { build } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { El, installDomGlobals, parseHtml, setRect } from './dom-double.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const tmp = path.join(here, '.tmp')

installDomGlobals()

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

function assertEqual(actual, expected, label) {
	const a = JSON.stringify(actual)
	const e = JSON.stringify(expected)
	if (a !== e) throw new Error(`${label}: expected ${e}, got ${a}`)
}

function assertMatch(value, regex, label) {
	if (!regex.test(String(value))) {
		throw new Error(`${label}: ${regex} 未匹配 ${JSON.stringify(String(value).slice(0, 400))}`)
	}
}

async function expectThrow(fn, matcher, label) {
	try {
		await fn()
	} catch (error) {
		if (matcher && !matcher(error)) {
			throw new Error(`${label}: 抛出的错误不符合预期：${error.message}`)
		}
		return error
	}
	throw new Error(`${label}: 预期抛错，但没有抛`)
}

/* ---------------------------------------------------------- bundling glue -- */

function prepareObsidianStub() {
	const dir = path.join(tmp, 'node_modules', 'obsidian')
	fs.mkdirSync(dir, { recursive: true })
	fs.copyFileSync(path.join(here, 'obsidian-stub.mjs'), path.join(dir, 'index.mjs'))
	fs.writeFileSync(
		path.join(dir, 'package.json'),
		JSON.stringify(
			{ name: 'obsidian', version: '0.0.0-stub', type: 'module', main: 'index.mjs', exports: './index.mjs' },
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

/* ------------------------------------------------------------ DOM fixtures -- */

const DECOY =
	'<div class="reactHeaderComponent markdown-preview-sizer markdown-preview-section"></div>'

function makeReadingView(inner, { width = 1000, height = 800 } = {}) {
	const parsed = parseHtml(
		`<div class="markdown-reading-view"><div class="markdown-preview-view">${inner}</div></div>`
	)
	const reading = parsed.children[0]
	const preview = reading.children[0]
	setRect(reading, width, height)
	setRect(preview, width, height - 40)
	return { reading, preview }
}

function sizerOf(preview, index = 0) {
	return preview.children.filter(c => c.classList.contains('markdown-preview-sizer'))[index]
}

/* ------------------------------------------------------------- fake vault -- */

/**
 * In-memory vault + adapter. Every operation can be made to fail by name, so
 * the tests exercise the failure paths the review asked for.
 */
function makeApp(options = {}) {
	const files = new Map()
	const dirs = new Set(['.'])
	const calls = []
	const vaultFiles = options.vaultFiles ?? []

	const shouldFail = (kind, p) => {
		const rule = options.fail
		if (!rule) return null
		return rule(kind, p)
	}
	const isSilent = (kind, p) => {
		const rule = options.silent
		return rule ? rule(kind, p) : false
	}

	const adapter = {
		async exists(p) {
			return files.has(p) || dirs.has(p)
		},
		async mkdir(p) {
			calls.push(['mkdir', p])
			const error = shouldFail('mkdir', p)
			if (error) throw new Error(error)
			dirs.add(p)
		},
		async write(p, data) {
			calls.push(['write', p])
			const error = shouldFail('write', p)
			if (error) throw new Error(error)
			if (isSilent('write', p)) return
			files.set(p, String(data))
		},
		async read(p) {
			if (!files.has(p)) throw new Error(`ENOENT ${p}`)
			return files.get(p)
		},
		async readBinary(p) {
			calls.push(['readBinary', p])
			const error = shouldFail('readBinary', p)
			if (error) throw new Error(error)
			if (!files.has(p)) throw new Error(`ENOENT ${p}`)
			return new Uint8Array([files.get(p).length])
		},
		async writeBinary(p, data) {
			calls.push(['writeBinary', p])
			const error = shouldFail('writeBinary', p)
			if (error) throw new Error(error)
			if (isSilent('writeBinary', p)) return
			files.set(p, `binary:${data.length}`)
		},
		async stat(p) {
			if (files.has(p)) return { size: files.get(p).length, type: 'file' }
			if (dirs.has(p)) return { size: 0, type: 'folder' }
			return null
		},
		async list(p) {
			const out = { files: [], folders: [] }
			for (const key of files.keys()) {
				if (path.posix.dirname(key) === p) out.files.push(key)
			}
			for (const key of dirs) {
				if (key !== p && path.posix.dirname(key) === p) out.folders.push(key)
			}
			return out
		},
		async rename(from, to) {
			calls.push(['rename', `${from} -> ${to}`])
			const error = shouldFail('rename', from)
			// A rule may hand back a ready-made error so a test can set `.code`
			// (Windows' transient EPERM/EBUSY locks are told apart by code, not
			// by message).
			if (error) throw typeof error === 'object' ? error : new Error(error)
			const movedFiles = [...files.keys()].filter(
				p => p === from || p.startsWith(`${from}/`)
			)
			for (const p of movedFiles) {
				const value = files.get(p)
				files.delete(p)
				files.set(`${to}${p.slice(from.length)}`, value)
			}
			const movedDirs = [...dirs].filter(
				p => p === from || p.startsWith(`${from}/`)
			)
			for (const p of movedDirs) {
				dirs.delete(p)
				dirs.add(`${to}${p.slice(from.length)}`)
			}
			if (movedFiles.length === 0 && movedDirs.length === 0) {
				throw new Error(`rename: 源不存在 ${from}`)
			}
		},
		async rmdir(p, recursive) {
			calls.push(['rmdir', p])
			const error = shouldFail('rmdir', p)
			if (error) throw new Error(error)
			for (const key of [...files.keys()]) {
				if (key === p || key.startsWith(`${p}/`)) files.delete(key)
			}
			for (const key of [...dirs]) {
				if (key === p || (recursive && key.startsWith(`${p}/`))) dirs.delete(key)
			}
		},
		getBasePath() {
			return 'D:/vault'
		}
	}

	return {
		files,
		dirs,
		calls,
		adapter,
		vault: {
			adapter,
			getAbstractFileByPath: p => vaultFiles.find(f => f.path === p) ?? null,
			getFiles: () => vaultFiles
		}
	}
}

function makeSnapshot(overrides = {}) {
	return {
		notePath: 'learn/agent/ra/示例笔记.md',
		noteTitle: '示例笔记',
		capturedAt: '2026-10-31T00:00:00.000Z',
		captureWidth: 1806,
		root: { className: '', style: '', data: {}, bodyClassName: 'theme-light' },
		reading: { className: 'markdown-reading-view', style: '', data: {} },
		preview: { className: 'markdown-preview-view', style: '', data: {} },
		resolution: {
			sizer: null,
			readingRoot: null,
			previewRoot: null,
			candidates: [{ index: 0, excluded: null, selected: true }],
			reason: '选中 #0',
			ambiguity: false,
			error: null
		},
		previewMetrics: {
			width: 1806,
			paddingLeft: 32,
			paddingRight: 32,
			readableLineWidth: true,
			fileLineWidth: '700px'
		},
		sizer: new El('div'),
		stats: {
			images: 7,
			mermaid: 4,
			mermaidWithSvg: 4,
			sidenotes: 75,
			sidenoteLeft: 0,
			sidenoteRight: 75,
			marginNotes: 0,
			stylesheets: 68,
			bytesOfContent: 12000,
			blocks: 210,
			math: 17
		},
		warnings: [],
		...overrides
	}
}

const EXTRA = {
	css: { bytes: 100, sheets: [], warnings: [] },
	pluginVersion: '0.1.0',
	audit: { generatedAt: 'x', U1_sidenoteStructure: {} }
}

/** Round 2A.2.2 (S3): the per-vault HMAC key every fixture export is signed with. */
const SIGNING_KEY = 'a1'.repeat(32)

/**
 * A page shaped like the real export.
 *
 * The body markers are what `verifyExport` measures, so the fixtures must
 * carry them — a bare `<html>body</html>` is no longer a valid export input
 * (review B2/B8).
 */
let BODY_START = '<!--he-body-start-->'
let BODY_END = '<!--he-body-end-->'

function page(body = '<p>正文</p>') {
	return (
		'<!doctype html>\n<html>\n<head><title>t</title></head>\n<body>\n' +
		`${BODY_START}\n${body}\n${BODY_END}\n` +
		'</body>\n</html>\n'
	)
}

/* ------------------------------------------------------------------ tests -- */

async function main() {
	fs.mkdirSync(tmp, { recursive: true })
	const stubUrl = prepareObsidianStub()
	// The production code does `instanceof TFile`; only the stub's class can
	// satisfy it, so the fixtures must use it rather than a look-alike.
	const { TFile } = await import(stubUrl)
	const file = (p, size = 128) => new TFile(p, size)

	const { resolveSizer, assertResolved, CaptureError } = await bundle(
		'src/capture/dom-resolver.ts',
		'round2-resolver'
	)
	const { cloneContent } = await bundle('src/capture/dom-clone.ts', 'round2-clone')
	const { AssetCollector } = await bundle(
		'src/assets/resource-manager.ts',
		'round2-assets'
	)
	const { collectCss, renderCss } = await bundle(
		'src/css/css-collector.ts',
		'round2-css'
	)
	const { writeExport: writeExportRaw, verifyExport, ExportError, measureBodyBytes } =
		await bundle('src/export/writer.ts', 'round2-writer')
	// Round 2A.2.2 (S3): `writeExport` now takes the per-vault signing key as its
	// 8th argument. Every call in this file passes the same seven arguments, so
	// a thin wrapper keeps 38 historical cases readable instead of appending the
	// key at 17 separate call sites.
	const writeExport = (...args) => writeExportRaw(...args, SIGNING_KEY)
	const { sanitizeReadingStyle, buildHtml, BODY_START: start, BODY_END: end } =
		await bundle('src/export/exporter.ts', 'round2-exporter')
	BODY_START = start
	BODY_END = end
	const { inspectOutputFolder, RECOMMENDED_FOLDER } = await bundle(
		'src/settings.ts',
		'round2-settings'
	)

	// Round 2A.1 (F-03): the export folder now carries an identity suffix, so a
	// test that hard-codes the directory name would silently test the wrong
	// path. Resolve it the same way the writer does.
	const { resolveExportDir } = await bundle('src/export/path-safety.ts', 'round2-path')
	const DEST = resolveExportDir('html-export', '示例笔记', 'learn/agent/ra/示例笔记.md').dir

	/* ------------------------------------------------- 9.1 DOM Resolver (11) -- */

	console.log('\n9.1 — DOM Resolver')

	await check('1. 只有一个真实 sizer 时选中它', () => {
		const { reading, preview } = makeReadingView('<div class="markdown-preview-sizer"><p>正文</p></div>')
		setRect(sizerOf(preview), 1396, 5000)
		const res = resolveSizer(reading)
		assert(res.sizer !== null, '应当解析成功')
		assertEqual(res.candidates.length, 1, '候选数')
		assertEqual(res.error, null, 'error')
	})

	await check('2. 空壳在真实 sizer 之前时不选空壳', () => {
		const { reading, preview } = makeReadingView(
			`${DECOY}<div class="markdown-preview-sizer"><p>正文</p></div>`
		)
		setRect(sizerOf(preview, 0), 1396, 0)
		setRect(sizerOf(preview, 1), 1396, 5000)
		const res = resolveSizer(reading)
		assert(res.sizer !== null, '应当解析成功')
		assertEqual(res.candidates[0].selected, false, '空壳不应被选中')
		assertEqual(res.candidates[1].selected, true, '真实 sizer 应被选中')
		assertMatch(res.candidates[0].excluded, /reactHeaderComponent/, '排除原因')
	})

	await check('3. 空壳在真实 sizer 之后时仍选真实 sizer', () => {
		const { reading, preview } = makeReadingView(
			`<div class="markdown-preview-sizer"><p>正文</p></div>${DECOY}`
		)
		setRect(sizerOf(preview, 0), 1396, 5000)
		setRect(sizerOf(preview, 1), 1396, 0)
		const res = resolveSizer(reading)
		assertEqual(res.candidates[0].selected, true, '真实 sizer 应被选中（与顺序无关）')
	})

	await check('4. 多个空壳时仍能选出真实 sizer', () => {
		const { reading, preview } = makeReadingView(
			`${DECOY}${DECOY}<div class="markdown-preview-sizer"><p>正文</p></div>${DECOY}`
		)
		setRect(sizerOf(preview, 3), 1396, 5000)
		const res = resolveSizer(reading)
		assertEqual(res.candidates.filter(c => c.excluded).length, 3, '三个空壳都应被排除')
		assertEqual(res.candidates[2].selected, true, '真实 sizer 应被选中')
	})

	await check('5. 未安装 React Components（无空壳）时正常', () => {
		const { reading, preview } = makeReadingView(
			'<div class="markdown-preview-sizer"><h1>标题</h1><p>段落</p></div>'
		)
		setRect(sizerOf(preview), 1396, 3000)
		const res = resolveSizer(reading)
		assert(res.sizer !== null, '应当解析成功')
		assertEqual(res.ambiguity, false, '不应报歧义')
	})

	await check('6. 已安装 React Components 且空壳有内容时，仍按内容权重选真实正文', () => {
		const header =
			'<div class="reactHeaderComponent markdown-preview-sizer markdown-preview-section"><p>笔记头</p></div>'
		const { reading, preview } = makeReadingView(
			`${header}<div class="markdown-preview-sizer"><p>a</p><p>b</p><p>c</p></div>`
		)
		setRect(sizerOf(preview, 0), 1396, 120)
		setRect(sizerOf(preview, 1), 1396, 5000)
		const res = resolveSizer(reading)
		assertEqual(res.candidates[0].excluded !== null, true, '空壳仍应被排除')
		assertEqual(res.candidates[1].selected, true, '正文应被选中')
	})

	await check('7. 正文只有图片时判定为有效正文', () => {
		const { reading, preview } = makeReadingView(
			'<div class="markdown-preview-sizer"><img src="app://v/a.png"></div>'
		)
		setRect(sizerOf(preview), 1396, 800)
		const res = resolveSizer(reading)
		assert(res.sizer !== null, '纯图片正文必须被视为有效')
		assertEqual(res.candidates[0].media, 1, '媒体计数')
	})

	await check('8. 正文只有 Mermaid 时判定为有效正文', () => {
		const { reading, preview } = makeReadingView(
			'<div class="markdown-preview-sizer"><div class="mermaid"><svg></svg></div></div>'
		)
		setRect(sizerOf(preview), 1396, 600)
		const res = resolveSizer(reading)
		assert(res.sizer !== null, '纯 Mermaid 正文必须被视为有效')
		assertEqual(res.candidates[0].mermaid, 1, 'Mermaid 计数')
	})

	await check('9. 正文只有批注与短文本时判定为有效正文', () => {
		const { reading, preview } = makeReadingView(
			'<div class="markdown-preview-sizer"><p>x<span class="sidenote-number">' +
				'<small class="sidenote-margin">批注</small></span></p></div>'
		)
		setRect(sizerOf(preview), 1396, 400)
		const res = resolveSizer(reading)
		assert(res.sizer !== null, '批注型正文必须被视为有效')
		assertEqual(res.candidates[0].sidenotes, 2, '批注节点计数')
	})

	await check('10. 两个等价候选时报歧义，不静默选择', () => {
		const { reading, preview } = makeReadingView(
			'<div class="markdown-preview-sizer"><p>x</p></div>' +
				'<div class="markdown-preview-sizer"><p>y</p></div>'
		)
		setRect(sizerOf(preview, 0), 1396, 500)
		setRect(sizerOf(preview, 1), 1396, 500)
		const res = resolveSizer(reading)
		assertEqual(res.sizer, null, '歧义时不得返回容器')
		assertEqual(res.error, 'ambiguous', '错误码')
		assertMatch(res.reason, /无法确定/, '原因应说明无法确定')

		let thrown = null
		try {
			assertResolved(res)
		} catch (error) {
			thrown = error
		}
		assert(thrown instanceof CaptureError, '歧义必须抛 CaptureError')
		assertMatch(thrown.message, /歧义/, '错误信息应说明歧义')
	})

	await check('11. 完全空白的阅读视图报 empty，且错误信息列出候选', () => {
		const { reading, preview } = makeReadingView('<div class="markdown-preview-sizer"></div>')
		setRect(sizerOf(preview), 1396, 0)
		const res = resolveSizer(reading)
		assertEqual(res.error, 'empty', '错误码')

		let thrown = null
		try {
			assertResolved(res)
		} catch (error) {
			thrown = error
		}
		assert(thrown instanceof CaptureError, '必须抛出 CaptureError')
		assertMatch(thrown.message, /正文为空/, '错误信息')
		assertMatch(thrown.message, /内容块 0/, '错误信息应列出候选统计')
	})

	/* ------------------------------------------------ 9.2 导出可靠性 (10) -- */

	console.log('\n9.2 — 导出可靠性')

	const okAssets = () => new AssetCollector(makeApp())

	await check('12. 目录创建失败时报「创建目录」阶段', async () => {
		const app = makeApp({ fail: (kind, p) => (kind === 'mkdir' && p.includes('示例笔记') ? 'EACCES' : null) })
		const error = await expectThrow(
			() => writeExport(app, makeSnapshot(), page(), 'body{}', okAssets(), 'html-export', EXTRA),
			e => e instanceof ExportError && e.stage === '创建目录',
			'目录创建失败'
		)
		assertMatch(error.message, /EACCES/, '应保留底层原因')
	})

	await check('13. index.html 写入失败时报「写入主文件」阶段', async () => {
		const app = makeApp({ fail: (kind, p) => (kind === 'write' && p.endsWith('index.html') ? 'ENOSPC' : null) })
		const error = await expectThrow(
			() => writeExport(app, makeSnapshot(), page(), 'body{}', okAssets(), 'html-export', EXTRA),
			e => e instanceof ExportError && e.stage === '写入主文件',
			'index.html 写入失败'
		)
		assertMatch(error.message, /ENOSPC/, '应保留底层原因')
	})

	await check('14. export.css 写入失败时报「写入主文件」阶段', async () => {
		const app = makeApp({ fail: (kind, p) => (kind === 'write' && p.endsWith('export.css') ? 'EIO' : null) })
		const error = await expectThrow(
			() => writeExport(app, makeSnapshot(), page(), 'body{}', okAssets(), 'html-export', EXTRA),
			e => e instanceof ExportError && e.stage === '写入主文件',
			'export.css 写入失败'
		)
		assertMatch(error.message, /EIO/, '应保留底层原因')
	})

	await check('15. 必要图片复制失败时导出标记为 incomplete，且计入 contentFailed', async () => {
		const app = makeApp({
			vaultFiles: [file('zzz_data/data/image-3.png')],
			fail: (kind, p) => (kind === 'writeBinary' ? 'EPERM' : null)
		})
		const assets = new AssetCollector(app)
		assets.resolve('app://vault/zzz_data/data/image-3.png', 'assets/media/', 'html', 'content')

		const report = await writeExport(
			app,
			makeSnapshot(),
			page(),
			'body{}',
			assets,
			'html-export',
			EXTRA
		)
		assertEqual(report.status, 'incomplete', '状态')
		assertEqual(report.assets.written, 0, 'written 必须为真实成功数')
		assertEqual(report.assets.failed.length, 1, '失败条目数')
		assertEqual(report.assets.contentFailed, 1, '必要资源失败数')
		// Review C1: a copy failure is also recorded in `missing`; the count
		// must stay 1 so the Notice does not report one image as two.
		assertEqual(report.assets.contentMissing, 1, '必要资源丢失数不得重复计数')
	})

	await check('16. manifest 写入失败时报「写入清单」阶段', async () => {
		const app = makeApp({
			fail: (kind, p) => (kind === 'write' && p.endsWith('export-manifest.json') ? 'EIO' : null)
		})
		const error = await expectThrow(
			() => writeExport(app, makeSnapshot(), page(), 'body{}', okAssets(), 'html-export', EXTRA),
			e => e instanceof ExportError && e.stage === '写入清单',
			'manifest 写入失败'
		)
		assertMatch(error.message, /EIO/, '应保留底层原因')
	})

	await check('17. runtime-audit 写入失败时同属事务，整体失败（写入审计阶段）', async () => {
		const app = makeApp({
			fail: (kind, p) => (kind === 'write' && p.endsWith('runtime-audit.json') ? 'EIO' : null)
		})
		const error = await expectThrow(
			() => writeExport(app, makeSnapshot(), page(), 'body{}', okAssets(), 'html-export', EXTRA),
			e => e instanceof ExportError && e.stage === '写入审计',
			'runtime-audit 写入失败'
		)
		assertMatch(error.message, /runtime-audit|EIO/, '应指出失败文件')
	})

	await check('18. 写入调用成功但文件不存在时，校验阶段失败', async () => {
		const app = makeApp({ silent: (kind, p) => kind === 'write' && p.endsWith('index.html') })
		const error = await expectThrow(
			() => writeExport(app, makeSnapshot(), page(), 'body{}', okAssets(), 'html-export', EXTRA),
			e => e instanceof ExportError && e.stage === 'verify',
			'文件不存在'
		)
		assertMatch(error.message, /index\.html/, '应指出缺失文件')
	})

	await check('19. 文件大小异常（0 字节）时校验失败', async () => {
		const app = makeApp()
		const error = await expectThrow(
			() => writeExport(app, makeSnapshot(), '', 'body{}', okAssets(), 'html-export', EXTRA),
			e => e instanceof ExportError && e.stage === 'verify',
			'0 字节'
		)
		assertMatch(error.message, /index\.html/, '应指出 index.html')
	})

	await check('20. 重复导出时新产物替换旧产物，旧产物保留为 .bak- 备份', async () => {
		// Round 2A.1: a hand-written `index.html` is no longer accepted as "the
		// previous export" — ownership has to be provable, so the fixture is a
		// real first export. That is also the only way this test still proves
		// anything about replacement rather than about refusal.
		const app = makeApp()
		await writeExport(
			app,
			makeSnapshot(),
			page('<p>OLD</p>'),
			'body{}',
			okAssets(),
			'html-export',
			EXTRA
		)

		const report = await writeExport(
			app,
			makeSnapshot(),
			page('<p>NEW</p>'),
			'body{}',
			okAssets(),
			'html-export',
			EXTRA
		)
		assertEqual(report.tmpDir, null, '发布成功后不得返回已消失的临时目录')
		assert(report.stages.includes('publish'), 'stages 必须记录发布阶段（证明走了 rename）')
		assertEqual(app.files.get(`${DEST}/index.html`), page('<p>NEW</p>'), '内容应更新')
		// Round 2A.2 (B5): the previous export is no longer auto-deleted. It is
		// moved to a `.bak-` directory and retained for the user to recover.
		assert(!!report.leftoverBackup, '应返回遗留的备份目录（Round 2A.2 B5：默认不再自动删除）')
		assert(report.leftoverBackup.includes('.bak-'), '备份目录应为 .bak- 形式')
		const backups = [...app.dirs].filter(
			d => d.includes('.bak-') && path.posix.dirname(d) === 'html-export'
		)
		assert(backups.length === 1, `应恰好保留一个备份目录（旧导出）：${backups}`)
		assert(
			app.files.get(`${report.leftoverBackup}/index.html`) === page('<p>OLD</p>'),
			'备份目录应保留旧内容，未被自动删除'
		)
		assert(
			![...app.dirs].some(d => d.includes('.tmp-')),
			'成功提交后不应残留临时目录'
		)
	})

	await check('21. 本次失败不得破坏上一次的有效导出', async () => {
		const app = makeApp({
			fail: (kind, p) => (kind === 'write' && p.endsWith('export-manifest.json') ? 'EIO' : null)
		})
		app.dirs.add('html-export')
		app.dirs.add(DEST)
		app.dirs.add(`${DEST}/assets`)
		app.dirs.add(`${DEST}/assets/media`)
		app.files.set(`${DEST}/index.html`, 'GOOD')
		app.files.set(`${DEST}/export-manifest.json`, '{"ok":true}')

		await expectThrow(
			() => writeExport(app, makeSnapshot(), page('<p>NEW</p>'), 'body{}', okAssets(), 'html-export', EXTRA),
			e => e instanceof ExportError,
			'导出应失败'
		)

		assertEqual(app.files.get(`${DEST}/index.html`), 'GOOD', '旧产物必须完好')
		assertEqual(
			app.files.get(`${DEST}/export-manifest.json`),
			'{"ok":true}',
			'旧 manifest 必须完好'
		)
		assert(
			[...app.dirs].some(d => d.includes('.tmp-')),
			'未完成的临时目录应保留以便恢复'
		)
	})

	await check('31. 完整骨架但正文为空时，写后校验必须失败', async () => {
		// R7 in its real shape: `buildHtml` always writes `${sizer.outerHTML}`,
		// so an empty body still carries the container's own tags (~40-90 chars).
		// A length-only check would pass this — the check must be structural.
		const emptySizer = '<div class="markdown-preview-sizer markdown-preview-section" style="width:1396px"></div>'
		const app = makeApp()
		const error = await expectThrow(
			() => writeExport(app, makeSnapshot(), page(emptySizer), 'body{}', okAssets(), 'html-export', EXTRA),
			e => e instanceof ExportError && e.stage === 'verify',
			'空容器正文'
		)
		assertMatch(error.message, /正文只有容器标签/, '应指出正文只有容器标签')
		assert(
			![...app.dirs].some(d => d === DEST),
			'校验失败不得发布出正式目录'
		)

		// And the degenerate input (markers with nothing between them) must fail too.
		const error2 = await expectThrow(
			() => writeExport(makeApp(), makeSnapshot(), page(''), 'body{}', okAssets(), 'html-export', EXTRA),
			e => e instanceof ExportError && e.stage === 'verify',
			'标记之间为空'
		)
		assertMatch(error2.message, /正文只有容器标签|标记缺失/, '应指出正文为空')
	})

	await check('32. 发布第二步失败时回滚，旧导出逐字节不变', async () => {
		// Round 2A.1: the previous export is no longer a hand-written fixture —
		// it has to be a real export, because `publish()` now refuses to replace
		// a directory it cannot prove is ours. That makes this test exercise the
		// real rollback path instead of failing earlier for a different reason.
		let failRule = null
		const app = makeApp({ fail: (kind, from) => (failRule ? failRule(kind, from) : null) })

		await writeExport(
			app,
			makeSnapshot(),
			page('<p>GOOD</p>'),
			'body{}',
			okAssets(),
			'html-export',
			EXTRA
		)
		const beforeHtml = app.files.get(`${DEST}/index.html`)
		const beforeManifest = app.files.get(`${DEST}/export-manifest.json`)
		assert(!!beforeHtml && beforeHtml.includes('GOOD'), '第一次导出应落盘')

		// rename(final → bak) succeeds, rename(tmp → final) fails: the backup
		// must be renamed back. This is the only state-destroying code in D2.
		failRule = (kind, from) => (kind === 'rename' && from.includes('.tmp-') ? 'EXDEV' : null)

		await expectThrow(
			() =>
				writeExport(
					app,
					makeSnapshot(),
					page('<p>NEW</p>'),
					'body{}',
					okAssets(),
					'html-export',
					EXTRA
				),
			e => e instanceof ExportError && e.stage === 'publish',
			'发布失败'
		)

		assertEqual(app.files.get(`${DEST}/index.html`), beforeHtml, '旧 index.html 必须逐字节不变')
		assertEqual(
			app.files.get(`${DEST}/export-manifest.json`),
			beforeManifest,
			'旧 manifest 必须逐字节不变'
		)
		assert(app.dirs.has(DEST), '旧目录必须被恢复')
	})

	await check('33. 适配器不支持 rename 时直接拒绝，且不写入任何文件', async () => {
		const app = makeApp()
		delete app.adapter.rename
		const error = await expectThrow(
			() => writeExport(app, makeSnapshot(), page(), 'body{}', okAssets(), 'html-export', EXTRA),
			e => e instanceof ExportError && e.stage === '适配器',
			'无 rename 适配器'
		)
		assertMatch(error.message, /不支持目录重命名/, '原因')
		assertEqual(app.files.size, 0, '不得写入任何文件')
		assertEqual(app.calls.length, 0, '不得调用任何适配器写操作（mkdir/write/rename）')
	})

	await check('34. 必要资源在库中找不到时，导出标记为 incomplete', async () => {
		// B1: a note image that never resolved used to leave status = 'ok'.
		const app = makeApp({ vaultFiles: [] })
		const assets = new AssetCollector(app)
		const out = assets.resolve(
			'app://vault/zzz_data/data/missing.png',
			'assets/media/',
			'html',
			'content'
		)
		assertEqual(out, null, '找不到必须返回 null')

		const report = await writeExport(
			app,
			makeSnapshot(),
			page('<p><img src="data:,"></p>'),
			'body{}',
			assets,
			'html-export',
			EXTRA
		)
		assertEqual(report.status, 'incomplete', '状态必须是 incomplete')
		assertEqual(report.assets.contentFailed, 0, '没有任何复制失败')
		assertEqual(report.assets.contentMissing, 1, '缺失必要资源计数')
	})

	/* ----------------------------------------------- 9.3 资源与 CSS (12) -- */

	console.log('\n9.3 — 资源与 CSS')

	await check('22. app://obsidian.md/* 归类为应用资源，不计入 missing', () => {
		const app = makeApp()
		const assets = new AssetCollector(app)
		const out = assets.resolve(
			'app://obsidian.md/public/fonts/70cc7ff27245e82ad414.ttf',
			'media/',
			'app://obsidian.md/app.css',
			'environment'
		)
		assertEqual(out, null, '不应被复制')
		assertEqual(assets.missing.length, 0, '不得计入 missing')
		assertEqual(assets.external.length, 1, '应记录为 external')
		assertEqual(assets.external[0].kind, 'app-resource', '分类')
	})

	await check('23. /lib/mathjax/* 根相对路径归类为 external，不计入 missing', () => {
		const app = makeApp()
		const assets = new AssetCollector(app)
		const out = assets.resolve(
			'/lib/mathjax/tex-font/chtml/woff2/mjx-tex-n.woff2',
			'media/',
			'inline#65',
			'environment'
		)
		assertEqual(out, null, '不应被复制')
		assertEqual(assets.missing.length, 0, '不得计入 missing')
		assertEqual(assets.external[0].kind, 'root-relative', '分类')

		// B11: the same `/x` inside a *file-based* sheet resolves against that
		// file's origin, i.e. the vault root — it may be a real note asset.
		const fileApp = makeApp({ vaultFiles: [file('img/x.png')] })
		const fileAssets = new AssetCollector(fileApp)
		const fromFile = fileAssets.resolve(
			'/img/x.png',
			'media/',
			'app://vault/.obsidian/themes/T/theme.css',
			'environment'
		)
		assert(fromFile !== null, '文件型样式表中的 /img/x.png 应解析为知识库文件')
		assertEqual(fileAssets.entries[0].vaultPath, 'img/x.png', '应命中知识库根下的文件')
		assertEqual(fileAssets.external.length, 0, '不应记为应用资源')
	})

	await check('24. 同名图片优先精确路径匹配', () => {
		const app = makeApp({
			vaultFiles: [
				file('zzz_data/data/image-3.png'),
				file('日常/日记/data/image-3.png')
			]
		})
		const assets = new AssetCollector(app)
		const out = assets.resolve(
			'app://vault/日常/日记/data/image-3.png',
			'assets/media/',
			'html',
			'content'
		)
		assert(out !== null, '精确路径必须解析成功')
		assertEqual(assets.missing.length, 0, '不应报缺失')
		assertEqual(assets.warnings.length, 0, '精确匹配不应触发后缀匹配 warning')
		assert(
			assets.entries[0].vaultPath === '日常/日记/data/image-3.png',
			`必须命中精确路径，实际 ${assets.entries[0]?.vaultPath}`
		)
	})

	await check('25. 同名图片多候选时拒绝猜测', () => {
		const app = makeApp({
			vaultFiles: [file('pic.png'), file('a/pic.png')]
		})
		const assets = new AssetCollector(app)
		const out = assets.resolve('app://vault/z/a/pic.png', 'assets/media/', 'html', 'content')
		assertEqual(out, null, '歧义必须拒绝')
		assertEqual(assets.missing[0].kind, 'ambiguous', '分类')
		assertMatch(assets.missing[0].reason, /拒绝猜测/, '原因')
	})

	await check('26. CSS 中的根相对 url() 不再产生「缺少基准 URL」警告', async () => {
		globalThis.CSSRule = { IMPORT_RULE: 3 }
		globalThis.document = {
			styleSheets: [
				{
					href: null,
					ownerNode: null,
					cssRules: [
						{
							type: 1,
							cssText:
								'@font-face{font-family:MJX-TEX-N;src:url(/lib/mathjax/tex-font/chtml/woff2/mjx-tex-n.woff2)}'
						}
					]
				}
			]
		}
		const app = makeApp()
		const col = await collectCss(app)
		assertEqual(col.warnings.length, 0, '不应再产生警告')
		assertMatch(col.chunks[0].text, /\/lib\/mathjax\//, '原始引用应保留')
	})

	await check('27. @import 仍被内联，且相对 url() 以被导入文件为基准', async () => {
		globalThis.CSSRule = { IMPORT_RULE: 3 }
		const cssFiles = {
			'.obsidian/themes/T/shared.css': '.shared{background:url(../img/bg.png)}'
		}
		const app = {
			vault: {
				adapter: {
					exists: async p => p in cssFiles,
					read: async p => cssFiles[p]
				}
			}
		}
		globalThis.document = {
			styleSheets: [
				{
					href: 'app://vault/.obsidian/themes/T/theme.css',
					ownerNode: null,
					cssRules: [
						{ type: 3, href: 'app://vault/.obsidian/themes/T/shared.css', media: { mediaText: '' } }
					]
				}
			]
		}
		const col = await collectCss(app)
		assertMatch(col.chunks[0].text, /\.shared\{/, '@import 内容应内联')
		assertMatch(
			col.chunks[0].text,
			/app:\/\/vault\/\.obsidian\/themes\/img\/bg\.png/,
			'相对 url() 应以被导入文件为基准绝对化'
		)
	})

	await check('28. CSS 级资源按 environment 解析，失败不计入 contentFailed', async () => {
		const calls = []
		const out = renderCss(
			{
				chunks: [{ origin: 'inline#7', text: '.a{src:url(app://vault/font.woff2)}' }],
				sheets: [],
				warnings: [],
				bytes: 0
			},
			{
				prefix: 'media/',
				assets: {
					resolve: (ref, prefix, source, role) => {
						calls.push({ ref, prefix, source, role })
						return null
					}
				}
			}
		)
		assertEqual(calls.length, 1, '解析调用次数')
		assertEqual(calls[0].role, 'environment', 'CSS 资源必须是 environment 角色')
		assertMatch(out, /url\("data:,"\)/, '无法解析时用惰性占位')
	})

	await check('29. Mermaid SVG 被保留，缺少 viewBox 时按宽高推导', () => {
		const parsed = parseHtml(
			'<div class="markdown-preview-sizer">' +
				'<div class="mermaid"><svg width="640" height="480"><g/></svg></div>' +
				'</div>'
		)
		const sizer = parsed.children[0]
		const { content, warnings } = cloneContent(sizer)
		const svg = content.querySelector('.mermaid svg')
		assert(svg !== null, 'SVG 必须被保留')
		assertEqual(svg.getAttribute('viewBox'), '0 0 640 480', 'viewBox 推导')
		assert(warnings.some(w => w.includes('viewBox')), '应记录推导 warning')
	})

	await check('30. Mermaid Beauty 悬浮 UI 与 Side Notes 探针被清理', () => {
		const parsed = parseHtml(
			'<div class="markdown-preview-sizer">' +
				'<div class="mermaid"><svg viewBox="0 0 1 1"></svg>' +
				'<div class="mermaid-beauty-actions"><button>x</button></div></div>' +
				'<div class="sidenote-measure-probe"></div>' +
				'<p>正文</p>' +
				'</div>'
		)
		const sizer = parsed.children[0]
		const { content } = cloneContent(sizer)
		assertEqual(content.querySelectorAll('.mermaid-beauty-actions').length, 0, '悬浮按钮必须被移除')
		assertEqual(content.querySelectorAll('.sidenote-measure-probe').length, 0, '探针必须被移除')
		assertEqual(content.querySelectorAll('.mermaid svg').length, 1, 'SVG 必须保留')
		assertEqual(content.querySelectorAll('p').length, 1, '正文必须保留')
	})

	await check('35. sanitizeReadingStyle 只剔除 width/height，不切坏 data URL', () => {
		assertEqual(
			sanitizeReadingStyle(
				'width:100%; height:100%; background:url(data:image/png;base64,AA); --sn-width:600px'
			),
			'background:url(data:image/png;base64,AA); --sn-width:600px',
			'url(data:…;base64,…) 内的分号不得成为分隔符'
		)
		assertEqual(
			sanitizeReadingStyle('height:100%;--x:url("a;b");width:5px'),
			'--x:url("a;b")',
			'引号内的分号不得成为分隔符'
		)
	})

	await check('36. iframe 与内联 style 里的图片会被改写为相对路径', () => {
		// Review C2: `rewriteMedia` used to skip iframe and inline style url(),
		// so those images kept `app://` paths and died outside Obsidian while
		// the export still reported ok.
		const app = makeApp({ vaultFiles: [file('img/a.png'), file('img/b.png')] })
		const assets = new AssetCollector(app)
		const snap = makeSnapshot({
			sizer: parseHtml(
				'<div class="markdown-preview-sizer">' +
					'<iframe src="app://vault/img/a.png"></iframe>' +
					'<div style="background-image:url(app://vault/img/b.png)"></div>' +
					'<p>正文</p>' +
					'</div>'
			).children[0]
		})
		const html = buildHtml(snap, { mode: 'export', cssText: '', assets })
		assert(!html.includes('app://vault/img/a.png'), 'iframe 的 src 必须被改写')
		assert(!html.includes('app://vault/img/b.png'), '内联 style 的 url() 必须被改写')
		assertMatch(html, /assets\/media\/[^"]*a\.png/, 'iframe 应指向媒体目录')
		assertMatch(html, /url\("assets\/media\/[^"]*b\.png"\)/, '内联 style 应指向媒体目录')
		assertEqual(assets.entries.length, 2, '两个资源都应登记')
	})

	await check('37. 引号或括号不闭合时仍必须剔除 width/height', () => {
		// Review C3: the fail-open direction is "keep fewer declarations", never
		// "leave width in".
		assert(
			!/width\s*:/.test(sanitizeReadingStyle('--x:"abc; width:5px')),
			'未闭合引号下 width 仍必须被剔除'
		)
		assert(
			!/width\s*:/.test(sanitizeReadingStyle('background:url(a;b; width:5px')),
			'未闭合括号下 width 仍必须被剔除'
		)
		assertEqual(
			sanitizeReadingStyle('content:"a\\";b"; width:5px'),
			'content:"a\\";b"',
			'转义引号不得提前结束字符串'
		)
	})

	/* ------------------------------------------------------ 9.4 设置诊断 (1) -- */

	console.log('\n9.4 — 设置诊断')

	await check('38. inspectOutputFolder 四类目录问题都能被识别', () => {
		// Review B7: the `legacy` branch used to be unreachable dead code.
		assertEqual(inspectOutputFolder('').kind, 'empty', '空值')
		assertEqual(inspectOutputFolder('   ').kind, 'empty', '纯空白')
		assertEqual(
			inspectOutputFolder('.obsidian/pluagins/html-export-preview/out').kind,
			'typo',
			'拼写错误优先于 legacy'
		)
		assertEqual(
			inspectOutputFolder('.obsidian/plugins/html-export-preview/out').kind,
			'legacy',
			'旧版默认值'
		)
		assertEqual(inspectOutputFolder('.obsidian/snippets/x').kind, 'config-dir', '配置目录')
		assertEqual(inspectOutputFolder(RECOMMENDED_FOLDER), null, '推荐目录无问题')
	})

	console.log('\n9.5 — 发布阶段遇到 Windows 临时锁')

	await check('39. 发布 rename 遇到 EPERM 临时锁时重试成功，而不是误报导出失败', async () => {
		// Measured in the sandbox: publishing a package that had just written 40+
		// new files failed with `EPERM` because Obsidian's own vault indexer still
		// held a handle inside the staged directory. The identical `fs.rename`
		// from Node succeeded a minute later against the same two paths.
		let attempts = 0
		const app = makeApp({
			fail: (kind, from) => {
				if (kind !== 'rename' || !from.includes('.tmp-')) return null
				attempts++
				if (attempts > 2) return null
				const locked = new Error('EPERM: operation not permitted, rename')
				locked.code = 'EPERM'
				return locked
			}
		})

		const report = await writeExport(
			app,
			makeSnapshot(),
			page('<p>RETRIED</p>'),
			'body{}',
			okAssets(),
			'html-export',
			EXTRA
		)
		assertEqual(report.status, 'ok', '重试后应发布成功')
		assertEqual(attempts, 3, '应在第 3 次尝试时成功')
		assert(
			(app.files.get(`${DEST}/index.html`) ?? '').includes('RETRIED'),
			'内容应真正落盘'
		)
	})

	await check('40. 非临时错误不重试：EXDEV 立即失败并回滚旧导出', async () => {
		let attempts = 0
		const app = makeApp({
			fail: kind => {
				if (kind !== 'rename') return null
				attempts++
				const crossDevice = new Error('EXDEV: cross-device link not permitted')
				crossDevice.code = 'EXDEV'
				return crossDevice
			}
		})

		await expectThrow(
			() =>
				writeExport(
					app,
					makeSnapshot(),
					page('<p>NOPE</p>'),
					'body{}',
					okAssets(),
					'html-export',
					EXTRA
				),
			e => e instanceof ExportError && e.stage === '发布',
			'EXDEV'
		)
		assertEqual(attempts, 1, '跨设备错误只尝试一次，不做无意义的等待')
	})

	/* ------------------------------------------------------------- report -- */

	console.log('')
	if (failures.length) {
		console.log(`✗ ${failures.length} 项失败，${passed} 项通过\n`)
		for (const failure of failures) console.log(`  - ${failure.name}`)
		process.exit(1)
	}
	console.log(`✓ 全部 ${passed} 项通过\n`)
}

main().catch(error => {
	console.error(error)
	process.exit(1)
})
