/**
 * 宿主侧端到端测试：用假 ctx 捕获路由，再用假 request/response 真跑一遍 handler。
 *
 * 路由是单个 prefix 路由（/dsh-script-manager），按去掉查询串的路径分派 ——
 * 本测试覆盖列表 / 开关 / 确认 / 防御路径（400/403/404/405）/ 变更检测。
 */
import { EventEmitter } from 'node:events'
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply } from '../lib/index.js'

const HOME = join(tmpdir(), 'dsh-script-manager-routes')
const DIR = join(HOME, 'scripts')
const BEACON = join(HOME, 'beacon.log')
const AUDIT = join(HOME, 'script-manager', 'audit.ndjson')
const STATE = join(HOME, 'script-manager', 'state.json')

const ok = []
const bad = []
const check = (label, pass, detail = '') => {
  ;(pass ? ok : bad).push(`${pass ? 'OK  ' : 'FAIL'} ${label}${detail ? '  → ' + detail : ''}`)
}

// ---- fixture ----
rmSync(HOME, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })
writeFileSync(join(DIR, 'alpha.ps1'),
  '# @script 端口检查\n# @desc 列出监听端口\nWrite-Output "hi"\n', 'utf8')
writeFileSync(join(DIR, 'beta.mjs'),
  '// @script 文件树\n// @desc: 递归打印文件\nconsole.log("tree")\n', 'utf8')

process.env.DSH_HOME = HOME

// ---- 捕获路由 ----
const routes = []
const ctx = {
  inject(_deps, callback) { callback(ctx) },
  webServer: { register(route) { routes.push(route); return () => {} } },
  logger: { info() {}, warn() {} },
}
apply(ctx, { directories: [DIR], beaconFile: BEACON })

check('注册了 1 条 prefix 路由', routes.length === 1, `routes=${routes.length}`)
check('路由路径为 /dsh-script-manager',
  !!routes[0] && routes[0].kind === 'prefix' && routes[0].path === '/dsh-script-manager',
  routes[0] ? `${routes[0].kind} ${routes[0].path}` : 'none')

const route = routes[0]
const LIST = '/dsh-script-manager/api/v1/list'
const TOGGLE = '/dsh-script-manager/api/v1/toggle'
const ACK = '/dsh-script-manager/api/v1/ack'

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
const call = async (method, url, body, headers) => {
  const res = fakeResponse()
  await route.handler(fakeRequest(method, url, body, headers), res)
  return res
}
const jsonOf = (res) => { try { return JSON.parse(res.body) } catch { return null } }

// ---- 列表 ----
let res = await call('GET', LIST)
let data = jsonOf(res)
check('GET list -> 200', res.status === 200, String(res.status))
check('返回扫描目录', Array.isArray(data.directories) && data.directories.length === 1)
check('扫描到 2 个脚本', data.scripts.length === 2, `count=${data.scripts.length}`)
const alpha = data.scripts.find((s) => s.filename === 'alpha.ps1')
const beta = data.scripts.find((s) => s.filename === 'beta.mjs')
check('解析出 @script 名称（alpha）', alpha && alpha.name === '端口检查', alpha && alpha.name)
check('解析出 @desc（alpha）', alpha && alpha.desc === '列出监听端口', alpha && alpha.desc)
check('解析出 @script 名称（beta）', beta && beta.name === '文件树', beta && beta.name)
check('解析出 @desc（beta，行内冒号）', beta && beta.desc === '递归打印文件', beta && beta.desc)
check('默认全部启用', data.scripts.every((s) => s.enabled === true))
check('每条都带 SHA256 与短哈希',
  data.scripts.every((s) => typeof s.hash === 'string' && s.hash.length === 64 && s.hashShort.length === 8))

// ---- 开关 ----
res = await call('POST', TOGGLE, { id: alpha.id, enabled: false })
check('POST toggle -> 200', res.status === 200, String(res.status))
check('toggle 回执含 persisted: true', jsonOf(res) && jsonOf(res).persisted === true, res.body.slice(0, 80))
check('状态文件已落盘', readFileSync(STATE, 'utf8').includes('"enabled": false')
  || readFileSync(STATE, 'utf8').includes('"enabled":false'))

res = await call('GET', LIST)
data = jsonOf(res)
check('列表反映禁用状态',
  data.scripts.find((s) => s.filename === 'alpha.ps1').enabled === false)

res = await call('POST', TOGGLE, { id: alpha.id, enabled: true })
check('可以恢复启用', res.status === 200 && jsonOf(res) && jsonOf(res).persisted === true)

// ---- 防御路径 ----
check('toggle 缺 enabled -> 400', (await call('POST', TOGGLE, { id: alpha.id })).status === 400)
check('toggle 缺 id -> 400', (await call('POST', TOGGLE, { enabled: true })).status === 400)
check('POST list -> 405（方法不对）', (await call('POST', LIST)).status === 405)
check('跨源 POST toggle -> 403',
  (await call('POST', TOGGLE, { id: alpha.id, enabled: true }, { origin: 'http://evil.example.com' })).status === 403)
check('未知端点 -> 404', (await call('GET', '/dsh-script-manager/nope')).status === 404)

// ---- 变更检测 ----
res = await call('GET', LIST)
data = jsonOf(res)
check('从未确认过 -> 全部标记 isNew',
  data.scripts.every((s) => s.isNew === true && s.changed === false),
  JSON.stringify(data.scripts.map((s) => [s.isNew, s.changed])))

check('ack 缺参数 -> 400', (await call('POST', ACK, {})).status === 400)
check('跨源 ack -> 403',
  (await call('POST', ACK, { all: true }, { origin: 'http://evil.example.com' })).status === 403)

res = await call('POST', ACK, { all: true })
check('POST ack(all) -> 200', res.status === 200, String(res.status))
check('ack 回执列出全部 id', jsonOf(res) && jsonOf(res).acknowledged.length === 2)

res = await call('GET', LIST)
data = jsonOf(res)
check('ack 之后 isNew 清空', data.scripts.every((s) => s.isNew === false))
check('ack 之后 changed 为空', data.scripts.every((s) => s.changed === false))
check('ack 之后记录了确认时间', data.scripts.every((s) => s.acknowledgedAt > 0))

// 篡改已记录的哈希 -> 该条应变成「已修改」
const state = JSON.parse(readFileSync(STATE, 'utf8'))
const tampered = data.scripts[0].id
state[tampered].hash = 'deadbeef'.repeat(8)
writeFileSync(STATE, JSON.stringify(state, null, 2), 'utf8')

res = await call('GET', LIST)
data = jsonOf(res)
const changed = data.scripts.filter((s) => s.changed)
check('篡改哈希后恰好 1 条标记「已修改」', changed.length === 1, `changed=${changed.length}`)
check('被标记的是被篡改那条', changed.length === 1 && changed[0].id === tampered)

// ---- 带查询串的端点必须能匹配上（曾经因为 endsWith 匹配而 404）----
check('带查询串的路径不落进 404',
  (await call('GET', '/dsh-script-manager/api/v1/audit?limit=1')).status === 200)

// ---- 单个 id 的 ack ----
res = await call('POST', ACK, { ids: [beta.id] })
check('ack 支持指定 ids', res.status === 200 && jsonOf(res).acknowledged.length === 1)

// ---- 探针（证明走的是 inject 路径）----
const beacon = readFileSync(BEACON, 'utf8')
check('探针含 inject-registered', beacon.includes('inject-registered'))
check('探针含 mount-ok', beacon.includes('mount-ok'))
check('探针没有 error 记录', !beacon.includes('-error'))

rmSync(HOME, { recursive: true, force: true })

console.log('\n===== 宿主路由端到端 =====')
for (const l of ok) console.log(' ', l)
for (const l of bad) console.log(' ', l)
console.log(`\n通过 ${ok.length} 项，失败 ${bad.length} 项`)
if (bad.length) process.exitCode = 1
