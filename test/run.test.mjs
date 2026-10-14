/**
 * 受控运行入口 + 审计日志的端到端测试（真实 spawn 子进程）
 */
import { EventEmitter } from 'node:events'
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply } from '../lib/index.js'

const HOME = join(tmpdir(), 'dsh-script-manager-run')
const DIR = join(HOME, 'run-scripts')
const BEACON = join(HOME, 'beacon-run.log')
const AUDIT = join(HOME, 'script-manager', 'audit.ndjson')

const problems = []
const oks = []
function check(label, ok, detail = '') {
  ;(ok ? oks : problems).push(`${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? '  → ' + detail : ''}`)
}

// 准备测试脚本（先彻底清场，保证可重复）
rmSync(DIR, { recursive: true, force: true })
rmSync(join(HOME, 'script-manager'), { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })
writeFileSync(join(DIR, 'hello.mjs'),
  '// @script 打招呼\n// @desc 打印一句话后正常退出\nconsole.log("HELLO-OK")\n', 'utf8')
writeFileSync(join(DIR, 'boom.mjs'),
  '// @script 会失败\n// @desc 往 stderr 写字并以退出码 3 结束\nconsole.error("BOOM-ERR")\nprocess.exit(3)\n', 'utf8')

process.env.DSH_HOME = HOME

const routes = []
const ctx = {
  inject(_deps, callback) { callback(ctx) },
  webServer: { register(route) { routes.push(route); return () => {} } },
  logger: { info() {}, warn() {} },
}
apply(ctx, { directories: [DIR], beaconFile: BEACON, runTimeoutMs: 20000, maxOutputBytes: 65536 })

const route = routes[0]
const LIST = '/dsh-script-manager/api/v1/list'
const TOGGLE = '/dsh-script-manager/api/v1/toggle'
const RUN = '/dsh-script-manager/api/v1/run'
const AUDIT_EP = '/dsh-script-manager/api/v1/audit'

function fakeRequest(method, url, body, headers) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = Object.assign({ host: '127.0.0.1:19387' }, headers || {})
  setImmediate(() => {
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)))
    req.emit('end')
  })
  return req
}
function fakeResponse() {
  const out = { status: 0, body: '' }
  out.writeHead = (s) => { out.status = s }
  out.end = (b) => { out.body = b || '' }
  return out
}
const json = (res) => { try { return JSON.parse(res.body) } catch { return null } }

// ---- 1) 列表 ----
const listRes = fakeResponse()
await route.handler(fakeRequest('GET', LIST), listRes)
const scripts = json(listRes).scripts
check('列出 2 个测试脚本', scripts.length === 2, `count=${scripts.length}`)
const hello = scripts.find((s) => s.filename === 'hello.mjs')
const boom = scripts.find((s) => s.filename === 'boom.mjs')

// ---- 2) 运行正常脚本 ----
let res = fakeResponse()
await route.handler(fakeRequest('POST', RUN, { id: hello.id }), res)
let data = json(res)
check('运行正常脚本 -> 200', res.status === 200, `status=${res.status}`)
check('outcome = ok', data && data.outcome === 'ok', data && data.outcome)
check('捕获到 stdout', data && String(data.stdout).includes('HELLO-OK'), data ? JSON.stringify(String(data.stdout).trim()) : 'none')
check('返回耗时', data && typeof data.durationMs === 'number')
check('exitCode = 0', data && data.exitCode === 0, String(data && data.exitCode))

// ---- 3) 运行失败脚本（非零退出码）----
res = fakeResponse()
await route.handler(fakeRequest('POST', RUN, { id: boom.id }), res)
data = json(res)
check('非零退出码 -> outcome = failed', data && data.outcome === 'failed', data && data.outcome)
check('捕获到 stderr', data && String(data.stderr).includes('BOOM-ERR'), data ? JSON.stringify(String(data.stderr).trim()) : 'none')
check('exitCode = 3', data && data.exitCode === 3, String(data && data.exitCode))

// ---- 4) 禁用后运行 → 必须被拒绝 ----
res = fakeResponse()
await route.handler(fakeRequest('POST', TOGGLE, { id: hello.id, enabled: false }), res)
check('禁用脚本 -> 200', res.status === 200, `status=${res.status}`)

res = fakeResponse()
await route.handler(fakeRequest('POST', RUN, { id: hello.id }), res)
data = json(res)
check('★ 禁用后运行被拒绝（403）', res.status === 403, `status=${res.status}`)
check('拒绝原因明确', data && data.outcome === 'denied' && String(data.error).includes('禁用'), data && data.error)

// ---- 5) 不支持的类型 ----
writeFileSync(join(DIR, 'query.sql'), '-- @script 查询\n-- @desc 只是 SQL\nSELECT 1;\n', 'utf8')
res = fakeResponse()
await route.handler(fakeRequest('GET', LIST), res)
const sqlScript = json(res).scripts.find((s) => s.filename === 'query.sql')
check('SQL 文件也被列出', !!sqlScript)
res = fakeResponse()
await route.handler(fakeRequest('POST', RUN, { id: sqlScript.id }), res)
data = json(res)
check('不支持的类型 -> 400 + unsupported', res.status === 400 && data && data.outcome === 'unsupported',
  `${res.status} ${data && data.outcome}`)

// ---- 6) 审计日志 ----
res = fakeResponse()
await route.handler(fakeRequest('GET', AUDIT_EP + '?limit=20'), res)
const entries = json(res).entries
check('审计接口有记录', Array.isArray(entries) && entries.length >= 4, `entries=${entries ? entries.length : 'none'}`)
check('审计含成功一次', entries.some((e) => e.outcome === 'ok' && e.name === '打招呼'))
check('审计含失败一次', entries.some((e) => e.outcome === 'failed' && e.exitCode === 3))
check('★ 审计含"被拒绝"一次', entries.some((e) => e.outcome === 'denied' && e.name === '打招呼'))
check('审计含不支持类型', entries.some((e) => e.outcome === 'unsupported'))
check('审计倒序（最新在前）', entries.length > 1 && Date.parse(entries[0].at) >= Date.parse(entries[entries.length - 1].at))
check('审计文件已落盘', existsSync(AUDIT) && readFileSync(AUDIT, 'utf8').trim().split('\n').length >= 4)

// ---- 7) 恢复 & 非法输入 ----
await route.handler(fakeRequest('POST', TOGGLE, { id: hello.id, enabled: true }), fakeResponse())
res = fakeResponse()
await route.handler(fakeRequest('POST', RUN, {}), res)
check('缺 id -> 400', res.status === 400, `status=${res.status}`)
res = fakeResponse()
await route.handler(fakeRequest('POST', RUN, { id: 'C:\\nope\\x.mjs' }), res)
check('未知脚本 -> 404', res.status === 404, `status=${res.status}`)
res = fakeResponse()
await route.handler(fakeRequest('POST', RUN, { id: hello.id }, { origin: 'http://evil.example.com' }), res)
check('跨源 run -> 403', res.status === 403, `status=${res.status}`)
res = fakeResponse()
await route.handler(fakeRequest('GET', RUN), res)
check('GET /run -> 405', res.status === 405, `status=${res.status}`)

console.log('\n===== 运行入口 + 审计 测试 =====')
for (const l of oks) console.log(' ', l)
for (const l of problems) console.log(' ', l)
console.log(`\n通过 ${oks.length} 项，失败 ${problems.length} 项`)
if (problems.length) process.exitCode = 1
