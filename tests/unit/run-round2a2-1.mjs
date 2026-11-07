/**
 * Round 2A.2.1 — S1–S5 专项测试
 *
 * 只覆盖主控复现出的 5 项问题，不重复 2A.2 已有的 B2–B6 断言（那套仍在
 * `run-round2a2.mjs` 里跑）。两套加起来才是完整回归。
 *
 *   S1  Manifest 版本降级（删 manifestVersion 不得变成 legacy）
 *   S2  notePath 参与所有权验证（含 legacy 与跨笔记共用目录）
 *   S3  Manifest 路径校验：先验证原始值，不清洗
 *   S4  safeRemoveBackup 已移除，且没有替代的自动删除入口
 *   S5  发布失败恢复：恢复成功 / 恢复失败两条路径各自的报告
 *
 * 与 2A.2 同一套手法：esbuild 把真实 `src/export/writer.ts` 编到内存，喂一个
 * 忠实实现 `adapter.list` 语义、可注入 rename 故障的内存适配器。
 *
 * 运行：node tests/unit/run-round2a2-1.mjs
 * 隔离副本：AB_ROOT=<copy> node tests/unit/run-round2a2-1.mjs   （反向对照用）
 */
import { build } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash, createHmac } from 'node:crypto'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = process.env.AB_ROOT
	? path.resolve(process.env.AB_ROOT)
	: path.resolve(here, '../..')
const out = path.join(here, '.out-round2a2-1')

/* ------------------------------------------------------------- bundling -- */
function prepareStub() {
	const dir = path.join(out, 'node_modules', 'obsidian')
	fs.mkdirSync(dir, { recursive: true })
	fs.writeFileSync(
		path.join(dir, 'index.mjs'),
		`export class TFile { constructor(p, size = 1) { this.path = p; this.name = p.split('/').pop() ?? p; this.basename = this.name.replace(/\\.[^.]+$/, ''); this.stat = { size } } }
export class TFolder {}
export class App {}
export class Plugin {}
export class MarkdownView {}
export class Notice {}
export class PluginSettingTab {}
export class Setting {}
export function normalizePath(p) { return p.replace(/\\\\/g, '/').replace(/\\/{2,}/g, '/').replace(/^\\/+/, '').replace(/\\/+$/, '') }
`
	)
	fs.writeFileSync(
		path.join(dir, 'package.json'),
		JSON.stringify({ name: 'obsidian', version: '0.0.0-stub', type: 'module', main: 'index.mjs', exports: './index.mjs' })
	)
}
async function bundle(entry, name) {
	prepareStub()
	const outfile = path.join(out, `${name}.mjs`)
	await build({ entryPoints: [path.join(root, entry)], outfile, bundle: true, format: 'esm', platform: 'node', target: 'node18', external: ['obsidian'], logLevel: 'error' })
	return import(`${pathToFileURL(outfile).href}?v=${Date.now()}`)
}

const writerModule = await bundle('src/export/writer.ts', 'writer')
const { writeExport, inspectOwnership } = writerModule
const { AssetCollector } = await bundle('src/assets/resource-manager.ts', 'assets')
const { resolveExportDir, identitySuffix } = await bundle('src/export/path-safety.ts', 'path-safety')
const { signingPayload } = await bundle('src/export/manifest-signing.ts', 'manifest-signing')

/**
 * Round 2A.2.2 (S3): fixtures are signed like real exports, with node:crypto
 * instead of WebCrypto so the two HMAC implementations cross-check each other.
 */
const TEST_KEY = 'cd'.repeat(32)
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

/* --------------------------------------------------------- fake adapter -- */
function makeVault(seed = {}, cfg = {}) {
	const files = new Map(Object.entries(seed.files ?? {}))
	const dirs = new Set(['.'])
	const addDirsFor = p => { const parts = p.split('/'); for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/')) }
	for (const p of files.keys()) addDirsFor(p)
	for (const d of seed.dirs ?? []) { dirs.add(d); addDirsFor(d) }
	const log = []
	const destroyed = []
	let renameCalls = 0
	// `renameFailAt` accepts a single call number (2A.2 style) or a list, which
	// S5 needs to fail both the publish rename *and* the restore rename.
	const failAt = new Set(
		Array.isArray(cfg.renameFailAt)
			? cfg.renameFailAt
			: cfg.renameFailAt
				? [cfg.renameFailAt]
				: []
	)
	const utf8 = s => new TextEncoder().encode(String(s))
	const adapter = {
		async exists(p) { return files.has(p) || dirs.has(p) },
		async mkdir(p) { log.push(['mkdir', p]); dirs.add(p) },
		async write(p, data) { log.push(['write', p]); files.set(p, String(data)); addDirsFor(p) },
		async read(p) { if (!files.has(p)) throw new Error(`ENOENT ${p}`); return files.get(p) },
		async readBinary(p) {
			if (cfg.readBinaryThrow) throw new Error('readBinary forced throw')
			if (!files.has(p)) throw new Error(`ENOENT ${p}`)
			return utf8(files.get(p))
		},
		async stat(p) {
			if (files.has(p)) return { size: String(files.get(p)).length, type: 'file' }
			if (dirs.has(p)) return { size: 0, type: 'folder' }
			return null
		},
		async list(p) {
			const res = { files: [], folders: [] }
			for (const k of files.keys()) if (path.posix.dirname(k) === p) res.files.push(k)
			for (const d of dirs) if (d !== '.' && d !== p && path.posix.dirname(d) === p) res.folders.push(d)
			return res
		},
		async rename(from, to) {
			renameCalls++
			if (failAt.has(renameCalls)) throw new Error(`EACCES simulated rename failure #${renameCalls}`)
			log.push(['rename', from, to])
			const moved = [...files.keys()].filter(k => k === from || k.startsWith(`${from}/`))
			const movedDirs = [...dirs].filter(d => d === from || d.startsWith(`${from}/`))
			if (moved.length === 0 && movedDirs.length === 0) throw new Error(`rename: 源不存在 ${from}`)
			for (const k of moved) { const v = files.get(k); files.delete(k); files.set(`${to}${k.slice(from.length)}`, v) }
			for (const d of movedDirs) { dirs.delete(d); dirs.add(`${to}${d.slice(from.length)}`) }
		},
		async rmdir(p, recursive) {
			log.push(['rmdir', p, recursive])
			for (const k of [...files.keys()]) if (k === p || k.startsWith(`${p}/`)) { destroyed.push({ path: k, content: files.get(k), via: 'rmdir' }); files.delete(k) }
			for (const d of [...dirs]) if (d === p || d.startsWith(`${p}/`)) dirs.delete(d)
		},
		async remove(p) {
			if (!files.has(p)) return
			destroyed.push({ path: p, content: files.get(p), via: 'remove' })
			files.delete(p)
		}
	}
	return { app: { vault: { adapter } }, files, dirs, log, destroyed, get renameCalls() { return renameCalls } }
}

/* ------------------------------------------------------------- fixtures -- */
const BODY_START = '<!--he-body-start-->'
const BODY_END = '<!--he-body-end-->'
const page = (body = '<p>正文内容</p>') =>
	'<!doctype html>\n<html>\n<head><title>t</title></head>\n<body>\n' +
	`${BODY_START}\n${body}\n${BODY_END}\n</body>\n</html>\n`

const sha256hex = s => createHash('sha256').update(String(s), 'utf8').digest('hex')
const NOTE_PATH = 'notes/note.md'
const TITLE = '笔记'

function buildManifest(entries, { notePath = NOTE_PATH, version = 2, filesOverride, identitySuffix: suffixOverride, outputFolder } = {}) {
	const filesArr = Object.entries(entries).map(([rel, content]) => ({
		path: rel,
		bytes: Buffer.byteLength(String(content), 'utf8'),
		sha256: sha256hex(content)
	}))
	return JSON.stringify(signFixture({
		manifestVersion: version,
		generatedAt: 'x',
		notePath,
		noteTitle: TITLE,
		// Round 2A.2.2 (S3.4/S3.5): signed and verified against the note/dir.
		identitySuffix: suffixOverride ?? identitySuffix(notePath),
		outputFolder: outputFolder ?? EXPORT_DIR.split('/').pop(),
		status: 'ok',
		assets: { written: 0, attempted: 0, entries: [], failed: [] },
		files: filesOverride ?? filesArr
	}))
}

function seedV1(dir, entries, opts = {}) {
	const files = {}
	for (const [rel, content] of Object.entries(entries)) files[`${dir}/${rel}`] = content
	files[`${dir}/export-manifest.json`] = buildManifest(entries, opts)
	return files
}

const EXPORT_DIR = resolveExportDir('html-export', TITLE, NOTE_PATH).dir
const OWN_ENTRIES = {
	'index.html': page('<p>第一版</p>'),
	'assets/export.css': 'body{}',
	'runtime-audit.json': '{"generatedAt":"x"}'
}

const snap = (title = TITLE, notePath = NOTE_PATH) => ({
	notePath, noteTitle: title, captureWidth: 900,
	stats: { blocks: 1, images: 0, mermaid: 0, sidenotes: 0, bytesOfContent: 40 },
	resolution: { candidates: [], reason: '唯一可用候选', ambiguity: false },
	previewMetrics: { width: 900 }, warnings: []
})
const EXTRA = { css: { bytes: 10, sheets: [], warnings: [] }, pluginVersion: '0.1.0', audit: { generatedAt: 'x' } }

const own = (app, dir = EXPORT_DIR, notePath = NOTE_PATH, key = TEST_KEY) =>
	inspectOwnership(app, dir, notePath, key)

async function runExport(vault, { title = TITLE, notePath = NOTE_PATH, body = '<p>第二版</p>' } = {}) {
	try {
		return { report: await writeExport(vault.app, snap(title, notePath), page(body), 'body{}', new AssetCollector(vault.app), 'html-export', EXTRA, TEST_KEY), error: null }
	} catch (e) {
		return { report: null, error: e }
	}
}

/* -------------------------------------------------------------- runner -- */
let pass = 0, fail = 0
const results = []
function record(id, name, ok, detail = '') {
	results.push({ id, name, verdict: ok ? 'PASS' : 'FAIL', detail })
	if (ok) pass++; else fail++
	console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${id}  ${name}${detail ? '  — ' + detail : ''}`)
}

/* ============================================================ S1: version */
console.log('\n=== S1 · Manifest 版本降级（删字段不得绕过 v1 校验）===')
{
	const files = seedV1(EXPORT_DIR, OWN_ENTRIES)
	const m = JSON.parse(files[`${EXPORT_DIR}/export-manifest.json`]); delete m.manifestVersion
	files[`${EXPORT_DIR}/export-manifest.json`] = JSON.stringify(signFixture(m))
	const v = makeVault({ files })
	const r = await own(v.app)
	record('S1-01', '删除 manifestVersion、保留完整 files → 拒绝', !r.owned && /manifestVersion/.test(r.reason), `owned=${r.owned} reason=${r.reason}`)
}
{
	// The dangerous variant: manifestVersion gone *and* index.html edited, so the
	// structural proof would pass and the tampered file would be replaced.
	const files = seedV1(EXPORT_DIR, OWN_ENTRIES)
	const m = JSON.parse(files[`${EXPORT_DIR}/export-manifest.json`]); delete m.manifestVersion
	files[`${EXPORT_DIR}/export-manifest.json`] = JSON.stringify(signFixture(m))
	files[`${EXPORT_DIR}/index.html`] = page('<p>被别人改过</p>')
	const v = makeVault({ files })
	const r = await own(v.app)
	record('S1-02', '删除 manifestVersion + 修改 index.html → 拒绝', !r.owned, `owned=${r.owned}`)
}
{
	const files = seedV1(EXPORT_DIR, OWN_ENTRIES)
	const m = JSON.parse(files[`${EXPORT_DIR}/export-manifest.json`]); delete m.manifestVersion
	files[`${EXPORT_DIR}/export-manifest.json`] = JSON.stringify(signFixture(m))
	files[`${EXPORT_DIR}/assets/export.css`] = 'body{color:red}/*被改*/'
	const v = makeVault({ files })
	const r = await own(v.app)
	record('S1-03', '删除 manifestVersion + 修改 export.css → 拒绝', !r.owned, `owned=${r.owned}`)
}
{
	const files = seedV1(EXPORT_DIR, OWN_ENTRIES)
	const m = JSON.parse(files[`${EXPORT_DIR}/export-manifest.json`]); delete m.manifestVersion
	m.files = m.files.map(f => ({ ...f, sha256: 'f'.repeat(64) }))
	files[`${EXPORT_DIR}/export-manifest.json`] = JSON.stringify(signFixture(m))
	const v = makeVault({ files })
	const r = await own(v.app)
	record('S1-04', '删除 manifestVersion + 篡改 files 哈希 → 拒绝', !r.owned, `owned=${r.owned}`)
}
{
	// The real legacy shape: no manifestVersion and no files, but notePath is
	// present (round 2 wrote it) and index.html carries the body markers.
	const files = {
		[`${EXPORT_DIR}/index.html`]: page('<p>旧版</p>'),
		[`${EXPORT_DIR}/assets/export.css`]: 'body{}',
		[`${EXPORT_DIR}/runtime-audit.json`]: '{}',
		[`${EXPORT_DIR}/export-manifest.json`]: JSON.stringify({
			notePath: NOTE_PATH,
			status: 'ok',
			assets: { written: 0, entries: [], failed: [] }
		})
	}
	const v = makeVault({ files })
	const r = await own(v.app)
	// 2A.2.1 旧断言（已废弃）：
	//   record('S1-05', '真正的旧版清单（无版本、无 files、有 notePath）→ 兼容并认可',
	//          r.owned && r.basis === 'legacy-structure', ...)
	// 2A.2.2 / S1：旧版与「人为降级」在字段结构上完全一致（键集差为空），
	// 无法区分，因此一律不得返回可供自动覆盖使用的 owned=true。
	record('S1-05', '真正的旧版清单（无版本、无 files、有 notePath）→ 拒绝（S1：旧版一律拒绝自动覆盖）', !r.owned && /旧版/.test(r.reason), `owned=${r.owned} basis=${r.basis} reason=${r.reason}`)
}
{
	// And the兼容 policy must still be fail-closed when the structural proof is
	// missing: legacy + no body markers → refused.
	const files = {
		[`${EXPORT_DIR}/index.html`]: '<!doctype html><p>别人的网页</p>',
		[`${EXPORT_DIR}/assets/export.css`]: 'body{}',
		[`${EXPORT_DIR}/runtime-audit.json`]: '{}',
		[`${EXPORT_DIR}/export-manifest.json`]: JSON.stringify({ notePath: NOTE_PATH, assets: { entries: [] } })
	}
	const v = makeVault({ files })
	const r = await own(v.app)
	record('S1-06', '旧版清单但 index.html 无正文标记 → 拒绝', !r.owned, `owned=${r.owned} reason=${r.reason}`)
}

/* ============================================================ S2: notePath */
console.log('\n=== S2 · notePath 参与所有权验证 ===')
{
	const files = seedV1(EXPORT_DIR, OWN_ENTRIES)
	const m = JSON.parse(files[`${EXPORT_DIR}/export-manifest.json`]); delete m.notePath
	files[`${EXPORT_DIR}/export-manifest.json`] = JSON.stringify(signFixture(m))
	const v = makeVault({ files })
	const r = await own(v.app)
	record('S2-01', 'v1 删除 notePath → 拒绝', !r.owned && /notePath/.test(r.reason), `owned=${r.owned} reason=${r.reason}`)
}
{
	const files = seedV1(EXPORT_DIR, OWN_ENTRIES)
	const m = JSON.parse(files[`${EXPORT_DIR}/export-manifest.json`]); m.notePath = ''
	files[`${EXPORT_DIR}/export-manifest.json`] = JSON.stringify(signFixture(m))
	const v = makeVault({ files })
	const r = await own(v.app)
	record('S2-02', 'notePath 为空字符串 → 拒绝', !r.owned && /notePath/.test(r.reason), `owned=${r.owned}`)
}
{
	const files = seedV1(EXPORT_DIR, OWN_ENTRIES)
	const m = JSON.parse(files[`${EXPORT_DIR}/export-manifest.json`]); m.notePath = 123
	files[`${EXPORT_DIR}/export-manifest.json`] = JSON.stringify(signFixture(m))
	const v = makeVault({ files })
	const r = await own(v.app)
	record('S2-03', 'notePath 类型错误（number）→ 拒绝', !r.owned && /notePath/.test(r.reason), `owned=${r.owned}`)
}
{
	const files = seedV1(EXPORT_DIR, OWN_ENTRIES, { notePath: 'notes/other.md' })
	const v = makeVault({ files })
	const r = await own(v.app)
	record('S2-04', 'notePath 指向另一篇笔记 → 拒绝', !r.owned && /另一篇笔记/.test(r.reason), `owned=${r.owned} reason=${r.reason}`)
}
{
	const files = seedV1(EXPORT_DIR, OWN_ENTRIES)
	const m = JSON.parse(files[`${EXPORT_DIR}/export-manifest.json`]); m.notePath = '../escape.md'
	files[`${EXPORT_DIR}/export-manifest.json`] = JSON.stringify(signFixture(m))
	const v = makeVault({ files })
	const r = await own(v.app)
	record('S2-05', 'notePath 不是合法 Vault 相对路径（..）→ 拒绝', !r.owned && /notePath/.test(r.reason), `owned=${r.owned}`)
}
{
	// Legacy without notePath: the old cross-note hole, still open before S2.
	const files = {
		[`${EXPORT_DIR}/index.html`]: page('<p>旧版</p>'),
		[`${EXPORT_DIR}/assets/export.css`]: 'body{}',
		[`${EXPORT_DIR}/runtime-audit.json`]: '{}',
		[`${EXPORT_DIR}/export-manifest.json`]: JSON.stringify({ assets: { written: 0, entries: [], failed: [] } })
	}
	const v = makeVault({ files })
	const r = await own(v.app)
	// 2A.2.1 断言的是「结构证明不能代替归属」，靠 notePath 缺失拒绝；
	// 2A.2.2 起拒绝发生在更早的版本门禁（无 manifestVersion 即旧版），
	// 因此理由里出现的是「旧版」而不是「notePath」——拒绝的结论不变。
	record('S2-06', 'Legacy 缺少 notePath → 拒绝（S1 起由版本门禁直接拒绝）', !r.owned && /旧版|notePath/.test(r.reason), `owned=${r.owned} reason=${r.reason}`)
}
{
	const files = {
		[`${EXPORT_DIR}/index.html`]: page('<p>旧版</p>'),
		[`${EXPORT_DIR}/assets/export.css`]: 'body{}',
		[`${EXPORT_DIR}/runtime-audit.json`]: '{}',
		[`${EXPORT_DIR}/export-manifest.json`]: JSON.stringify({ notePath: NOTE_PATH, assets: { written: 0, entries: [], failed: [] } })
	}
	const v = makeVault({ files })
	const r = await own(v.app)
	// 2A.2.1 旧断言（已废弃）：
	//   record('S2-07', 'Legacy notePath 与当前笔记一致 → 认可',
	//          r.owned && r.basis === 'legacy-structure', ...)
	// 2A.2.2 / S1：notePath 一致也不构成可信完整性证明——清单本身可被改写，
	// 只有本 Vault 的 HMAC 能证明归属。旧版一律拒绝。
	record('S2-07', 'Legacy notePath 与当前笔记一致 → 仍拒绝（S1：无签名即无归属证明）', !r.owned && /旧版/.test(r.reason), `owned=${r.owned} basis=${r.basis} reason=${r.reason}`)
}
{
	// Two notes, same title, one directory. `resolveExportDir` normally keeps
	// them apart via the identity suffix, so the collision is built explicitly:
	// the directory note B is about to write into already holds note A's export
	// (what a moved/copied folder, or an export from a pre-suffix build, looks
	// like). The refusal must come from the note identity, not from luck.
	const title = '同名'
	const dirB = resolveExportDir('html-export', title, 'notes/同名-B.md').dir
	const files = seedV1(dirB, OWN_ENTRIES, { notePath: 'notes/同名-A.md' })
	const v = makeVault({ files })
	const before = new Map(v.files)
	const { error } = await runExport(v, { title, notePath: 'notes/同名-B.md' })
	const untouched = [...before].every(([k, val]) => v.files.get(k) === val)
	record('S2-08', '两篇同名笔记共用同一输出目录 → 拒绝且原目录不动',
		!!error && /另一篇笔记|不一致/.test(error.message) && untouched,
		error ? `stage=${error.stage} ${error.message.split('\n')[1] ?? ''}` : '未拒绝')
}
{
	// Complementary: with no collision, the identity suffix alone already keeps
	// two same-title notes in two directories (round 2A.1 F-03 still holds).
	const a = resolveExportDir('html-export', '同名', 'notes/同名-A.md').dir
	const b = resolveExportDir('html-export', '同名', 'notes/同名-B.md').dir
	record('S2-10', '同名不同笔记默认落在不同目录（identity suffix 仍生效）', a !== b, `${a} ≠ ${b}`)
}
{
	// Same-note re-export must still work — the guard is not a blanket refusal.
	const v = makeVault({ files: seedV1(EXPORT_DIR, OWN_ENTRIES) })
	const { error, report } = await runExport(v)
	record('S2-09', '同一篇笔记重复导出 → 仍然允许（防止把保护做成全拒）', !error && !!report, error ? error.message : `dir=${report.dir}`)
}

/* =============================================================== S3: paths */
console.log('\n=== S3 · Manifest 路径校验（先验证原始值，不清洗）===')
const ILLEGAL = [
	['S3-01', '/index.html', '绝对路径'],
	['S3-02', '//server/share', 'UNC 路径'],
	['S3-03', 'C:/Windows/file', '盘符路径（正斜杠）'],
	['S3-04', 'C:\\Windows\\file', '盘符路径（反斜杠）'],
	['S3-05', '../escape', '上跳路径'],
	['S3-06', 'assets/../escape', '中段上跳'],
	['S3-07', 'assets//media/x.png', '空段'],
	['S3-08', 'assets/', '尾斜杠'],
	['S3-09', '', '空路径'],
	['S3-10', 'export-manifest.json', '指向清单自身'],
	['S3-11', 'bad\u0001name.html', '控制字符']
]
for (const [id, badPath, label] of ILLEGAL) {
	const files = {}
	for (const [rel, c] of Object.entries(OWN_ENTRIES)) files[`${EXPORT_DIR}/${rel}`] = c
	const m = JSON.parse(buildManifest(OWN_ENTRIES))
	m.files = [{ path: badPath, bytes: 1, sha256: sha256hex('x') }]
	files[`${EXPORT_DIR}/export-manifest.json`] = JSON.stringify(signFixture(m))
	const v = makeVault({ files })
	const r = await own(v.app)
	record(id, `${label} → 拒绝（${JSON.stringify(badPath)}）`, !r.owned && /非法路径|files/.test(r.reason), `owned=${r.owned}`)
}
{
	// Positive control: a legal nested path is still accepted, so the tests
	// above fail because of the path, not because every manifest is refused.
	const entries = { ...OWN_ENTRIES, 'assets/media/pic.png': 'binary:3' }
	const v = makeVault({ files: seedV1(EXPORT_DIR, entries) })
	const r = await own(v.app)
	record('S3-12', '合法嵌套路径 assets/media/pic.png → 仍然认可（反向对照）', r.owned, `owned=${r.owned} reason=${r.reason}`)
}
{
	// `/index.html` is the exact laundering case: cleaned, it equals the real
	// file and would verify green. Assert the raw form is what gets rejected.
	const files = {}
	for (const [rel, c] of Object.entries(OWN_ENTRIES)) files[`${EXPORT_DIR}/${rel}`] = c
	const m = JSON.parse(buildManifest(OWN_ENTRIES))
	m.files = m.files.map(f => ({ ...f, path: f.path === 'index.html' ? '/index.html' : f.path }))
	files[`${EXPORT_DIR}/export-manifest.json`] = JSON.stringify(signFixture(m))
	const v = makeVault({ files })
	const r = await own(v.app)
	record('S3-13', '仅把 index.html 写成 /index.html → 拒绝（未被清洗成合法值）', !r.owned, `owned=${r.owned} reason=${r.reason}`)
}

/* ================================================================ S4: backup */
console.log('\n=== S4 · safeRemoveBackup 已移除，且无替代清理入口 ===')
{
	record('S4-01', '模块导出面不含 safeRemoveBackup', !('safeRemoveBackup' in writerModule),
		`exports=${Object.keys(writerModule).sort().join(',')}`)
	record('S4-02', '模块导出面不含任何删除/清理型入口',
		!Object.keys(writerModule).some(k => /remove|clean|purge|delete|prune/i.test(k)),
		`exports=${Object.keys(writerModule).join(',')}`)
}
{
	const v = makeVault({ files: seedV1(EXPORT_DIR, OWN_ENTRIES) })
	const { report, error } = await runExport(v)
	const rmdir = v.log.filter(l => l[0] === 'rmdir').length
	const remove = v.log.filter(l => l[0] === 'remove').length
	const kept = !!report && (await v.app.vault.adapter.exists(`${report.leftoverBackup}/index.html`))
	record('S4-03', '成功发布：备份原样保留，0 次 rmdir / 0 次 remove', !error && rmdir === 0 && remove === 0 && kept,
		`rmdir=${rmdir} remove=${remove} kept=${kept}`)
}
{
	// Two consecutive exports: the first backup must survive the second run.
	// (An "accumulation cleanup" would delete the oldest one here.)
	const v = makeVault({ files: seedV1(EXPORT_DIR, OWN_ENTRIES) })
	const first = await runExport(v, { body: '<p>第二版</p>' })
	const second = await runExport(v, { body: '<p>第三版</p>' })
	const firstBackup = first.report && first.report.leftoverBackup
	const secondBackup = second.report && second.report.leftoverBackup
	const bothKept =
		!!firstBackup &&
		!!secondBackup &&
		(await v.app.vault.adapter.exists(`${firstBackup}/index.html`)) &&
		(await v.app.vault.adapter.exists(`${secondBackup}/index.html`))
	record('S4-04', '连续两次导出：两个备份都保留，不做累积清理', bothKept,
		`first=${firstBackup ? 'kept' : 'gone'} second=${secondBackup ? 'kept' : 'gone'}`)
}

/* ============================================================== S5: restore */
console.log('\n=== S5 · 发布失败恢复的两条路径 ===')
{
	// 2nd rename (tmp → final) fails, 3rd (backup → final) succeeds.
	const oldFiles = { ...seedV1(EXPORT_DIR, OWN_ENTRIES) }
	const v = makeVault({ files: oldFiles }, { renameFailAt: 2 })
	const { error } = await runExport(v)
	const restoredIndex = v.files.get(`${EXPORT_DIR}/index.html`)
	const byteIdentical =
		restoredIndex === oldFiles[`${EXPORT_DIR}/index.html`] &&
		v.files.get(`${EXPORT_DIR}/assets/export.css`) === oldFiles[`${EXPORT_DIR}/assets/export.css`] &&
		v.files.get(`${EXPORT_DIR}/runtime-audit.json`) === oldFiles[`${EXPORT_DIR}/runtime-audit.json`]
	record('S5-01', '发布 rename 失败、恢复 rename 成功 → 旧目录逐字节复原', !!error && byteIdentical, `err=${error ? error.stage : 'none'} identical=${byteIdentical}`)
	record('S5-02', '恢复成功时消息明确说明「已恢复」而不是「无法恢复」',
		!!error && /已恢复/.test(error.message) && !/无法恢复/.test(error.message),
		error ? error.message.replace(/\n/g, ' ⏎ ') : 'none')
	record('S5-03', '恢复成功后 backup 目录已不存在（内容已改名回去）',
		!!error && ![...v.files.keys()].some(k => k.includes('.bak-')),
		`bak=${[...v.files.keys()].filter(k => k.includes('.bak-')).length}`)
	record('S5-04', '失败消息里给出 finalDir 与临时目录，用户知道去哪找',
		!!error && error.message.includes(EXPORT_DIR) && /临时目录/.test(error.message),
		error ? `tmpDir=${error.tmpDir}` : 'none')
}
{
	// 2nd AND 3rd renames fail: the old export stays in the backup directory and
	// the message must name that exact path.
	const oldFiles = { ...seedV1(EXPORT_DIR, OWN_ENTRIES) }
	const v = makeVault({ files: oldFiles }, { renameFailAt: [2, 3] })
	const { error } = await runExport(v)
	const backups = [...v.files.keys()].filter(k => k.endsWith('/index.html') && k.includes('.bak-'))
	const backupDir = backups.length === 1 ? backups[0].slice(0, -'/index.html'.length) : null
	const oldIntact = !!backupDir && v.files.get(`${backupDir}/index.html`) === oldFiles[`${EXPORT_DIR}/index.html`]
	record('S5-05', '恢复 rename 也失败 → 旧导出留在 backup，内容未损', !!error && oldIntact, `backup=${backupDir}`)
	record('S5-06', '恢复失败时消息点名 backup 位置且说明如何恢复',
		!!error && !!backupDir && error.message.includes(backupDir) && /无法恢复|恢复旧导出也失败/.test(error.message),
		error ? error.message.split('\n')[0] : 'none')
}
{
	// The Notice text is `HTML 导出失败（<stage> 阶段）\n<message>` — assert
	// main.ts still interpolates the message, so what these tests check is what
	// the user actually reads (not just what the exception carries).
	//
	// Round 3.2.3 (F-02): the *shape* of that interpolation had to change. The
	// old template read `error.stage` and `error.message` directly, which is the
	// unsafe access pattern this round removes (`instanceof`-then-`.message` can
	// throw, and a raw object in a template can carry a key). The message now
	// comes from `describeErrorSafely()`, i.e. the same text after redaction and
	// without touching the object with an unguarded getter. The assertion keeps
	// its original intent — the user still sees the error's own message — and
	// adds the requirement that it arrives through the safe conversion.
	const mainSrc = fs.readFileSync(path.join(root, 'src/main.ts'), 'utf8')
	const noticeUsesMessage =
		/HTML 导出失败（\$\{stageText\} 阶段）[\s\S]{0,40}\$\{message\}/.test(mainSrc) &&
		/const message = describeErrorSafely\(error, \[key\]\)/.test(mainSrc)
	record('S5-07', 'Notice 直接呈现 ExportError.message（消息即用户所见）', noticeUsesMessage,
		noticeUsesMessage ? 'main.ts 已接线（经 describeErrorSafely 脱敏）' : 'main.ts 未把 message 放进 Notice')
}

/* ------------------------------------------------------------- summary -- */
console.log(`\n小计：PASS ${pass} / FAIL ${fail} / 共 ${results.length}`)
fs.mkdirSync(out, { recursive: true })
fs.writeFileSync(path.join(out, 'round2a2-1-results.json'), JSON.stringify({ pass, fail, total: results.length, results }, null, 2))
process.exit(fail > 0 ? 1 : 0)
