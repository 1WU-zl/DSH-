/**
 * 客户端 bundle 预渲染测试（不需要真实浏览器、不需要重启 DSH）
 *
 * 做法：造一个最小的 window/document + 打桩的 react 与 ui-primitives，
 * 按 DSH 的模块加载契约执行 client.js，然后：
 *   1. 校验导出形状（name / inject / apply）
 *   2. 校验注册参数（插槽 key、id、order）
 *   3. 把组件函数真正跑一遍，检查渲染出的元素树
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const BUNDLE = fileURLToPath(new URL('../client/client.js', import.meta.url))

const problems = []
const oks = []
function check(label, ok, detail = '') {
  ;(ok ? oks : problems).push(`${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? '  → ' + detail : ''}`)
}

// ---------------- 打桩 ----------------
let hookIndex = 0
// React 的 hook 调用顺序：0=useRef, 1=open, 2=pos, 3=status, 4=scripts, 5=directories,
// 6=error, 7=busy, 8=copiedId, 9=autoSend, 10=note, 11=runState, 12=audit, 13=notifyCount
const preset = {
  1: true,            // 面板设为打开
  3: 'ready',         // 状态 ready
  4: [
    { id: 'a', name: '端口占用检查', desc: '列出本机监听端口', enabled: true,
      file: 'C:\\demo\\.dsh-scripts\\check-ports.ps1', filename: 'check-ports.ps1',
      hash: 'aaaaaaaaaaaa', hashShort: 'aaaaaaaa', isNew: true, changed: false },
    { id: 'b', name: 'Ollama 状态', desc: '检查 Ollama 服务', enabled: false,
      file: 'C:\\demo\\.dsh-scripts\\ollama-status.ps1', filename: 'ollama-status.ps1',
      hash: 'bbbbbbbbbbbb', hashShort: 'bbbbbbbb', isNew: false, changed: true },
  ],
  5: ['C:\\demo\\.dsh-scripts'],
  // 11 = runState：a 留下"被拒绝"结果、b 留下"成功"结果（验证结果块）
  11: {
    a: { status: 'done', result: { outcome: 'denied', error: '该脚本已被禁用：运行入口拒绝执行（已计入审计）' } },
    b: { status: 'done', result: { outcome: 'ok', stdout: 'HELLO-OK\n', exitCode: 0, durationMs: 123 } },
  },
  // 13 = notifyCount：红点显示 2
  13: 2,
}

/** 记录所有 setState 调用（index = hook 序号），用于验证状态之间的联动 */
const stateWrites = []

const react = {
  Fragment: 'Fragment',
  createElement: (type, props, ...children) => ({ __el: true, type, props: props || {}, children }),
  useRef: (init) => { hookIndex++; return { current: init } },
  useState: (init) => {
    const i = hookIndex++
    const value = Object.prototype.hasOwnProperty.call(preset, i) ? preset[i] : init
    const setter = (next) => {
      stateWrites.push({ index: i, value: typeof next === 'function' ? next(value) : next })
    }
    return [value, setter]
  },
  useEffect: () => {},
  useLayoutEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
}

const primitives = { Button: 'Button', Switch: 'Switch' }

const requireStub = (id) => {
  if (id === 'react') return react
  if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitives
  throw new Error('bundle 请求了未预期的模块: ' + id)
}

let stylesInjected = 0
const doc = {
  getElementById: () => null,
  createElement: () => ({ set textContent(v) { stylesInjected++ }, get textContent() { return '' } }),
  head: { appendChild: () => {} },
  querySelector: () => null,
}
const win = { innerWidth: 1280, innerHeight: 800 }

let loadedDef = null
win.__ModuleLoader__ = { load: (def) => { loadedDef = def } }

// ---------------- 执行 bundle ----------------
const source = readFileSync(BUNDLE, 'utf8')
try {
  new Function('window', 'document', source)(win, doc)
  check('bundle 顶层可执行（未抛异常）', true)
} catch (e) {
  check('bundle 顶层可执行（未抛异常）', false, String(e.message))
}
check('调用了 window.__ModuleLoader__.load', !!loadedDef)
check('模块 id 正确', loadedDef && loadedDef.id === 'dsh-script-manager', loadedDef && loadedDef.id)

let mod = null
try {
  mod = loadedDef.factory(requireStub)
  check('factory(require) 执行成功', true)
} catch (e) {
  check('factory(require) 执行成功', false, String(e.message))
}

if (mod) {
  check('exports.name = dsh-script-manager', mod.name === 'dsh-script-manager', mod.name)
  check('exports.inject 含 "slots"', Array.isArray(mod.inject) && mod.inject.includes('slots'), JSON.stringify(mod.inject))
  check('exports.apply 是函数', typeof mod.apply === 'function')

  // ---------------- 注册校验 ----------------
  let injectedKey = null
  let regOpts = null
  let regComp = null
  const ctx = {
    slots: {
      inject: (key, cb) => { injectedKey = key; return cb() },
      register: (opts, comp) => { regOpts = opts; regComp = comp; return () => {} },
    },
  }
  try {
    mod.apply(ctx)
    check('apply(ctx) 未抛异常', true)
  } catch (e) {
    check('apply(ctx) 未抛异常', false, String(e.message))
  }

  check('通过 slots.inject 等待插槽', injectedKey === 'conversation.input.left', String(injectedKey))
  check('注册到 conversation.input.left', regOpts && regOpts.name === 'conversation.input.left', regOpts && regOpts.name)
  check('注册 id = dsh-script-manager', regOpts && regOpts.id === 'dsh-script-manager', regOpts && regOpts.id)
  check('注册 order 是数字', regOpts && typeof regOpts.order === 'number', String(regOpts && regOpts.order))
  check('提供了 label', !!regOpts && typeof regOpts.label === 'function', regOpts && typeof regOpts.label)
  check('组件是函数', typeof regComp === 'function')
  check('样式已注入', stylesInjected > 0, String(stylesInjected))

  // ---------------- 渲染校验 ----------------
  // 打桩：输入框写入能力（真实由 session 作用域插槽下发 inputActions）
  const injected = []
  const submitted = []
  const inputActions = {
    captureInsertion: () => ({ revision: 7 }),
    insertText: (text) => { injected.push({ via: 'insertText', text }); return true },
    setDraft: (text) => { injected.push({ via: 'setDraft', text }) },
    submit: () => { submitted.push(true) },
  }
  const statusMap = (running) => new Map([['sess-1', { running }]])
  const props = {
    inputActions,
    useInput: () => '',
    sessionId: 'sess-1',
    useSessionStatus: (selector) => selector(statusMap(false)),
  }
  // 打桩 fetch，避免测试依赖正在运行的 DSH
  const toggled = []
  const acked = []
  globalThis.fetch = async (url, init) => {
    const u = String(url)
    const body = init && init.body
    if (u.endsWith('/toggle')) {
      try { toggled.push(JSON.parse(body || '{}')) } catch {}
    }
    if (u.endsWith('/ack')) {
      try { acked.push(JSON.parse(body || '{}')) } catch {}
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ scripts: [], directories: [] }) }
  }

  hookIndex = 0
  let tree = null
  try {
    tree = regComp(props)
    check('组件函数渲染未抛异常（open=true, 有 2 条脚本）', true)
  } catch (e) {
    check('组件函数渲染未抛异常', false, String(e.message))
  }

  function collect(node, out = { texts: [], types: [], els: [] }) {
    if (node === null || node === undefined) return out
    if (Array.isArray(node)) { for (const n of node) collect(n, out); return out }
    if (typeof node === 'string' || typeof node === 'number') { out.texts.push(String(node)); return out }
    if (node.__el) {
      out.types.push(typeof node.type === 'string' ? node.type : (node.type.name || 'Component'))
      out.els.push(node)
      for (const c of node.children) collect(c, out)
    }
    return out
  }

  const { texts, types, els } = collect(tree)
  const joined = texts.join(' | ')
  check('行内不再有 Switch（只剩「自动发送」设置那一个）',
    types.filter((t) => t === 'Switch').length === 1, `switches=${types.filter((t) => t === 'Switch').length}`)
  check('渲染出 Button', types.includes('Button'))
  check('面板标题「脚本管理」出现', texts.includes('脚本管理'), joined.substring(0, 120))
  check('显示脚本 1 名称（来自脚本元信息）', texts.includes('端口占用检查'))
  check('显示脚本 1 功能说明', texts.includes('列出本机监听端口'))
  check('显示脚本 2 名称', texts.includes('Ollama 状态'))
  check('显示启用计数 1 / 2', texts.some((t) => String(t).includes('1 / 2 已启用')), joined.substring(0, 60))
  check('显示「重新扫描」按钮文案', texts.includes('重新扫描'))

  // 新增：脚本文件位置（点击复制）
  check('显示脚本 1 的完整路径', texts.includes('C:\\demo\\.dsh-scripts\\check-ports.ps1'))
  check('显示脚本 2 的完整路径', texts.includes('C:\\demo\\.dsh-scripts\\ollama-status.ps1'))
  const pathEls = els.filter((e) => typeof e.props.className === 'string' && e.props.className.includes('dsh-sm-path-click'))
  check('路径元素带可点击样式', pathEls.length === 2, `count=${pathEls.length}`)
  check('路径元素带提示与点击处理',
    pathEls.length === 2 && typeof pathEls[0].props.onClick === 'function' && !!pathEls[0].props.title,
    pathEls.length ? `title=${pathEls[0].props.title}` : 'none')

  // 新增：状态徽章 + 「禁用并告知」按钮（只数"启用/已禁用"徽章，不含"新增/已修改"标记）
  const badges = els.filter((e) => {
    const cn = e.props.className
    return typeof cn === 'string' && cn.includes('dsh-sm-badge')
      && !cn.includes('dsh-sm-badge-new') && !cn.includes('dsh-sm-badge-mod')
  })
  check('每行有状态徽章（启用 / 已禁用）', badges.length === 2, `count=${badges.length}`)
  const badgeTexts = badges.flatMap((b) => b.children.map(String))
  check('徽章文案正确（启用 / 已禁用）',
    badgeTexts.includes('启用') && badgeTexts.includes('已禁用'), badgeTexts.join(','))

  // 布局回归：动作区里只放按钮 —— 徽章挪到左侧后，窄面板才不会把按钮裁成「用并告」
  const actionBoxes = els.filter((e) => typeof e.props.className === 'string' && e.props.className.includes('dsh-sm-actions'))
  check('每行都有动作区', actionBoxes.length === 2, `count=${actionBoxes.length}`)
  const badgeInsideActions = actionBoxes.some((box) => (box.children || []).some((child) =>
    child && child.props && typeof child.props.className === 'string'
    && child.props.className.includes('dsh-sm-badge')))
  check('动作区里不放徽章（避免窄面板下溢出裁字）', !badgeInsideActions)

  // 回归：行内按钮一律 outline —— primary 在真实界面里会渲染成"比文字还小的小方块"
  const rowButtons = els.filter((e) => e.type === 'Button'
    && typeof e.props.className === 'string' && e.props.className.includes('dsh-sm-rowbtn'))
  check('行内按钮全部使用 outline 变体（禁用 primary）—— 现在每行 2 个（运行 + 告知），共 4 个',
    rowButtons.length === 4 && rowButtons.every((b) => b.props.variant === 'outline'),
    rowButtons.map((b) => String(b.props.variant)).join(','))
  check('已禁用的行内按钮带强调色类',
    rowButtons.some((b) => String(b.props.className).includes('dsh-sm-rowbtn-off')))

  // 新增：受控运行入口的 UI
  check('每行都有「运行」按钮', texts.filter((t) => t === '运行').length === 2,
    `count=${texts.filter((t) => t === '运行').length}`)
  check('运行结果块渲染出「已被拒绝」', texts.includes('● 已被拒绝'))
  check('结果块显示拒绝原因', texts.some((t) => String(t).includes('运行入口拒绝执行')))
  check('成功结果块显示退出码与耗时',
    texts.some((t) => String(t) === '退出码 0') && texts.some((t) => String(t) === '123 ms'))
  check('成功结果块显示 stdout', texts.some((t) => String(t).includes('HELLO-OK')))

  // 新增：触发按钮红点
  const dots = els.filter((e) => typeof e.props.className === 'string' && e.props.className.includes('dsh-sm-dot'))
  check('触发按钮带红点', dots.length === 1, `count=${dots.length}`)
  check('红点显示待确认数量 2', dots.length === 1 && dots[0].children.map(String).includes('2'))

  // 新增：审计视图（单独渲染一次）
  preset[12] = [
    { at: '2026-10-14T10:00:00.000Z', outcome: 'denied', name: '打招呼', reason: '脚本处于禁用状态，运行入口拒绝执行' },
    { at: '2026-10-14T09:59:00.000Z', outcome: 'ok', name: '打招呼', exitCode: 0, durationMs: 120 },
    { at: '2026-10-14T09:58:00.000Z', outcome: 'failed', name: '会失败', exitCode: 3, durationMs: 90 },
  ]
  hookIndex = 0
  const auditView = collect(regComp(props))
  check('审计视图标题为「运行审计」', auditView.texts.includes('运行审计'))
  check('审计视图显示记录条数', auditView.texts.some((t) => String(t).includes('3 条记录')))
  check('审计行渲染「被拒绝」', auditView.texts.includes('被拒绝'))
  check('审计行渲染「成功」', auditView.texts.includes('成功'))
  check('审计行渲染「失败」', auditView.texts.includes('失败'))
  check('审计行显示退出码', auditView.texts.some((t) => String(t).includes('exit 3')))
  check('审计视图提供「返回」按钮', auditView.texts.includes('返回'))
  delete preset[12]
  check('按钮文案「禁用并告知」', texts.includes('禁用并告知'))
  check('按钮文案「启用并告知」', texts.includes('启用并告知'))

  // 新增：点击按钮 → 注入指令到输入框 + 翻转持久化状态
  const actionButtons = els.filter((e) => {
    const kids = (e.children || []).map(String)
    return e.type === 'Button' && (kids.includes('禁用并告知') || kids.includes('启用并告知'))
  })
  check('找到 2 个告知按钮', actionButtons.length === 2, `count=${actionButtons.length}`)
  if (actionButtons.length === 2) {
    // 脚本 1 当前 enabled=true → 点它应"禁用并告知"
    await actionButtons[0].props.onClick()
    const first = injected[0]
    check('点击后向输入框注入了指令', !!first, JSON.stringify(first))
    check('走的是 insertText（追加式，不覆盖已有草稿）', first && first.via === 'insertText', first && first.via)
    check('指令含脚本名与完整路径',
      !!first && first.text.includes('端口占用检查') && first.text.includes('C:\\demo\\.dsh-scripts\\check-ports.ps1'),
      first ? first.text.slice(0, 80) : 'none')
    check('指令明确表达"不要执行"', !!first && first.text.includes('不要执行'), first ? first.text.slice(0, 40) : 'none')
    check('同时翻转了持久化状态（POST /toggle）',
      toggled.length === 1 && toggled[0].enabled === false, JSON.stringify(toggled))
    check('自动发送已触发（提交输入框）', submitted.length === 1, `submit=${submitted.length}`)
  }

  // 新增：变更检测的可见性
  check('头部显示「待确认」计数', texts.some((t) => String(t).includes('待确认')), joined.match(/待确认/) ? 'found' : 'missing')
  check('渲染「新增」标记', texts.includes('新增'))
  check('渲染「已修改」标记', texts.includes('已修改'))
  check('渲染行内「确认」按钮', texts.includes('确认'))
  check('渲染「全部确认」按钮', texts.includes('全部确认'))
  check('渲染「自动发送」设置项', texts.includes('点击后自动发送（不用你按回车）'))
  const allAck = els.filter((e) => e.type === 'Button' && (e.children || []).map(String).includes('全部确认'))
  check('「全部确认」按钮可用', allAck.length === 1 && typeof allAck[0].props.onClick === 'function')
  if (allAck.length === 1) {
    await allAck[0].props.onClick()
    check('「全部确认」调用 POST /ack', toggled.length === 1 && acked.length === 1,
      `acked=${JSON.stringify(acked)}`)
    check('「全部确认」提交了全部脚本 id', acked.length === 1 && Array.isArray(acked[0].ids) && acked[0].ids.length === 2,
      acked.length ? JSON.stringify(acked[0].ids) : 'none')
    // 回归：确认之后红点计数必须立刻同步（此前只在 30 秒轮询里更新，导致红点不实时消失）
    check('★ 确认后红点计数被同步更新（不依赖下一次轮询）',
      stateWrites.some((w) => w.index === 13 && w.value === 0),
      JSON.stringify(stateWrites.filter((w) => w.index === 13)))
  }

  // 新增：触发按钮外观（曾是灰方块）
  const triggerEls = els.filter((e) => e.type === 'Button' && (e.children || []).map(String).includes('脚本'))
  check('触发按钮用 ghost 变体（不再渲染成灰方块）',
    triggerEls.length === 1 && triggerEls[0].props.variant === 'ghost',
    triggerEls.length ? String(triggerEls[0].props.variant) : 'none')
  check('触发按钮带线性图标', triggerEls.length === 1 && !!triggerEls[0].props.icon)

  // 新增：我正忙时 —— 必须注入但绝不自动发送（否则会打断任务）
  const busyProps = {
    inputActions,
    useInput: () => '',
    sessionId: 'sess-1',
    useSessionStatus: (selector) => selector(statusMap(true)),
  }
  injected.length = 0
  submitted.length = 0
  hookIndex = 0
  const busyEls = collect(regComp(busyProps)).els
  const busyButtons = busyEls.filter((e) => {
    const kids = (e.children || []).map(String)
    return e.type === 'Button' && (kids.includes('禁用并告知') || kids.includes('启用并告知'))
  })
  check('忙碌场景找到告知按钮', busyButtons.length === 2, `count=${busyButtons.length}`)
  if (busyButtons.length > 0) {
    check('忙碌时按钮带旋转加载图标', !!busyButtons[0].props.icon)
    check('忙碌时提示文案说明不会自动发送',
      String(busyButtons[0].props.title || '').includes('不会自动发送'),
      String(busyButtons[0].props.title || '').slice(0, 40))
    await busyButtons[0].props.onClick()
    check('忙碌时【不】自动发送（避免打断任务）', submitted.length === 0, `submit=${submitted.length}`)
    check('忙碌时仍然注入了指令（放进草稿）', injected.length === 1, `injected=${injected.length}`)
  }

  // 保守默认：running 未知（undefined）时也必须按"忙"处理
  const unknownProps = {
    inputActions,
    useInput: () => '',
    sessionId: 'sess-1',
    useSessionStatus: (selector) => selector(new Map([['sess-1', { running: undefined }]])),
  }
  injected.length = 0
  submitted.length = 0
  hookIndex = 0
  const unknownEls = collect(regComp(unknownProps)).els
  const unknownButtons = unknownEls.filter((e) => {
    const kids = (e.children || []).map(String)
    return e.type === 'Button' && (kids.includes('禁用并告知') || kids.includes('启用并告知'))
  })
  if (unknownButtons.length > 0) {
    await unknownButtons[0].props.onClick()
    check('running 未知时按"忙"处理，不自动发送', submitted.length === 0, `submit=${submitted.length}`)
    check('running 未知时仍注入指令', injected.length === 1, `injected=${injected.length}`)
  }
  // 完全没有 useSessionStatus（异常环境）也应退化为"忙"
  injected.length = 0
  submitted.length = 0
  hookIndex = 0
  const noHookEls = collect(regComp({ inputActions, useInput: () => '', sessionId: 'sess-1' })).els
  const noHookButtons = noHookEls.filter((e) => {
    const kids = (e.children || []).map(String)
    return e.type === 'Button' && (kids.includes('禁用并告知') || kids.includes('启用并告知'))
  })
  if (noHookButtons.length > 0) {
    await noHookButtons[0].props.onClick()
    check('无 useSessionStatus 时也退化为"忙"，不自动发送', submitted.length === 0, `submit=${submitted.length}`)
  }

  // 关闭态：不应渲染面板
  hookIndex = 0
  preset[1] = false
  const closed = collect(regComp(props))
  check('关闭态下不渲染面板', closed.els.filter((e) => typeof e.props.className === 'string' && e.props.className.includes('dsh-sm-panel')).length === 0)
  preset[1] = true
}

console.log('\n===== 客户端 bundle 预渲染测试 =====')
for (const l of oks) console.log(' ', l)
for (const l of problems) console.log(' ', l)
console.log(`\n通过 ${oks.length} 项，失败 ${problems.length} 项`)
if (problems.length) process.exitCode = 1
