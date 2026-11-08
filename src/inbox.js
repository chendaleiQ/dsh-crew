/**
 * 收件箱：把「现在需要你这个人的事」从一堆 Bot 的状态里拎出来。
 *
 * 为什么单独一层而不是面板里现算：
 * - 这是唯一你每天真正要看的清单，口径必须稳、必须可测；
 * - 「什么算需要你」是一条产品判断（不是一个渲染细节）：失败要你看、空产出要你看、
 *   目标只剩人要验、目标被你叫停——这些都不能悄悄躺在某张卡片里。
 *
 * 铁律：**宁可多报一条，也不许漏报一条。** 漏报 = 你以为没事，实际上它在等你到明天。
 */

/** 任务类结局里，需要人看一眼的那些。done 不算，cancelled 也不算（那是你主动停的）。 */
const TASK_NEEDS_YOU = new Set(["failed", "empty", "timeout"])

/** 目标类状态里，需要人的那些。 */
const GOAL_NEEDS_YOU = new Set(["needs-human"])

/** 目标停下来的两种情况，属于「知会你一声」而不是「等着你救」。 */
const GOAL_NOTICE = new Set(["stopped"])

function timeOf(value) {
  const stamp = Date.parse(typeof value === "string" ? value : "")
  return Number.isFinite(stamp) ? stamp : 0
}

/**
 * 从花名册 + 运行态 + 目标摘要里拼出收件箱。
 *
 * @param {object} input
 * @param {Array<object>} input.bots       花名册
 * @param {object} input.runtime           运行态 state.bots
 * @param {object} input.goals             目标摘要（index.js 里已经拼好的那份）
 * @returns {Array<{ botId: string, name: string, kind: string, level: "action"|"notice", title: string, detail: string, at: string, sessionId: string }>}
 */
export function buildInbox({ bots = [], runtime = {}, goals = {} } = {}) {
  const items = []
  for (const bot of bots) {
    const run = runtime?.[bot.id] ?? {}
    const goal = goals?.[bot.id]

    // 1) 派活失败 / 空产出 / 超时：这些「不成功」不能被当成完成。
    if (TASK_NEEDS_YOU.has(run.state)) {
      const label = run.state === "failed" ? "派活失败" : run.state === "empty" ? "本轮没有产出" : "派活超时"
      items.push({
        botId: bot.id,
        name: bot.name,
        kind: `task-${run.state}`,
        level: "action",
        title: `${bot.name}：${label}`,
        detail: String(run.error ?? "").trim() || String(run.task ?? "").trim(),
        at: run.endedAt ?? run.startedAt ?? "",
        sessionId: run.sessionId ?? "",
      })
    }

    if (goal === undefined) continue

    // 2) 目标只剩人能验、或超预算 → 真的在等你。
    if (GOAL_NEEDS_YOU.has(goal.status)) {
      items.push({
        botId: bot.id,
        name: bot.name,
        kind: "goal-needs-human",
        level: "action",
        title: `${bot.name}：目标等你介入`,
        detail: String(goal.note ?? "").trim() || String(goal.objective ?? "").trim(),
        at: goal.updatedAt ?? "",
        sessionId: "",
      })
    } else if (GOAL_NOTICE.has(goal.status)) {
      // 3) 目标被停下 → 知会，不催。
      items.push({
        botId: bot.id,
        name: bot.name,
        kind: "goal-stopped",
        level: "notice",
        title: `${bot.name}：目标已停`,
        detail: String(goal.note ?? "").trim() || `跑了 ${goal.rounds ?? 0} 轮后停下`,
        at: goal.updatedAt ?? "",
        sessionId: "",
      })
    }

    // 4) 目标还在磨，但它自己报「缺人」以外的信号：没有。运行中不打扰你。
  }

  // 要动手的排前面；同级按时间倒序（新的先看）。
  return items.sort((left, right) => {
    if (left.level !== right.level) return left.level === "action" ? -1 : 1
    return timeOf(right.at) - timeOf(left.at)
  })
}

/** 收件箱顶部的一句话摘要，面板直接显示。 */
export function inboxSummary(items) {
  const actions = items.filter((item) => item.level === "action").length
  const notices = items.length - actions
  if (actions === 0 && notices === 0) return "没有需要你的事"
  if (actions === 0) return `${notices} 条知会，不用动手`
  return `${actions} 件等你处理${notices > 0 ? `，另有 ${notices} 条知会` : ""}`
}
