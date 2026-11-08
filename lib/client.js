/**
 * dsh-crew — 渲染侧（Web 客户端）。
 *
 * 一个侧边栏入口 + 一个主面板：
 *   sidebar.panellist  id=dsh-crew  → 左边的图标
 *   main               key=dsh-crew → 面板本体（壳子按 id/key 配对）
 *
 * 三条铁律（都是踩过的坑）：
 * 1. 渲染进程里没有 Node API：一切磁盘操作都走宿主的 /crew/* 路由；
 * 2. 面板只信宿主的运行态，不在本地攒影子状态——刷新/重启后看到的必须一致；
 * 3. 任何失败都要显示出来（红条），不许静默转圈。
 */

window.__ModuleLoader__.load({
  id: "@chendaleiq/dsh-crew",
  factory(require) {
    const React = require("react")
    const h = React.createElement

    /** 必须与 package.json 的 version 一致；test/package.test.mjs 和 CI 都会挡。 */
    const VERSION = "0.1.1"

    /** apply 时把客户端 ctx 存这儿：组件里要用 ctx.get('uiWorkspace') 开会话。 */
    let hostCtx = null

    /** 轮询间隔：看得见在动，又不至于把宿主打满。 */
    const POLL_MS = 3000

    const STATE_LABEL = {
      running: "在忙",
      starting: "启动中",
      done: "已完成",
      empty: "空产出",
      failed: "失败",
      timeout: "超时",
      cancelled: "已取消",
      idle: "空闲",
    }

    /** 状态 → 颜色类名，配色用 DSH 自己的 token，别硬编码色值。 */
    const STATE_TONE = {
      running: "busy",
      starting: "busy",
      done: "good",
      empty: "warn",
      failed: "bad",
      timeout: "warn",
      cancelled: "muted",
      idle: "muted",
    }

    const CSS = `
.crew-panel{display:flex;flex-direction:column;gap:14px;padding:18px 20px 28px;height:100%;overflow:auto;font-size:13px}
.crew-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.crew-title{font-size:16px;font-weight:600}
.crew-sub{color:var(--dsw-alias-text-secondary,#8a8f98);font-size:11px;font-family:var(--dsw-font-mono,ui-monospace,monospace)}
.crew-spacer{flex:1}
.crew-btn{border:1px solid var(--dsw-alias-border-default,#3a3f46);background:var(--dsw-alias-bg-elevated,transparent);color:inherit;border-radius:8px;padding:5px 11px;font-size:12px;cursor:pointer;line-height:1.4}
.crew-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary,#4c8dff)}
.crew-btn:disabled{opacity:.45;cursor:not-allowed}
.crew-btn.primary{background:var(--dsw-alias-brand-primary,#4c8dff);border-color:transparent;color:#fff}
.crew-empty{padding:26px 4px;color:var(--dsw-alias-text-secondary,#8a8f98);line-height:1.8}
.crew-card{border:1px solid var(--dsw-alias-border-default,#3a3f46);border-radius:12px;padding:12px 13px;display:flex;flex-direction:column;gap:9px}
.crew-card.open{border-color:var(--dsw-alias-brand-primary,#4c8dff)}
.crew-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.crew-name{font-weight:600}
.crew-role{color:var(--dsw-alias-text-secondary,#8a8f98);font-size:12px}
.crew-pill{font-size:11px;padding:1px 8px;border-radius:999px;border:1px solid transparent;background:rgba(127,127,127,.16)}
.crew-pill.busy{color:#d9a300;background:rgba(217,163,0,.14)}
.crew-pill.good{color:#2f9e6a;background:rgba(47,158,106,.14)}
.crew-pill.warn{color:#c9741a;background:rgba(201,116,26,.14)}
.crew-pill.bad{color:#d94b4b;background:rgba(217,75,75,.14)}
.crew-pill.muted{color:var(--dsw-alias-text-secondary,#8a8f98)}
.crew-task{font-size:12px;color:var(--dsw-alias-text-secondary,#8a8f98);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.crew-out{white-space:pre-wrap;font-size:12px;line-height:1.65;max-height:220px;overflow:auto;background:rgba(127,127,127,.07);border-radius:8px;padding:9px 10px}
.crew-error{color:#d94b4b;font-size:12px;white-space:pre-wrap;line-height:1.6}
.crew-note{font-size:11px;color:var(--dsw-alias-text-secondary,#8a8f98);line-height:1.6}
.crew-input,.crew-area,.crew-select{width:100%;box-sizing:border-box;background:var(--dsw-alias-bg-elevated,rgba(127,127,127,.06));border:1px solid var(--dsw-alias-border-default,#3a3f46);border-radius:9px;color:inherit;padding:7px 9px;font-size:12px;font-family:inherit}
.crew-area{min-height:74px;resize:vertical;line-height:1.6}
.crew-field{display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--dsw-alias-text-secondary,#8a8f98)}
.crew-form{display:flex;flex-direction:column;gap:9px;border:1px dashed var(--dsw-alias-border-default,#3a3f46);border-radius:12px;padding:13px}
.crew-grid2{display:grid;grid-template-columns:1fr 1fr;gap:9px}
.crew-banner{font-size:12px;padding:8px 11px;border-radius:9px;background:rgba(217,75,75,.12);color:#d94b4b;white-space:pre-wrap}
.crew-inbox{border:1px solid var(--dsw-alias-border-default,#3a3f46);border-radius:12px;padding:11px 13px;display:flex;flex-direction:column;gap:8px}
.crew-inbox-head{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:600}
.crew-item{display:flex;flex-direction:column;gap:2px;padding:6px 0;border-top:1px solid rgba(127,127,127,.16)}
.crew-item:first-of-type{border-top:none}
.crew-item-title{font-size:12px;font-weight:600}
.crew-item.notice .crew-item-title{font-weight:400;color:var(--dsw-alias-text-secondary,#8a8f98)}
.crew-item-detail{font-size:11px;color:var(--dsw-alias-text-secondary,#8a8f98);white-space:pre-wrap;line-height:1.6}
.crew-banner.ok{background:rgba(47,158,106,.12);color:#2f9e6a}
`

    /** 同源相对路径，和宿主路由一一对应。 */
    async function call(path, body) {
      const response = await fetch(`/crew${path}`, {
        method: body === undefined ? "GET" : "POST",
        cache: "no-store",
        headers: body === undefined ? { accept: "application/json" } : { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || payload?.ok === false) {
        throw new Error(payload?.error || `HTTP ${response.status}`)
      }
      return payload
    }

    // DevTools 里的诊断口：看一眼版本、手动拉一次花名册，不用开面板。
    try {
      window.__DSH_CREW__ = {
        version: VERSION,
        listBots: () => call("/bots"),
      }
    } catch {
      /* 没有 window 的极端情况忽略 */
    }

    /** 侧边栏图标：三个头像点，和 Dot 的同心圆区分开。 */
    function CrewIcon(props) {
      const size = props?.size ?? 20
      const color = props?.active ? "var(--dsw-alias-brand-primary,#4c8dff)" : "currentColor"
      return h(
        "svg",
        { viewBox: "0 0 24 24", width: size, height: size, "aria-hidden": true, style: { display: "block", color } },
        h("circle", { cx: 8, cy: 9, r: 2.6, fill: "none", stroke: "currentColor", "stroke-width": 1.5 }),
        h("circle", { cx: 16, cy: 9, r: 2.6, fill: "none", stroke: "currentColor", "stroke-width": 1.5 }),
        h("path", { d: "M3.6 18.4c.7-2.6 2.4-4 4.4-4s3.7 1.4 4.4 4", fill: "none", stroke: "currentColor", "stroke-width": 1.5, "stroke-linecap": "round" }),
        h("path", { d: "M14.6 18.4c.4-1.6 1.4-2.6 2.6-2.6 1.2 0 2.2 1 2.6 2.6", fill: "none", stroke: "currentColor", "stroke-width": 1.5, "stroke-linecap": "round" }),
      )
    }

    /**
     * 预算文案。
     *
     * 只有「真花了钱」（spentCny > 0）才显示金额——否则一句「今日 ¥0.00 / ¥50」
     * 会让人以为账在算，其实根本没接上用量数据。没数据就说没数据。
     */
    function budgetText(goal) {
      const spent = Number(goal?.budget?.spentCny ?? 0)
      const cap = Number(goal?.budget?.capCny ?? 0)
      const head = `第 ${goal?.rounds ?? 0} 轮 · 死路 ${goal?.deadEnds ?? 0} 条${goal?.routines > 0 ? ` · 套路 ${goal.routines} 条` : ""}`
      if (spent > 0) return `${head} · 今日约 ¥${spent.toFixed(2)}/¥${cap.toFixed(0)}`
      return `${head} · 花费未接（会话日志无逐轮用量）`
    }

    /** 一个 Bot 的卡片：状态、上次产出/失败原因、派活入口。 */
    function BotCard({ bot, runtime, goal, onAssigned, onOpenSession, onGoalFire, onGoalStop, onEditGoal, busy }) {
      const [open, setOpen] = React.useState(false)
      const [task, setTask] = React.useState("")
      const state = runtime?.state ?? "idle"
      const running = state === "running" || state === "starting"

      const submit = async () => {
        const want = task.trim()
        if (want === "") return
        await onAssigned(bot.id, want)
        setTask("")
        setOpen(false)
      }

      return h(
        "div",
        { className: `crew-card${open ? " open" : ""}` },
        h(
          "div",
          { className: "crew-row" },
          h("span", { className: "crew-name" }, bot.name),
          bot.role === "" ? null : h("span", { className: "crew-role" }, bot.role),
          h("span", { className: `crew-pill ${STATE_TONE[state] ?? "muted"}` }, STATE_LABEL[state] ?? state),
          bot.fault ? h("span", { className: "crew-pill bad" }, "档案损坏") : null,
          h("span", { className: "crew-spacer" }),
          running && runtime?.taskId
            ? h("button", { type: "button", className: "crew-btn", onClick: () => onOpenSession(runtime.sessionId) }, "看进度")
            : null,
          runtime?.sessionId && !running
            ? h("button", { type: "button", className: "crew-btn", onClick: () => onOpenSession(runtime.sessionId) }, "打开会话")
            : null,
          h(
            "button",
            { type: "button", className: `crew-btn${open ? "" : " primary"}`, onClick: () => setOpen((v) => !v), disabled: running || bot.fault || busy },
            open ? "收起" : "派活",
          ),
        ),
        runtime?.task ? h("div", { className: "crew-task" }, `任务：${runtime.task}`) : null,
        runtime?.result ? h("div", { className: "crew-out" }, runtime.result) : null,
        runtime?.error ? h("div", { className: "crew-error" }, runtime.error) : null,
        bot.fault ? h("div", { className: "crew-error" }, bot.faultReason) : null,
        goal === undefined
          ? h(
              "div",
              { className: "crew-row" },
              h("span", { className: "crew-note" }, "还没有目标"),
              h("span", { className: "crew-spacer" }),
              h("button", { type: "button", className: "crew-btn", onClick: () => onEditGoal(bot.id), disabled: busy || bot.fault }, "设目标"),
            )
          : h(
              "div",
              { className: "crew-field" },
              h(
                "div",
                { className: "crew-row" },
                h("span", { className: "crew-pill " + (goal.status === "done" ? "good" : goal.status === "active" ? "busy" : "warn") },
                  goal.status === "done" ? "目标达成" : goal.status === "active" ? "磨目标中" : goal.status === "needs-human" ? "等你介入" : "已停"),
                h("span", { className: "crew-note" }, budgetText(goal)),
                h("span", { className: "crew-spacer" }),
                goal.running
                  ? h("button", { type: "button", className: "crew-btn", onClick: () => onGoalStop(bot.id), disabled: busy }, "停")
                  : h("button", { type: "button", className: "crew-btn primary", onClick: () => onGoalFire(bot.id), disabled: busy || bot.fault }, "磨目标"),
                h("button", { type: "button", className: "crew-btn", onClick: () => onEditGoal(bot.id), disabled: busy }, "改"),
              ),
              h("div", { className: "crew-task" }, `目标：${goal.objective}`),
              goal.note ? h("div", { className: "crew-note" }, goal.note) : null,
            ),
        open
          ? h(
              "div",
              { className: "crew-field" },
              h("textarea", {
                className: "crew-area",
                placeholder: `交给「${bot.name}」做什么？一句话说清要的结果。`,
                value: task,
                onChange: (event) => setTask(event.target.value),
              }),
              h(
                "div",
                { className: "crew-row" },
                h("span", { className: "crew-note" }, bot.cwd === "" ? "⚠ 这个 Bot 没有工作目录，派活会被拒" : bot.cwd),
                h("span", { className: "crew-spacer" }),
                h("button", { type: "button", className: "crew-btn primary", onClick: () => void submit(), disabled: busy || task.trim() === "" }, "派给这个 Bot"),
              ),
            )
          : null,
      )
    }

    /** 目标表单：目标 + 验收条件。验收是这个模式的命门，所以放在最显眼的位置。 */
    function GoalForm({ bot, onCreated, disabled }) {
      const [objective, setObjective] = React.useState("")
      const [checks, setChecks] = React.useState("")
      const [hints, setHints] = React.useState("")
      const ready = objective.trim() !== "" && checks.trim() !== ""

      const submit = async () => {
        if (!ready) return
        const acceptance = checks
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line !== "")
          .map((line) => {
            const index = line.indexOf(":")
            if (index < 0) return null
            const kind = line.slice(0, index).trim().toLowerCase()
            const value = line.slice(index + 1).trim()
            if (value === "") return null
            if (kind === "file") return { kind: "file", path: value }
            if (kind === "run") return { kind: "command", cmd: value }
            if (kind === "human") return { kind: "manual", hint: value }
            return null
          })
          .filter(Boolean)
        if (acceptance.length === 0) return
        await onCreated(bot.id, { objective: objective.trim(), acceptance })
        setObjective("")
        setChecks("")
        setHints("")
      }

      return h(
        "div",
        { className: "crew-form" },
        h("div", { className: "crew-row" }, h("b", null, `给「${bot.name}」一个目标`),
          h("span", { className: "crew-spacer" }),
          h("span", { className: "crew-note" }, "没有验收条件的目标不许开跑")),
        h("label", { className: "crew-field" }, "目标（要什么结果，不是做什么动作）",
          h("textarea", { className: "crew-area", value: objective, onChange: (event) => setObjective(event.target.value), placeholder: "把这一期视频的成片做出来，能过平台审核" })),
        h("label", { className: "crew-field" }, "验收条件，一行一条。file:路径 / run:命令 / human:要人看什么",
          h("textarea", { className: "crew-area", value: checks, onChange: (event) => setChecks(event.target.value), placeholder: "file:~/out/final.mp4\nrun:npm test\nhuman:听一遍音轨有没有破音" })),
        hints === "" ? null : h("div", { className: "crew-note" }, hints),
        h("div", { className: "crew-row" }, h("span", { className: "crew-spacer" }),
          h("button", { type: "button", className: "crew-btn primary", onClick: () => void submit(), disabled: disabled || !ready }, "存下目标")),
      )
    }

    /** 新建 Bot 的表单。字段刻意少：先把「能干活」跑通，细节去改 bot.json。 */
    function NewBotForm({ onCreated, disabled }) {
      const [form, setForm] = React.useState({ id: "", name: "", role: "", persona: "", cwd: "" })
      const set = (key) => (event) => setForm((prev) => ({ ...prev, [key]: event.target.value }))
      const ready = form.id.trim() !== "" && form.name.trim() !== "" && form.cwd.trim() !== ""
      const submit = async () => {
        if (!ready) return
        await onCreated({
          id: form.id.trim().toLowerCase(),
          name: form.name.trim(),
          role: form.role.trim(),
          persona: form.persona.trim(),
          cwd: form.cwd.trim(),
        })
        setForm({ id: "", name: "", role: "", persona: "", cwd: "" })
      }
      return h(
        "div",
        { className: "crew-form" },
        h("div", { className: "crew-row" }, h("b", null, "新建一个 Bot"),
          h("span", { className: "crew-spacer" }),
          h("span", { className: "crew-note" }, "id 用小写字母和连字符，决定目录名")),
        h(
          "div",
          { className: "crew-grid2" },
          h("label", { className: "crew-field" }, "id", h("input", { className: "crew-input", value: form.id, onChange: set("id"), placeholder: "writer" })),
          h("label", { className: "crew-field" }, "名字", h("input", { className: "crew-input", value: form.name, onChange: set("name"), placeholder: "小文" })),
          h("label", { className: "crew-field" }, "角色（可选）", h("input", { className: "crew-input", value: form.role, onChange: set("role"), placeholder: "口播稿" })),
          h("label", { className: "crew-field" }, "工作目录（必填）", h("input", { className: "crew-input", value: form.cwd, onChange: set("cwd"), placeholder: "~/Desktop/mine/cdq-creator" })),
        ),
        h("label", { className: "crew-field" }, "人格（它每次开工前都会读）",
          h("textarea", { className: "crew-area", value: form.persona, onChange: set("persona"), placeholder: "你写口语化中文，句子短，不用书面语。" })),
        h(
          "div",
          { className: "crew-row" },
          h("span", { className: "crew-spacer" }),
          h("button", { type: "button", className: "crew-btn primary", onClick: () => void submit(), disabled: !ready || disabled }, "建好"),
        ),
      )
    }

    function CrewPanel() {
      const [snapshot, setSnapshot] = React.useState(null)
      const [error, setError] = React.useState("")
      const [flash, setFlash] = React.useState("")
      const [busy, setBusy] = React.useState(false)
      const [creating, setCreating] = React.useState(false)
      const [goalFor, setGoalFor] = React.useState("")
      const alive = React.useRef(true)

      const refresh = React.useCallback(async () => {
        try {
          const payload = await call("/bots")
          if (!alive.current) return
          setSnapshot(payload)
          setError("")
        } catch (cause) {
          if (!alive.current) return
          setError(cause?.message ?? String(cause))
        }
      }, [])

      React.useEffect(() => {
        alive.current = true
        void refresh()
        // 面板不可见时不轮询：藏起来的标签页每 3 秒打一次宿主毫无意义，还费电。
        const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden"
        const timer = window.setInterval(() => {
          if (!hidden()) void refresh()
        }, POLL_MS)
        // 切回来立刻补一次，别让你盯着一张过期的卡片。
        const onVisible = () => {
          if (typeof document !== "undefined" && document.visibilityState === "visible") void refresh()
        }
        if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
          document.addEventListener("visibilitychange", onVisible)
        }
        return () => {
          alive.current = false
          window.clearInterval(timer)
          if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
            document.removeEventListener("visibilitychange", onVisible)
          }
        }
      }, [refresh])

      const withBusy = async (fn) => {
        setBusy(true)
        setFlash("")
        try {
          await fn()
        } catch (cause) {
          setError(cause?.message ?? String(cause))
        } finally {
          setBusy(false)
          void refresh()
        }
      }

      const onAssigned = async (botId, task) => {
        await withBusy(async () => {
          const accepted = await call("/assign", { botId, task })
          setFlash(`已交给 ${botId}（会话 ${accepted.sessionId}）`)
        })
      }

      const onGoalFire = async (botId) => {
        await withBusy(async () => {
          const fired = await call("/goal/fire", { botId, maxRounds: 20 })
          setFlash(`已点火：${botId} 最多 ${fired.maxRounds} 轮`)
        })
      }

      const onGoalStop = async (botId) => {
        await withBusy(async () => {
          await call("/goal/stop", { botId })
          setFlash(`${botId} 会在当前这一轮结束后停下`)
        })
      }

      const onGoalCreate = async (botId, goal) => {
        await withBusy(async () => {
          await call("/goal", { botId, ...goal })
          setFlash(`目标已存下：${botId}`)
          setGoalFor("")
        })
      }

      const onCreated = async (bot) => {
        await withBusy(async () => {
          await call("/bots", bot)
          setFlash(`已建好 ${bot.name}`)
          setCreating(false)
        })
      }

      const onOpenSession = (sessionId) => {
        if (sessionId === undefined || sessionId === "") return
        try {
          const workspace = hostCtx?.get?.("uiWorkspace")
          if (workspace !== undefined && typeof workspace.openSession === "function") {
            workspace.openSession(sessionId)
            return
          }
          setError("打不开会话：当前客户端没有 uiWorkspace 服务")
        } catch (cause) {
          setError(cause?.message ?? String(cause))
        }
      }

      const bots = snapshot?.bots ?? []
      const runtime = snapshot?.state?.bots ?? {}
      const goals = snapshot?.goals ?? {}

      return h(
        "div",
        { className: "crew-panel" },
        h("style", null, CSS),
        h(
          "div",
          { className: "crew-head" },
          h("span", { className: "crew-title" }, "Crew · 班组"),
          h("span", { className: "crew-sub" }, snapshot?.dataDir ?? ""),
          h("span", { className: "crew-spacer" }),
          h("button", { type: "button", className: "crew-btn", onClick: () => void refresh(), disabled: busy }, "刷新"),
          h("button", { type: "button", className: `crew-btn${creating ? "" : " primary"}`, onClick: () => setCreating((v) => !v) }, creating ? "收起" : "新建 Bot"),
        ),
        h(
          "div",
          { className: "crew-inbox" },
          h("div", { className: "crew-inbox-head" },
            h("span", null, "收件箱"),
            h("span", { className: "crew-note" }, snapshot?.inboxSummary ?? ""),
          ),
          (snapshot?.inbox ?? []).length === 0
            ? h("div", { className: "crew-note" }, "没有需要你的事。Bot 在忙就在忙，不用盯着。")
            : (snapshot?.inbox ?? []).map((item, index) =>
                h(
                  "div",
                  { key: `${item.kind}-${item.botId}-${index}`, className: `crew-item ${item.level}` },
                  h("span", { className: "crew-item-title" }, item.title),
                  item.detail ? h("span", { className: "crew-item-detail" }, item.detail) : null,
                  item.sessionId
                    ? h("span", { className: "crew-row" },
                        h("button", { type: "button", className: "crew-btn", onClick: () => onOpenSession(item.sessionId) }, "打开会话"),
                        h("span", { className: "crew-note" }, item.sessionId),
                      )
                    : null,
                ),
              ),
        ),
        error !== "" ? h("div", { className: "crew-banner" }, error) : null,
        flash !== "" ? h("div", { className: "crew-banner ok" }, flash) : null,
        creating ? h(NewBotForm, { onCreated, disabled: busy }) : null,
        goalFor !== ""
          ? h(GoalForm, {
              bot: bots.find((item) => item.id === goalFor) ?? { id: goalFor, name: goalFor },
              onCreated: onGoalCreate,
              disabled: busy,
            })
          : null,
        bots.length === 0
          ? h(
              "div",
              { className: "crew-empty" },
              "花名册还是空的。点右上角「新建 Bot」，给它名字、人格和一个工作目录；",
              h("br", null),
              "之后你只需要说一句话，它在自己的目录里干活，结果回到这张卡片上。",
            )
          : bots.map((bot) =>
              h(BotCard, {
                key: bot.id,
                bot,
                runtime: runtime[bot.id],
                goal: goals[bot.id],
                onAssigned,
                onOpenSession,
                onGoalFire,
                onGoalStop,
                onEditGoal: setGoalFor,
                busy,
              }),
            ),
        h(
          "div",
          { className: "crew-note" },
          "派活的会话是真实的 DSH 会话，能在会话列表里打开；审批照常由 DSH 弹给你，这里不代你点头。",
        ),
      )
    }

    return {
      name: "dsh-crew-client",
      inject: ["slots"],
      apply(ctx) {
        hostCtx = ctx
        /** 侧边栏图标。壳子按 id 与 main 的 key 配对，两者必须都是 dsh-crew。 */
        ctx.slots.inject("sidebar.panellist", () =>
          ctx.slots.register(
            {
              name: "sidebar.panellist",
              id: "dsh-crew",
              order: 30,
              label: () => "Crew",
            },
            CrewIcon,
          ),
        )
        ctx.slots.inject("main", () =>
          ctx.slots.register(
            {
              name: "main",
              key: "dsh-crew",
            },
            CrewPanel,
          ),
        )
        console.info("[dsh-crew] renderer half loaded")
      },
    }
  },
})
