/**
 * Round 2A.1 tests — export ownership, directory integrity, stable identity.
 *
 * Round 2A's review left three findings open:
 *
 *   F-01  `publish()` treated "a manifest exists" as proof the directory was
 *         ours, then renamed it to `.bak-…` and deleted it recursively. Any
 *         file the user had put next to that manifest went with it.
 *   F-02  `verifyExport()` only walked `assets/media`, so a stray file at the
 *         root or under `assets/` still verified green.
 *   F-03  `A:B`, `A?B` and `A_B` all sanitised to `A_B`, and two long titles
 *         sharing their first 120 bytes truncated to the same name — different
 *         notes silently overwrote each other.
 *
 * Every test here asserts on the *final directory*, not on an intermediate
 * string: a slug that looks unique but resolves to a shared folder is exactly
 * the bug F-03 describes.
 *
 * Run with: npm run test:round2a1
 */
import { createHmac } from 'node:crypto'
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
	const outfile = path.join(tmp, `${name}-2a1.mjs`)
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

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const toBytes = value => (typeof value === 'string' ? encoder.encode(value) : value)

/**
 * In-memory vault whose `list()` behaves like the real adapter: both `files`
 * and `folders` carry full paths. A fixture that omits `folders` cannot express
 * a deep file, and a walk that only sees one level reports the deep file as
 * "missing" instead of "extra" — which is how the F-02 tests would silently
 * test the wrong thing.
 */
function makeApp(options = {}) {
	const files = new Map()
	const dirs = new Set(['.'])
	const vaultFiles = options.vaultFiles ?? []

	const adapter = {
		async exists(p) {
			return files.has(p) || dirs.has(p)
		},
		async mkdir(p) {
			dirs.add(p)
		},
		async write(p, data) {
			files.set(p, String(data))
		},
		async read(p) {
			if (!files.has(p)) throw new Error(`ENOENT ${p}`)
			const value = files.get(p)
			return typeof value === 'string' ? value : decoder.decode(value)
		},
		async readBinary(p) {
			if (!files.has(p)) throw new Error(`ENOENT ${p}`)
			return toBytes(files.get(p))
		},
		async writeBinary(p, data) {
			files.set(p, data)
		},
		async stat(p) {
			if (files.has(p)) return { size: toBytes(files.get(p)).length, type: 'file' }
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
			const movedFiles = [...files.keys()].filter(p => p === from || p.startsWith(`${from}/`))
			const movedDirs = [...dirs].filter(p => p === from || p.startsWith(`${from}/`))
			if (movedFiles.length === 0 && movedDirs.length === 0) {
				throw new Error(`rename: 源不存在 ${from}`)
			}
			for (const p of movedFiles) {
				const value = files.get(p)
				files.delete(p)
				files.set(`${to}${p.slice(from.length)}`, value)
			}
			for (const p of movedDirs) {
				dirs.delete(p)
				dirs.add(`${to}${p.slice(from.length)}`)
			}
		},
		async rmdir(p, recursive) {
			const children = [...files.keys()].filter(k => k.startsWith(`${p}/`))
			if (!recursive && children.length > 0) {
				throw new Error(`rmdir: 目录非空 ${p}`)
			}
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
		/** Files under `dir/`, i.e. what a human would see on disk. */
		under: dir => [...files.keys()].filter(k => k.startsWith(`${dir}/`)).sort(),
		write: (p, v) => files.set(p, v),
		mkdir: p => dirs.add(p),
		snapshot: () => new Map(files)
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

const snap = (title = 'note', notePath = 'notes/note.md') => ({
	notePath,
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

/** An `AssetReport` for `verifyExport`, with `names` already on disk. */
const assetReport = (names = []) => ({
	written: names.length,
	writtenEntries: names.map(name => ({ name })),
	attempted: names.length,
	failed: [],
	entries: names.map(name => ({ name })),
	missing: [],
	warnings: [],
	remote: [],
	external: [],
	contentFailed: 0,
	contentMissing: 0
})

async function sha256hex(bytes) {
	const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
	return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Round 2A.2.2 (S3): fixtures are signed exactly like a real export.
 *
 * The HMAC is computed with `node:crypto` while the production code signs with
 * WebCrypto. If the two disagreed about the algorithm or the canonical payload,
 * every "owned" assertion below would fail — so these fixtures double as a
 * cross-check of the signing implementation.
 */
const TEST_KEY = 'ef'.repeat(32)
function signFixture(manifest) {
	manifest.signature = {
		alg: 'HMAC-SHA256',
		v: 1,
		value: createHmac('sha256', Buffer.from(TEST_KEY, 'hex'))
			.update(signingPayload(manifest))
			.digest('hex')
	}
	return manifest
}

/**
 * Seed a *valid* export directory: index.html, css, audit, optional media, and
 * a signed v2 manifest whose `files[]` carries real sizes and hashes. Every
 * F-02 test starts from this and breaks exactly one thing, so a red result
 * names the break rather than a broken fixture.
 */
async function seedValid(fake, dir, options = {}) {
	const media = options.media ?? []
	const notePath = options.notePath ?? 'notes/note.md'
	fake.mkdir(dir)
	fake.mkdir(`${dir}/assets`)
	if (media.length > 0) fake.mkdir(`${dir}/assets/media`)
	fake.write(`${dir}/index.html`, page(options.body))
	fake.write(`${dir}/assets/export.css`, 'body{}')
	fake.write(`${dir}/runtime-audit.json`, '{"ok":true}')
	for (const name of media) fake.write(`${dir}/assets/media/${name}`, 'binary:3')

	const paths = [
		'index.html',
		'assets/export.css',
		'runtime-audit.json',
		...media.map(name => `assets/media/${name}`)
	]
	const files = []
	for (const p of paths) {
		const bytes = toBytes(fake.files.get(`${dir}/${p}`))
		files.push({ path: p, bytes: bytes.length, sha256: await sha256hex(bytes) })
	}

	const manifest = {
		manifestVersion: 2,
		notePath,
		identitySuffix: identitySuffix(notePath),
		outputFolder: dir.split('/').pop(),
		stats: { blocks: 1, images: media.length, mermaid: 0, sidenotes: 0, bytesOfContent: 40 },
		assets: { written: media.length, entries: media.map(name => ({ name })), failed: [] },
		files
	}
	signFixture(manifest)
	fake.write(`${dir}/export-manifest.json`, JSON.stringify(manifest))
	return manifest
}

/* ------------------------------------------------------------------- main -- */

const stubUrl = prepareObsidianStub()
void stubUrl

const { safeFolderName, resolveExportDir, identitySuffix, assertVaultRelativeRoot, PathEscapeError } =
	await bundle('src/export/path-safety.ts', 'path-safety')
const { inspectOwnership, verifyExport, writeExport } = await bundle(
	'src/export/writer.ts',
	'writer'
)
const { signingPayload } = await bundle('src/export/manifest-signing.ts', 'manifest-signing')
const { AssetCollector } = await bundle('src/assets/resource-manager.ts', 'resource-manager')

/* ========================================================================== *
 * F-01 — a directory may only be replaced when ownership is *proven*
 * ========================================================================== */

console.log('\nF-01 — 目录所有权必须可证明')

// Round 2A.2.2 (S3): ownership now requires a signed v2 manifest whose
// `identitySuffix`/`outputFolder` match the real directory, so the fixture
// directory has to be the one `resolveExportDir` would actually produce.
const OWN = resolveExportDir('html-export', 'owned', 'notes/note.md').dir

await check('1. 与清单完全一致（含哈希）时判定为可替换', async () => {
	const fake = makeApp()
	await seedValid(fake, OWN, { media: ['a.png', 'b.png'] })
	const verdict = await inspectOwnership(fake.app, OWN, 'notes/note.md', TEST_KEY)
	assert(verdict.owned, `应判定为自有目录，实际：${verdict.reason}`)
	// Round 2A.2.2 (S3): the basis is no longer a bare hash list — the manifest
	// itself is HMAC-signed with the per-vault key.
	assertEqual(verdict.basis, 'manifest-hmac', '判定依据')
	assertEqual(verdict.foreignFiles, [], '清单外文件')
	assertEqual(verdict.missingFiles, [], '缺失文件')
	assertEqual(verdict.checked, 5, '比对文件数')
})

await check('2. 根目录有 README.md 时拒绝（用户文件）', async () => {
	const fake = makeApp()
	await seedValid(fake, OWN)
	fake.write(`${OWN}/README.md`, '# 我写的说明')
	const verdict = await inspectOwnership(fake.app, OWN, 'notes/note.md', TEST_KEY)
	assert(!verdict.owned, '不得判定为自有目录')
	assert(verdict.foreignFiles.includes('README.md'), `应识别出 README.md：${verdict.foreignFiles}`)
	assert(/README\.md/.test(verdict.reason), `原因应点名 README.md：${verdict.reason}`)
})

await check('3. 根目录有用户图片时拒绝', async () => {
	const fake = makeApp()
	await seedValid(fake, OWN)
	fake.write(`${OWN}/封面.png`, 'binary:99')
	const verdict = await inspectOwnership(fake.app, OWN, 'notes/note.md', TEST_KEY)
	assert(!verdict.owned, '不得判定为自有目录')
	assert(verdict.foreignFiles.includes('封面.png'), `应识别出封面.png：${verdict.foreignFiles}`)
})

await check('4. assets/custom.css 时拒绝', async () => {
	const fake = makeApp()
	await seedValid(fake, OWN)
	fake.write(`${OWN}/assets/custom.css`, '.mine{}')
	const verdict = await inspectOwnership(fake.app, OWN, 'notes/note.md', TEST_KEY)
	assert(!verdict.owned, '不得判定为自有目录')
	assert(
		verdict.foreignFiles.includes('assets/custom.css'),
		`应识别出 assets/custom.css：${verdict.foreignFiles}`
	)
})

await check('5. assets/media 里有用户文件时拒绝', async () => {
	const fake = makeApp()
	await seedValid(fake, OWN, { media: ['a.png'] })
	fake.write(`${OWN}/assets/media/user-image.png`, 'binary:7')
	const verdict = await inspectOwnership(fake.app, OWN, 'notes/note.md', TEST_KEY)
	assert(!verdict.owned, '不得判定为自有目录')
	assert(
		verdict.foreignFiles.includes('assets/media/user-image.png'),
		`应识别出用户图片：${verdict.foreignFiles}`
	)
})

await check('6. 深层用户目录（任意深度）时拒绝', async () => {
	const fake = makeApp()
	await seedValid(fake, OWN)
	fake.mkdir(`${OWN}/我的资料`)
	fake.mkdir(`${OWN}/我的资料/2026`)
	fake.write(`${OWN}/我的资料/2026/清单.txt`, '别删我')
	const verdict = await inspectOwnership(fake.app, OWN, 'notes/note.md', TEST_KEY)
	assert(!verdict.owned, '不得判定为自有目录')
	assert(
		verdict.foreignFiles.includes('我的资料/2026/清单.txt'),
		`应识别出深层文件：${verdict.foreignFiles}`
	)
	assert(
		verdict.foreignDirs.includes('我的资料'),
		`应识别出多余目录：${verdict.foreignDirs}`
	)
})

await check('7. 清单被改动（不可解析）时拒绝', async () => {
	const fake = makeApp()
	await seedValid(fake, OWN)
	fake.write(`${OWN}/export-manifest.json`, '{ 这不是 JSON')
	const verdict = await inspectOwnership(fake.app, OWN, 'notes/note.md', TEST_KEY)
	assert(!verdict.owned, '不得判定为自有目录')
	assertEqual(verdict.basis, 'none', '判定依据')
	assert(/清单/.test(verdict.reason), `原因应说明清单问题：${verdict.reason}`)
})

await check('8. 清单记录的文件缺失时拒绝', async () => {
	const fake = makeApp()
	await seedValid(fake, OWN, { media: ['a.png'] })
	fake.files.delete(`${OWN}/assets/media/a.png`)
	const verdict = await inspectOwnership(fake.app, OWN, 'notes/note.md', TEST_KEY)
	assert(!verdict.owned, '不得判定为自有目录')
	assert(
		verdict.missingFiles.includes('assets/media/a.png'),
		`应识别出缺失：${verdict.missingFiles}`
	)
})

await check('9. 文件内容被改（哈希不符）时拒绝', async () => {
	const fake = makeApp()
	await seedValid(fake, OWN)
	fake.write(`${OWN}/index.html`, page('<p>我手动改过</p>'))
	const verdict = await inspectOwnership(fake.app, OWN, 'notes/note.md', TEST_KEY)
	assert(!verdict.owned, '不得判定为自有目录')
	assert(
		verdict.changedFiles.some(p => p.startsWith('index.html')),
		`应识别出内容变化：${verdict.changedFiles}`
	)
})

await check('10. 老清单（无 files）即使带正文标记也不再判定为自有（S1：旧版一律拒绝）', async () => {
	// 2A.2.1 旧断言（已废弃）：
	//   check('10. 老清单（无 files）但有正文标记时按结构判定为自有', ...)
	//   assert(verdict.owned, ...); assertEqual(verdict.basis, 'legacy-structure', ...)
	// 2A.2.2 / S1：旧版清单与「把新版清单降级」在字段结构上无法区分，而清单
	// 本身可被任意改写，因此结构证明不再能充当归属证明——旧版一律拒绝覆盖。
	const fake = makeApp()
	fake.mkdir(OWN)
	fake.mkdir(`${OWN}/assets`)
	fake.write(`${OWN}/index.html`, page())
	fake.write(`${OWN}/assets/export.css`, 'body{}')
	fake.write(`${OWN}/runtime-audit.json`, '{}')
	fake.write(
		`${OWN}/export-manifest.json`,
		JSON.stringify({
			notePath: 'notes/note.md',
			stats: { blocks: 1 },
			assets: { written: 0, entries: [], failed: [] }
		})
	)
	const verdict = await inspectOwnership(fake.app, OWN, 'notes/note.md', TEST_KEY)
	assert(!verdict.owned, `旧版目录不得判定为自有，实际：${verdict.reason}`)
	assertEqual(verdict.basis, 'none', '判定依据')
	assert(/旧版/.test(verdict.reason), `拒绝原因应说明是旧版：${verdict.reason}`)
})

await check('10b. 老清单缺少 notePath → 拒绝（S1 起由版本门禁直接拒绝）', async () => {
	const fake = makeApp()
	fake.mkdir(OWN)
	fake.mkdir(`${OWN}/assets`)
	fake.write(`${OWN}/index.html`, page())
	fake.write(`${OWN}/assets/export.css`, 'body{}')
	fake.write(`${OWN}/runtime-audit.json`, '{}')
	fake.write(
		`${OWN}/export-manifest.json`,
		JSON.stringify({ stats: { blocks: 1 }, assets: { written: 0, entries: [], failed: [] } })
	)
	const verdict = await inspectOwnership(fake.app, OWN, 'notes/note.md', TEST_KEY)
	assert(!verdict.owned, '缺少 notePath 时不得判定为自有目录')
	// 2A.2.1 断言的是 /notePath/；2A.2.2 起拒绝发生在更早的版本门禁，
	// 理由里出现的是「旧版」。拒绝的结论不变。
	assert(/旧版|notePath/.test(verdict.reason), `拒绝原因应点名旧版或 notePath：${verdict.reason}`)
})

await check('11. 无清单且无正文标记时拒绝', async () => {
	const fake = makeApp()
	fake.mkdir(OWN)
	fake.write(`${OWN}/index.html`, '<!doctype html><p>别人的网页</p>')
	const verdict = await inspectOwnership(fake.app, OWN, 'notes/note.md', TEST_KEY)
	assert(!verdict.owned, '不得判定为自有目录')
	// Round 2A.2.1 (S2): the refusal now happens at the manifest step — with no
	// manifest there is no `notePath`, so no ownership basis is ever reached.
	assertEqual(verdict.basis, 'none', '判定依据')
})

await check('12. 拒绝时目录内每个文件都原样保留（端到端）', async () => {
	const fake = makeApp()
	const dir = resolveExportDir('html-export', '笔记', 'notes/笔记.md').dir
	await seedValid(fake, dir, { media: ['a.png'] })
	fake.write(`${dir}/README.md`, '# 我写的说明')
	fake.write(`${dir}/assets/media/user-image.png`, 'binary:7')
	const before = fake.snapshot()

	await expectThrow(
		() =>
			writeExport(
				fake.app,
				snap('笔记', 'notes/笔记.md'),
				page('<p>新版本</p>'),
				'body{}',
				new AssetCollector(fake.app),
				'html-export',
				EXTRA,
					TEST_KEY
			),
		error => error.stage === 'publish' && /无法证明它完全由本插件生成/.test(error.message),
		'覆盖陌生目录'
	)

	assertEqual(fake.files.get(`${dir}/README.md`), '# 我写的说明', 'README 必须逐字节保留')
	assertEqual(
		fake.files.get(`${dir}/assets/media/user-image.png`),
		'binary:7',
		'用户图片必须逐字节保留'
	)
	// The previous export must be untouched too — a refusal is not a partial write.
	assertEqual(fake.files.get(`${dir}/index.html`), before.get(`${dir}/index.html`), '旧导出主文件')
	assertEqual(fake.under(dir).length, before.size, '目录内文件数量不变')
	// And no leftover half-product in the target directory.
	assert(
		!fake.under(dir).some(p => p.includes('.bak-')),
		`拒绝时不应留下备份目录：${fake.under(dir)}`
	)
})

await check('13. 目录属于另一篇笔记时拒绝（路径不匹配）', async () => {
	const fake = makeApp()
	const dir = resolveExportDir('html-export', '同名', 'notes/A.md').dir
	await seedValid(fake, dir, { notePath: 'notes/B.md' })

	await expectThrow(
		() =>
			writeExport(
				fake.app,
				snap('同名', 'notes/A.md'),
				page(),
				'body{}',
				new AssetCollector(fake.app),
				'html-export',
				EXTRA,
					TEST_KEY
			),
		error => error.stage === 'publish' && /属于另一篇笔记/.test(error.message),
		'跨笔记覆盖'
	)
	assert(!!fake.files.get(`${dir}/export-manifest.json`), '清单必须保留')
})

await check('14. 可以替换时旧导出不再删除，而是保留到 .bak- 备份目录', async () => {
	// Round 2A.2 (B5): the previous export is no longer auto-deleted. It is
	// moved to a `.bak-` directory and retained so the user can recover.
	const fake = makeApp()
	const dir = resolveExportDir('html-export', '正常', 'notes/正常.md').dir
	await seedValid(fake, dir, { notePath: 'notes/正常.md' })
	const report = await writeExport(
		fake.app,
		snap('正常', 'notes/正常.md'),
		page('<p>第二版</p>'),
		'body{}',
		new AssetCollector(fake.app),
		'html-export',
		EXTRA,
			TEST_KEY
	)
	assertEqual(report.dir, dir, '导出目录')
	assert(!!report.leftoverBackup, '应遗留备份目录（Round 2A.2 B5：默认不再自动删除）')
	assert(report.leftoverBackup.includes('.bak-'), '备份目录应为 .bak- 形式')
	const backups = fake.under('html-export').filter(p => p.includes('.bak-'))
	assert(backups.length >= 1, `应保留至少一个备份文件：${JSON.stringify(fake.under('html-export'))}`)
	assert(
		fake.files.get(`${report.leftoverBackup}/index.html`).includes('正文内容'),
		'备份目录应保留旧内容，未被自动删除'
	)
	assert(
		fake.files.get(`${dir}/index.html`).includes('第二版'),
		'应写入新版本'
	)
	assert(
		![...fake.files.keys()].some(p => p.includes('.tmp-')),
		'成功提交后不应残留临时目录'
	)
})

/* ========================================================================== *
 * F-02 — the whole directory is compared, not just assets/media
 * ========================================================================== */

console.log('\nF-02 — 目录完整性校验')

/** Run verifyExport and return the directory-integrity check. */
async function integrity(fake, dir, report) {
	const verified = await verifyExport(fake.app, dir, report, { body: null })
	const found = verified.checks.find(c => c.name === '目录内容与清单一致')
	assert(!!found, '必须存在目录一致性检查')
	return { verified, found }
}

await check('15. 根目录额外文件 → 校验失败', async () => {
	const fake = makeApp()
	const dir = 'out'
	await seedValid(fake, dir)
	fake.write(`${dir}/README.md`, '# 说明')
	const { verified, found } = await integrity(fake, dir, assetReport())
	assertEqual(found.ok, false, '校验结论')
	assert(/多余 1 个/.test(found.detail), `应指出 1 个多余文件：${found.detail}`)
	assert(/README\.md/.test(found.detail), `应点名 README.md：${found.detail}`)
	assertEqual(verified.ok, false, '整体校验不得 PASS')
})

await check('16. assets 额外文件 → 校验失败', async () => {
	const fake = makeApp()
	const dir = 'out'
	await seedValid(fake, dir)
	fake.write(`${dir}/assets/custom.css`, '.mine{}')
	const { verified, found } = await integrity(fake, dir, assetReport())
	assertEqual(found.ok, false, '校验结论')
	assert(/assets\/custom\.css/.test(found.detail), `应点名 custom.css：${found.detail}`)
	assertEqual(verified.ok, false, '整体校验不得 PASS')
})

await check('17. media 额外文件 → 校验失败', async () => {
	const fake = makeApp()
	const dir = 'out'
	await seedValid(fake, dir, { media: ['a.png'] })
	fake.write(`${dir}/assets/media/user-image.png`, 'binary:7')
	const { verified, found } = await integrity(fake, dir, assetReport(['a.png']))
	assertEqual(found.ok, false, '校验结论')
	assert(
		/assets\/media\/user-image\.png/.test(found.detail),
		`应点名用户图片：${found.detail}`
	)
	assertEqual(verified.ok, false, '整体校验不得 PASS')
})

await check('18. 深层额外文件 → 校验失败，并报出多余目录', async () => {
	const fake = makeApp()
	const dir = 'out'
	await seedValid(fake, dir)
	fake.mkdir(`${dir}/我的资料`)
	fake.mkdir(`${dir}/我的资料/2026`)
	fake.write(`${dir}/我的资料/2026/清单.txt`, '别删我')
	const { verified, found } = await integrity(fake, dir, assetReport())
	assertEqual(found.ok, false, '校验结论')
	assert(/多余 1 个/.test(found.detail), `应指出多余文件：${found.detail}`)
	// Both the directory and its parent are unaccounted for; the deeper one is
	// what a reader needs to see, so the count has to include both.
	assert(/多余目录 2 个/.test(found.detail), `应指出多余目录：${found.detail}`)
	assert(/我的资料\/2026/.test(found.detail), `应点名最深的多余目录：${found.detail}`)
	assertEqual(verified.ok, false, '整体校验不得 PASS')
})

await check('19. 清单内文件缺失 → 校验失败', async () => {
	const fake = makeApp()
	const dir = 'out'
	await seedValid(fake, dir, { media: ['a.png'] })
	fake.files.delete(`${dir}/assets/media/a.png`)
	const { verified, found } = await integrity(fake, dir, assetReport(['a.png']))
	assertEqual(found.ok, false, '校验结论')
	assert(/缺失 1 个/.test(found.detail), `应指出缺失：${found.detail}`)
	assertEqual(verified.ok, false, '整体校验不得 PASS')
})

await check('20. 内容哈希不一致 → 校验失败', async () => {
	const fake = makeApp()
	const dir = 'out'
	await seedValid(fake, dir)
	fake.write(`${dir}/assets/export.css`, 'body{/* 我改过 */}')
	const { verified, found } = await integrity(fake, dir, assetReport())
	assertEqual(found.ok, false, '校验结论')
	assert(/内容不符 1 个/.test(found.detail), `应指出内容不符：${found.detail}`)
	assert(/assets\/export\.css/.test(found.detail), `应点名 export.css：${found.detail}`)
	assertEqual(verified.ok, false, '整体校验不得 PASS')
})

await check('21. manifest 资源记录不一致 → 校验失败', async () => {
	const fake = makeApp()
	const dir = 'out'
	await seedValid(fake, dir, { media: ['a.png'] })
	// Manifest claims two packaged images, `files` only knows about one.
	const manifest = JSON.parse(fake.files.get(`${dir}/export-manifest.json`))
	manifest.assets.entries.push({ name: 'b.png' })
	manifest.assets.written = 2
	fake.write(`${dir}/export-manifest.json`, JSON.stringify(manifest))

	const verified = await verifyExport(fake.app, dir, assetReport(['a.png']), { body: null })
	const found = verified.checks.find(c => c.name === 'manifest 资源记录自洽')
	assert(!!found, '必须存在 manifest 自洽检查')
	assertEqual(found.ok, false, '校验结论')
	assert(/b\.png/.test(found.detail), `应点名 entries 多出的文件：${found.detail}`)
	assertEqual(verified.ok, false, '整体校验不得 PASS')
})

/* ========================================================================== *
 * F-03 — the export directory has a stable, unique identity
 * ========================================================================== */

console.log('\nF-03 — 导出目录身份')

const folderOf = (title, identity) => resolveExportDir('html-export', title, identity).folder
const dirOf = (title, identity) => resolveExportDir('html-export', title, identity).dir

/** Windows/macOS compare names case-insensitively; two folders must still differ. */
function assertDistinct(a, b, label) {
	assert(a !== b, `${label}: 目录相同 ${a}`)
	assert(a.toLowerCase() !== b.toLowerCase(), `${label}: 大小写不敏感时仍相同 ${a}`)
}

await check('22. "A:B" 与 "A_B" 不再共用目录', () => {
	const a = dirOf('A:B', 'notes/1.md')
	const b = dirOf('A_B', 'notes/2.md')
	assertEqual(safeFolderName('A:B'), 'A_B', '两个标题的 slug 相同（前提）')
	assertDistinct(a, b, 'A:B 与 A_B')
})

await check('23. "A?B" 与 "A_B" 不再共用目录', () => {
	const a = dirOf('A?B', 'notes/1.md')
	const b = dirOf('A_B', 'notes/2.md')
	assertEqual(safeFolderName('A?B'), 'A_B', '两个标题的 slug 相同（前提）')
	assertDistinct(a, b, 'A?B 与 A_B')
})

await check('24. "A:B" / "A?B" / "A_B" 三者互不相同', () => {
	const dirs = ['A:B', 'A?B', 'A_B'].map((title, i) => dirOf(title, `notes/${i}.md`))
	assertEqual(new Set(dirs).size, 3, `三个目录必须互不相同：${dirs.join(' | ')}`)
})

await check('25. 同标题的不同笔记不共用目录', () => {
	const a = dirOf('周报', 'work/2026/第1周.md')
	const b = dirOf('周报', 'personal/2026/第1周.md')
	assertDistinct(a, b, '同标题不同笔记')
	// …and each stays stable across repeated resolution.
	assertEqual(dirOf('周报', 'work/2026/第1周.md'), a, '同一笔记必须稳定')
})

await check('26. 超长标题截断后仍不共用目录', () => {
	const prefix = '很长的标题'.repeat(40) // 600 bytes, well past the 120-byte cap
	const a = dirOf(`${prefix}A`, 'notes/long-a.md')
	const b = dirOf(`${prefix}B`, 'notes/long-b.md')
	assertEqual(safeFolderName(`${prefix}A`), safeFolderName(`${prefix}B`), '截断后 slug 相同（前提）')
	assertDistinct(a, b, '超长标题')
})

await check('27. emoji 标题可用且目录合法', () => {
	const dir = dirOf('🎉 庆祝 · 发布', 'notes/party.md')
	const folder = folderOf('🎉 庆祝 · 发布', 'notes/party.md')
	assert(!/[\\/:*?"<>|]/.test(folder), `目录名不得含非法字符：${folder}`)
	assert(!folder.startsWith('.') && !folder.endsWith('.'), `不得以点开头或结尾：${folder}`)
	assert(folder.startsWith('🎉'), `可读部分应保留 emoji：${folder}`)
	assert(dir.startsWith('html-export/'), `必须位于导出根目录之下：${dir}`)
	assertEqual(dirOf('🎉 庆祝 · 发布', 'notes/party.md'), dir, '必须稳定')
})

await check('28. 不同原路径、同一 slug 不共用目录', () => {
	const a = dirOf('a/b', 'notes/x.md')
	const b = dirOf('a\\b', 'notes/y.md')
	assertEqual(safeFolderName('a/b'), 'a_b', '前提：slug 相同')
	assertEqual(safeFolderName('a\\b'), 'a_b', '前提：slug 相同')
	assertDistinct(a, b, '不同原路径同一 slug')
})

await check('29. Windows 大小写冲突：Report.md 与 report.md 不共用目录', () => {
	const a = dirOf('Report', 'notes/Report.md')
	const b = dirOf('Report', 'notes/report.md')
	// Same readable title, identities differing only by case: the hashes must
	// still differ, or one note overwrites the other on a case-insensitive disk.
	assert(identitySuffix('notes/Report.md') !== identitySuffix('notes/report.md'), '后缀必须不同')
	assertDistinct(a, b, '大小写不同的身份')
})

await check('30. 同一笔记重复导出落到同一目录，旧版保留为 .bak- 备份（端到端）', async () => {
	// Round 2A.2 (B5): a repeat export keeps the previous run as a `.bak-`
	// backup instead of deleting it, so there should be exactly one final
	// export directory plus exactly one backup directory.
	const fake = makeApp()
	const notePath = 'notes/重复.md'
	const first = await writeExport(
		fake.app,
		snap('重复', notePath),
		page('<p>第一版</p>'),
		'body{}',
		new AssetCollector(fake.app),
		'html-export',
		EXTRA,
			TEST_KEY
	)
	const second = await writeExport(
		fake.app,
		snap('重复', notePath),
		page('<p>第二版</p>'),
		'body{}',
		new AssetCollector(fake.app),
		'html-export',
		EXTRA,
			TEST_KEY
	)
	assertEqual(second.dir, first.dir, '两次导出的目录必须相同')
	const topLevel = [...fake.dirs].filter(d => path.posix.dirname(d) === 'html-export')
	const finals = topLevel.filter(d => !d.includes('.bak-'))
	const backups = topLevel.filter(d => d.includes('.bak-'))
	assertEqual(finals.length, 1, `导出根目录下应只有一个最终导出目录：${topLevel}`)
	assertEqual(backups.length, 1, `应恰好保留一个备份目录：${topLevel}`)
	assert(fake.files.get(`${first.dir}/index.html`).includes('第二版'), '应写入第二版')
	assert(
		fake.files.get(`${backups[0]}/index.html`).includes('第一版'),
		'备份目录应保留第一版内容'
	)
})

await check('31. 输出根目录必须是 vault 相对路径（F-04）', () => {
	for (const bad of ['C:\\out', 'D:/out', '//server/share', '\\\\server\\share', '/abs']) {
		let thrown = null
		try {
			assertVaultRelativeRoot(bad)
		} catch (error) {
			thrown = error
		}
		assert(thrown instanceof PathEscapeError, `应拒绝 ${bad}`)
	}
	assertEqual(assertVaultRelativeRoot('html-export'), 'html-export', '正常路径原样返回')
})

/* ---------------------------------------------------------------- report -- */

console.log('')
if (failures.length > 0) {
	console.error(`✗ ${failures.length} 项失败 / ${passed + failures.length} 项`)
	for (const f of failures) console.error(`  - ${f.name}: ${f.message}`)
	process.exit(1)
}
console.log(`✓ 全部 ${passed} 项通过`)
