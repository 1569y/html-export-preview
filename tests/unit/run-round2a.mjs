/**
 * Round 2A unit tests — path safety, honest counters, transactional safety.
 *
 * These cover the three findings Agent B's review left open after round 2:
 *
 *   X-extra  `noteTitle` must never escape the export root (`..`, `CON`, …)
 *   R6/X8    `written` counts real successes, and the manifest never lists a
 *            failed copy as packaged
 *   X6       a failed run leaves no half-export and cannot destroy the last
 *            good one; a directory we did not create is never overwritten
 *
 * Run with: npm run test:round2a
 */
import { createHash } from 'node:crypto'
import { build } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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

function assertEqual(actual, expected, label) {
	const a = JSON.stringify(actual)
	const e = JSON.stringify(expected)
	if (a !== e) throw new Error(`${label}: expected ${e}, got ${a}`)
}

async function expectThrow(fn, predicate, label) {
	let thrown = null
	try {
		await fn()
	} catch (error) {
		thrown = error
	}
	assert(thrown !== null, `${label}: 应当抛错但没有`)
	assert(predicate(thrown), `${label}: 抛出的错误不符合预期：${thrown && thrown.message}`)
	return thrown
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
	const outfile = path.join(tmp, `${name}-2a.mjs`)
	await build({
		entryPoints: [path.join(root, entry)],
		outfile,
		bundle: true,
		format: 'esm',
		platform: 'node',
		target: 'node18',
		external: ['obsidian'],
		logLevel: 'warning'
	})
	return import(`${pathToFileURL(outfile).href}?v=${Date.now()}`)
}

/* ------------------------------------------------------------- fake vault -- */

/** In-memory vault; every adapter call can be made to fail by name. */
function makeApp(options = {}) {
	const files = new Map()
	const dirs = new Set(['.'])
	const vaultFiles = options.vaultFiles ?? []
	let fail = options.fail ?? (() => null)

	const adapter = {
		async exists(p) {
			return files.has(p) || dirs.has(p)
		},
		async mkdir(p) {
			const e = fail('mkdir', p)
			if (e) throw new Error(e)
			dirs.add(p)
		},
		async write(p, data) {
			const e = fail('write', p)
			if (e) throw new Error(e)
			files.set(p, String(data))
		},
		async read(p) {
			if (!files.has(p)) throw new Error(`ENOENT ${p}`)
			return files.get(p)
		},
		async readBinary(p) {
			const e = fail('readBinary', p)
			if (e) throw new Error(e)
			// Round 2A.2.2 (S2): the manifest records size *and* hash from a single
			// read, and verification reads the same way. Files already in the
			// export tree must therefore return their real bytes, otherwise every
			// record would claim the same 3-byte payload and "content changed"
			// could never be detected. Paths that only exist in the vault (source
			// images) keep the fixed payload — the write path is what is tested.
			if (files.has(p)) return new TextEncoder().encode(files.get(p))
			return new Uint8Array([1, 2, 3])
		},
		async writeBinary(p, data) {
			const e = fail('writeBinary', p)
			if (e) throw new Error(e)
			files.set(p, `binary:${data.length}`)
		},
		async stat(p) {
			if (files.has(p)) return { size: files.get(p).length, type: 'file' }
			if (dirs.has(p)) return { size: 0, type: 'folder' }
			return null
		},
		// Round 2A.1: 递归遍历依赖 folders。少了它，walkDir 只看到第一层，
		// 深层文件会被误报成“清单内缺失”。真实 Adapter 两者都返回。
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
			const e = fail('rename', from)
			if (e) throw new Error(e)
			const moved = [...files.keys()].filter(p => p === from || p.startsWith(`${from}/`))
			for (const p of moved) {
				const v = files.get(p)
				files.delete(p)
				files.set(`${to}${p.slice(from.length)}`, v)
			}
			const movedDirs = [...dirs].filter(p => p === from || p.startsWith(`${from}/`))
			for (const p of movedDirs) {
				dirs.delete(p)
				dirs.add(`${to}${p.slice(from.length)}`)
			}
			if (moved.length === 0 && movedDirs.length === 0) {
				throw new Error(`rename: 源不存在 ${from}`)
			}
		},
		async rmdir(p) {
			for (const key of [...files.keys()]) {
				if (key === p || key.startsWith(`${p}/`)) files.delete(key)
			}
			for (const d of [...dirs]) {
				if (d === p || d.startsWith(`${p}/`)) dirs.delete(d)
			}
		}
	}

	const vault = {
		adapter,
		getAbstractFileByPath: p => vaultFiles.find(f => f.path === p) ?? null,
		getFiles: () => vaultFiles
	}

	return {
		app: { vault },
		files,
		dirs,
		setFail(fn) {
			fail = fn
		},
		/** Files under `dir/`, i.e. what a human would see on disk. */
		countUnder: dir => [...files.keys()].filter(k => k.startsWith(`${dir}/`)).length,
		write: (p, v) => files.set(p, v),
		mkdir: p => dirs.add(p)
	}
}

function file(p, size = 128) {
	return {
		path: p,
		name: path.posix.basename(p),
		basename: path.posix.basename(p),
		extension: 'png',
		stat: { size }
	}
}

/* --------------------------------------------------------------- fixtures -- */

const BODY_START = '<!--he-body-start-->'
const BODY_END = '<!--he-body-end-->'

const page = (body = '<p>正文内容</p>') =>
	'<!doctype html>\n<html>\n<head><title>t</title></head>\n<body>\n' +
	`${BODY_START}\n${body}\n${BODY_END}\n</body>\n</html>\n`

const snap = (title = 'note') => ({
	notePath: 'notes/note.md',
	noteTitle: title,
	captureWidth: 900,
	stats: { blocks: 1, images: 0, mermaid: 0, sidenotes: 0, bytesOfContent: 40 },
	resolution: { candidates: [], reason: '唯一可用候选', ambiguity: false },
	previewMetrics: { width: 900 },
	warnings: []
})

const EXTRA = {
	css: { bytes: 10, sheets: [], warnings: [] },
	pluginVersion: '0.1.0',
	audit: { generatedAt: 'x' }
}

/** Round 2A.2.2 (S3): the per-vault HMAC key every fixture export is signed with. */
const SIGNING_KEY = 'b7'.repeat(32)

/* ------------------------------------------------------------------- main -- */

const stubUrl = prepareObsidianStub()
void stubUrl

console.log('\nX-extra — 导出路径安全')
const { safeFolderName, resolveOutputDir, normalizeVaultPath, PathEscapeError } =
	await bundle('src/export/path-safety.ts', 'path-safety')
const { resolveExportDir, identitySuffix, assertVaultRelativeRoot } = await bundle(
	'src/export/path-safety.ts',
	'path-safety'
)

/** Round 2A.1 (F-03): 导出目录现在带身份后缀，测试必须用真实解析结果。 */
const dest = (title, identity = 'notes/note.md') =>
	resolveExportDir('html-export', title, identity).dir

const FORBIDDEN = /[\\/:*?"<>|]/

await check('1. ".." 不能变成上一级目录', () => {
	assertEqual(safeFolderName('..'), 'note', '目录名')
})

await check('2. "." / "..." 同样被拒绝', () => {
	assertEqual(safeFolderName('.'), 'note', '.')
	assertEqual(safeFolderName('...'), 'note', '...')
})

await check('3. "../../etc/passwd" 只剩单一段，且不越界', () => {
	const out = safeFolderName('../../etc/passwd')
	assert(!FORBIDDEN.test(out), `仍含路径分隔符：${out}`)
	assert(out !== '..' && out !== '.', `不能恰好是相对目录：${out}`)
	// The real guarantee is structural: one segment under the configured root.
	const { dir, root: rootDir } = resolveOutputDir('html-export', '../../etc/passwd')
	assertEqual(dir, `html-export/${out}`, '最终目录')
	assert(dir.startsWith(`${rootDir}/`), '必须位于导出根目录之下')
})

await check('4. 绝对路径不能保留前导分隔符', () => {
	const out = safeFolderName('/abs/path')
	assert(!out.startsWith('/'), `仍以 / 开头：${out}`)
	assert(!FORBIDDEN.test(out), `仍含分隔符：${out}`)
})

await check('5. Windows 盘符与反斜杠被替换', () => {
	const out = safeFolderName('C:\\Windows\\x')
	assert(!FORBIDDEN.test(out), `仍含非法字符：${out}`)
})

for (const reserved of ['CON', 'con', 'CON.txt', 'PRN', 'AUX', 'NUL', 'COM1', 'LPT1']) {
	await check(`6. Windows 保留名 ${reserved} 被加前缀`, () => {
		const out = safeFolderName(reserved)
		assert(out.startsWith('_'), `${reserved} 未被保留名规则处理：${out}`)
	})
}

await check('7. COM0 / LPT10 不是保留名，不应被改', () => {
	assertEqual(safeFolderName('COM0'), 'COM0', 'COM0')
	assertEqual(safeFolderName('LPT10'), 'LPT10', 'LPT10')
})

await check('8. 非法字符逐个替换', () => {
	const out = safeFolderName('a:b*c?d"e<f>g|h')
	assert(!FORBIDDEN.test(out), `仍含非法字符：${out}`)
})

await check('9. 首尾空格与结尾点被去掉（Windows 会静默截断）', () => {
	assertEqual(safeFolderName('  题目  '), '题目', '空格')
	assertEqual(safeFolderName('题目...'), '题目', '结尾点')
	assertEqual(safeFolderName('题目. '), '题目', '点+空格')
})

await check('10. 前导点（隐藏文件）被去掉', () => {
	assertEqual(safeFolderName('.hidden'), 'hidden', '.hidden')
})

await check('11. 超长中文标题按 UTF-8 字节截断到 120 以内', () => {
	const out = safeFolderName('测'.repeat(255))
	const bytes = new TextEncoder().encode(out).length
	assert(bytes <= 120, `字节数 ${bytes} 超过 120`)
	assert(out.length > 0, '不能截成空串')
})

await check('12. 表情截断不产生半个代理对', () => {
	const out = safeFolderName('😀'.repeat(100))
	const bytes = new TextEncoder().encode(out).length
	assert(bytes <= 120, `字节数 ${bytes} 超过 120`)
	// A lone surrogate would survive encode() as the replacement character.
	assert(!out.includes('\uFFFD'), '出现替换字符，说明截断切断了码点')
	for (const ch of out) {
		const code = ch.codePointAt(0)
		assert(code > 0xffff || (code < 0xd800 || code > 0xdfff), '出现孤立代理项')
	}
})

await check('13. 空标题 / 纯控制字符回落到 note', () => {
	assertEqual(safeFolderName(''), 'note', '空串')
	assertEqual(safeFolderName('   '), 'note', '空白')
	assertEqual(safeFolderName('\u0000\u0001'), 'note', '控制字符')
})

await check('14. 控制字符被删除而不是留在文件名里', () => {
	assertEqual(safeFolderName('a\u0000b\u001fc'), 'abc', '控制字符')
})

await check('15. resolveOutputDir("html-export", "..") 不越界', () => {
	const { dir, folder, root: rootDir } = resolveOutputDir('html-export', '..')
	assertEqual(folder, 'note', '目录名')
	assertEqual(dir, 'html-export/note', '最终目录')
	assert(dir.startsWith(`${rootDir}/`), '必须位于导出根目录之下')
})

await check('16. resolveOutputDir 处理嵌套与 .. 正规化', () => {
	assertEqual(resolveOutputDir('a/b/../c', 't').dir, 'a/c/t', 'a/b/../c')
	assertEqual(resolveOutputDir('a/b', 'x/y').dir, 'a/b/x_y', '标题里的斜杠')
})

await check('17. normalizeVaultPath 拒绝向上越界', async () => {
	await expectThrow(
		() => normalizeVaultPath('../x'),
		e => e instanceof PathEscapeError,
		'../x'
	)
	assertEqual(normalizeVaultPath('a//b/./c'), 'a/b/c', '正规化')
})

console.log('\nR6 / X8 — 写入统计与清单口径')
const { AssetCollector } = await bundle('src/assets/resource-manager.ts', 'assets')
const { writeExport: writeExportRaw, verifyExport } = await bundle(
	'src/export/writer.ts',
	'writer'
)
// Round 2A.2.2 (S3): every fixture export is signed with the same per-vault
// key; the 8th argument is new, so wrap once instead of editing 5 call sites.
const writeExport = (...args) => writeExportRaw(...args, SIGNING_KEY)

async function collect(app, refs) {
	const assets = new AssetCollector(app)
	for (const ref of refs) {
		assets.resolve(`app://vault/${ref}`, 'assets/media/', 'html', 'content')
	}
	return assets
}

const REFS = ['img/a.png', 'img/b.png', 'img/c.png']
const vaultWith = () => ({ vaultFiles: REFS.map(r => file(r)) })

await check('18. 全部成功：written = 3，磁盘 3 个文件', async () => {
	const fake = makeApp(vaultWith())
	const assets = await collect(fake.app, REFS)
	const report = await assets.flush('out/assets/media')
	assertEqual(report.written, 3, 'written')
	assertEqual(report.writtenEntries.length, 3, 'writtenEntries')
	assertEqual(report.attempted, 3, 'attempted')
	assertEqual(report.failed.length, 0, 'failed')
	assertEqual(fake.countUnder('out/assets/media'), 3, '磁盘文件数')
})

await check('19. 单条失败：written = 2，失败 1，磁盘 2 个文件', async () => {
	const fake = makeApp({
		...vaultWith(),
		fail: (kind, p) => (kind === 'writeBinary' && p.endsWith('b.png') ? 'EACCES' : null)
	})
	const assets = await collect(fake.app, REFS)
	const report = await assets.flush('out/assets/media')
	assertEqual(report.written, 2, 'written')
	assertEqual(
		report.writtenEntries.map(e => e.name.replace(/^[0-9a-f]+-/, '')),
		['a.png', 'c.png'],
		'成功清单'
	)
	assertEqual(report.failed.length, 1, 'failed')
	assertEqual(report.failed[0].name.replace(/^[0-9a-f]+-/, ''), 'b.png', '失败项')
	assertEqual(report.attempted, 3, 'attempted')
	assertEqual(fake.countUnder('out/assets/media'), 2, '磁盘文件数')
})

await check('20. 全部失败：written = 0，磁盘 0 个文件', async () => {
	const fake = makeApp({
		...vaultWith(),
		fail: kind => (kind === 'writeBinary' ? 'EPERM' : null)
	})
	const assets = await collect(fake.app, REFS)
	const report = await assets.flush('out/assets/media')
	assertEqual(report.written, 0, 'written')
	assertEqual(report.writtenEntries.length, 0, 'writtenEntries')
	assertEqual(report.failed.length, 3, 'failed')
	assertEqual(report.attempted, 3, 'attempted')
	assertEqual(fake.countUnder('out/assets/media'), 0, '磁盘文件数')
})

await check('21. 部分失败：contentFailed 与磁盘数量一致', async () => {
	const fake = makeApp({
		...vaultWith(),
		fail: (kind, p) => (kind === 'writeBinary' && p.includes('a.png') ? 'EIO' : null)
	})
	const assets = await collect(fake.app, REFS)
	const report = await assets.flush('out/assets/media')
	assertEqual(report.contentFailed, 1, 'contentFailed')
	assertEqual(report.written + report.failed.length, report.attempted, 'written+failed=attempted')
	assertEqual(fake.countUnder('out/assets/media'), report.written, '磁盘数=written')
})

await check('22. manifest 的 entries 只含成功项，失败项只在 failed', async () => {
	const fake = makeApp({
		...vaultWith(),
		fail: (kind, p) => (kind === 'writeBinary' && p.endsWith('b.png') ? 'EACCES' : null)
	})
	const assets = await collect(fake.app, REFS)
	const report = await writeExport(
		fake.app,
		snap('统计'),
		page(),
		'body{}',
		assets,
		'html-export',
		EXTRA
	)
	const manifest = JSON.parse(
		fake.files.get(`${report.dir}/export-manifest.json`)
	)
	assertEqual(manifest.assets.written, 2, 'manifest written')
	assertEqual(manifest.assets.attempted, 3, 'manifest attempted')
	assertEqual(
		manifest.assets.entries.map(e => e.name.replace(/^[0-9a-f]+-/, '')),
		['a.png', 'c.png'],
		'manifest entries 只能是成功项'
	)
	assertEqual(
		manifest.assets.failed.map(e => e.name.replace(/^[0-9a-f]+-/, '')),
		['b.png'],
		'manifest failed'
	)
})

console.log('\nX6 — 事务写入与目录保护')

await check('23. 陌生目录（无 manifest）拒绝覆盖', async () => {
	const fake = makeApp()
	const dir = dest('我的笔记')
	fake.mkdir('html-export')
	fake.mkdir(dir)
	fake.write(`${dir}/important.txt`, '用户自己的文件')

	const error = await expectThrow(
		() =>
			writeExport(
				fake.app,
				snap('我的笔记'),
				page(),
				'body{}',
				new AssetCollector(fake.app),
				'html-export',
				EXTRA
			),
		e => e.stage === 'publish',
		'陌生目录'
	)
	assert(
		/无法证明它完全由本插件生成/.test(error.message),
		`错误信息应说明拒绝原因：${error.message}`
	)
	assertEqual(fake.files.get(`${dir}/important.txt`), '用户自己的文件', '用户文件必须原样保留')
	assertEqual(fake.countUnder(dir), 1, '不能写入任何导出文件')
})

await check('24. 上一次的有效导出在失败时保持不变', async () => {
	const fake = makeApp()
	await writeExport(
		fake.app,
		snap('周报'),
		page('<p>第一版</p>'),
		'body{}',
		new AssetCollector(fake.app),
		'html-export',
		EXTRA
	)
	const dir = dest('周报')
	const before = fake.files.get(`${dir}/index.html`)
	assert(!!before && before.includes('第一版'), '首次导出应落盘')

	// Second run blows up while still staging.
	fake.setFail((kind, p) =>
		kind === 'write' && p.includes('.tmp-') && p.endsWith('index.html') ? 'ENOSPC' : null
	)
	await expectThrow(
		() =>
			writeExport(
				fake.app,
				snap('周报'),
				page('<p>第二版</p>'),
				'body{}',
				new AssetCollector(fake.app),
				'html-export',
				EXTRA
			),
		e => e.stage === '写入主文件',
		'第二次导出'
	)

	assertEqual(fake.files.get(`${dir}/index.html`), before, '上一次导出必须逐字节保持')
})

await check('25. CSS 写失败时不会留下 index.html（半成品）', async () => {
	const fake = makeApp({
		fail: (kind, p) => (kind === 'write' && p.endsWith('export.css') ? 'EIO' : null)
	})
	await expectThrow(
		() =>
			writeExport(
				fake.app,
				snap('半成品'),
				page(),
				'body{}',
				new AssetCollector(fake.app),
				'html-export',
				EXTRA
			),
		e => e.stage === '写入主文件',
		'CSS 写失败'
	)
	assert(
		!fake.files.has('html-export/半成品/index.html'),
		'最终目录不得出现 index.html'
	)
})

await check('26. 目录里多出清单外的文件时校验失败', async () => {
	const fake = makeApp()
	const assets = new AssetCollector(fake.app)
	fake.mkdir('out')
	fake.mkdir('out/assets')
	fake.mkdir('out/assets/media')
	const bodies = {
		'index.html': page(),
		'assets/export.css': 'body{}',
		'runtime-audit.json': '{}'
	}
	for (const [p, body] of Object.entries(bodies)) fake.write(`out/${p}`, body)
	// Round 2A.2.2 (S2): a record must carry a real byte count and a 64-hex
	// SHA-256. A bare `{ path }` list is no longer a usable manifest, so the
	// fixture must be *fully* valid for the extra file to be the only break —
	// otherwise the case would go red for the wrong reason.
	const record = p => ({
		path: p,
		bytes: Buffer.byteLength(bodies[p], 'utf8'),
		sha256: createHash('sha256').update(bodies[p], 'utf8').digest('hex')
	})
	fake.write(
		'out/export-manifest.json',
		JSON.stringify({
			manifestVersion: 2,
			notePath: 'notes/note.md',
			stats: { blocks: 1 },
			assets: { written: 0, entries: [], failed: [] },
			files: Object.keys(bodies).map(record)
		})
	)
	fake.write('out/assets/media/stale.png', 'binary:3')

	const verified = await verifyExport(fake.app, 'out', await assets.flush('out/assets/media'), {
		body: null
	})
	const check11 = verified.checks.find(c => c.name === '目录内容与清单一致')
	assert(!!check11, '必须存在目录一致性检查')
	assertEqual(check11.ok, false, '多余文件必须让校验失败')
	assert(/多余 1 个/.test(check11.detail), `detail 应指出多余文件：${check11.detail}`)
})

/* ---------------------------------------------------------------- report -- */

console.log('')
if (failures.length > 0) {
	console.error(`✗ ${failures.length} 项失败 / ${passed + failures.length} 项`)
	for (const f of failures) console.error(`  - ${f.name}: ${f.message}`)
	process.exit(1)
}
console.log(`✓ 全部 ${passed} 项通过`)
