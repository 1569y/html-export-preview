/**
 * Optional real-browser DOM verification for generated HTML.
 *
 * The offline unit suite models the HTML RAWTEXT rule with a regex. This script
 * goes one step further and asks a real Chromium what it actually parsed —
 * the only way to be certain that theme CSS is a stylesheet and not body text.
 *
 * Usage:
 *   node tests/e2e/verify-html-dom.mjs [--expect-probe] <file.html> [...]
 *
 * Browser startup uses the WorkBuddy browser-lifecycle helper when present
 * (HE_BROWSER_LIFECYCLE or ~/.workbuddy/skills/...), so the temp profile is
 * always closed and removed. Without it the check prints SKIP and exits 0 —
 * it is deliberately not part of `npm test`.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
const expectProbe = args.includes('--expect-probe')
const files = args.filter(a => !a.startsWith('--'))
const helper =
	process.env.HE_BROWSER_LIFECYCLE ||
	path.join(os.homedir(), '.workbuddy/skills/browser-lifecycle/scripts/browser-lifecycle.mjs')
const exe =
	process.env.BROWSER_EXE ||
	'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'

if (!fs.existsSync(helper)) {
	console.log('SKIP: browser-lifecycle helper not found (' + helper + ')')
	process.exit(0)
}
if (!fs.existsSync(exe)) {
	console.log('SKIP: Chromium/Edge not found (' + exe + ')')
	process.exit(0)
}
if (files.length === 0) {
	console.log('usage: node tests/e2e/verify-html-dom.mjs [--expect-probe] <file.html> [...]')
	process.exit(2)
}

const { withBrowser } = await import(pathToFileURL(helper).href)

const PROBE = `(() => {
  const q = s => document.querySelectorAll(s).length;
  const text = document.body ? document.body.innerText : '';
  const markers = ['body:not(', '.markdown-rendered', '.HyperMD-header',
                   '-webkit-mask-image', 'url(data:image'];
  const hits = {};
  for (const m of markers) hits[m] = text.split(m).length - 1;
  const probeEl = document.createElement('div');
  probeEl.className = 'he-probe';
  document.body.appendChild(probeEl);
  const probeVar = getComputedStyle(probeEl).getPropertyValue('--he-probe').trim();
  probeEl.remove();
  return {
    styleCount: q('style'),
    headStyleCount: document.head ? document.head.querySelectorAll('style').length : -1,
    bodyStyleCount: document.body ? document.body.querySelectorAll('style').length : -1,
    bodyTextLen: text.length,
    hits,
    probeVar,
    hasNote: q('.markdown-preview-sizer') > 0,
    headings: q('.markdown-preview-sizer h1, .markdown-preview-sizer h2'),
    lists: q('.markdown-preview-sizer li'),
    tables: q('.markdown-preview-sizer table'),
    codeBlocks: q('.markdown-preview-sizer pre')
  };
})()`

class CDP {
	constructor(ws) {
		this.ws = ws
		this.id = 0
		this.pending = new Map()
		this.listeners = []
		ws.addEventListener('message', ev => {
			const msg = JSON.parse(ev.data)
			if (msg.id && this.pending.has(msg.id)) {
				const { resolve, reject } = this.pending.get(msg.id)
				this.pending.delete(msg.id)
				msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
			} else if (msg.method) {
				for (const fn of this.listeners) fn(msg)
			}
		})
	}
	send(method, params = {}, sessionId) {
		const id = ++this.id
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject })
			this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
		})
	}
	wait(method, ms = 20000) {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => { off(); reject(new Error('EVENT_TIMEOUT ' + method)) }, ms)
			const fn = msg => { if (msg.method === method) { clearTimeout(timer); off(); resolve(msg.params) } }
			const off = () => { this.listeners = this.listeners.filter(x => x !== fn) }
			this.listeners.push(fn)
		})
	}
}

const results = await withBrowser(
	{ label: 'he-html-dom', exe, url: 'about:blank', startupTimeoutMs: 30000, taskTimeoutMs: 180000 },
	async b => {
		const ver = await (await fetch(b.httpEndpoint + '/json/version')).json()
		const ws = new WebSocket(ver.webSocketDebuggerUrl)
		await new Promise((res, rej) => {
			ws.addEventListener('open', res, { once: true })
			ws.addEventListener('error', rej, { once: true })
		})
		const cdp = new CDP(ws)
		const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
		const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
		await cdp.send('Page.enable', {}, sessionId)
		await cdp.send('Runtime.enable', {}, sessionId)
		const out = []
		for (const file of files) {
			const loaded = cdp.wait('Page.loadEventFired')
			await cdp.send('Page.navigate', { url: pathToFileURL(path.resolve(file)).href }, sessionId)
			try { await loaded } catch { /* evaluate anyway */ }
			const r = await cdp.send('Runtime.evaluate', {
				expression: PROBE, returnByValue: true, awaitPromise: true
			}, sessionId)
			if (r.exceptionDetails) throw new Error(file + ': ' + JSON.stringify(r.exceptionDetails).slice(0, 300))
			out.push({ file, ...r.result.value })
		}
		ws.close()
		return out
	}
)

let failed = 0
for (const r of results) {
	const cssInBody = Object.values(r.hits).reduce((a, b) => a + b, 0)
	const ok =
		r.bodyStyleCount === 0 &&
		cssInBody === 0 &&
		r.hasNote &&
		(!expectProbe || r.probeVar === '1')
	if (!ok) failed++
	console.log(`${ok ? 'PASS' : 'FAIL'} | ${path.basename(r.file)} | styles=${r.styleCount} head=${r.headStyleCount} body=${r.bodyStyleCount} bodyText=${r.bodyTextLen} cssInBody=${cssInBody} probe=${r.probeVar || '(empty)'} note=${r.hasNote}`)
	if (!ok) console.log('       ' + JSON.stringify(r))
}
console.log(`\n[html-dom] ${results.length - failed} passed, ${failed} failed`)
if (failed) process.exit(1)
