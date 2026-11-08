/**
 * 目标循环（自进化模式）：给它一个目标，它一轮一轮磨到达成为止。
 *
 * 和 Grok Bot 那种「云上常驻」的区别在诚实处：
 * - 每一轮都是**新开的干净会话**，只有磁盘上的目标、复盘、死路能带过去。
 *   这不是省事，是防「上下文越长越糊涂」——长跑的关键在于每轮都从一份
 *   写清楚的战报出发，而不是背着一整天的聊天记录。
 * - 每轮结束必须**跑验收**。没有验收条件的目标不许开工，也不许自称完成。
 * - 停的条件在 goal.js 的 decide() 里，不由模型说了算。
 *
 * 自进化的落点：失败写成「死路」（下一轮开工前注入）、跑通的流程沉淀进记忆、
 * 目标达成后整份 rounds 明细就是下次同类目标的参考。
 */

import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"

import { composeBrief, composeSystemPrompt } from "./persona.js"
import { effectiveTools } from "./registry.js"
import { buildRoutine } from "./routine.js"
import { traceShowsSuccess, traceWorthRecording } from "./trace.js"
import { BotGoneError, addDeadEnd, checkAcceptance, decide, recordRound, rollDay } from "./goal.js"
import { runTurn } from "./turn.js"

/** 两轮之间留一口气，别把宿主和模型接口打个不停。 */
const ROUND_GAP_MS = 1_500

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 通过率：用来判断「这一轮到底有没有往前挪」。 */
function passing(acceptance) {
  return acceptance.checks.filter((check) => check.ok === true).length
}

/**
 * 一轮的结局分类。
 *
 * 只有「机器验收的通过项真的变多」才算 progress——模型说自己有进展不算数。
 */
export function classify(turn, before, after) {
  if (turn.state !== "done") return "error"
  if (turn.result === "") return "empty"
  return passing(after) > passing(before) ? "progress" : "no-progress"
}

/** 给模型看的目标正文。 */
export function goalTaskText(goal) {
  const lines = [`目标：${goal.objective}`]
  if (goal.acceptance.length > 0) {
    lines.push("", "完成的标准（每一条都会被机器或人真正检查）：")
    for (const check of goal.acceptance) lines.push(`- ${check.label}`)
  }
  if (goal.constraints.length > 0) {
    lines.push("", "不许越过：")
    for (const constraint of goal.constraints) lines.push(`- ${constraint}`)
  }
  return lines.join("\n")
}

/** 这一轮的额外交代：死路、上一轮结论、这一轮该怎么打。 */
export function roundExtra(goal, round, acceptance) {
  const lines = []
  if (round > 1) {
    const last = goal.rounds.at(-1)
    if (last) {
      lines.push(`## 上一轮（第 ${last.n} 轮）${last.outcome}`, last.note === "" ? "（没留下结论）" : last.note)
    }
  }
  if (goal.deadEnds.length > 0) {
    lines.push("", "## 已经试过、确认走不通的路（别再试同样的）")
    for (const dead of goal.deadEnds.slice(-10)) lines.push(`- ${dead}`)
  }
  const failing = acceptance.checks.filter((check) => !check.ok)
  if (failing.length > 0) {
    lines.push("", "## 还没过的验收", ...failing.map((check) => `- ${check.label}${check.detail === "" ? "" : `（${check.detail}）`}`))
  }
  lines.push(
    "",
    `## 这是第 ${round} 轮，你要做的`,
    "- 挑**一件**最能推进目标的具体动作，直接做完，不要写计划书。",
    "- 做完自己跑一遍验收，没过就说清卡在哪里、下一步换什么招。",
    "- 需要我做决定或做我做不了的事（比如动用公开账号、花钱、碰物理世界），把问题一条条列出来，然后停下等我。",
  )
  return lines.join("\n")
}

export class Expedition {
  constructor({ ctx, registry, goals, config, gate = null, log = () => {}, warn = () => {}, pollMs = 1_000, gapMs = ROUND_GAP_MS }) {
    this.ctx = ctx
    this.registry = registry
    this.goals = goals
    this.config = config
    this.log = log
    this.warn = warn
    this.pollMs = pollMs
    this.gapMs = gapMs
    /** 与派活共用的并发闸门（一块跑，才不会把上限翻倍）。 */
    this.gate = gate
    /** botId -> { stop, round, state } */
    this.runs = new Map()
  }

  available() {
    return typeof this.ctx?.agents?.create === "function"
  }

  get activeCount() {
    return [...this.runs.values()].filter((run) => run.state === "running").length
  }

  status(botId) {
    const run = this.runs.get(botId)
    if (run === undefined) return { running: false, round: 0, state: "idle" }
    return { running: run.state === "running", round: run.round, state: run.state, stopReason: run.stopReason ?? "" }
  }

  /**
   * 点火。同样的 Bot 不会起两条循环——重复点火是烧钱最快的方式。
   *
   * @returns {Promise<{ accepted: boolean, reason?: string, done: Promise<object> }>}
   */
  async start(botId, { maxRounds = 20 } = {}) {
    if (!this.available()) throw new Error("宿主没有 agents 服务，无法跑目标")
    /**
     * 双开守卫必须同步生效：先登记，再 await 读文件。
     * 之前是「await 读完 → 再登记」，两次快速点火会都通过检查，然后并行烧钱。
     */
    if (this.status(botId).running) throw new Error("这个 Bot 已经在磨目标了")
    const run = { stop: false, round: 0, state: "running", stopReason: "" }
    this.runs.set(botId, run)
    let released = false
    const release = () => {
      if (released) return
      released = true
      if (this.gate !== null) this.gate.release(botId)
    }
    try {
      if (this.gate !== null) this.gate.acquire(botId)
      return await this.#startChecked(botId, { maxRounds, run, release })
    } catch (error) {
      if (this.runs.get(botId) === run) this.runs.delete(botId)
      release()
      throw error
    }
  }

  async #startChecked(botId, { maxRounds, run, release }) {

    const bot = await this.registry.read(botId)
    if (bot.cwd === "") throw new Error("这个 Bot 没有工作目录，目标无处落地")
    if (!existsSync(bot.cwd)) throw new Error(`工作目录不存在：${bot.cwd}`)
    if (!(await this.goals.exists(botId))) throw new Error("这个 Bot 还没有目标，先给它一个")

    const goal = rollDay(await this.goals.read(botId))
    if (goal.acceptance.length === 0) {
      throw new Error("目标没有验收条件，我无法判断做到没有——先补上验收再点火")
    }

    const done = this.#loop(botId, maxRounds, run).finally(() => {
      run.state = run.state === "running" ? "stopped" : run.state
      release()
    })
    return { accepted: true, done }
  }

  /** 叫停：当前这一轮会跑完，之后不再起新一轮。 */
  stop(botId) {
    const run = this.runs.get(botId)
    if (run === undefined) return false
    run.stop = true
    run.stopReason = "你叫停了"
    return true
  }

  async #loop(botId, maxRounds, run) {
    let goal = rollDay(await this.goals.read(botId))
    let bot = await this.registry.read(botId)

    /**
     * 收尾：**把所有停下来的事实写进目标状态**。
     *
     * 这一条曾经漏过：循环因为「轮次用尽」停下来了，但目标状态还是 active，
     * 于是收件箱里空空如也，人以为一切正常。停下来的原因必须落盘，否则
     * 「没有需要你的事」就是一句谎话。
     */
    /** 保存目标；档案被删就返回 false，让循环干净停下而不是崩掉。 */
    const saveGoal = async (next) => {
      try {
        await this.goals.save(next)
        return true
      } catch (error) {
        if (error instanceof BotGoneError || error?.name === "BotGoneError") return false
        throw error
      }
    }

    const finished = async (verdict) => {
      // exhausted（轮次用尽）也算 needs-human：它不是"结束了"，是"等你决定还加不加轮"。
      const status =
        verdict.action === "done"
          ? "done"
          : verdict.action === "need-human" || verdict.action === "exhausted"
            ? "needs-human"
            : "stopped"
      if (goal.status !== status || (verdict.reason !== "" && goal.note !== verdict.reason)) {
        goal = { ...goal, status, note: verdict.note ?? verdict.reason, updatedAt: new Date().toISOString() }
        if (!(await saveGoal(goal).catch(() => false))) {
          this.warn("dsh-crew: 收尾时档案已不在，跳过一次写入")
        }
      }
      run.state = status === "done" ? "done" : "stopped"
      run.stopReason = verdict.reason
      this.log(`dsh-crew: ${botId} 目标停止 · ${verdict.action} · ${verdict.reason}`)
      return { botId, action: verdict.action, reason: verdict.reason, rounds: goal.rounds.length }
    }

    for (let round = 1; round <= maxRounds; round += 1) {
      const verdict = decide(goal)
      if (verdict.action !== "continue") return await finished(verdict)
      if (run.stop) return await finished({ action: "stop", reason: run.stopReason || "你叫停了" })

      run.round = round
      /**
       * 每一轮都重新读一次档案：
       * - 档案被删了还继续跑，就是对着一个不存在的 Bot 烧钱，必须立刻停；
       * - 档案被改了（人格、目录、工具），下一轮要按新设定来，而不是沿用开跑时那份。
       */
      try {
        bot = await this.registry.read(botId)
      } catch {
        return await finished({ action: "stop", reason: "这只 Bot 的档案已被删除，停止磨目标" })
      }
      if (bot.fault) {
        return await finished({ action: "stop", reason: `档案读不出来，停止磨目标：${bot.faultReason}` })
      }
      const before = await checkAcceptance(goal, { cwd: bot.cwd })
      // 每轮开工前顺手压一次记忆：不压缩的话，第 50 轮还在读第 1 轮的流水账。
      try {
        const compacted = await this.registry.compactMemory(botId, this.config.memoryLimits ?? {})
        if (compacted.changed) this.log(`dsh-crew: ${botId} 记忆压缩 · ${compacted.summary}`)
      } catch (error) {
        this.warn(`dsh-crew: 记忆压缩失败 ${String(error)}`)
      }
      const memory = await this.registry.readMemory(botId)
      const routines = await this.registry.listRoutines(botId).catch(() => [])
      const system = composeSystemPrompt({ bot, memory, routines })
      const { brief } = composeBrief({
        bot,
        memory,
        task: goalTaskText(goal),
        extra: roundExtra(goal, round, before),
        includeIdentity: false,
      })

      const sessionId = `crew-${botId}-g${round}-${randomUUID().slice(0, 6)}`
      const turn = await runTurn({
        ctx: this.ctx,
        sessionId,
        cwd: bot.cwd,
        preset: bot.preset,
        agentOptions: this.#agentOptions(bot),
        text: brief,
        systemText: system.text,
        allowTools: effectiveTools(bot),
        writeRoot: bot.cwd,
        title: `${bot.name} · 第${round}轮`,
        timeoutMs: this.config.taskTimeoutMs,
        pollMs: this.pollMs,
        shouldCancel: () => run.stop,
        log: this.warn,
      })

      const after = await checkAcceptance(goal, { cwd: bot.cwd })
      const outcome = classify(turn, before, after)
      goal = recordRound(goal, {
        outcome,
        sessionId,
        startedAt: turn.startedAt,
        endedAt: turn.endedAt,
        note: firstLine(turn.result || turn.error),
        // 只有你配了单价才记钱；否则留 0，面板就不显示金额（不装作知道）。
        costCny: this.config.costPerRoundCny || 0,
      })
      // 有实质进展的轮次值得记下来：它证明了"这条路走得通"。
      if (
        (outcome === "progress" || after.ok) &&
        this.config.recordRoutines !== false &&
        traceWorthRecording(turn.trace) &&
        traceShowsSuccess(turn.trace)
      ) {
        try {
          const routine = buildRoutine({
            task: `${goal.objective}（第 ${round} 轮）`,
            acceptance: after.checks.filter((check) => check.ok === true),
            result: turn.result,
            trace: turn.trace,
            botName: bot.name,
          })
          await this.registry.saveRoutine(botId, routine)
        } catch (error) {
          this.warn(`dsh-crew: 录制 routine 失败 ${String(error)}`)
        }
      }

      if (outcome !== "progress") {
        goal = addDeadEnd(goal, `第 ${round} 轮：${firstLine(turn.error || turn.result) || "没有产出"}`)
      }

      // 机器验收全过 + 没有人待确认 → 真完成了。
      const machineOk = after.checks.filter((check) => check.manual !== true).every((check) => check.ok)
      if (after.ok) {
        goal = { ...goal, status: "done", note: "全部验收通过", updatedAt: new Date().toISOString() }
        if (!(await saveGoal(goal))) {
          return await finished({ action: "stop", reason: "验收通过，但档案已被删除，结果无处记录" })
        }
        return await finished({ action: "done", reason: "全部验收通过" })
      }
      if (machineOk && after.manualPending.length > 0) {
        goal = {
          ...goal,
          status: "needs-human",
          note: `机器能验的都过了，剩下要你：${after.manualPending.join("；")}`,
          updatedAt: new Date().toISOString(),
        }
        if (!(await saveGoal(goal))) {
          return await finished({ action: "stop", reason: "需要人介入，但档案已被删除" })
        }
        return await finished({ action: "need-human", reason: goal.note })
      }

      if (!(await saveGoal(goal))) {
        return await finished({ action: "stop", reason: "这只 Bot 的档案已被删除，停止磨目标" })
      }
      if (run.stop) return await finished({ action: "stop", reason: run.stopReason || "你叫停了" })
      await sleep(this.gapMs)
    }

    // 轮次用尽：交给人在「再加几轮」和「收工」之间拍板——它自己不许偷偷继续。
    run.state = "exhausted"
    run.stopReason = "轮次用尽"
    this.log(`dsh-crew: ${botId} 轮次用尽（${maxRounds}）`)
    return await finished({ action: "exhausted", reason: `轮次用尽（${maxRounds}），等你决定要不要再点火` })
  }

  #agentOptions(bot) {
    const selection = this.ctx?.get?.("agentDefaultModel")?.currentSelection?.() ?? null
    const provider = bot.provider || selection?.provider || this.config.provider || ""
    const model = bot.model || selection?.model || this.config.model || ""
    return provider !== "" && model !== "" ? { provider, model } : {}
  }
}

/** 取第一行非空文本，当结论摘要。 */
function firstLine(text) {
  const line = String(text ?? "")
    .split("\n")
    .map((item) => item.trim())
    .find((item) => item !== "")
  return line === undefined ? "" : line.slice(0, 180)
}
