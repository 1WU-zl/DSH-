/**
 * 回归测试：受限代理 ctx（访问未声明服务即抛错）
 *
 * 背景（真实故障）：apply 里写了 `if (ctx.webServer) ...`，宿主 ctx 是受限代理，
 * 访问未声明的服务会直接抛异常 → apply 中途炸掉 → 路由永远挂不上（接口 404）。
 *
 * 本测试做两件事：
 *   1) 先证明这个"受限代理"mock 确实能复现那个 bug（旧写法必然抛异常）；
 *   2) 再证明修复后的写法在同样的 ctx 下安然无恙、并成功注册路由。
 */
import { EventEmitter } from 'node:events'
import { readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply } from '../lib/index.js'

const TMP = join(tmpdir(), 'dsh-script-manager-guard')
const DIR = join(TMP, 'scripts')
const BEACON = join(TMP, 'beacon-guard.log')

// 造一个样例脚本，保证 list 目录非空
mkdirSync(DIR, { recursive: true })
writeFileSync(join(DIR, 'demo.mjs'), '// @script 示例\n// @desc 演示脚本\nconsole.log(1)\n', 'utf8')

const problems = []
const oks = []
function check(label, ok, detail = '') {
  ;(ok ? oks : problems).push(`${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? '  → ' + detail : ''}`)
}

/** 受限代理：只有 inject 可访问，其余服务一律抛错（模拟宿主行为）。 */
function guardedCtx(injectImpl) {
  return new Proxy({ inject: injectImpl }, {
    get(_t, prop) {
      if (prop === 'inject') return injectImpl
      throw new Error(`sandbox ctx: service "${String(prop)}" is not declared`)
    },
    has(_t, prop) {
      if (prop === 'inject') return true
      throw new Error(`sandbox ctx: has("${String(prop)}") refused`)
    },
  })
}

// ---------- 1) 先证明 mock 能复现旧 bug ----------
function oldStyleApply(ctx) {
  // 这正是修复前的写法
  if (ctx.webServer) return 'mounted'
  return 'not-mounted'
}
let oldThrew = false
try {
  oldStyleApply(guardedCtx(() => {}))
} catch (e) {
  oldThrew = true
}
check('mock 能复现旧 bug（旧写法 `if (ctx.webServer)` 在受限 ctx 上抛错）', oldThrew)

// ---------- 2) 修复后的写法必须安然无恙 ----------
try { rmSync(BEACON, { force: true }) } catch {}

let injectedDeps = null
let injectCallback = null
const routes = []
const ctx = guardedCtx((deps, cb) => {
  injectedDeps = deps
  injectCallback = cb
})

let applyThrew = null
try {
  apply(ctx, { directories: [DIR], beaconFile: BEACON })
} catch (error) {
  applyThrew = error
}
check('修复后 apply 不抛异常', applyThrew === null, applyThrew ? String(applyThrew.message) : '')
check('调用了 ctx.inject', injectedDeps !== null)
check('注入依赖恰为 ["webServer"]', JSON.stringify(injectedDeps) === '["webServer"]', JSON.stringify(injectedDeps))
check('未在 inject 之前触达其他服务（apply 未抛错即证明）', applyThrew === null)

// ---------- 3) 注入回调触发后应成功注册路由 ----------
if (typeof injectCallback === 'function') {
  const webCtx = {
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
  }
  let cbThrew = null
  try {
    injectCallback(webCtx)
  } catch (error) {
    cbThrew = error
  }
  check('注入回调执行不抛异常', cbThrew === null, cbThrew ? String(cbThrew.message) : '')
  check('成功注册 1 条路由', routes.length === 1, `routes=${routes.length}`)
  check('路由为 prefix /dsh-script-manager',
    routes[0] && routes[0].kind === 'prefix' && routes[0].path === '/dsh-script-manager',
    routes[0] ? routes[0].kind + ' ' + routes[0].path : 'none')

  // 真跑一次 list，确认 handler 可用
  if (routes[0]) {
    const req = new EventEmitter()
    req.method = 'GET'
    req.url = '/dsh-script-manager/api/v1/list'
    req.headers = { host: '127.0.0.1:19387' }
    setImmediate(() => req.emit('end'))
    const res = { status: 0, body: '', writeHead(s) { this.status = s }, end(b) { this.body = b || '' } }
    await routes[0].handler(req, res)
    check('handler 真跑 GET list 返回 200', res.status === 200, String(res.status))
    let parsed = null
    try { parsed = JSON.parse(res.body) } catch {}
    check('返回体含 scripts 数组', parsed !== null && Array.isArray(parsed.scripts),
      parsed ? `scripts=${parsed.scripts ? parsed.scripts.length : 'n/a'}` : 'parse failed')
  }
} else {
  check('注入回调被保存', false)
}

// ---------- 4) 探针应记录到 inject 路径 ----------
let beaconText = ''
try { beaconText = readFileSync(BEACON, 'utf8') } catch {}
check('探针含 module-loaded', beaconText.includes('module-loaded'))
check('探针含 apply-called', beaconText.includes('apply-called'))
check('探针含 inject-registered', beaconText.includes('inject-registered'), beaconText.split('\n').slice(-3).join(' | '))
check('探针含 inject-fired', beaconText.includes('inject-fired'))
check('探针含 mount-ok', beaconText.includes('mount-ok'))
check('探针不含任何 error 记录', !beaconText.includes('-error'), beaconText.includes('-error') ? 'has error' : '')

try { rmSync(BEACON, { force: true }) } catch {}

console.log('\n===== 受限 ctx 回归测试 =====')
for (const l of oks) console.log(' ', l)
for (const l of problems) console.log(' ', l)
console.log(`\n通过 ${oks.length} 项，失败 ${problems.length} 项`)
if (problems.length) process.exitCode = 1
