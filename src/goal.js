/**
 * 目标态：自进化模式下，「一个目标」到底存了什么、什么时候该继续、什么时候该停。
 *
 * 这一层是整个模式的地基，也是唯一能防「它说自己做完了」的地方：
 * 目标带**机器可判定的验收条件**，而不带一句「已完成」的自我声明。
 *
 * 设计取舍：
 * - 一轮一行记账（rounds），不做聚合统计——聚合可以算出来，明细丢了就补不回来。
 * - 死路单独存（deadEnds），每轮开工前注入，避免反复撞墙。
 * - 停的条件写在代码里，不写在提示词里。模型可以建议停，但能不能停由这里说了算。
 */

import { execFile } from "node:child_process"
import { mkdir, readFile, writeFile, rename } from "node:fs/promises"
import { dirname, join } from "node:path"

import { expandPath, normalizeBotId } from "./registry.js"

/** 目标文件相对 Bot 目录的位置。 */
export const GOAL_FILE = "goal.json"

/**
 * 档案已经不存在了。
 *
 * 这不是"写失败"，而是"这件事已经没有归属了"——调用方（目标循环）应当据此
 * 干净地停下来，而不是当成一次 I/O 错误重试或崩掉。
 */
export class BotGoneError extends Error {
  constructor(botId) {
    super(`Bot ${botId} 的档案已被删除`)
    this.name = "BotGoneError"
    this.botId = botId
  }
}

/** 连续这么多轮没有实质进展就停：再跑也只是烧钱。 */
export const MAX_NO_PROGRESS = 3

/**
 * 目标里最多保留多少轮明细。
 *
 * 跑上百轮之后 rounds 会变成一份比目标本身还长的流水账：读一次几万字符，
 * 而 decide() 只关心最近几轮。所以只留最近 N 轮，更早的折成一条计数说明——
 * 折叠不是删除事实，是让它别再占据每一轮的读盘与注入体积。
 */
export const MAX_ROUNDS_KEPT = 200

export const GOAL_STATUS = ["active", "done", "stopped", "blocked", "needs-human"]

/** 一条验收：file（文件存在）/ command（命令成功）/ manual（只能人看）。 */
function normalizeCheck(raw) {
  if (!raw || typeof raw !== "object") return null
  const kind = raw.kind
  if (kind === "file") {
    const path = expandPath(raw.path ?? "")
    if (path === "") return null
    return { kind, path, label: raw.label ?? `文件存在：${path}`, nonEmpty: raw.nonEmpty !== false }
  }
  if (kind === "command") {
    const cmd = typeof raw.cmd === "string" ? raw.cmd.trim() : ""
    if (cmd === "") return null
    return { kind, cmd, label: raw.label ?? `命令成功：${cmd}`, timeoutMs: Number(raw.timeoutMs) > 0 ? Number(raw.timeoutMs) : 120_000 }
  }
  if (kind === "manual") {
    const hint = typeof raw.hint === "string" ? raw.hint.trim() : ""
    return { kind, hint, label: raw.label ?? `需要你看：${hint || "（没写清要看什么）"}` }
  }
  return null
}

/** 规模上限：验收条件太多等于每轮都要跑一大堆命令，把一轮拖成十分钟。 */
export const GOAL_LIMITS = { objectiveChars: 2_000, acceptance: 20, constraints: 20 }

/** 建一个空目标。真正的目标是用户给的，这里只保证形状完整。 */
export function emptyGoal({ botId, objective, acceptance = [], constraints = [], budget = {} } = {}) {
  const now = new Date().toISOString()
  const text = String(objective ?? "").trim()
  return {
    botId: normalizeBotId(botId),
    objective: text.length > GOAL_LIMITS.objectiveChars ? text.slice(0, GOAL_LIMITS.objectiveChars) : text,
    acceptance: (Array.isArray(acceptance) ? acceptance : []).slice(0, GOAL_LIMITS.acceptance).map(normalizeCheck).filter(Boolean),
    constraints: Array.isArray(constraints)
      ? constraints.map((item) => String(item).trim()).filter(Boolean).slice(0, GOAL_LIMITS.constraints)
      : [],
    status: "active",
    rounds: [],
    deadEnds: [],
    budget: {
      capCny: Number(budget.capCny) > 0 ? Number(budget.capCny) : 50,
      spentCny: 0,
      day: now.slice(0, 10),
    },
    createdAt: now,
    updatedAt: now,
    note: "",
  }
}

/** 读回来的目标一律过一遍规范化：坏字段降级，不让它把决策逻辑带歪。 */
export function normalizeGoal(raw, { botId } = {}) {
  if (!raw || typeof raw !== "object") throw new Error("goal.json 必须是对象")
  const base = emptyGoal({ botId: raw.botId ?? botId, objective: raw.objective })
  const rounds = Array.isArray(raw.rounds)
    ? raw.rounds
        .filter((round) => round && typeof round === "object")
        .map((round) => ({
          n: Number(round.n) || 0,
          sessionId: typeof round.sessionId === "string" ? round.sessionId : "",
          startedAt: typeof round.startedAt === "string" ? round.startedAt : "",
          endedAt: typeof round.endedAt === "string" ? round.endedAt : "",
          outcome: ["progress", "no-progress", "error", "done", "empty"].includes(round.outcome) ? round.outcome : "error",
          note: typeof round.note === "string" ? round.note : "",
          costCny: Number(round.costCny) > 0 ? Number(round.costCny) : 0,
        }))
    : []
  return {
    ...base,
    objective: String(raw.objective ?? "").trim(),
    acceptance: Array.isArray(raw.acceptance) ? raw.acceptance.map(normalizeCheck).filter(Boolean) : [],
    constraints: Array.isArray(raw.constraints) ? raw.constraints.map((item) => String(item).trim()).filter(Boolean) : [],
    status: GOAL_STATUS.includes(raw.status) ? raw.status : "active",
    rounds,
    roundsTrimmed: Number.isFinite(raw.roundsTrimmed) && raw.roundsTrimmed > 0 ? Math.trunc(raw.roundsTrimmed) : 0,
    deadEnds: Array.isArray(raw.deadEnds) ? raw.deadEnds.filter((item) => typeof item === "string" && item.trim() !== "") : [],
    budget: {
      capCny: Number(raw.budget?.capCny) > 0 ? Number(raw.budget.capCny) : base.budget.capCny,
      spentCny: Number(raw.budget?.spentCny) > 0 ? Number(raw.budget.spentCny) : 0,
      day: typeof raw.budget?.day === "string" ? raw.budget.day : base.budget.day,
    },
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : base.createdAt,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : base.updatedAt,
    note: typeof raw.note === "string" ? raw.note : "",
  }
}

/** 连续没有实质进展的轮数（从末尾往前数）。 */
export function consecutiveNoProgress(goal) {
  let count = 0
  for (let index = goal.rounds.length - 1; index >= 0; index -= 1) {
    const round = goal.rounds[index]
    if (round.outcome === "no-progress" || round.outcome === "error" || round.outcome === "empty") count += 1
    else break
  }
  return count
}

/** 当日预算：跨天自动清零（不回头看昨天花了多少）。 */
export function rollDay(goal, today = new Date().toISOString().slice(0, 10)) {
  if (goal.budget.day === today) return goal
  return { ...goal, budget: { ...goal.budget, day: today, spentCny: 0 } }
}

/**
 * 该继续、该收工、还是该叫醒人。
 *
 * 顺序很重要：先看人给的状态（他叫停就必须停），再看验收（真的做到了就不许再跑），
 * 然后才是"跑不动了"和"钱不够了"。这样任何一条都不会被别的规则盖掉。
 *
 * @returns {{ action: "continue"|"done"|"stop"|"need-human", reason: string }}
 */
export function decide(goal, { maxNoProgress = MAX_NO_PROGRESS } = {}) {
  if (goal.objective === "") return { action: "stop", reason: "目标是空的，没什么可做" }
  if (goal.status === "done") return { action: "done", reason: "目标已标记完成" }
  if (goal.status === "stopped") return { action: "stop", reason: "你叫停了这个目标" }
  if (goal.status === "blocked") return { action: "stop", reason: `已被标记卡住：${goal.note || "未写原因"}` }
  if (goal.status === "needs-human") return { action: "need-human", reason: goal.note || "需要你介入" }

  // 没有验收条件的目标根本不许开跑：否则「做到」只能靠模型自称，那正是这个模式要防的。
  if (goal.acceptance.length === 0) {
    return { action: "need-human", reason: "这个目标没有验收条件，我无法判断做到没有" }
  }

  const streak = consecutiveNoProgress(goal)
  if (streak >= maxNoProgress) {
    return { action: "stop", reason: `连续 ${streak} 轮没有实质进展，停下来让你看` }
  }

  if (goal.budget.capCny > 0 && goal.budget.spentCny >= goal.budget.capCny) {
    return { action: "need-human", reason: `今天已花 ¥${goal.budget.spentCny.toFixed(2)}，到上限 ¥${goal.budget.capCny}，要不要继续` }
  }

  return { action: "continue", reason: `第 ${goal.rounds.length + 1} 轮` }
}

/** 只跑一个验收命令，带超时；失败不抛，转成结果。 */
function runCommand(check, cwd) {
  return new Promise((resolve) => {
    execFile("/bin/sh", ["-c", check.cmd], { cwd, timeout: check.timeoutMs, maxBuffer: 512 * 1024 }, (error, stdout, stderr) => {
      if (error === null) {
        resolve({ label: check.label, ok: true, detail: String(stdout).trim().slice(0, 400) })
        return
      }
      const detail = String(stderr || error.message).trim().slice(0, 400)
      resolve({ label: check.label, ok: false, detail })
    })
  })
}

/**
 * 跑一遍全部验收条件。
 *
 * 注意 `manual` 永远返回 ok:false + manual:true：机器不能替人点头，
 * 所以「只有人能验的」在没有人工确认之前，目标就不算完成。
 */
export async function checkAcceptance(goal, { cwd = "", manualApproved = [] } = {}) {
  const checks = []
  // 手写的 goal.json 可能没走 normalizeGoal，这里再规范一遍：验收条件是最要命的一层，
  // 宁可这里宽容，也不要因为少一个字段就把「空文件」判成通过。
  for (const raw of goal.acceptance) {
    const check = normalizeCheck(raw)
    if (check === null) continue
    if (check.kind === "file") {
      try {
        const text = await readFile(check.path, "utf8")
        checks.push({ label: check.label, ok: !check.nonEmpty || text.trim() !== "", detail: check.path })
      } catch (error) {
        checks.push({ label: check.label, ok: false, detail: error instanceof Error ? error.message : String(error) })
      }
      continue
    }
    if (check.kind === "command") {
      checks.push(await runCommand(check, cwd === "" ? process.cwd() : cwd))
      continue
    }
    const approved = manualApproved.includes(check.hint) || manualApproved.includes(check.label)
    checks.push({ label: check.label, ok: approved, manual: true, detail: approved ? "你已确认" : `待你确认：${check.hint}` })
  }
  const blocking = checks.filter((check) => !check.ok)
  return {
    ok: blocking.length === 0,
    checks,
    manualPending: blocking.filter((check) => check.manual === true).map((check) => check.detail),
  }
}

/** 追一轮记账，并把「支出」并进当日预算；超过上限时折叠最老的明细。 */
export function recordRound(goal, round) {
  // 轮次编号必须全局单调：被折叠掉的老轮次也要算进来，否则折叠之后编号会撞回 201、202…
  // 编号一旦不单调，日志里「第几轮」就对不上，复盘时全是错位。
  const previousTotal = (goal.roundsTrimmed ?? 0) + goal.rounds.length
  const rounds = [...goal.rounds, { n: previousTotal + 1, ...round }]
  const cost = Number(round.costCny) > 0 ? Number(round.costCny) : 0
  const kept = rounds.length > MAX_ROUNDS_KEPT ? rounds.slice(rounds.length - MAX_ROUNDS_KEPT) : rounds
  const trimmed = (goal.roundsTrimmed ?? 0) + (rounds.length - kept.length)
  return rollDay({
    ...goal,
    rounds: kept,
    roundsTrimmed: trimmed,
    budget: { ...goal.budget, spentCny: goal.budget.spentCny + cost },
    updatedAt: new Date().toISOString(),
  })
}

/** 记一条死路：下一轮开工前会被注入，避免重复撞墙。 */
export function addDeadEnd(goal, note) {
  const text = String(note ?? "").trim()
  if (text === "") return goal
  return { ...goal, deadEnds: [...goal.deadEnds, text].slice(-30), updatedAt: new Date().toISOString() }
}

/** 目标的磁盘读写：一个 Bot 一个 goal.json，和它的档案、记忆放在一起。 */
export class GoalStore {
  constructor(registry) {
    this.registry = registry
  }

  file(botId) {
    return join(this.registry.botDir(botId), GOAL_FILE)
  }

  async read(botId) {
    const text = await readFile(this.file(botId), "utf8")
    try {
      return normalizeGoal(JSON.parse(text), { botId })
    } catch (error) {
      throw new Error(`goal.json 解析失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async exists(botId) {
    try {
      await readFile(this.file(botId), "utf8")
      return true
    } catch {
      return false
    }
  }

  async save(goal) {
    const target = this.file(goal.botId)
    // 先确认档案还在：目录被删掉后 mkdir 会把它重建出来，反而制造一个空壳 Bot。
    if (!(await this.registry.exists(goal.botId))) throw new BotGoneError(goal.botId)
    await mkdir(dirname(target), { recursive: true })
    const temp = `${target}.tmp-${process.pid}-${Date.now()}`
    await writeFile(temp, `${JSON.stringify(goal, null, 2)}\n`, "utf8")
    try {
      await rename(temp, target)
    } catch (error) {
      // 竞态：写完临时文件、rename 之前目录被删了。
      if (error?.code === "ENOENT") throw new BotGoneError(goal.botId)
      throw error
    }
    return goal
  }

  async create(input) {
    const goal = emptyGoal(input)
    if (goal.objective === "") throw new Error("建目标必须给一个 objective")
    return this.save(goal)
  }
}
