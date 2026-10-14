/**
 * dsh-script-manager —— 浏览器侧
 *
 * 以 DSH Web 客户端的模块加载契约打包（无需构建工具）：
 * 注册进插槽 conversation.input.left —— 官方注释为
 * "Compact controls at the left of the composer tool row"，
 * 即会话输入框工具行左侧、权限控件所在的同一行。
 */
window.__ModuleLoader__.load({ id: "dsh-script-manager", factory: (require) => {
	var module = { exports: {} };
	var exports = module.exports;

	const react = require("react");
	const primitives = require("@deepseek-ai/dsh-client-ui-primitives");

	const name = "dsh-script-manager";
	/** Cordis 客户端服务依赖：插槽注册表。 */
	const inject = ["slots"];
	/** 目标插槽：输入框工具行左侧（list 类型，允许与权限控件并列）。 */
	const SLOT_KEY = "conversation.input.left";
	const API_BASE = "/dsh-script-manager/api/v1";
	const STYLE_ID = "dsh-script-manager-style";

	const CSS = [
		".dsh-sm-wrap{position:relative;display:inline-flex}",
		".dsh-sm-backdrop{position:fixed;inset:0;z-index:79;background:transparent}",
		".dsh-sm-panel{position:fixed;z-index:80;width:450px;max-width:calc(100vw - 24px);max-height:58vh;overflow:auto;padding:12px;border-radius:12px;border:1px solid rgba(127,127,127,.28);background:var(--dsw-alias-bg-elevated,#fff);box-shadow:0 12px 32px rgba(0,0,0,.18);font-size:13px;line-height:1.5;color:inherit}",
		".dsh-sm-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}",
		".dsh-sm-title{font-weight:600}",
		".dsh-sm-sub{opacity:.6;font-size:11px}",
		// 行：**上下两行**结构（文本块在上、动作区在下）。
		// 之前用横向 flex 时，动作区会在窄面板里被收缩，导致按钮被压窄、文字从两端被裁
		// （只剩下中间几个字）。改成纵向堆叠后，横向没有任何宽度竞争，任何面板宽度都不会裁字。
		".dsh-sm-row{display:flex;flex-direction:column;align-items:stretch;gap:6px;padding:8px 2px;border-top:1px solid rgba(127,127,127,.16)}",
		".dsh-sm-row:first-of-type{border-top:none}",
		".dsh-sm-meta{min-width:0}",
		".dsh-sm-name{font-weight:500;word-break:break-all}",
		".dsh-sm-desc{opacity:.66;font-size:12px;margin-top:2px;word-break:break-word}",
		".dsh-sm-path{opacity:.42;font-size:11px;margin-top:3px;word-break:break-all;font-family:ui-monospace,Consolas,monospace}",
		".dsh-sm-path-click{cursor:pointer;border-radius:4px;padding:1px 3px;margin-left:-3px}",
		".dsh-sm-path-click:hover{opacity:.85;background:rgba(127,127,127,.14)}",
		".dsh-sm-copied{opacity:.8;color:#2e7d32}",
		// 动作区独占一行、右对齐；内部允许换行，但按钮本身永不收缩
		".dsh-sm-actions{display:flex;align-items:center;flex-wrap:wrap;justify-content:flex-end;gap:6px 8px;width:100%}",
		// 行内按钮：只加颜色，绝不碰尺寸/布局（避免再次把它压变形）
		".dsh-sm-rowbtn{flex:0 0 auto}",
		// 「已禁用 → 启用并告知」用实心强调。注意：这里只声明颜色，尺寸继承 outline（它渲染正常）；
		// 直接用 variant="primary" 会渲染成小方块，所以不碰那个变体。
		".dsh-sm-rowbtn-off{background:var(--dsw-alias-button-primary-fill);border-color:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}",
		".dsh-sm-rowbtn-off:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover);border-color:var(--dsw-alias-button-primary-hover)}",
		".dsh-sm-actions button{white-space:nowrap;flex:0 0 auto}",
		".dsh-sm-badge{font-size:11px;padding:1px 6px;border-radius:999px;background:rgba(46,125,50,.14);color:#2e7d32;white-space:nowrap;flex:0 0 auto}",
		".dsh-sm-badge-off{background:rgba(198,40,40,.14);color:#c62828}",
		".dsh-sm-badge-new{background:rgba(21,101,192,.16);color:#1565c0}",
		".dsh-sm-badge-mod{background:rgba(230,81,0,.16);color:#e65100}",
		".dsh-sm-flags{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:3px}",
		".dsh-sm-setting{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:10px;padding-top:8px;border-top:1px solid rgba(127,127,127,.16);font-size:12px}",
		".dsh-sm-setting-label{opacity:.75}",
		".dsh-sm-note{margin-top:8px;padding:6px 8px;border-radius:8px;background:rgba(230,81,0,.12);color:#a34a00;font-size:12px}",
		".dsh-sm-empty{padding:16px 4px;opacity:.65;text-align:center}",
		".dsh-sm-foot{display:flex;justify-content:flex-end;gap:8px;margin-top:10px}",
		// 触发按钮：跟工具行其它控件一样不换行
		".dsh-sm-trigger{white-space:nowrap}",
		// 忙碌指示（旋转图标）
		".dsh-sm-spin{animation:dsh-sm-rotate 1s linear infinite;transform-origin:50% 50%}",
		"@keyframes dsh-sm-rotate{from{transform:rotate(0)}to{transform:rotate(360deg)}}",
		// 运行入口 / 审计 / 红点
		".dsh-sm-dot{position:absolute;top:-5px;right:-5px;min-width:15px;height:15px;padding:0 4px;border-radius:999px;background:#e53935;color:#fff;font-size:10px;line-height:15px;text-align:center;font-weight:600;box-shadow:0 0 0 2px var(--dsw-alias-bg-elevated,#fff)}",
		".dsh-sm-result{margin-top:6px;border-radius:8px;background:rgba(127,127,127,.10);padding:8px}",
		".dsh-sm-result-head{display:flex;align-items:center;gap:8px;margin-bottom:5px;font-size:12px;opacity:.85}",
		".dsh-sm-pre{margin:0 0 4px 0;max-height:200px;overflow:auto;white-space:pre-wrap;word-break:break-all;font-family:ui-monospace,Consolas,monospace;font-size:11px;line-height:1.45}",
		".dsh-sm-audit-row{display:flex;align-items:baseline;justify-content:space-between;gap:10px;padding:6px 2px;border-top:1px solid rgba(127,127,127,.14);font-size:12px}",
		".dsh-sm-audit-row:first-child{border-top:none}",
		".dsh-sm-audit-meta{opacity:.6;font-size:11px;white-space:nowrap}",
		".dsh-sm-t-ok{color:#2e7d32}",
		".dsh-sm-t-fail{color:#c62828}",
		".dsh-sm-t-warn{color:#e65100}",
	].join("");

	function ensureStyle() {
		if (typeof document === "undefined") return;
		if (document.getElementById(STYLE_ID)) return;
		const el = document.createElement("style");
		el.id = STYLE_ID;
		el.textContent = CSS;
		document.head.appendChild(el);
	}

	async function request(path, init) {
		const options = Object.assign({ credentials: "same-origin" }, init || {});
		const res = await fetch(API_BASE + path, options);
		const text = await res.text();
		let data = null;
		try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
		if (!res.ok) {
			const error = new Error((data && data.error) ? data.error : ("HTTP " + res.status));
			// 把响应载荷挂在错误上：运行入口的 403 需要区分"被拒绝"与其他失败
			error.status = res.status;
			error.payload = data;
			throw error;
		}
		return data;
	}

	/** 触发按钮图标：一个"脚本文件"线性图标（自带，不依赖图标包）。 */
	function scriptIcon() {
		return react.createElement("svg", {
			width: 14, height: 14, viewBox: "0 0 16 16", fill: "none",
			stroke: "currentColor", strokeWidth: 1.4,
			strokeLinecap: "round", strokeLinejoin: "round",
			"aria-hidden": "true", focusable: "false",
		},
			react.createElement("path", { d: "M4 2.5h5l3 3v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1Z" }),
			react.createElement("path", { d: "M9 2.5v3h3" }),
			react.createElement("path", { d: "M5.5 8.5h5" }),
			react.createElement("path", { d: "M5.5 11h3" }));
	}

	/** 忙碌指示：一段圆弧 + .dsh-sm-spin 旋转。 */
	function spinnerIcon() {
		return react.createElement("svg", {
			className: "dsh-sm-spin",
			width: 13, height: 13, viewBox: "0 0 16 16", fill: "none",
			stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round",
			"aria-hidden": "true", focusable: "false",
		},
			react.createElement("path", { d: "M8 1.8a6.2 6.2 0 1 0 6.2 6.2" }));
	}

	function ScriptManager(rawProps) {
		const props = rawProps || {};
		// session 作用域插槽会下发 inputActions —— 官方的"程序化写入输入框"能力
		const inputActions = props.inputActions || null;
		// 当前草稿：仅在草稿为空时才允许整体替换，避免覆盖你正在输入的内容
		const draftText = typeof props.useInput === "function"
			? (props.useInput((state) => (state && state.draft) || "") || "")
			: "";
		// 输入机相位：只在 plain（空闲）时才自动提交，避免打断正在进行的提交
		const inputPhase = typeof props.useInput === "function"
			? (props.useInput((state) => (state && state.phase) || "plain") || "plain")
			: "plain";
		// 我是否正在这个会话里执行任务。
		// 保守判定：只有**明确知道** running === false 才认为空闲。
		// 基线未建立时为 undefined —— 按"忙"处理。代价不对称：误判为忙只是少自动发一次
		// （指令仍在草稿里，按回车即可）；误判为空闲却会打断正在执行的任务。
		const sessionId = props.sessionId;
		const runningFlag = typeof props.useSessionStatus === "function"
			? props.useSessionStatus((map) => {
				if (!map || typeof map.get !== "function") return undefined;
				const status = map.get(sessionId);
				return status ? status.running : undefined;
			})
			: undefined;
		const agentBusy = runningFlag !== false;
		const wrapRef = react.useRef(null);
		const [open, setOpen] = react.useState(false);
		const [pos, setPos] = react.useState(null);
		const [status, setStatus] = react.useState("idle");
		const [scripts, setScripts] = react.useState([]);
		const [directories, setDirectories] = react.useState([]);
		const [error, setError] = react.useState("");
		const [busy, setBusy] = react.useState({});
		// 记录"刚刚复制过路径"的脚本 id，用于短暂反馈（放在 hook 顺序末尾，避免影响既有索引）
		const [copiedId, setCopiedId] = react.useState("");
		// 点击后是否自动提交。偏好存 localStorage，默认开启。
		const [autoSend, setAutoSend] = react.useState(true);
		// 一次性提示（例如"我正忙，未发送"）
		const [note, setNote] = react.useState("");
		// 每个脚本的运行状态与结果：{ [id]: { status: 'running'|'done', result } }
		const [runState, setRunState] = react.useState({});
		// 审计视图：null = 未打开；数组 = 已打开并载入
		const [audit, setAudit] = react.useState(null);
		// 触发按钮上的红点：待确认脚本数（面板关闭时也能看到）
		const [notifyCount, setNotifyCount] = react.useState(0);

		react.useEffect(() => { ensureStyle(); }, []);

		react.useEffect(() => {
			try {
				const saved = window.localStorage.getItem("dsh-script-manager.autoSend");
				if (saved === "0") setAutoSend(false);
				else if (saved === "1") setAutoSend(true);
			} catch (e) {
				/* 无 localStorage（或不许访问）时沿用默认值 */
			}
		}, []);

		/** 记住「自动发送」偏好。 */
		const rememberAutoSend = react.useCallback((next) => {
			setAutoSend(next);
			try { window.localStorage.setItem("dsh-script-manager.autoSend", next ? "1" : "0") } catch (e) { /* 忽略 */ }
		}, []);

		// 后台轮询"待确认"数量 —— 面板关着时也能在触发按钮上看到红点
		react.useEffect(() => {
			let alive = true;
			const tick = async () => {
				try {
					const data = await request("/list");
					if (!alive) return;
					const list = Array.isArray(data && data.scripts) ? data.scripts : [];
					setNotifyCount(list.filter((s) => s.isNew || s.changed).length);
				} catch (e) {
					/* 轮询失败静默，不打扰用户 */
				}
			};
			tick();
			const timer = setInterval(tick, 30000);
			return () => { alive = false; clearInterval(timer); };
		}, []);

		const load = react.useCallback(async () => {
			setStatus("loading");
			setError("");
			try {
				const data = await request("/list");
				const list = Array.isArray(data && data.scripts) ? data.scripts : [];
				setScripts(list);
				setDirectories(Array.isArray(data && data.directories) ? data.directories : []);
				// ★ 红点必须和列表用同一份数据同步更新。
				// 之前只在 30 秒轮询里更新，导致「确认」之后红点要等下一轮才消失。
				setNotifyCount(list.filter((s) => s.isNew || s.changed).length);
				setStatus("ready");
			} catch (err) {
				setError(String((err && err.message) || err));
				setStatus("error");
			}
		}, []);

		react.useEffect(() => { if (open) load(); }, [open, load]);

		react.useLayoutEffect(() => {
			if (!open) return;
			const node = wrapRef.current;
			if (!node || typeof window === "undefined") return;
			const rect = node.getBoundingClientRect();
			const width = 450;   // 与 .dsh-sm-panel 的 width 保持一致
			const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
			setPos({ left: left, bottom: Math.max(12, window.innerHeight - rect.top + 8) });
		}, [open]);

		const toggle = react.useCallback(async (script, next) => {
			setBusy((b) => Object.assign({}, b, { [script.id]: true }));
			try {
				await request("/toggle", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ id: script.id, enabled: next }),
				});
				setScripts((list) => list.map((item) =>
					item.id === script.id ? Object.assign({}, item, { enabled: next }) : item));
			} catch (err) {
				setError(String((err && err.message) || err));
			} finally {
				setBusy((b) => Object.assign({}, b, { [script.id]: false }));
			}
		}, []);

		/** 复制脚本完整路径到剪贴板（带降级方案），并短暂显示"已复制"。 */
		const copyPath = react.useCallback((script) => {
			const text = script.file;
			let settled = false;
			const done = () => {
				if (settled) return;
				settled = true;
				setCopiedId(script.id);
				setTimeout(() => setCopiedId((cur) => (cur === script.id ? "" : cur)), 1200);
			};
			const fallback = () => {
				try {
					const area = document.createElement("textarea");
					area.value = text;
					area.style.position = "fixed";
					area.style.opacity = "0";
					document.body.appendChild(area);
					area.select();
					document.execCommand("copy");
					document.body.removeChild(area);
				} catch (e) {
					/* 复制失败也不影响其他功能 */
				}
				done();
			};
			try {
				if (navigator.clipboard && navigator.clipboard.writeText) {
					navigator.clipboard.writeText(text).then(done, fallback);
					return;
				}
			} catch (e) {
				/* 落到降级方案 */
			}
			fallback();
		}, []);

		/**
		 * 把一条指令注入输入框（不覆盖你已输入的内容）。
		 *
		 * 优先 insertText（在光标处追加）；失败且草稿为空时才用 setDraft 整体替换；
		 * 都不可用时退化为复制到剪贴板。绝不静默丢弃你正在输入的文字。
		 * @param text - 要注入的指令文本。
		 * @returns 'inserted' | 'draft' | 'clipboard' | 'blocked'
		 */
		const notifyAgent = react.useCallback((text) => {
			const actions = inputActions;
			if (actions) {
				try {
					// 追加式写入：保留已有内容，且只占一步撤销
					if (typeof actions.captureInsertion === "function" && typeof actions.insertText === "function") {
						const span = actions.captureInsertion();
						if (actions.insertText(text, span) === true) return "inserted";
					}
					// 兜底：整体替换 —— 只在草稿为空时做，避免覆盖
					if (typeof actions.setDraft === "function" && draftText === "") {
						actions.setDraft(text);
						return "draft";
					}
				} catch (e) {
					/* 落到剪贴板 */
				}
			}
			try {
				if (navigator.clipboard && navigator.clipboard.writeText) {
					navigator.clipboard.writeText(text);
					return "clipboard";
				}
			} catch (e) {
				/* 复制失败也不再尝试 */
			}
			return "blocked";
		}, [inputActions, draftText]);

		/**
		 * 「禁用并告知」：既翻转持久化状态（列表里能一眼看到），
		 * 又把一条明确的指令注入输入框 —— 后者才是真正能约束 agent 的一步。
		 */
		const notify = react.useCallback(async (script) => {
			const next = !script.enabled;
			await toggle(script, next);
			const text = next
				? `该脚本已重新启用，可以正常使用：「${script.name}」（${script.file}）`
				: `请不要执行脚本「${script.name}」（${script.file}）：你已在脚本管理器中把它标记为禁用。如确有必要，先说明理由并等我确认。`;
			const how = notifyAgent(text);
			if (how === "blocked") {
				setError("输入框写入被拒绝，剪贴板也不可用 —— 请手动告知我这条指令");
				return;
			}
			// ★ 我正忙时绝不自动发送：那条消息会作为新输入打断正在执行的任务。
			// 指令已经放进草稿，等任务结束后按回车即可 —— 状态也已经落库了。
			if (agentBusy) {
				setNote("我正忙：指令已放进输入框但「未发送」，避免打断当前任务。等任务结束后按回车即可。");
				return;
			}
			// 自动发送：仅在真正写进输入框、且输入机空闲（plain）时提交。
			// 走剪贴板的情况不自动发送 —— 那时输入框里并没有这条指令。
			if (autoSend && how !== "clipboard" && inputActions
				&& typeof inputActions.submit === "function" && inputPhase === "plain") {
				try {
					inputActions.submit();
					setNote("");
				} catch (e) {
					setError("自动发送失败，请手动按回车发送");
				}
			} else if (how !== "clipboard") {
				setNote("指令已放进输入框，按回车发送给我即可。");
			}
		}, [toggle, notifyAgent, autoSend, inputActions, inputPhase, agentBusy]);

		/** 运行脚本 —— 走的是宿主的受控入口：禁用的会被拒绝并记审计。 */
		const runScript = react.useCallback(async (script) => {
			setRunState((s) => Object.assign({}, s, { [script.id]: { status: "running" } }));
			try {
				const data = await request("/run", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ id: script.id }),
				});
				setRunState((s) => Object.assign({}, s, { [script.id]: { status: "done", result: data } }));
			} catch (err) {
				const payload = err && err.payload;
				setRunState((s) => Object.assign({}, s, {
					[script.id]: {
						status: "done",
						result: (payload && payload.outcome)
							? payload
							: { outcome: "error", error: String((err && err.message) || err) },
					},
				}));
			}
		}, []);

		/** 打开 / 关闭审计视图。 */
		const toggleAudit = react.useCallback(async () => {
			if (audit !== null) {
				setAudit(null);
				return;
			}
			try {
				const data = await request("/audit?limit=50");
				setAudit(Array.isArray(data && data.entries) ? data.entries : []);
			} catch (err) {
				setAudit([]);
				setError(String((err && err.message) || err));
			}
		}, [audit]);

		/** 确认（接受当前版本）：记录哈希，清掉「新增 / 已修改」标记。 */
		const acknowledge = react.useCallback(async (ids) => {
			if (!Array.isArray(ids) || ids.length === 0) return;
			setBusy((b) => {
				const next = Object.assign({}, b);
				for (const id of ids) next[id] = true;
				return next;
			});
			try {
				await request("/ack", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ ids }),
				});
				await load();
			} catch (err) {
				setError(String((err && err.message) || err));
			} finally {
				setBusy((b) => {
					const next = Object.assign({}, b);
					for (const id of ids) next[id] = false;
					return next;
				});
			}
		}, [load]);

		const trigger = react.createElement(primitives.Button, {
			variant: "ghost",
			size: "sm",
			className: "dsh-sm-trigger",
			icon: scriptIcon(),
			title: "脚本管理",
			"aria-label": "脚本管理",
			"aria-expanded": open ? "true" : "false",
			onClick: () => setOpen((v) => !v),
		}, "脚本");

		const enabledCount = scripts.filter((s) => s.enabled).length;
		/** 新增或内容被改动过、还没确认的脚本数 */
		const pendingCount = scripts.filter((s) => s.isNew || s.changed).length;

		/** 渲染某个脚本的运行结果块（没有结果时返回 null）。 */
		const runResultNode = (script) => {
			const st = runState[script.id];
			if (!st) return null;
			if (st.status === "running") {
				return react.createElement("div", { className: "dsh-sm-result" }, "运行中…");
			}
			const r = st.result || {};
			const tone = r.outcome === "ok" ? "dsh-sm-t-ok"
				: (r.outcome === "denied" || r.outcome === "unsupported" ? "dsh-sm-t-warn" : "dsh-sm-t-fail");
			const label = ({
				ok: "成功", failed: "失败", timeout: "超时",
				denied: "已被拒绝", unsupported: "不支持直接运行", error: "出错",
			})[r.outcome] || String(r.outcome || "未知");
			return react.createElement("div", { className: "dsh-sm-result" },
				react.createElement("div", { className: "dsh-sm-result-head" },
					react.createElement("span", { className: tone }, "● " + label),
					typeof r.exitCode === "number" ? react.createElement("span", null, "退出码 " + r.exitCode) : null,
					typeof r.durationMs === "number" ? react.createElement("span", null, r.durationMs + " ms") : null,
					r.truncated ? react.createElement("span", { className: "dsh-sm-t-warn" }, "输出已截断") : null),
				r.error ? react.createElement("div", { className: tone }, String(r.error)) : null,
				r.stdout ? react.createElement("pre", { className: "dsh-sm-pre" }, String(r.stdout)) : null,
				r.stderr ? react.createElement("pre", { className: "dsh-sm-pre dsh-sm-t-fail" }, String(r.stderr)) : null);
		};

		let body;
		if (status === "loading") {
			body = react.createElement("div", { className: "dsh-sm-empty" }, "读取中…");
		} else if (status === "error") {
			body = react.createElement("div", { className: "dsh-sm-empty" }, "读取失败：" + error);
		} else if (scripts.length === 0) {
			body = react.createElement("div", { className: "dsh-sm-empty" },
				"没有发现脚本",
				react.createElement("div", { className: "dsh-sm-path" },
					directories.length ? directories.join("   |   ") : "（未配置脚本目录）"));
		} else {
			body = scripts.map((script) => react.createElement("div", { className: "dsh-sm-row", key: script.id },
				react.createElement("div", { className: "dsh-sm-meta" },
					react.createElement("div", { className: "dsh-sm-flags" },
						react.createElement("span", {
							className: "dsh-sm-badge" + (script.enabled ? "" : " dsh-sm-badge-off"),
						}, script.enabled ? "启用" : "已禁用"),
						script.isNew
							? react.createElement("span", { className: "dsh-sm-badge dsh-sm-badge-new" }, "新增")
							: null,
						script.changed
							? react.createElement("span", { className: "dsh-sm-badge dsh-sm-badge-mod" }, "已修改")
							: null),
					react.createElement("div", { className: "dsh-sm-name" }, script.name),
					react.createElement("div", { className: "dsh-sm-desc" },
						script.desc || "（脚本头部未写 @desc 说明）"),
					react.createElement("div", {
						className: "dsh-sm-path dsh-sm-path-click" + (copiedId === script.id ? " dsh-sm-copied" : ""),
						title: "点击复制完整路径",
						onClick: () => copyPath(script),
					}, copiedId === script.id ? "已复制 ✓" : script.file)),
				react.createElement("div", { className: "dsh-sm-actions" },
					react.createElement(primitives.Button, {
						// 受控运行入口：禁用的脚本点击后会被宿主拒绝，并在下方显示原因
						variant: "outline",
						size: "sm",
						className: "dsh-sm-rowbtn" + (script.enabled ? "" : " dsh-sm-t-warn"),
						disabled: !!(runState[script.id] && runState[script.id].status === "running"),
						title: script.enabled
							? "通过受控入口运行这个脚本，输出显示在下方"
							: "该脚本已禁用 —— 受控入口会拒绝执行；点一下可以看到拒绝理由",
						onClick: () => runScript(script),
					}, (runState[script.id] && runState[script.id].status === "running") ? "运行中…" : "运行"),
					(script.isNew || script.changed)
						? react.createElement(primitives.Button, {
							variant: "ghost",
							size: "sm",
							disabled: !!busy[script.id],
							title: "确认接受当前版本（记录哈希；之后再有改动会重新标记）",
							onClick: () => acknowledge([script.id]),
						}, "确认")
						: null,
					react.createElement(primitives.Button, {
						// 只用 outline：你的截图证明它渲染正常；primary 在本面板上下文里会渲染成
						// 一个比文字还小的小方块（读 primitives 的 Button.module.css 无法解释），
						// 所以不冒险用它，强调改由颜色表达。
						variant: "outline",
						size: "sm",
						className: "dsh-sm-rowbtn" + (script.enabled ? "" : " dsh-sm-rowbtn-off"),
						disabled: !!busy[script.id],
						// 忙碌时显示旋转指示：提示"点了也不会发送"
						icon: agentBusy ? spinnerIcon() : undefined,
						title: agentBusy
							? "我正在执行任务：点击只会把指令放进草稿，不会自动发送"
							: (script.enabled
								? "把「不要执行这个脚本」注入输入框，并标记为已禁用"
								: "把「该脚本已重新启用」注入输入框"),
						onClick: () => notify(script),
					}, script.enabled ? "禁用并告知" : "启用并告知")),
				runResultNode(script)));
		}

		// 审计视图：打开时覆盖脚本列表
		if (audit !== null) {
			body = audit.length === 0
				? react.createElement("div", { className: "dsh-sm-empty" }, "暂无审计记录")
				: audit.map((entry, index) => {
					const tone = entry.outcome === "ok" ? "dsh-sm-t-ok"
						: (entry.outcome === "denied" || entry.outcome === "unsupported" ? "dsh-sm-t-warn" : "dsh-sm-t-fail");
					const label = ({
						ok: "成功", failed: "失败", timeout: "超时",
						denied: "被拒绝", unsupported: "不支持", error: "出错",
					})[entry.outcome] || String(entry.outcome || "未知");
					const when = String(entry.at || "").replace("T", " ").slice(0, 19);
					return react.createElement("div", { className: "dsh-sm-audit-row", key: index },
						react.createElement("span", null,
							react.createElement("span", { className: tone }, label),
							" · " + (entry.name || entry.id || ""),
							entry.reason
								? react.createElement("span", { className: "dsh-sm-audit-meta" }, "（" + entry.reason + "）")
								: null),
						react.createElement("span", { className: "dsh-sm-audit-meta" },
							(typeof entry.exitCode === "number" ? "exit " + entry.exitCode + " · " : "")
							+ (typeof entry.durationMs === "number" ? entry.durationMs + "ms · " : "")
							+ when));
				});
		}

		const panel = open ? react.createElement("div", {
			className: "dsh-sm-panel",
			role: "dialog",
			"aria-label": "脚本管理",
			style: pos
				? { left: pos.left + "px", bottom: pos.bottom + "px" }
				: { visibility: "hidden", left: "12px", bottom: "12px" },
		},
			react.createElement("div", { className: "dsh-sm-head" },
				react.createElement("span", { className: "dsh-sm-title" }, audit !== null ? "运行审计" : "脚本管理"),
				react.createElement("span", { className: "dsh-sm-sub" },
					audit !== null
						? (audit.length + " 条记录（最新在前）")
						: (status === "ready"
							? (enabledCount + " / " + scripts.length + " 已启用"
								+ (pendingCount > 0 ? " · " + pendingCount + " 待确认" : ""))
							: ""))),
			body,
			note
				? react.createElement("div", { className: "dsh-sm-note" }, note)
				: null,
			react.createElement("div", { className: "dsh-sm-setting" },
				react.createElement("span", { className: "dsh-sm-setting-label" },
					"点击后自动发送（不用你按回车）"),
				react.createElement(primitives.Switch, {
					checked: !!autoSend,
					label: "点击后自动发送",
					onChange: (next) => rememberAutoSend(next),
				})),
			react.createElement("div", { className: "dsh-sm-foot" },
				react.createElement(primitives.Button, {
					variant: "ghost", size: "sm",
					title: audit !== null
						? "返回脚本列表"
						: "查看运行审计：谁在什么时候跑了什么，以及被拒绝的记录",
					onClick: () => toggleAudit(),
				}, audit !== null ? "返回" : "审计"),
				pendingCount > 0
					? react.createElement(primitives.Button, {
						variant: "outline", size: "sm",
						disabled: status === "loading",
						title: "接受全部脚本的当前版本",
						onClick: () => acknowledge(scripts.map((s) => s.id)),
					}, "全部确认")
					: null,
				react.createElement(primitives.Button, {
					variant: "outline", size: "sm",
					disabled: status === "loading",
					onClick: () => load(),
				}, "重新扫描"),
				react.createElement(primitives.Button, {
					variant: "ghost", size: "sm",
					onClick: () => setOpen(false),
				}, "关闭"))
		) : null;

		return react.createElement("span", { className: "dsh-sm-wrap", ref: wrapRef },
			trigger,
			notifyCount > 0
				? react.createElement("span", {
					className: "dsh-sm-dot",
					title: notifyCount + " 个脚本是新增或已修改，待确认",
				}, String(notifyCount))
				: null,
			open ? react.createElement("div", {
				className: "dsh-sm-backdrop",
				onClick: () => setOpen(false),
			}) : null,
			panel);
	}

	function apply(ctx) {
		ensureStyle();
		const register = () => ctx.slots.register({
			name: SLOT_KEY,
			id: "dsh-script-manager",
			order: 45,
			label: () => "脚本管理",
		}, ScriptManager);
		try {
			// inject 等待插槽被声明，避免与 conversation UI 的加载顺序竞争
			ctx.slots.inject(SLOT_KEY, register);
		} catch (err) {
			try { register(); } catch (e) { /* 插槽未声明：静默放弃，不影响 DSH 启动 */ }
		}
	}

	exports.name = name;
	exports.inject = inject;
	exports.apply = apply;
	return module.exports;
}});
