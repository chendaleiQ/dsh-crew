/**
 * 一轮：把一段文字交给一个新会话，等它跑完，把结果拿回来。
 *
 * 派活（assign.js）和目标循环（expedition.js）共用这一个函数——这是刻意的：
 * 两种模式如果各写一套「建会话 / 投消息 / 等结束 / 取结果」，早晚会漂移成
 * 两种不同的脾气，而用户只应该感受到一种。
 *
 * 契约：不抛异常（除非参数本身不合法），一切结局都从返回值读：
 *   state: "done" | "empty" | "failed" | "timeout" | "cancelled"
 */

import { randomUUID } from "node:crypto"

import { summariseTrace } from "./trace.js"

/**
 * 白名单之外永远放行的宿主内部工具：它们不改数据，只做会话自身的记账。
 * 少了它们，Bot 会被"自己的白名单"卡死在第一步。
 */
const INTERNAL_TOOLS = ["working_directory", "todo_write"]

/** 把 unknown 压成一句人话，避免状态里出现 [object Object]。 */
function errText(error) {
  return error instanceof Error ? error.message : String(error)
}

/** 造一条「用户说的话」，形状与宿主内部一致。 */
export function userMessage(text) {
  return {
    id: `crew-${randomUUID()}`,
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "dsh-crew", form: "notice", summary: "Crew 派活简报" },
  }
}

/** 从后往前找最后一条 assistant 文本。 */
export function lastAssistantText(agent, sinceIndex = 0) {
  try {
    const events = agent?.session?.snapshotEvents?.() ?? []
    for (let index = events.length - 1; index >= sinceIndex; index -= 1) {
      const event = events[index]
      if (event?.type !== "assistant/message") continue
      const blocks = event.data?.message?.content ?? []
      const text = blocks
        .filter((block) => block?.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("\n")
        .trim()
      if (text !== "") return text
    }
  } catch {
    // 会话可能已经被拆掉，读不到就当没有结果。
  }
  return ""
}

/**
 * 本轮跑完但一个字都没产出时，尽量说清「为什么」。
 *
 * 真实形状（从会话日志核过）：turn/end 的 data.reason.kind === "error"。
 */
export function describeEmptyTurn(agent, sinceIndex = 0) {
  try {
    const events = (agent?.session?.snapshotEvents?.() ?? []).slice(sinceIndex)
    if (events.length === 0) return "这一轮没有任何事件，可能是会话没真正开始"
    const kinds = [...new Set(events.map((event) => String(event?.type ?? "?")))].slice(-6)
    const errors = events
      .map((event) => {
        if (event?.type === "turn/end" && event?.data?.reason?.kind === "error") {
          return String(event.data.reason.error?.message ?? "本轮以错误结束")
        }
        if (event?.type === "session/error" || event?.type === "error") {
          const raw = event?.error ?? event?.data?.error ?? event?.data?.message ?? event
          const message = typeof raw === "string" ? raw : raw?.message ?? ""
          return typeof message === "string" ? message : ""
        }
        return ""
      })
      .filter((text) => text !== "")
    const tail = kinds.length > 0 ? `最近事件：${kinds.join("、")}` : ""
    if (errors.length > 0) {
      const first = errors[0]
      if (/no provider\/model/i.test(first)) {
        return `本轮没有产出文本；这个会话没有拿到 provider/model——检查 profile 里的 agent-default-model，或给这只 Bot 在 bot.json 里填 provider/model。（${tail}）`
      }
      return `本轮没有产出文本；${first}（${tail}）`
    }
    return `本轮没有产出文本；${tail}`
  } catch {
    return "本轮没有产出文本，且读不到会话事件"
  }
}

/**
 * 跑一轮。
 *
 * @param {object} input
 * @param {object} input.ctx        宿主上下文，需有 ctx.agents
 * @param {string} input.sessionId  会话 id（自己生成，便于和工作关联）
 * @param {string} input.cwd        工作目录
 * @param {string} [input.preset]   agentPreset，默认 standard
 * @param {object} [input.agentOptions] provider/model
 * @param {string} input.text       投进去的那段话
 * @param {string} [input.title]    会话列表里的名字
 * @param {number} input.timeoutMs  一轮的最长等待
 * @param {number} [input.pollMs]   轮询间隔
 * @param {() => boolean} [input.shouldCancel]
 * @param {string} [input.systemText]   写进 system prompt 的身份与边界
 * @param {string[]} [input.allowTools] 工具白名单；空数组 = 不限制
 * @param {(line: string) => void} [input.log]
 */
export async function runTurn({
  ctx,
  sessionId,
  cwd,
  preset = "standard",
  agentOptions = {},
  text,
  title = "",
  timeoutMs,
  pollMs = 1_000,
  shouldCancel = () => false,
  systemText = "",
  allowTools = [],
  log = () => {},
}) {
  const startedAt = new Date().toISOString()
  if (typeof ctx?.agents?.create !== "function") {
    return { state: "failed", result: "", error: "宿主没有 agents 服务", sessionId, startedAt, endedAt: startedAt, toolPolicy }
  }

  let agent
  /** 这一轮实际调用了哪些工具——routine 录制靠它，不靠模型复述。 */
  let trace = null
  /** 记录「身份注入」和「工具白名单」到底有没有真的生效；失败要能被上层看到。 */
  const toolPolicy = { systemPrompt: "empty", restrict: "unrestricted", guard: "unrestricted" }
  try {
    const handle = await ctx.agents.create({
      sessionId,
      meta: { cwd, agentPreset: preset },
      agentOptions,
      /**
       * setup 是唯一能在会话发布前动「这一轮 agent 的配置」的地方：
       * 身份进 system prompt，工具白名单走 tools.restrict。
       * 任何一步挂了都要**说出来**——白名单静默失效比没有白名单更危险。
       */
      setup: (agentCtx) => {
        // 身份：写进 system prompt。成功要明确记 "applied"——不然「没报错」和「没做」分不清。
        if (systemText !== "") {
          if (typeof agentCtx?.systemPrompt?.section !== "function") {
            toolPolicy.systemPrompt = "unavailable: 宿主没有 systemPrompt.section"
          } else {
            try {
              agentCtx.systemPrompt.section({ name: "dsh-crew:bot", order: 26, text: systemText })
              toolPolicy.systemPrompt = "applied"
            } catch (error) {
              toolPolicy.systemPrompt = `failed: ${errText(error)}`
            }
          }
        } else {
          toolPolicy.systemPrompt = "empty"
        }

        if (Array.isArray(allowTools) && allowTools.length > 0) {
          // restrict 只收"白名单本身"的名字（它会对未知名字整条报错）；
          // 内部工具只在 guard 里放行，不让它们把 restrict 拖崩。
          const allowed = new Set(allowTools)
          const guardAllowed = new Set([...allowTools, ...INTERNAL_TOOLS])
          // 两道闸，各管一段：
          //   restrict 会校验名字是否在宿主的全局工具表里——薄 profile 上会整条失败（实测过）；
          //   guard 在调用时按名字拦，不依赖宿主认不认识这些名字，所以它才是真正的兜底。
          if (typeof agentCtx?.tools?.restrict !== "function") {
            toolPolicy.restrict = "unavailable"
          } else {
            try {
              agentCtx.tools.restrict({ allow: [...allowed] })
              toolPolicy.restrict = "applied"
            } catch (error) {
              toolPolicy.restrict = `failed: ${errText(error)}`
              log(`crew: tools.restrict 未生效 ${toolPolicy.restrict}`)
            }
          }
          if (typeof agentCtx?.tools?.guard !== "function") {
            toolPolicy.guard = "unavailable"
            log("crew: 宿主没有 tools.guard，工具白名单无法执行")
          } else {
            try {
              agentCtx.tools.guard((exec) => {
                const name = String(exec?.name ?? "")
                return guardAllowed.has(name) ? undefined : `Crew：工具 ${name} 不在这个 Bot 的白名单里`
              })
              toolPolicy.guard = "applied"
            } catch (error) {
              toolPolicy.guard = `failed: ${errText(error)}`
              log(`crew: tools.guard 未生效 ${toolPolicy.guard}`)
            }
          }
        } else {
          toolPolicy.restrict = "unrestricted"
          toolPolicy.guard = "unrestricted"
        }
      },
    })
    agent = handle?.agent
    if (agent === undefined) throw new Error("宿主没有返回 agent 句柄")

    if (title !== "") {
      try {
        ctx.get?.("sessionTitle")?.rename?.(agent.session, title)
      } catch {
        // 改不了名不影响干活。
      }
    }

    const eventsBefore = agent?.session?.snapshotEvents?.() ?? []
    const startIndex = eventsBefore.length
    await Promise.resolve(agent.followup(userMessage(text)))

    const outcome = await waitForIdle({ agent, timeoutMs, pollMs, shouldCancel })
    const endedAt = new Date().toISOString()

    if (outcome.state !== "done") {
      return { ...outcome, result: "", sessionId, startedAt, endedAt, toolPolicy, trace }
    }
    // 只取这一轮新增的事件算轨迹（会话可能被 resume 过，历史不算这次做的）。
    const eventsAfter = agent?.session?.snapshotEvents?.() ?? []
    trace = summariseTrace(eventsAfter.slice(startIndex))
    const result = lastAssistantText(agent, startIndex)
    if (result === "") {
      return { state: "empty", result: "", error: describeEmptyTurn(agent, startIndex), sessionId, startedAt, endedAt, toolPolicy, trace }
    }
    return { state: "done", result, error: "", sessionId, startedAt, endedAt, toolPolicy, trace }
  } catch (error) {
    const endedAt = new Date().toISOString()
    const message = error instanceof Error ? error.message : String(error)
    log(`crew turn failed: ${message}`)
    return { state: "failed", result: "", error: message, sessionId, startedAt, endedAt, toolPolicy }
  } finally {
    // 会话本体保留（随时能在列表里打开），只释放 agent 句柄。
    try {
      await Promise.resolve(agent?.dispose?.())
    } catch {
      /* 句柄可能已经被宿主拆掉了 */
    }
  }
}

/** 等 agent 从 running 回到 idle；超时与取消都在这里收口。 */
function waitForIdle({ agent, timeoutMs, pollMs, shouldCancel }) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve) => {
    const tick = () => {
      if (shouldCancel()) {
        void Promise.resolve(agent?.cancel?.({ kind: "user", reason: "crew_cancelled" })).catch(() => {})
        resolve({ state: "cancelled", error: "已取消" })
        return
      }
      if (Date.now() > deadline) {
        void Promise.resolve(agent?.cancel?.({ kind: "user", reason: "crew_timeout" })).catch(() => {})
        resolve({ state: "timeout", error: `超过 ${Math.round(timeoutMs / 1000)} 秒没跑完` })
        return
      }
      if (String(agent?.status ?? "") === "idle") {
        resolve({ state: "done", error: "" })
        return
      }
      setTimeout(tick, pollMs)
    }
    setTimeout(tick, pollMs)
  })
}
