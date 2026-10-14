# dsh-script-manager

> DeepSeek Harness（DSH）的**脚本管理器**插件：把散落的脚本集中登记、一眼看清状态、**通过受控入口运行**，并把每一次运行（含被拒绝的）写进审计日志。

在会话输入框左侧多一个「脚本」按钮，点开是一个面板：

```
┌──────────────────────────────────────────────────────────┐
│ 脚本管理 ②              3 / 5 已启用 · 1 待确认           │ ← ② 待确认红点
├──────────────────────────────────────────────────────────┤
│ [启用] [新增]                                             │
│ 部署检查              [运行] [确认] [禁用并告知]          │
│ 检查服务是否在线并汇总状态                                 │
│ C:\...\.dsh-scripts\health-check.mjs          ← 点击复制  │
│ ┌ 运行结果 ─────────────────────────────┐                 │
│ │ ● 成功            退出码 0    128 ms  │                 │
│ │ 服务在线 ✅                            │                 │
│ └───────────────────────────────────────┘                 │
│ [已禁用]                                                  │
│ 危险脚本              [运行] [启用并告知]                 │
│ …                                                         │
├──────────────────────────────────────────────────────────┤
│ 点击后自动发送（不用你按回车）                    [ ●]     │
│                       [审计] [全部确认] [重新扫描] [关闭] │
└──────────────────────────────────────────────────────────┘
```

## 功能

| 功能 | 说明 |
|---|---|
| **清单** | 扫描配置的目录，从脚本头部注释里读出名称与说明（`@script` / `@desc`） |
| **受控运行** | 面板内直接运行脚本，输出回显在行内。**禁用的脚本会被宿主拒绝（403）** |
| **审计日志** | 每次运行都记一条：成功 / 失败 / 超时 / **被拒绝** / 不支持，含退出码与耗时 |
| **变更检测** | 记录确认时的 SHA256；脚本被**新增**或**改动**过会标出来 |
| **红点提醒** | 待确认数量直接显示在「脚本」按钮上，不用打开面板 |
| **告知 agent** | 点「禁用并告知」会把一条禁用指令**注入输入框并自动发送**给对话中的 agent |

## ⚠️ 约束力的边界（重要，请先读）

这个插件的定位是**受控入口 + 审计 + 变更可见**，**不是沙箱**。

- ✅ **走「运行」入口时，禁用状态是真的闸门**：宿主返回 403，不执行，并写审计。
- ⚠️ **agent 仍可绕过这个入口** —— 直接 `node x.mjs`、把内容内联执行、复制到别处、或新写一个脚本。
  **绕过时不会有审计记录** —— 换句话说，**审计里的"缺口"本身就是"有人绕过了"的信号**。
- 它也无法阻止 agent 创建文件；它能做的是**让你立刻看到有新脚本出现**（红点 + 「新增」标记）。

想真正做到"防止"需要一个站在执行路径上的沙箱，那是另一件事。本插件选择**诚实**：不做假闸门，
而是把"可检测"做到位。

## 安装

插件以 DSH profile 的 bundle 形式安装。把本仓库放进 profile 的 `node_modules`（或 `plugins/` 并做链接），
然后：

**1. `package.json`** —— 加入依赖与 bundle 列表：

```jsonc
{
  "dependencies": {
    // 方式 A：本地目录软链（开发常用）
    "dsh-script-manager": "link:./plugins/dsh-script-manager"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        // …
        "dsh-script-manager"
      ]
    }
  }
}
```

**2. `cordis.patch.yml`**（profile 根目录）—— 配置扫描目录：

```yaml
- id: dsh-script-manager
  name: 'dsh-script-manager'
  config:
    directories:
      - 'D:\my-scripts'
```

**3. 重启 DSH** —— 宿主插件与客户端 bundle 都在启动时加载，改动代码后必须重启才生效。

> 内容类改动**不需要重启**：新增脚本、开关、确认、运行、审计全是实时的。

## 脚本元信息约定

插件从脚本**头部注释**读取元信息。注释符不限（`#` `//` `--` `REM` `::` `<!--` `/*` `*`），冒号可省：

```powershell
# @script 端口占用检查
# @desc 列出本机正在监听的 TCP 端口及对应进程
```

```javascript
// @script 工作区文件树
// @desc: 递归打印工作区文件（跳过 node_modules）
```

也接受 `@name` / `@description` 别名与中文全角冒号。**没写 `@script` 就用文件名兜底。**

支持的扩展名：`.ps1 .psm1 .js .mjs .cjs .ts .py .sh .bash .bat .cmd .sql .java`

## 配置

| 键 | 默认值 | 说明 |
|---|---|---|
| `directories` | `<DSH_HOME>/scripts`、`<cwd>/.dsh-scripts` | 要扫描的目录（数组） |
| `runTimeoutMs` | `60000` | 运行超时；超时会杀进程并记 `timeout` |
| `maxOutputBytes` | `65536` | 单次输出上限；超出标记"已截断" |

也支持环境变量 `DSH_SCRIPT_DIRS`（分号分隔）。优先级：`directories` > `DSH_SCRIPT_DIRS` > 约定目录。

## 受控运行的支持范围

| 扩展名 | 解释器 |
|---|---|
| `.ps1` `.psm1` | `powershell`（带 `-ExecutionPolicy Bypass`，因为默认策略会拦未签名脚本） |
| `.js` `.mjs` `.cjs` | **宿主进程自带的 node**（不依赖 PATH） |
| `.py` | `python`（Windows）/ `python3`（其他） |
| `.bat` `.cmd` | `cmd.exe /c` |
| `.sh` `.bash` | `bash` |
| `.sql` `.java` 等 | **不支持** —— 返回 400 `unsupported` 并记审计 |

**长驻或交互式脚本请去终端跑**；这个入口是"跑一下看看结果"用的。

## HTTP 接口

面板通过同源 HTTP 路由与宿主通信（无需鉴权头；**所有 POST 校验同源**）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/dsh-script-manager/api/v1/list` | 扫描目录、脚本清单（名称/说明/启用态/SHA256/`isNew`/`changed`） |
| POST | `/dsh-script-manager/api/v1/toggle` | body `{ id, enabled }` |
| POST | `/dsh-script-manager/api/v1/ack` | body `{ ids: [...] }` 或 `{ all: true }`，确认接受当前版本 |
| POST | `/dsh-script-manager/api/v1/run` | body `{ id }`，**受控运行**；禁用返回 403 |
| GET | `/dsh-script-manager/api/v1/audit?limit=N` | 最近 N 条审计（最新在前） |

数据文件：

```
<DSH_HOME>/script-manager/state.json      # 启用状态 + 已确认哈希
<DSH_HOME>/script-manager/audit.ndjson    # 审计日志（每行一条 JSON）
```

## 开发

无构建步骤 —— 客户端 bundle 就是手写的纯 JS，直接放进 `client/client.js`，
通过 DSH Web 客户端的模块加载契约注册：

```js
window.__ModuleLoader__.load({ id: "dsh-script-manager", factory: (require) => { … } })
```

宿主侧注册进插槽 `conversation.input.left`（*"composer 工具行左侧的紧凑控件"*，
与权限/计划按钮同一行）：

```js
ctx.inject(['webServer'], (webCtx) => { /* 注册路由 */ })
ctx.slots.inject('conversation.input.left', () => ctx.slots.register({ … }, Component))
```

### 测试

```bash
node test/all.mjs          # 全部
node test/run.test.mjs     # 单个
```

覆盖：元信息解析 · 宿主路由端到端（列表/开关/确认/运行/审计 + 400/403/404/405）·
**真实 spawn 的运行入口**（含禁用被拒）· 受限 ctx 回归 · 客户端 bundle 预渲染（含"确认后红点同步"）。

> 运行入口的测试会真的起子进程，因此在受限环境里可能需要放宽权限。

## 许可

MIT —— 见 [LICENSE](LICENSE)。
