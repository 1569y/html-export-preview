/**
 * P2 Task 1 — same-article jumps in the *real* ReAct note.
 *
 * Regression case (sidenote #54, `docs/demo-note.md:365`):
 *
 *   <span class="sidenote">前面abstract中有解释 [[示例笔记#ABSTRACT]] </span>
 *
 * Real Obsidian DOM / metadata evidence (tests/e2e/tmp/p2-diag-linkpath.json):
 *   - `data-href = "示例笔记#ABSTRACT"`, text `示例笔记 > ABSTRACT`
 *   - `getFirstLinkpathDest('示例笔记', …)` → null (unresolved)
 *   - `unresolvedLinks['docs/demo-note.md']` → `{ '示例笔记': 1 }`
 *   - `getFirstLinkpathDest('demo-note', …)` → `docs/demo-note.md`
 *   - `getFileCache(file).headings` contains `ABSTRACT`
 *   - Side Notes duplicates the link into `small.sidenote-margin`
 *
 * Before this fix the link became `obsidian://open?file=REACT%E7%AC%94…%23…`,
 * then share sanitisation turned it into dead plain text (`anchorLinks=0`).
 *
 * These tests pin the identity verdict, the clone-time rewrite, and that the
 * preview iframe / single-file share / directory export all end up with the
 * same native `href="#ABSTRACT"` jump and no vault path.
 *
 * Run with: node tests/unit/run-p2-same-note.mjs
 */
import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseHtml } from './dom-double.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')

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
	if (JSON.stringify(a) !== JSON.stringify(b)) {
		throw new Error(`${label}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)
	}
}
const match = (v, re, label) => {
	if (!re.test(String(v))) throw new Error(`${label}: ${re} 未匹配`)
}

async function bundle(entry, name) {
	const outfile = path.join(here, '.tmp', `${name}.mjs`)
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

const identityMod = await bundle('src/capture/link-identity.ts', 'p2-identity')
const cloneMod = await bundle('src/capture/dom-clone.ts', 'p2-clone')
const anchorsMod = await bundle('src/export/anchors.ts', 'p2-anchors')
const sanitizeMod = await bundle('src/export/share-sanitize.ts', 'p2-sanitize')
const exporter = await bundle('src/export/exporter.ts', 'p2-exporter')

/* ------------------------------------------------------- real vault fixture */

const CURRENT = {
	path: 'docs/demo-note.md',
	name: 'demo-note.md',
	basename: 'demo-note',
	extension: 'md'
}
/**
 * The same note as it exists in the user's real vault: the file is literally
 * called `示例笔记.md`, so `[[示例笔记#ABSTRACT]]` is *resolved* by Obsidian
 * instead of dangling. This is the shape case 4 must keep working in; the
 * renamed sandbox copy above is only a test artefact.
 */
const VAULT_FILE = {
	path: 'learn/agent/ra/示例笔记.md',
	name: '示例笔记.md',
	basename: '示例笔记',
	extension: 'md'
}
const OTHER = {
	path: 'docs/doc-02-long.md',
	name: 'doc-02-long.md',
	basename: 'doc-02-long',
	extension: 'md'
}

/** Mirrors the metadataCache verdicts measured in the sandbox. */
function makeApp({ aliases, extraLinks = [] } = {}) {
	const headings = [
		{ heading: 'REACT : SYNERGIZING REASONING AND ACTING IN LANGUAGE MODELS', level: 1 },
		{ heading: 'ABSTRACT', level: 2 },
		{ heading: '1. INTRODUCTION', level: 2 },
		{ heading: '第一段：研究启发', level: 3 }
	]
	const links = [
		{
			link: '示例笔记#ABSTRACT',
			original: '[[示例笔记#ABSTRACT]]',
			displayText: '示例笔记 > ABSTRACT'
		},
		...extraLinks
	]
	return {
		metadataCache: {
			getFileCache: () => ({
				headings,
				links,
				frontmatter: aliases ? { aliases } : undefined
			}),
			getFirstLinkpathDest: linkpath => {
				if (linkpath === '示例笔记' || linkpath === '示例笔记.md') return null
				if (
					linkpath === 'doc-02-long' ||
					linkpath === 'doc-02-long.md' ||
					linkpath === 'docs/doc-02-long.md'
				) return OTHER
				if (
					linkpath === 'demo-note' ||
					linkpath === 'demo-note.md' ||
					linkpath === 'docs/demo-note.md' ||
					linkpath === 'docs/demo-note'
				) return CURRENT
				return null
			},
			unresolvedLinks: {
				'docs/demo-note.md': { 示例笔记: 1 }
			}
		}
	}
}

/**
 * The real vault: `示例笔记` resolves back to the file being exported, and
 * nothing about it is unresolved.
 */
function makeVaultApp({ aliases } = {}) {
	return {
		metadataCache: {
			getFileCache: () => ({
				headings: [
					{ heading: 'REACT : SYNERGIZING REASONING AND ACTING IN LANGUAGE MODELS', level: 1 },
					{ heading: 'ABSTRACT', level: 2 },
					{ heading: '1. INTRODUCTION', level: 2 },
					{ heading: '第一段：研究启发', level: 3 }
				],
				links: [{ link: '示例笔记#ABSTRACT', original: '[[示例笔记#ABSTRACT]]' }],
				frontmatter: aliases ? { aliases } : undefined
			}),
			getFirstLinkpathDest: linkpath => {
				if (linkpath === '示例笔记' || linkpath === '示例笔记.md') return VAULT_FILE
				if (linkpath === 'doc-02-long') return OTHER
				return null
			},
			unresolvedLinks: {}
		}
	}
}

/** Sandbox copy (renamed file): the linkpath genuinely has no destination. */
const realIdentity = identityMod.readSameNoteIdentity(makeApp(), CURRENT)
/** Real vault shape: the linkpath resolves to this exact TFile. */
const vaultIdentity = identityMod.readSameNoteIdentity(makeVaultApp(), VAULT_FILE)

/* ------------------------------------------- 1. Obsidian-parsed source identity */

await check('源笔记身份来自 TFile.path 与 metadataCache，不是笔记名比较', () => {
	equal(realIdentity.path, 'docs/demo-note.md', '源文件路径')
	match(realIdentity.selfLinkpaths.join('|'), /demo-note/, 'Obsidian 解析回当前 TFile')
	assert(
		realIdentity.unresolvedLinkpaths.includes('示例笔记'),
		'示例笔记 应被 Obsidian 记录为来自本篇的 unresolved link'
	)
	assert(realIdentity.headings.includes('ABSTRACT'), '当前文件的解析标题含 ABSTRACT')
	assert(
		!realIdentity.foreignLinkpaths.includes('示例笔记'),
		'unresolved link 不能被算作跨篇'
	)
})

await check('跨篇链接被 Obsidian 判定为另一个文件并显式拒绝', () => {
	const id = identityMod.readSameNoteIdentity(
		makeApp({ extraLinks: [{ link: 'doc-02-long#ABSTRACT' }] }),
		CURRENT
	)
	assert(id.foreignLinkpaths.includes('doc-02-long'), 'doc-02-long 应解析到别的文件')
	equal(
		identityMod.sameNoteFragment('doc-02-long#ABSTRACT', id),
		null,
		'跨篇链接不得变成本篇跳转'
	)
})

await check('真实 Vault 形态：[[示例笔记#ABSTRACT]] 解析回当前 TFile，仍是页内跳转', () => {
	assert(
		vaultIdentity.selfLinkpaths.includes('示例笔记'),
		'示例笔记 应被 Obsidian 解析回当前 TFile.path'
	)
	assert(
		!vaultIdentity.unresolvedLinkpaths.includes('示例笔记'),
		'真实 Vault 中这条链接不是 unresolved'
	)
	equal(
		identityMod.sameNoteFragment('示例笔记#ABSTRACT', vaultIdentity),
		'ABSTRACT',
		'真实侧注链接不得回归'
	)
	equal(
		identityMod.sameNoteFragment('示例笔记#^block-xyz', vaultIdentity),
		'^block-xyz',
		'解析回本篇后，块引用同样属于本篇'
	)
})

await check('改名副本：unresolved 且标题存在，不再被推断为本篇', () => {
	// The sandbox file is `docs/demo-note.md`, so `示例笔记` has no
	// destination. "A heading called ABSTRACT exists here" is not evidence that
	// the link meant *this* note — see the counter-example below.
	equal(
		identityMod.sameNoteFragment('示例笔记#ABSTRACT', realIdentity),
		null,
		'unresolved 链接不得仅凭标题存在转成本篇锚点'
	)
	equal(
		identityMod.sameNoteFragment('示例笔记#不存在的章节', realIdentity),
		null,
		'标题不存在时当然不得转成本篇'
	)
})

await check('反例：[[一个不存在的其他笔记#ABSTRACT]] 不得转成本篇锚点', () => {
	// The most important counter-example. The current note has an ABSTRACT
	// heading and the linkpath is unresolved, which is *byte-for-byte* the same
	// evidence as the renamed-copy case above. It must stay inert.
	const id = identityMod.readSameNoteIdentity(
		{
			metadataCache: {
				getFileCache: () => ({
					headings: [{ heading: 'ABSTRACT', level: 2 }],
					links: [{ link: '一个不存在的其他笔记#ABSTRACT' }]
				}),
				getFirstLinkpathDest: () => null,
				unresolvedLinks: {
					'docs/demo-note.md': { 一个不存在的其他笔记: 1 }
				}
			}
		},
		CURRENT
	)
	assert(
		id.unresolvedLinkpaths.includes('一个不存在的其他笔记'),
		'夹具前提：Obsidian 记录为 unresolved'
	)
	equal(
		identityMod.sameNoteFragment('一个不存在的其他笔记#ABSTRACT', id),
		null,
		'不存在的其他笔记不得被改写成本篇章节跳转'
	)
})

await check('反例：另一篇存在的笔记也有 ABSTRACT，仍不得转成本篇', () => {
	const id = identityMod.readSameNoteIdentity(
		{
			metadataCache: {
				getFileCache: () => ({
					headings: [{ heading: 'ABSTRACT', level: 2 }],
					links: [{ link: '另一篇笔记#ABSTRACT' }]
				}),
				getFirstLinkpathDest: linkpath =>
					linkpath === '另一篇笔记' ? OTHER : null,
				unresolvedLinks: {}
			}
		},
		CURRENT
	)
	assert(id.foreignLinkpaths.includes('另一篇笔记'), '应判定为跨篇')
	equal(
		identityMod.sameNoteFragment('另一篇笔记#ABSTRACT', id),
		null,
		'跨篇链接即使标题同名也不得转成本篇跳转'
	)
})

await check('[[#标题]] / [[当前笔记#标题]] / 别名 / 外部链接分流正确', () => {
	equal(identityMod.sameNoteFragment('#ABSTRACT', vaultIdentity), 'ABSTRACT', '[[#ABSTRACT]]')
	equal(
		identityMod.sameNoteFragment('[[示例笔记#ABSTRACT|别名]]', vaultIdentity),
		null,
		'非链接目标字符串不应误判'
	)
	equal(
		identityMod.sameNoteFragment('示例笔记#ABSTRACT', vaultIdentity),
		'ABSTRACT',
		'Obsidian 解析回当前 TFile 的 linkpath'
	)
	equal(
		identityMod.sameNoteFragment('https://example.com/p#ABSTRACT', vaultIdentity),
		null,
		'外部链接不被误判'
	)
	equal(
		identityMod.sameNoteFragment('示例笔记#ABSTRACT', null),
		null,
		'没有宿主身份时不得靠笔记名称字符串猜测'
	)
	// The documented way to make a differently-named reference work: declare it
	// as an alias. Obsidian then resolves it, and rule (2)/(3) accepts it.
	const aliased = identityMod.readSameNoteIdentity(
		makeApp({ aliases: ['示例笔记'] }),
		CURRENT
	)
	equal(
		identityMod.sameNoteFragment('示例笔记#ABSTRACT', aliased),
		'ABSTRACT',
		'frontmatter 别名也来自 Obsidian 解析'
	)
})

/* -------------------------------------------------- 2. clone-time link rewrite */

const NOTE_HTML = `
<div class="markdown-preview-sizer">
  <h1>REACT : SYNERGIZING REASONING AND ACTING IN LANGUAGE MODELS</h1>
  <h2>ABSTRACT</h2>
  <p>We begin with knowledge-intensive reasoning tasks<span class="sidenote-number">
    <span class="sidenote">前面abstract中有解释
      <a class="internal-link" data-href="示例笔记#ABSTRACT" href="示例笔记#ABSTRACT" target="_blank" rel="noopener">示例笔记 &gt; ABSTRACT</a>
    </span>
    <small class="sidenote-margin"><a class="internal-link" data-href="示例笔记#ABSTRACT" href="示例笔记#ABSTRACT" target="_blank" rel="noopener">示例笔记 &gt; ABSTRACT</a></small>
  </span></p>
  <p><a class="internal-link" data-href="#ABSTRACT" href="#ABSTRACT" target="_blank" rel="noopener">同篇章裸锚点</a></p>
  <p><a class="internal-link" data-href="doc-02-long#ABSTRACT" href="doc-02-long#ABSTRACT" target="_blank">跨篇链接</a></p>
  <p><a class="external-link" href="https://example.com/#ABSTRACT">外部链接</a></p>
</div>`

function capturedClone() {
	const source = parseHtml(NOTE_HTML).children[0]
	return cloneMod.cloneContent(source, vaultIdentity)
}

/** The renamed sandbox copy: same DOM, but the linkpath has no destination. */
function capturedCloneRenamed() {
	const source = parseHtml(NOTE_HTML).children[0]
	return cloneMod.cloneContent(source, realIdentity)
}

await check('捕获阶段：两份 Side Notes 链接都改成 #ABSTRACT，不再出现 obsidian://', () => {
	const { content, warnings } = capturedClone()
	const links = content.querySelectorAll('a.internal-link')
	const side = links.filter(a => (a.textContent ?? '').includes('示例笔记'))
	equal(side.length, 2, 'Side Notes 复制出的两份链接')
	for (const a of side) {
		equal(a.getAttribute('href'), '#ABSTRACT', 'href 改为页内锚点')
		equal(a.getAttribute('data-href'), '#ABSTRACT', 'data-href 同步')
		equal(a.getAttribute('target'), null, '去掉 target=_blank')
		equal(a.getAttribute('rel'), null, '去掉 rel')
	}
	assert(
		!content.outerHTML.includes('REACT%E7%AC%94'),
		'同篇链接不应被写成 obsidian://open?file=REACT%E7%AC%94…'
	)
	// 跨篇链接在本模式仍按既有规则改写为 obsidian://，那是 Vault 内部可用的
	// 形式；分享模式会另行净化。这里只禁止「本篇链接」被当成跨篇处理。
	assert(
		!content.outerHTML.includes('obsidian://open?file=REACT'),
		'本篇链接不得走跨篇 obsidian:// 分支'
	)
	assert(
		warnings.some(w => w.includes('页内跳转')),
		'捕获警告应报告同篇链接数量'
	)
})

await check('捕获阶段：跨篇链接仍按原保护规则处理，外部链接不变', () => {
	const { content } = capturedClone()
	const links = content.querySelectorAll('a.internal-link')
	const cross = links.find(a => (a.textContent ?? '').includes('跨篇'))
	equal(cross.getAttribute('data-href'), 'doc-02-long#ABSTRACT', '保留原 data-href')
	match(cross.getAttribute('href'), /^obsidian:\/\/open\?file=/, '跨篇仍转 obsidian://')
	const external = content.querySelector('a.external-link')
	equal(external.getAttribute('href'), 'https://example.com/#ABSTRACT', '外部链接不变')
})

await check('改名副本：侧注链接不生成伪造的本篇锚点', () => {
	const { content } = capturedCloneRenamed()
	const side = content
		.querySelectorAll('a.internal-link')
		.filter(a => (a.textContent ?? '').includes('示例笔记'))
	equal(side.length, 2, '两份侧注链接仍被保留')
	for (const a of side) {
		assert(
			a.getAttribute('href') !== '#ABSTRACT',
			'unresolved 链接不得被改成本篇锚点'
		)
		assert(
			(a.getAttribute('data-href') ?? '') !== '#ABSTRACT',
			'data-href 也不得被改写成本篇锚点'
		)
	}
	// It is still allowed to become a vault-internal obsidian:// open (that is
	// the pre-existing cross-note rule); what must never happen is a jump inside
	// *this* document to a heading the link never pointed at. Only the bare
	// `[[#ABSTRACT]]` link may resolve to `#ABSTRACT`.
	const jumps = content
		.querySelectorAll('a.internal-link')
		.filter(a => a.getAttribute('href') === '#ABSTRACT')
	equal(jumps.length, 1, '只有裸锚点 [[#ABSTRACT]] 指向本篇标题')
	equal(
		jumps[0].textContent ?? '',
		'同篇章裸锚点',
		'指向本篇的必须是裸锚点本身'
	)
})

/* ------------------------------------- 3. preview / single / package 一致性 */
function makeSnapshot(sizer) {
	return {
		sizer,
		captureWidth: 700,
		noteTitle: '示例笔记',
		notePath: 'learn/agent/ra/示例笔记.md',
		capturedAt: '2026-11-06T00:00:00.000Z',
		root: {
			className: 'theme-dark',
			style: '',
			data: {},
			bodyClassName: 'theme-dark',
			bodyStyle: '',
			bodyData: {}
		},
		reading: { className: 'markdown-reading-view', style: '', data: {} },
		preview: { className: 'markdown-preview-view', style: '', data: {} },
		sidenotes: { margin: 1, inline: 0, room: 0 },
		stats: { math: 0, images: 0, mermaid: 0, sidenotes: 1, blocks: 5 }
	}
}

function built(mode) {
	const { content } = capturedClone()
	return exporter.buildHtml(makeSnapshot(content), {
		mode,
		cssText: '',
		prepare: mode === 'single' ? s => sanitizeMod.sanitizeForShare(s) : undefined
	})
}

for (const mode of ['preview', 'single', 'export']) {
	await check(`${mode}：真实侧注链接落地为 href="#ABSTRACT"，可离线跳转`, () => {
		const html = built(mode)
		match(html, /href="#ABSTRACT"/, '存在原生同篇跳转')
		// 分享模式额外要求零 Vault 内链接；preview / 目录导出仍允许跨篇链接
		// 保留原有的 obsidian:// 打开方式（它们由 Vault 拥有者自己打开）。
		if (mode === 'single') {
			assert(!html.includes('obsidian://'), '分享 HTML 不含 obsidian:// 链接')
		}
		assert(!html.includes('app://'), '最终 HTML 不含 app:// 链接')
		assert(
			!html.includes('REACT%E7%AC%94%E8%AE%B0%23ABSTRACT') &&
				!html.includes('obsidian://open?file=REACT'),
			'不泄露 URL 编码后的笔记名/路径'
		)
		assert(
			!html.includes('data-href="示例笔记#ABSTRACT"'),
			'不残留原始 vault 内链接目标'
		)
		assert(!/href="#ABSTRACT"[^>]*target=/.test(html), '同篇链接不能开新标签页')
	})
}

await check('分享净化后：同篇链接可点，跨篇链接保留文字但不可跳', () => {
	const html = built('single')
	match(html, /href="#ABSTRACT"[^>]*>示例笔记/, '真实侧注文字仍可点')
	assert(
		html.includes('data-he-unresolved="1"'),
		'跨篇链接仍被置为不可跳并给出诊断'
	)
	match(html, /示例笔记[^<]*ABSTRACT/, '链接可读文本完整保留')
})

await check('applyInternalAnchors：两份侧注链接与裸锚点都解析到同一标题 id', () => {
	const { content } = capturedClone()
	const result = anchorsMod.applyInternalAnchors(content)
	equal(result.resolved, 3, '2 份侧注 + 1 个裸锚点')
	equal(result.unresolved, 0, '无本篇死链')
	assert(result.ids.includes('ABSTRACT'), '生成了 ABSTRACT 标题 id')
	const side = content
		.querySelectorAll('a.internal-link')
		.filter(a => (a.textContent ?? '').includes('示例笔记'))
	for (const a of side) {
		equal(a.getAttribute('href'), '#ABSTRACT', '解析到 ABSTRACT')
		equal(a.getAttribute('target'), null, '不带 target')
	}
})

console.log(`\n总计：PASS ${passed} / FAIL ${failures.length}`)
if (failures.length) {
	for (const f of failures) console.log(`  - ${f.name}: ${f.message}`)
	process.exit(1)
}
console.log('OK')
