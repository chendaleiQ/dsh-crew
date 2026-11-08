/**
 * Routine：把一次真正跑通的活，固化成下次能直接照着走的「套路」。
 *
 * 这是「自进化」里唯一能长期攒下来的东西——记忆会过期，死路只是别踩，而 routine
 * 是**验证过的正确路径**。下一次同类任务，Bot 会在系统提示里看到它，少走弯路。
 *
 * 三条设计原则：
 * 1. **只记真跑过的**：步骤来自 tool/call 轨迹，不是模型复述。
 * 2. **草稿状态**：自动生成的一律标 `status: draft`，不冒充"已确认的最佳实践"。
 * 3. **验收跟着走**：把通过的验收条件一起记下来，下次重跑就知道怎么算成功。
 */

import { createHash } from "node:crypto"

/** 文件名 slug：尽量可读，实在不可读就用短哈希（中文任务名基本都是后者）。 */
export function routineSlug(task) {
  const text = String(task ?? "").trim()
  const ascii = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 40)
  if (ascii.length >= 4) return ascii
  return `routine-${createHash("sha1").update(text).digest("hex").slice(0, 8)}`
}

/** 一句话标题：任务的第一行，去掉多余空白。 */
export function routineTitle(task) {
  const line = String(task ?? "")
    .split("\n")
    .map((item) => item.trim())
    .find((item) => item !== "")
  const text = (line ?? "未命名套路").replace(/\s+/gu, " ")
  return text.length > 60 ? `${text.slice(0, 59)}…` : text
}

/** 轨迹 → 人类可读的步骤列表。 */
function stepsOf(trace) {
  if (trace === undefined || trace === null) return []
  return trace.calls.map((call, index) => {
    const target = call.target === "" ? "" : `：${call.target.replace(/\s+/gu, " ").slice(0, 160)}`
    return `${index + 1}. \`${call.name}\`${target}`
  })
}

/**
 * 生成一份 routine 草稿。
 *
 * @param {object} input
 * @param {string} input.task        这次让它做的事
 * @param {Array}  [input.acceptance] 验收条件（通过的会被记下来）
 * @param {string} [input.result]    这轮的结论
 * @param {object} [input.trace]     summariseTrace 的结果
 * @param {string} [input.botName]
 * @returns {{ slug: string, title: string, text: string, status: string }}
 */
export function buildRoutine({ task, acceptance = [], result = "", trace = null, botName = "" } = {}) {
  const title = routineTitle(task)
  const steps = stepsOf(trace)
  const now = new Date().toISOString()

  const lines = [
    `# ${title}`,
    "",
    `<!-- dsh-crew routine · status: draft · created: ${now}${botName === "" ? "" : ` · by: ${botName}`} -->`,
    "",
    "## 什么时候用",
    String(task ?? "").trim() || "（这次没有写清任务，下次用之前补上）",
    "",
  ]

  if (acceptance.length > 0) {
    lines.push("## 怎么算成功（这次真通过的验收）")
    for (const check of acceptance) lines.push(`- ${check.label ?? check.kind ?? "验收"}`)
    lines.push("")
  }

  if (steps.length > 0) {
    lines.push("## 跑通的步骤（按真实执行顺序，来自会话轨迹）", ...steps, "")
  } else {
    lines.push("## 跑通的步骤", "（这轮没有可用的工具轨迹）", "")
  }

  if (Array.isArray(trace?.touched) && trace.touched.length > 0) {
    lines.push("## 动过的文件")
    for (const file of trace.touched) lines.push(`- ${file}`)
    lines.push("")
  }

  if (String(result ?? "").trim() !== "") {
    lines.push("## 这轮的结论", String(result).trim().slice(0, 800), "")
  }

  lines.push(
    "## 注意",
    "- 这是**草稿**：自动从一次真实执行里抽出来的，还没经过人确认。",
    "- 重跑时如果目录结构或工具变了，先核对步骤再照做。",
    "- 走通了、并且你认可，就把状态改成 `status: confirmed`，以后可以当默认路径。",
  )

  return { slug: routineSlug(task), title, text: `${lines.join("\n")}\n`, status: "draft" }
}

/**
 * 从 routine 文件里读出「标题 / 状态 / 什么时候用」，用于注入系统提示。
 * 只认我们自己写的头部格式，认不出来就当草稿。
 */
export function parseRoutine(slug, text) {
  const source = String(text ?? "")
  const titleMatch = /^#\s+(.+)$/mu.exec(source)
  const statusMatch = /status:\s*([a-z]+)/iu.exec(source)
  const whenMatch = /##\s*什么时候用\s*\n+([^\n#]+)/u.exec(source)
  return {
    slug,
    title: titleMatch?.[1]?.trim() ?? slug,
    status: (statusMatch?.[1] ?? "draft").toLowerCase(),
    when: whenMatch?.[1]?.trim() ?? "",
  }
}
