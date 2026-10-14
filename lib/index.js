/**
 * dsh-script-manager —— 宿主侧
 *
 * 职责：
 *  1. 扫描配置的脚本目录，递归收集可识别的脚本文件；
 *  2. 从脚本头部注释里解析内嵌元信息（@script / @desc），这是我写脚本时"填进去"的信息；
 *  3. 把每条脚本的启用/禁用状态持久化到 DSH_HOME 下的 JSON；
 *  4. 通过 webServer 暴露 HTTP 路由，供浏览器面板读写。
 *
 * 设计约束：本文件在宿主启动链上执行，任何未捕获异常都会中断 DSH 启动。
 * 因此所有入口都做了防御：拿不到服务就安静地不挂载，绝不抛出。
 *
 * 诊断：config.beacon !== false 时，各装载阶段会追加一行到 beacon 文件，
 * 用于在拿不到宿主日志时定位"插件究竟走到哪一步"。定位完成后关掉即可。
 */
import { readFile, writeFile, readdir, stat, mkdir, appendFile } from 'node:fs/promises'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { join, extname, resolve, dirname, sep } from 'node:path'
import { homedir } from 'node:os'

export const name = 'dsh-script-manager'

/** 允许被列出的脚本扩展名。 */
const SCRIPT_EXTENSIONS = new Set([
  '.ps1', '.psm1',
  '.js', '.mjs', '.cjs', '.ts',
  '.py',
  '.sh', '.bash',
  '.bat', '.cmd',
  '.sql',
  '.java',
])

/** 单次扫描的文件数上限，避免误配一个大目录把内存吃满。 */
const MAX_FILES = 500

function dshHome() {
  const fromEnv = process.env.DSH_HOME
  return fromEnv && fromEnv.trim() !== '' ? fromEnv : join(homedir(), '.dsh')
}

// ---------------------------------------------------------------------------
// 探针（诊断期使用）
// ---------------------------------------------------------------------------
let beaconFile = null

/** 追加一条探针记录，永不抛错。 */
function beacon(stage, detail = '') {
  if (beaconFile === null) return
  try {
    appendFileSync(beaconFile, `${new Date().toISOString()}  ${stage}${detail ? '  ' + detail : ''}\n`)
  } catch {
    /* 探针失败绝不影响功能 */
  }
}

/** 模块被 import 时立刻留痕：能区分"没被导入"与"导入了但没 apply"。 */
function initBeacon(config) {
  if (config && config.beacon === false) return
  beaconFile = (config && typeof config.beaconFile === 'string' && config.beaconFile.trim() !== '')
    ? config.beaconFile
    : join(process.cwd(), '.plugin-beacon.log')
  beacon('module-loaded', `pid=${process.pid} cwd=${process.cwd()}`)
}

/**
 * 解析脚本头部的 @script / @desc 元信息。
 *
 * 约定（任意注释前缀都行：# // -- REM :: <!-- /* *）：
 *   @script  <名称>
 *   @desc    <功能说明>
 *
 * @param text 脚本正文（调用方已截断到头部若干行）。
 * @param fallbackName 没写 @script 时用的文件名。
 * @returns 解析出的名称与说明。
 */
export function parseMeta(text, fallbackName) {
  let scriptName = ''
  let desc = ''
  const lines = String(text).split(/\r?\n/).slice(0, 60)
  for (const raw of lines) {
    // 行首注释符：支持 # // -- :: REM | *（块注释续行）/*（块注释起始）<!--（HTML 注释）
    // 交替顺序很重要：/\*+ 与 <!-- 必须排在 * 和 -- 之前
    const cleaned = raw
      .replace(/^\s*(?:\/\*+|<!--|#|\/\/|--|::|\*|REM\b)\s?/i, '')
      .trim()
    if (!cleaned.startsWith('@')) continue
    // 冒号可省：`@script 名称` 与 `@script: 名称` 都接受；\b 防止 @description 被 desc 抢先匹配
    const matched = /^@(script|name|desc|description)\b\s*[:：]?\s*(.*)$/i.exec(cleaned)
    if (!matched) continue
    const key = matched[1].toLowerCase()
    // 再剥掉块注释的收尾符（ */ 与 --> ），否则会混进说明文字里
    const value = matched[2].replace(/\s*(?:\*\/|-->)\s*$/, '').trim()
    if (key === 'desc' || key === 'description') {
      if (desc === '') desc = value
    } else if (scriptName === '') {
      scriptName = value
    }
  }
  return { name: scriptName || fallbackName, desc }
}

/** 递归收集目录下的脚本文件。 */
async function collectFiles(dir, out, depth = 0) {
  if (out.length >= MAX_FILES || depth > 6) return
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (out.length >= MAX_FILES) return
    if (entry.name.startsWith('.') && entry.name !== '.dsh-scripts') continue
    if (entry.name === 'node_modules') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      await collectFiles(full, out, depth + 1)
      continue
    }
    if (!entry.isFile()) continue
    if (!SCRIPT_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue
    out.push(full)
  }
}

/** 读取状态文件（不存在或损坏都退化成空对象）。 */
async function readState(file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

async function writeState(file, state) {
  try {
    // 首次运行时 DSH_HOME 下还没有 script-manager 目录，必须先建
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify(state, null, 2), 'utf8')
    return true
  } catch {
    return false
  }
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(payload))
}

/**
 * 安全地写宿主日志。
 * 受限 ctx 上访问未声明的服务（含 logger）会抛异常，所以必须包在 try 里。
 */
function log(ctx, level, message) {
  try {
    const logger = ctx && ctx.logger
    if (logger && typeof logger[level] === 'function') logger[level](message)
  } catch {
    /* 拿不到 logger 就不写，绝不影响功能 */
  }
}

function readJsonBody(request) {
  return new Promise((resolvePromise) => {
    let raw = ''
    request.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 64 * 1024) raw = raw.slice(0, 64 * 1024)
    })
    request.on('end', () => {
      try {
        resolvePromise(JSON.parse(raw || '{}'))
      } catch {
        resolvePromise(null)
      }
    })
    request.on('error', () => resolvePromise(null))
  })
}

// ---------------------------------------------------------------------------
// 受控运行入口 —— 本插件唯一"有约束力"的地方
//
// 说明：禁用状态在其他任何路径上都拦不住谁（agent 可以直接 node x.mjs）。
// 但走这个入口时，禁用会被**真的拒绝**，并且**逐条写审计**。
// 于是"绕过"从"没人知道"变成"留了痕"。
// ---------------------------------------------------------------------------

/** 按扩展名决定解释器；返回 null 表示这类文件不能直接运行。 */
function runnerFor(file, ext) {
  const win = process.platform === 'win32'
  switch (ext) {
    case '.ps1':
    case '.psm1':
      // 本机执行策略会拦未签名脚本，所以显式用 Bypass（与用户在终端里的做法一致）
      return { command: win ? 'powershell.exe' : 'pwsh', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file] }
    case '.js':
    case '.mjs':
    case '.cjs':
      // 宿主进程自己就是 Node —— 直接用同一个可执行文件，不依赖 PATH
      return { command: process.execPath, args: [file] }
    case '.py':
      return { command: win ? 'python' : 'python3', args: [file] }
    case '.bat':
    case '.cmd':
      return { command: 'cmd.exe', args: ['/c', file] }
    case '.sh':
    case '.bash':
      return { command: 'bash', args: [file] }
    default:
      return null // .sql / .java 等不是可直接执行的脚本
  }
}

/**
 * 执行一个脚本并收集输出（同步式：等它结束或超时）。
 * 输出有上限，超时会被杀掉 —— 长驻脚本请去终端里跑。
 */
function runProcess(spec, cwd, timeoutMs, maxBytes) {
  return new Promise((resolveRun) => {
    const started = Date.now()
    let stdout = ''
    let stderr = ''
    let truncated = false
    let settled = false
    const finish = (payload) => {
      if (settled) return
      settled = true
      resolveRun({ durationMs: Date.now() - started, truncated, stdout, stderr, ...payload })
    }

    let child
    try {
      child = spawn(spec.command, spec.args, {
        cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      finish({ outcome: 'error', error: String((error && error.message) || error), exitCode: null })
      return
    }

    const take = (chunk, isErr) => {
      const text = String(chunk)
      const used = isErr ? stderr.length : stdout.length
      if (used + text.length > maxBytes) {
        truncated = true
        return
      }
      if (isErr) stderr += text
      else stdout += text
    }
    if (child.stdout) child.stdout.on('data', (c) => take(c, false))
    if (child.stderr) child.stderr.on('data', (c) => take(c, true))

    const timer = setTimeout(() => {
      try { child.kill() } catch { /* 忽略 */ }
      finish({ outcome: 'timeout', exitCode: null })
    }, timeoutMs)

    child.on('error', (error) => {
      clearTimeout(timer)
      finish({ outcome: 'error', error: String((error && error.message) || error), exitCode: null })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      finish({ outcome: code === 0 ? 'ok' : 'failed', exitCode: code })
    })
  })
}

/** 追加一条审计记录；永不影响主流程。 */
async function appendAudit(file, entry) {
  try {
    await mkdir(dirname(file), { recursive: true })
    await appendFile(file, JSON.stringify(entry) + '\n', 'utf8')
    return true
  } catch {
    return false
  }
}

/** 读取审计日志尾部若干条（最新在前）。 */
async function readAudit(file, limit) {
  try {
    const raw = await readFile(file, 'utf8')
    const lines = raw.split('\n').filter((l) => l.trim() !== '')
    const tail = lines.slice(Math.max(0, lines.length - limit))
    const out = []
    for (const line of tail) {
      try { out.push(JSON.parse(line)) } catch { /* 跳过坏行 */ }
    }
    return out.reverse()
  } catch {
    return []
  }
}

/** 只接受同源请求（面板与宿主同端口）。 */
function sameOrigin(request) {
  const origin = request.headers.origin
  if (!origin) return true
  try {
    return new URL(origin).host === request.headers.host
  } catch {
    return false
  }
}

/**
 * 解析要扫描的目录列表。
 * 优先级：显式 config.directories > 环境变量 DSH_SCRIPT_DIRS > 约定目录。
 */
function resolveDirectories(config) {
  const fromConfig = Array.isArray(config && config.directories) ? config.directories : []
  const explicit = fromConfig.filter((d) => typeof d === 'string' && d.trim() !== '')
  if (explicit.length > 0) return explicit.map((d) => resolve(d))

  const fromEnv = (process.env.DSH_SCRIPT_DIRS || '')
    .split(/[;]/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (fromEnv.length > 0) return fromEnv.map((d) => resolve(d))

  const candidates = [join(dshHome(), 'scripts'), join(process.cwd(), '.dsh-scripts')]
  return [...new Set(candidates.map((d) => resolve(d)))]
}

/** 宿主侧插件主体。 */
export function apply(ctx, config = {}) {
  initBeacon(config)
  beacon('apply-called', `config=${JSON.stringify(config)}`)

  let directories
  try {
    directories = resolveDirectories(config)
  } catch (error) {
    beacon('resolve-dirs-error', String(error && error.stack))
    directories = []
  }
  const stateFile = join(dshHome(), 'script-manager', 'state.json')
  const auditFile = join(dshHome(), 'script-manager', 'audit.ndjson')
  // 运行入口的限制：默认 60 秒超时、单次输出上限 64 KB
  const runTimeoutMs = Number.isFinite(config && config.runTimeoutMs) ? config.runTimeoutMs : 60000
  const maxOutputBytes = Number.isFinite(config && config.maxOutputBytes) ? config.maxOutputBytes : 65536
  beacon('resolved', `dirs=${directories.join('|')} state=${stateFile}`)

  const listScripts = async () => {
    const state = await readState(stateFile)
    const files = []
    for (const dir of directories) {
      await collectFiles(dir, files)
    }
    files.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))

    const scripts = []
    for (const file of files) {
      let head = ''
      let digest = ''
      let info = null
      try {
        // 一次读入 Buffer：既取头部做元信息解析，又算整体 SHA256 用于变更检测
        const buffer = await readFile(file)
        head = buffer.subarray(0, 4000).toString('utf8')
        digest = createHash('sha256').update(buffer).digest('hex')
      } catch {
        head = ''
        digest = ''
      }
      try {
        info = await stat(file)
      } catch {
        info = null
      }
      const meta = parseMeta(head, file.slice(file.lastIndexOf(sep) + 1))
      const entry = state[file]
      // 变更检测：只与"已确认的哈希"比较；没有记录 = 新脚本（待审）
      const knownHash = entry && typeof entry.hash === 'string' ? entry.hash : ''
      scripts.push({
        id: file,
        file,
        filename: file.slice(file.lastIndexOf(sep) + 1),
        name: meta.name,
        desc: meta.desc,
        ext: extname(file).toLowerCase(),
        size: info ? info.size : 0,
        mtime: info ? info.mtimeMs : 0,
        enabled: entry && typeof entry.enabled === 'boolean' ? entry.enabled : true,
        hash: digest,
        hashShort: digest ? digest.slice(0, 8) : '',
        /** 是否为首次出现（尚无已确认的哈希） */
        isNew: digest !== '' && knownHash === '',
        /** 内容是否在确认之后被改动过 */
        changed: digest !== '' && knownHash !== '' && knownHash !== digest,
        acknowledgedAt: entry && typeof entry.acknowledgedAt === 'number' ? entry.acknowledgedAt : 0,
      })
    }
    return { directories, scripts }
  }

  let mounted = false

  const mount = (webCtx, via) => {
    if (mounted) {
      beacon('mount-skipped', `already mounted (via=${via})`)
      return
    }
    try {
      const webServer = webCtx && webCtx.webServer
      if (!webServer || typeof webServer.register !== 'function') {
        beacon('mount-no-webserver', `via=${via} type=${typeof webServer}`)
        log(ctx, 'warn', '[dsh-script-manager] webServer 服务不可用，面板路由未挂载')
        return
      }
      beacon('mount-start', `via=${via}`)

      const disposers = []

      // 用单个 prefix 路由覆盖本插件全部端点：注册次数最少，失败面最小。
      disposers.push(webServer.register({
        kind: 'prefix',
        path: '/dsh-script-manager',
        handler: async (request, response) => {
          const url = String(request.url || '')
          // 匹配必须用去掉查询串的路径：否则 `/audit?limit=20` 会落进 404
          const path = url.split('?')[0]
          if (path.endsWith('/list')) {
            if (request.method !== 'GET') {
              response.writeHead(405, { allow: 'GET' })
              response.end()
              return
            }
            try {
              sendJson(response, 200, { schema: 1, ...(await listScripts()) })
            } catch (error) {
              sendJson(response, 500, { schema: 1, error: String((error && error.message) || error) })
            }
            return
          }
          if (path.endsWith('/toggle')) {
            if (request.method !== 'POST') {
              response.writeHead(405, { allow: 'POST' })
              response.end()
              return
            }
            if (!sameOrigin(request)) {
              sendJson(response, 403, { error: 'cross-origin request refused' })
              return
            }
            const body = await readJsonBody(request)
            const id = body && typeof body.id === 'string' ? body.id : ''
            const enabled = body && typeof body.enabled === 'boolean' ? body.enabled : null
            if (id === '' || enabled === null) {
              sendJson(response, 400, { error: 'expected { id: string, enabled: boolean }' })
              return
            }
            const state = await readState(stateFile)
            state[id] = { ...(state[id] || {}), enabled, updatedAt: Date.now() }
            const ok = await writeState(stateFile, state)
            sendJson(response, ok ? 200 : 500, { schema: 1, id, enabled, persisted: ok })
            return
          }
          if (path.endsWith('/ack')) {
            // 确认（接受当前版本）：把当前哈希记为"已确认"，之后改动会被标为「已修改」。
            // 传 { ids: [...] } 确认指定脚本；传 { all: true } 确认全部。
            if (request.method !== 'POST') {
              response.writeHead(405, { allow: 'POST' })
              response.end()
              return
            }
            if (!sameOrigin(request)) {
              sendJson(response, 403, { error: 'cross-origin request refused' })
              return
            }
            const body = await readJsonBody(request)
            const ids = body && Array.isArray(body.ids)
              ? body.ids.filter((x) => typeof x === 'string' && x !== '')
              : []
            const all = !!(body && body.all === true)
            if (ids.length === 0 && !all) {
              sendJson(response, 400, { error: 'expected { ids: string[] } or { all: true }' })
              return
            }
            const snapshot = await listScripts()
            const wanted = all ? snapshot.scripts.map((s) => s.id) : ids
            const state = await readState(stateFile)
            const acknowledged = []
            for (const script of snapshot.scripts) {
              if (!wanted.includes(script.id) || script.hash === '') continue
              state[script.id] = {
                ...(state[script.id] || {}),
                hash: script.hash,
                acknowledgedAt: Date.now(),
                updatedAt: Date.now(),
              }
              acknowledged.push(script.id)
            }
            const ok = await writeState(stateFile, state)
            sendJson(response, ok ? 200 : 500, { schema: 1, acknowledged, persisted: ok })
            return
          }
          if (path.endsWith('/run')) {
            // ★ 受控运行入口：禁用的脚本在这里被真的拒绝，并写审计。
            if (request.method !== 'POST') {
              response.writeHead(405, { allow: 'POST' })
              response.end()
              return
            }
            if (!sameOrigin(request)) {
              sendJson(response, 403, { error: 'cross-origin request refused' })
              return
            }
            const body = await readJsonBody(request)
            const id = body && typeof body.id === 'string' ? body.id : ''
            if (id === '') {
              sendJson(response, 400, { error: 'expected { id: string }' })
              return
            }

            const snapshot = await listScripts()
            const script = snapshot.scripts.find((s) => s.id === id)
            if (!script) {
              sendJson(response, 404, { error: 'unknown script', id })
              return
            }

            // 闸门：状态文件里的 enabled 在这里第一次真正生效
            if (!script.enabled) {
              await appendAudit(auditFile, {
                at: new Date().toISOString(),
                action: 'run',
                outcome: 'denied',
                id,
                name: script.name,
                reason: '脚本处于禁用状态，运行入口拒绝执行',
              })
              sendJson(response, 403, {
                schema: 1,
                outcome: 'denied',
                error: '该脚本已被禁用：运行入口拒绝执行（已计入审计）',
              })
              return
            }

            const runner = runnerFor(id, script.ext)
            if (!runner) {
              await appendAudit(auditFile, {
                at: new Date().toISOString(),
                action: 'run',
                outcome: 'unsupported',
                id,
                name: script.name,
                reason: `不支持直接运行的扩展名 ${script.ext}`,
              })
              sendJson(response, 400, {
                schema: 1,
                outcome: 'unsupported',
                error: `不支持直接运行的扩展名：${script.ext}（请在终端里手动执行）`,
              })
              return
            }

            const result = await runProcess(runner, dirname(id), runTimeoutMs, maxOutputBytes)
            await appendAudit(auditFile, {
              at: new Date().toISOString(),
              action: 'run',
              outcome: result.outcome,
              id,
              name: script.name,
              exitCode: result.exitCode,
              durationMs: result.durationMs,
              truncated: result.truncated,
              error: result.error,
            })
            sendJson(response, 200, { schema: 1, id, name: script.name, ...result })
            return
          }
          if (path.endsWith('/audit')) {
            if (request.method !== 'GET') {
              response.writeHead(405, { allow: 'GET' })
              response.end()
              return
            }
            const limitRaw = Number(new URL(url, 'http://x').searchParams.get('limit'))
            const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 50
            const entries = await readAudit(auditFile, limit)
            sendJson(response, 200, { schema: 1, entries })
            return
          }
          sendJson(response, 404, { error: 'unknown endpoint', url })
        },
      }))
      beacon('register-returned', `count=${disposers.length}`)

      mounted = true
      beacon('mount-ok', `dirs=${directories.join('|')}`)
      log(ctx, 'info', `[dsh-script-manager] 已挂载，脚本目录: ${directories.join(' | ')}`)

      try {
        const cleanup = () => {
          for (const dispose of disposers) {
            try {
              dispose()
            } catch {
              /* 忽略 */
            }
          }
        }
        if (typeof webCtx.effect === 'function') {
          webCtx.effect(() => cleanup, 'dsh-script-manager: http routes')
        } else if (typeof webCtx.on === 'function') {
          webCtx.on('dispose', cleanup)
        }
      } catch {
        /* 清理失败不影响功能 */
      }
    } catch (error) {
      beacon('mount-error', String(error && error.stack))
    }
  }

  // 只走依赖注入这一条路。
  //
  // 教训（真实故障）：不要探测 `ctx.webServer`。宿主 ctx 是受限代理，访问
  // **未声明**的服务会直接抛异常；写成 `if (ctx.webServer) ...` 时，apply 会在
  // 这一句上炸掉，后面的路由注册永远执行不到 —— 表现是插件"已加载"但接口 404。
  // webServer 只在 inject 回调内部访问，那时它已是"已声明"的服务。
  try {
    if (typeof ctx.inject !== 'function') {
      beacon('no-inject-api')
      return
    }
    ctx.inject(['webServer'], (webCtx) => {
      beacon('inject-fired')
      mount(webCtx, 'inject')
    })
    beacon('inject-registered')
  } catch (error) {
    beacon('inject-error', String(error && error.stack))
  }
}

export default { name, apply }
