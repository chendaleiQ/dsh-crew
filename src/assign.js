/**
 * 派活：把一个 Bot 的活变成一个真实的 DSH agent 会话。
 *
 * 形状是「先接单、后台干、状态落盘」：
 *
 *   start()  → 立刻返回 { taskId, sessionId, done }
 *               ├─ 把 composeBrief 的简报投进一个新会话（runTurn 负责跑）
 *               └─ 后台等它结束，把结果写进运行态 + 记忆
 *
 * 执行细节全在 turn.js 里，和目标循环共用一条路径——两种模式不该有两种脾气。
 */

import { randomUUID } from "node:crypto"

import { composeBrief, composeSystemPrompt } from "./persona.js"
import { effectiveTools } from "./registry.js"
import { buildRoutine } from "./routine.js"
import { traceWorthRecording } from "./trace.js"
import { runTurn } from "./turn.js"

export class CrewAssigner {
  /**
   * @param {object} options
   * @param {object} options.ctx       宿主插件上下文（要有 ctx.agents）
   * @param {import("./registry.js").BotRegistry} options.registry
   * @param {object} options.config    已解析的插件配置
   * @param {(line: string) => void} [options.log]
   * @param {(line: string) => void} [options.warn]
   * @param {number} [options.pollMs]  测试用，可把轮询间隔调小
   */
  constructor({ ctx, registry, config, gate = null, log = () => {}, warn = () => {}, pollMs = 1_000 }) {
    this.ctx = ctx
    this.registry = registry
    this.config = config
    this.log = log
    this.warn = warn
    this.pollMs = pollMs
    /** 与目标循环共用的并发闸门；没有就退回自己的计数（单测场景）。 */
    this.gate = gate
    /** 正在跑的派活：taskId -> { botId, sessionId, cancelled } */
    this.running = new Map()
  }

  /** 宿主没提供 agents 服务时明确报出来，而不是让面板一直转圈。 */
  available() {
    return typeof this.ctx?.agents?.create === "function"
  }

  get activeCount() {
    return this.running.size
  }

  /**
   * 接单：立刻返回任务 id，活交给后台。
   *
   * @returns {Promise<{ taskId: string, sessionId: string, done: Promise<object> }>}
   */
  async start({ botId, task, extra = "", onProgress = () => {} }) {
    if (!this.available()) throw new Error("宿主没有 agents 服务，无法派活")
    /**
     * 先同步占位，再做任何 await。
     *
     * 之前是「await 读档案 → 再占位」，两个请求几乎同时进来会都通过检查，
     * 于是并发上限形同虚设（双倍烧钱）。占位必须在第一个 await 之前完成；
     * 中途任何一步失败都要把额度还回去。
     */
    const taskId = randomUUID()
    if (this.gate !== null) this.gate.acquire(taskId)
    let released = false
    const release = () => {
      if (released) return
      released = true
      if (this.gate !== null) this.gate.release(taskId)
    }
    try {
      return await this.#startWithSlot({ botId, task, extra, onProgress, taskId, release })
    } catch (error) {
      release()
      throw error
    }
  }

  async #startWithSlot({ botId, task, extra, onProgress, taskId, release }) {

    const bot = await this.registry.read(botId)
    if (bot.fault) throw new Error(`这个 Bot 的档案是坏的：${bot.faultReason}`)
    if (bot.cwd === "") throw new Error("这个 Bot 没有工作目录，先在档案里给它一个 cwd")

    // 派活也会往记忆里追加结论；不压的话跑几十次同样会把记忆撑爆。
    try {
      await this.registry.compactMemory(bot.id, this.config.memoryLimits ?? {})
    } catch (error) {
      this.warn(`dsh-crew: 记忆压缩失败 ${String(error)}`)
    }
    const memory = await this.registry.readMemory(bot.id)
    const routines = await this.registry.listRoutines(bot.id).catch(() => [])
    // 身份走 system prompt，任务走用户消息：两边不重复。
    const system = composeSystemPrompt({ bot, memory, routines })
    const { brief } = composeBrief({ bot, memory, task, extra, includeIdentity: false })

    const sessionId = `crew-${bot.id}-${taskId.slice(0, 8)}`
    const entry = { botId: bot.id, sessionId, taskId, task, cancelled: false }

    await this.registry.patchState(bot.id, {
      state: "starting",
      taskId,
      sessionId,
      task,
      startedAt: new Date().toISOString(),
      endedAt: "",
      result: "",
      error: "",
    })
    this.running.set(taskId, entry)
    onProgress({ phase: "created", taskId, sessionId })

    const done = this.#run({ entry, bot, brief, system, memoryClipped: system.memoryClipped }).finally(() => {
      this.running.delete(taskId)
      release()
    })

    return { taskId, sessionId, done }
  }

  /** 后台跑完一件事，把结局落到运行态。 */
  async #run({ entry, bot, brief, system, memoryClipped }) {
    const { taskId, sessionId, task } = entry
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
      title: `${bot.name} · ${String(task ?? "").replace(/\s+/gu, " ").trim().slice(0, 24)}`,
      timeoutMs: this.config.taskTimeoutMs,
      pollMs: this.pollMs,
      shouldCancel: () => entry.cancelled,
      log: this.warn,
    })

    await this.registry.patchState(bot.id, {
      state: turn.state,
      endedAt: turn.endedAt,
      result: turn.result,
      error: turn.error,
      // 白名单没生效必须留在状态里：否则「我以为受限了其实没有」是最坏的情况。
      toolPolicy: turn.toolPolicy,
    })

    // 跑通了就把它固化成 routine：下次同类任务直接在系统提示里看到这条路径。
    if (turn.state === "done" && turn.result !== "" && this.config.recordRoutines !== false && traceWorthRecording(turn.trace)) {
      try {
        const routine = buildRoutine({ task, result: turn.result, trace: turn.trace, botName: bot.name })
        await this.registry.saveRoutine(bot.id, routine)
      } catch (error) {
        this.warn(`dsh-crew: 录制 routine 失败 ${String(error)}`)
      }
    }

    if (turn.result !== "") {
      // 记忆写入是本地小文件，直接 await：让「派活结束」这个事实包含记忆已落盘。
      try {
        await this.registry.appendMemory(bot.id, `做完「${String(task ?? "").slice(0, 60)}」，结论：\n${turn.result.slice(0, 600)}`)
      } catch (error) {
        this.warn(`dsh-crew: 写记忆失败 ${String(error)}`)
      }
    }

    this.log(`dsh-crew: ${bot.id} 派活结束 · ${turn.state}${memoryClipped ? " · 记忆已截断" : ""}`)
    return { taskId, sessionId, state: turn.state, result: turn.result, error: turn.error, toolPolicy: turn.toolPolicy }
  }

  /**
   * 给新建的会话挑模型。
   *
   * 优先级：这只 Bot 自己指定的 provider/model > 宿主当前的默认选择 > 插件配置。
   */
  #agentOptions(bot) {
    const selection = this.ctx?.get?.("agentDefaultModel")?.currentSelection?.() ?? null
    const provider = bot.provider || selection?.provider || this.config.provider || ""
    const model = bot.model || selection?.model || this.config.model || ""
    return provider !== "" && model !== "" ? { provider, model } : {}
  }

  /** 取消正在跑的一件活。取消是协作式的：只置标记，由等待循环去真正 abort。 */
  cancel(taskId) {
    const entry = this.running.get(taskId)
    if (entry === undefined) return false
    entry.cancelled = true
    return true
  }
}
