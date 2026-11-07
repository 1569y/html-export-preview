#!/usr/bin/env node
/**
 * Round 3.2.4 §四 — W-01 offline self-test honesty.
 *
 * The Round 3.2.3 `--self-test-cleanup` silently omitted the two checks that
 * depend on the project root when it could not find `package.json` above the
 * script (e.g. running from an extracted ZIP / isolated Review Runner). The
 * remaining four or five checks still passed, so the run printed "全部通过"
 * over a *smaller* test set.
 *
 * This suite runs the fixed runner in two locations and checks:
 *   WS-01  online  — 6 checks, all executed, exit 0
 *   WS-02  offline — still 6 records, the project-root ones are explicitly
 *                    SKIPPED / NOT TESTED with a reason, exit != 0
 *   WS-03  offline — the conclusion must NOT claim full coverage
 *   WS-04  offline — no check was silently dropped (record count = 6)
 *
 * Offline means: the runner is copied into a deep directory whose ancestors
 * contain no `package.json`, so its 12-level upward search necessarily fails.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(here, '../..')
const script = path.join(
	projectRoot,
	'review/phase-1/fix-round-3-2-4/reverse-control/generate-reverse-control.mjs'
)

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hep-r324-w01-'))
process.on('exit', () => {
	try {
		fs.rmSync(TMP_ROOT, { recursive: true, force: true })
	} catch {
		/* best effort */
	}
})

let pass = 0
let fail = 0
const results = []
function record(id, name, ok, detail = '') {
	results.push({ id, name, verdict: ok ? 'PASS' : 'FAIL', detail })
	if (ok) pass++
	else fail++
	process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${id}  ${name}${detail ? '  — ' + detail : ''}\n`)
}

function runCleanup(cwd, scriptPath) {
	const res = spawnSync(process.execPath, [scriptPath, '--self-test-cleanup'], {
		cwd,
		encoding: 'utf8',
		maxBuffer: 16 * 1024 * 1024
	})
	return {
		exit: res.status ?? -1,
		text: `${res.stdout ?? ''}${res.stderr ?? ''}`
	}
}

const CHECK_LINES = /^ {2}(?:OK|BAD|SKIP|NT)\s+\S/gm
function recordCount(text) {
	return (text.match(CHECK_LINES) ?? []).length
}

console.log('Round 3.2.4 — W-01 离线自检口径')

if (!fs.existsSync(script)) {
	record('WS-01', '固定版自检脚本存在', false, `missing=${script}`)
} else {
	/* 1. online: project root is discoverable */
	const online = runCleanup(projectRoot, script)
	const onlineLines = recordCount(online.text)
	const onlinePass = /结果：PASS 6 \/ SKIPPED 0 \/ NOT TESTED 0 \/ FAIL 0/.test(online.text)
	record('WS-01', '在线（项目根可定位）→ 6 项全部执行、exit 0、无跳过项',
		online.exit === 0 && onlineLines === 6 && onlinePass,
		`exit=${online.exit} records=${onlineLines} allPass=${onlinePass}`)

	/* 2..4. offline: a deep directory with no package.json in 12 ancestors */
	let offlineDir = TMP_ROOT
	for (const seg of 'a b c d e f g h i j k l m n'.split(' ')) {
		offlineDir = path.join(offlineDir, seg)
	}
	fs.mkdirSync(offlineDir, { recursive: true })
	const offlineScript = path.join(offlineDir, 'generate-reverse-control.mjs')
	fs.copyFileSync(script, offlineScript)
	// Verify the premise: no package.json anywhere in the first 12 ancestors.
	let probe = offlineDir
	let foundProjectFile = false
	for (let i = 0; i < 12; i++) {
		if (fs.existsSync(path.join(probe, 'package.json'))) foundProjectFile = true
		const parent = path.dirname(probe)
		if (parent === probe) break
		probe = parent
	}
	const offline = runCleanup(offlineDir, offlineScript)
	const lines = recordCount(offline.text)
	const skippedCount = (offline.text.match(/SKIPPED|NOT TESTED/g) ?? []).length
	const named = /项目目录（存在但非本次创建）→ 拒绝且仍存在/.test(offline.text) &&
		/目录内符号链接指向项目 → 只删本目录，链接目标不受影响/.test(offline.text)

	record('WS-02', '离线（无项目根）→ 依赖项目根的检查显式 SKIPPED / NOT TESTED，且 exit 非 0',
		!foundProjectFile && offline.exit !== 0 && named && skippedCount >= 2,
		`premiseNoPackageJson=${!foundProjectFile} exit=${offline.exit} namedChecksPresent=${named} skipMentions=${skippedCount}`)

	const noFalseGreen = /未完整验证|不可声称全部通过/.test(offline.text) &&
		!/结论：6 项全部执行并通过/.test(offline.text)
	record('WS-03', '离线结论不宣称「全部通过」，明确标注未完整验证', noFalseGreen,
		`honestConclusion=${noFalseGreen}`)

	const fixedTotal = /检查项总数：6（固定 6 项，跳过项仍计入）/.test(offline.text)
	record('WS-04', '离线仍报告固定 6 项检查，未默默减少测试数量', lines === 6 && fixedTotal,
		`records=${lines} fixedTotalLine=${fixedTotal}`)
}

const total = results.length
console.log('\n' + '─'.repeat(72))
console.log(`总计：${total} 例，PASS ${pass}，FAIL ${fail}，NOT TESTED 0`)
if (fail > 0) {
	console.log('\nFAILED:')
	for (const r of results.filter(r => r.verdict === 'FAIL')) {
		console.log(`  ${r.id}  ${r.name}  —  ${r.detail}`)
	}
	process.exitCode = 1
}
