#!/usr/bin/env node
/**
 * Round 3.2.3 — W-01 behavioural test.
 *
 * The reverse-control script used to delete three fixed directories inside the
 * project (`tests/unit/.out-round3-*`) before every run, because those suites
 * derive their bundle directory from their own file path and would otherwise
 * reuse a stale bundle. That also deleted anything the user happened to have
 * there — a prior round's artifacts, a debugging copy, whatever.
 *
 * This test does not read the source and does not trust a comment. It:
 *
 *   1. puts a sentinel file into each of those three directories (creating the
 *      directory first if it is missing) and hashes everything in them;
 *   2. runs a real reverse-control pass (`--only R1`, so it is quick);
 *   3. re-hashes: every sentinel must be byte-identical and every pre-existing
 *      file must still be there;
 *   4. checks that the project tree gained no new file;
 *   5. checks that the run's own `mkdtemp` directories were cleaned up.
 *
 * Then it removes only what *it* created.
 *
 * Run: node tests/unit/run-round3-2-3-w01-isolation.mjs
 * Exit: 0 all good, 1 a check failed, 2 environment problem.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const DECOYS = ['.out-round3-2-1', '.out-round3-2-2', '.out-round3-review-fix']
const SENTINEL = 'w01-sentinel.txt'
const SENTINEL_TEXT = 'round-3.2.3 W-01 decoy — must survive the reverse control\n'
const SCRIPT = path.join(
	root,
	'review/phase-1/fix-round-3-2-3/reverse-control/generate-reverse-control.mjs'
)

const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const listFiles = dir => {
	const found = []
	const walk = d => {
		for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
			const p = path.join(d, entry.name)
			if (entry.isDirectory()) walk(p)
			else if (entry.isFile()) found.push(path.relative(dir, p))
		}
	}
	if (fs.existsSync(dir)) walk(dir)
	return found.sort()
}

const checks = []
const record = (name, pass, detail) => {
	checks.push({ name, pass, detail })
	console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}  — ${detail}`)
}

if (!fs.existsSync(SCRIPT)) {
	console.error(`找不到反向对照脚本：${SCRIPT}`)
	process.exit(2)
}

/* ---------------------------------------------- 1. plant the decoys -- */
const createdDirs = []
const before = {}
for (const name of DECOYS) {
	const dir = path.join(here, name)
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true })
		createdDirs.push(dir)
	}
	fs.writeFileSync(path.join(dir, SENTINEL), SENTINEL_TEXT, 'utf8')
	before[name] = {
		sentinel: sha256(path.join(dir, SENTINEL)),
		files: listFiles(dir)
	}
}
console.log(`已布置 ${DECOYS.length} 个哨兵目录（其中新建 ${createdDirs.length} 个）`)

/* ----------------------------- 2. snapshot the project + temp root -- */
const projectSnapshot = () => {
	const entries = []
	const walk = d => {
		for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
			if (entry.name === 'node_modules' || entry.name === '.git') continue
			const p = path.join(d, entry.name)
			if (entry.isDirectory()) walk(p)
			else entries.push(path.relative(root, p))
		}
	}
	walk(path.join(root, 'tests'))
	walk(path.join(root, 'src'))
	return entries.sort()
}
const filesBefore = projectSnapshot()
const tempBefore = fs
	.readdirSync(os.tmpdir())
	.filter(n => n.startsWith('hep-rc323-'))
	.sort()

/* --------------------------------------------------- 3. run for real -- */
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hep-w01-out-'))
const started = Date.now()
const res = spawnSync(
	process.execPath,
	[SCRIPT, '--project-root', root, '--out', outDir, '--only', 'R1'],
	{ encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
)
const elapsed = Math.round((Date.now() - started) / 1000)
const output = `${res.stdout ?? ''}${res.stderr ?? ''}`
fs.writeFileSync(path.join(outDir, 'reverse-control.log'), output, 'utf8')
console.log(`反向对照（仅 R1）结束：exit=${res.status}，耗时 ${elapsed}s`)

/* ------------------------------------- 4. verify the decoys survived -- */
for (const name of DECOYS) {
	const dir = path.join(here, name)
	const exists = fs.existsSync(dir)
	const sentinel = exists ? path.join(dir, SENTINEL) : null
	const sentinelOk = !!sentinel && fs.existsSync(sentinel)
	const hashOk = sentinelOk && sha256(sentinel) === before[name].sentinel
	const filesNow = listFiles(dir)
	const kept = before[name].files.filter(f => filesNow.includes(f))
	record(
		`${name} 未被删除且哨兵字节不变`,
		exists && sentinelOk && hashOk && kept.length === before[name].files.length,
		`exists=${exists} sentinelIntact=${hashOk} files=${filesNow.length}/${before[name].files.length}`
	)
}

/* ------------------------------- 5. the project gained no new files -- */
const filesAfter = projectSnapshot()
const added = filesAfter.filter(f => !filesBefore.includes(f))
record(
	'项目树没有新增文件（bundle 全部落在临时目录）',
	added.length === 0,
	added.length ? `新增：${added.slice(0, 5).join(', ')}` : '新增 0'
)

/* ----------------------- 6. the run cleaned up its own temp dirs -- */
const tempAfter = fs
	.readdirSync(os.tmpdir())
	.filter(n => n.startsWith('hep-rc323-'))
	.sort()
const leftovers = tempAfter.filter(n => !tempBefore.includes(n))
record(
	'本次创建的临时目录已全部清理',
	leftovers.length === 0,
	leftovers.length ? `残留：${leftovers.join(', ')}` : `残留 0（运行前 ${tempBefore.length} 个，运行后 ${tempAfter.length} 个）`
)

/* ------------------------------------ 7. the control really did run -- */
record(
	'反向对照真的执行了（有结论行，且 R1 精确吻合）',
	res.status === 0 && /结论：通过/.test(output) && /R1 {2}OK/.test(output),
	`exit=${res.status} verdict=${/结论：通过/.test(output)} r1ok=${/R1 {2}OK/.test(output)}`
)

/* ------------------------------------------------------- 8. clean up -- */
for (const name of DECOYS) {
	const dir = path.join(here, name)
	fs.rmSync(path.join(dir, SENTINEL), { force: true })
	if (createdDirs.includes(dir)) {
		// Only a directory this test created may be removed here — and only if
		// nothing else appeared in it meanwhile.
		if (listFiles(dir).length === 0) fs.rmdirSync(dir)
	}
}
fs.rmSync(outDir, { recursive: true, force: true })

/* ----------------------------------------------------------- summary -- */
const failed = checks.filter(c => !c.pass)
console.log('\n' + '─'.repeat(72))
console.log(`总计：${checks.length} 项，PASS ${checks.length - failed.length}，FAIL ${failed.length}`)
if (failed.length) {
	console.log('FAILED:')
	for (const c of failed) console.log(`  ${c.name}  —  ${c.detail}`)
	process.exit(1)
}
process.exit(0)
