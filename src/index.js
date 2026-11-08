/**
 * dsh-crew — 宿主侧入口。
 *
 * 职责边界（重要，别越界）：
 * - 这里只管「花名册」和「派活的账」：Bot 档案、运行态、收件箱条目。
 * - 真正干活的是 DSH 自己的 agent 会话，crew 不实现对话循环、不代理模型、
 *   不碰审批——审批永远由 DSH 弹给你。
 * - 每一处对外能力都走两条门：渲染侧拿 `dshCrew` 服务，或走宿主 web server
 *   上的 /crew/* 路由。两条门读到的是同一份磁盘状态（BotRegistry）。
 *
 * loader 行 id、package 名、本文件的 `name` 三者必须一致。
 */

import { BotRegistry, expandPath, normalizeBotId } from "./registry.js"
import { CrewAssigner } from "./assign.js"
import { Expedition } from "./expedition.js"
import { GoalStore } from "./goal.js"
import { Gate } from "./gate.js"
import { buildInbox, inboxSummary } from "./inbox.js"

export const name = "@chendaleiq/dsh-crew"

/**
 * 依赖的宿主服务：
 * - `agents`：派活要建真会话（ctx.agents.create / followup / status）。
 *   webServer 不在这里声明——它绑得比较晚，走 ctx.inject 懒等，避免启动竞态。
 */
export const inject = ["agents"]

const DEFAULTS = {
  enabled: true,
  dataDir: "",
  taskTimeoutMs: 900_000,
  maxConcurrent: 2,
  workspaceRoot: "",
  // 空 = 跟随宿主当前的默认模型（agent-default-model 的 currentSelection）。
  provider: "",
  model: "",
  // 跑通之后是否把路径录成 routine（草稿），下次同类任务直接注入系统提示
  recordRoutines: true,
  // 记忆压缩阈值：超了就归档旧条目（明细留 memory.archive.md，不丢）
  // 注入预算只有 3000 字（见 persona.js），阈值定在它 2 倍左右；超出的部分反正读不到。
  memoryMaxEntries: 30,
  memoryMaxChars: 6_000,
  memoryKeepRecent: 10,
}

/** 只接受与默认值同类型的覆盖，避免 YAML 里一个字符串把数字字段写坏。 */
function resolveConfig(raw) {
  const config = { ...DEFAULTS }
  if (raw === null || typeof raw !== "object") return config
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    const value = raw[key]
    if (value === undefined) continue
    if (typeof value !== typeof fallback) continue
    config[key] = value
  }
  config.dataDir = expandPath(config.dataDir, "")
  config.workspaceRoot = expandPath(config.workspaceRoot, "")
  config.maxConcurrent = Math.max(1, Math.min(4, Math.trunc(config.maxConcurrent) || 2))
  config.recordRoutines = config.recordRoutines !== false
  config.costPerRoundCny = Number.isFinite(config.costPerRoundCny) && config.costPerRoundCny > 0 ? config.costPerRoundCny : 0
  config.memoryLimits = {
    maxEntries: Math.max(5, Math.trunc(config.memoryMaxEntries) || 30),
    maxChars: Math.max(2_000, Math.trunc(config.memoryMaxChars) || 6_000),
    keepRecent: Math.max(3, Math.trunc(config.memoryKeepRecent) || 10),
  }
  return config
}

/** 读一个 JSON 请求体，超出上限直接拒。 */
function readBody(request, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on("data", (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error("请求体过大"))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on("end", () => {
      try {
        resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8")))
      } catch (error) {
        reject(error)
      }
    })
    request.on("error", reject)
  })
}

/** 统一 JSON 回包。 */
function answer(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  })
  response.end(body)
}

/**
 * 判断请求是不是「本机页面发来的」。
 *
 * 这套路由只服务于 DSH 自己的渲染进程，所以不额外发 token：宿主 web server
 * 只绑 loopback，且连接本身已经过宿主准入。这里再挡一层，拒掉带外站 Origin
 * 的请求，避免别的本地页面顺手改你的花名册。
 */
function fromOwnOrigin(request, server) {
  const origin = request.headers.origin
  if (typeof origin !== "string" || origin === "" || origin === "null") return true
  let own
  try {
    own = typeof server.getOrigin === "function" ? server.getOrigin() : undefined
  } catch {
    own = undefined
  }
  if (typeof own !== "string" || own === "") return true
  try {
    return new URL(origin).origin === new URL(own).origin
  } catch {
    return false
  }
}

export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig)
  if (!config.enabled) return

  const registry = new BotRegistry(config.dataDir)
  /** 派活与目标循环共用同一个并发配额（各自计数会让上限翻倍）。 */
  const gate = new Gate(config.maxConcurrent)
  const log = (message) => ctx.logger?.info?.(message)
  const warn = (message) => ctx.logger?.warn?.(message)

  /** 派活的执行者。宿主没给 agents 服务时它自己会说不可用，不让面板干等。 */
  const assigner = new CrewAssigner({ ctx, registry, config, gate, log, warn: warn ?? (() => {}) })
  /** 目标循环：自进化模式的引擎，和派活共用 turn.js 那条执行路径。 */
  const goals = new GoalStore(registry)
  const expedition = new Expedition({ ctx, registry, goals, config, gate, log, warn: warn ?? (() => {}) })

  /** 渲染侧与命令行共用的服务面：花名册 + 记忆 + 派活。 */
  const service = {
    version: 1,
    dataDir: registry.dataDir,
    listBots: () => registry.list(),
    readBot: (id) => registry.read(id),
    saveBot: (bot) => registry.save(bot),
    removeBot: (id) => registry.remove(normalizeBotId(id)),
    readMemory: (id) => registry.readMemory(id),
    appendMemory: (id, text) => registry.appendMemory(id, text),
    readState: () => registry.readState(),
    canAssign: () => assigner.available(),
    assign: (input) => assigner.start(input),
    cancel: (taskId) => assigner.cancel(taskId),
    readGoal: (botId) => goals.read(botId),
    createGoal: (input) => goals.create(input),
    saveGoal: (goal) => goals.save(goal),
    fireGoal: (botId, options) => expedition.start(botId, options),
    stopGoal: (botId) => expedition.stop(botId),
    goalStatus: (botId) => expedition.status(botId),
  }

  if (typeof ctx.effect === "function") {
    ctx.effect(() => ctx.provide("dshCrew", service), "dsh-crew: host service")
  }

  /**
   * 启动对账：上一次进程死掉时，state.json 里可能还留着 running/starting。
   * 不清理的话，面板会永远显示"在忙"，收件箱也不会报——等于静默丢了一件事。
   * 这里把它们标成 interrupted，交给人看。
   */
  const reconcile = async () => {
    try {
      const state = await registry.readState()
      const stale = Object.entries(state.bots ?? {}).filter(
        ([, entry]) => entry?.state === "running" || entry?.state === "starting",
      )
      if (stale.length === 0) return 0
      for (const [botId, entry] of stale) {
        state.bots[botId] = {
          ...entry,
          state: "interrupted",
          error: "上一次运行没走完就结束了（DSH 重启或崩溃）；这一轮的状态未知，重跑一次即可",
          endedAt: new Date().toISOString(),
        }
      }
      await registry.writeState(state)
      warn(`dsh-crew: 启动对账 · ${stale.length} 条残留运行态改判为 interrupted`)
      return stale.length
    } catch (error) {
      warn(`dsh-crew: 启动对账失败 ${error instanceof Error ? error.message : String(error)}`)
      return 0
    }
  }
  void reconcile()

  const mount = (hostCtx) => {
    const server = hostCtx.webServer
    if (server === undefined || typeof server.register !== "function") {
      warn("dsh-crew: 宿主没有可注册路由的 webServer，面板将无法读写花名册")
      return
    }

    const route = (path, handler) =>
      server.register({ kind: "exact", path, handler })

    const disposers = [
      route("/crew/bots", (request, response) => {
        if (!fromOwnOrigin(request, server)) return answer(response, 403, { ok: false, error: "跨站请求被拒" })
        void (async () => {
          try {
            if (request.method === "GET") {
              const [bots, state] = await Promise.all([registry.list(), registry.readState()])
              // 目标摘要：面板要显示「磨到第几轮、花了多少、卡在哪」，不能让面板自己再猜。
              const goalSummaries = {}
              for (const bot of bots) {
                try {
                  const goal = await goals.read(bot.id)
                  const routineCount = (await registry.listRoutines(bot.id).catch(() => [])).length
                  goalSummaries[bot.id] = {
                    objective: goal.objective,
                    status: goal.status,
                    note: goal.note,
                    rounds: goal.rounds.length,
                    lastOutcome: goal.rounds.at(-1)?.outcome ?? "",
                    deadEnds: goal.deadEnds.length,
                    acceptance: goal.acceptance.length,
                    budget: goal.budget,
                    running: expedition.status(bot.id).running,
                    runningRound: expedition.status(bot.id).round,
                    updatedAt: goal.updatedAt,
                    routines: routineCount,
                  }
                } catch {
                  // 没有目标或目标档坏了：不阻塞花名册。
                }
              }
              const inbox = buildInbox({ bots, runtime: state.bots ?? {}, goals: goalSummaries })
              answer(response, 200, {
                ok: true,
                dataDir: registry.dataDir,
                bots,
                state,
                goals: goalSummaries,
                inbox,
                inboxSummary: inboxSummary(inbox),
                gate: gate.snapshot(),
              })
              return
            }
            if (request.method === "POST" || request.method === "PUT") {
              const payload = await readBody(request)
              const bot = await registry.save(payload)
              answer(response, 200, { ok: true, bot })
              return
            }
            if (request.method === "DELETE") {
              const id = new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get("id") ?? ""
              await registry.remove(normalizeBotId(id))
              answer(response, 200, { ok: true })
              return
            }
            answer(response, 405, { ok: false, error: "支持 GET / POST / DELETE" })
          } catch (error) {
            answer(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
          }
        })()
      }),
      route("/crew/memory", (request, response) => {
        if (!fromOwnOrigin(request, server)) return answer(response, 403, { ok: false, error: "跨站请求被拒" })
        void (async () => {
          try {
            if (request.method === "GET") {
              const id = new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get("id") ?? ""
              const text = await registry.readMemory(normalizeBotId(id))
              answer(response, 200, { ok: true, text })
              return
            }
            if (request.method === "POST") {
              const payload = await readBody(request)
              const ok = await registry.appendMemory(normalizeBotId(payload?.id), payload?.text)
              answer(response, 200, { ok })
              return
            }
            answer(response, 405, { ok: false, error: "支持 GET / POST" })
          } catch (error) {
            answer(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
          }
        })()
      }),
      route("/crew/routines", (request, response) => {
        if (!fromOwnOrigin(request, server)) return answer(response, 403, { ok: false, error: "跨站请求被拒" })
        void (async () => {
          try {
            if (request.method !== "GET") {
              answer(response, 405, { ok: false, error: "用 GET" })
              return
            }
            const params = new URL(request.url ?? "/", "http://127.0.0.1").searchParams
            const botId = normalizeBotId(params.get("id") ?? "")
            const slug = params.get("slug")
            if (slug !== null && slug !== "") {
              const text = await registry.readRoutine(botId, slug)
              answer(response, 200, { ok: true, text })
              return
            }
            answer(response, 200, { ok: true, routines: await registry.listRoutines(botId) })
          } catch (error) {
            answer(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
          }
        })()
      }),
      route("/crew/memory/compact", (request, response) => {
        if (!fromOwnOrigin(request, server)) return answer(response, 403, { ok: false, error: "跨站请求被拒" })
        void (async () => {
          try {
            if (request.method !== "POST") {
              answer(response, 405, { ok: false, error: "用 POST" })
              return
            }
            const payload = await readBody(request)
            const outcome = await registry.compactMemory(normalizeBotId(payload?.botId), config.memoryLimits)
            answer(response, 200, { ok: true, ...outcome })
          } catch (error) {
            answer(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
          }
        })()
      }),
      route("/crew/assign", (request, response) => {
        if (!fromOwnOrigin(request, server)) return answer(response, 403, { ok: false, error: "跨站请求被拒" })
        void (async () => {
          try {
            if (request.method !== "POST") {
              answer(response, 405, { ok: false, error: "用 POST" })
              return
            }
            const payload = await readBody(request)
            const botId = typeof payload?.botId === "string" ? payload.botId : ""
            const task = typeof payload?.task === "string" ? payload.task : ""
            if (botId === "" || task.trim() === "") {
              answer(response, 400, { ok: false, error: "要给 botId 和 task" })
              return
            }
            // 接单即回：真正的跑动在后台，面板靠读状态看进展。
            const accepted = await assigner.start({
              botId,
              task,
              extra: typeof payload?.extra === "string" ? payload.extra : "",
            })
            accepted.done?.catch?.(() => {})
            answer(response, 202, { ok: true, taskId: accepted.taskId, sessionId: accepted.sessionId })
          } catch (error) {
            answer(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
          }
        })()
      }),
      route("/crew/goal", (request, response) => {
        if (!fromOwnOrigin(request, server)) return answer(response, 403, { ok: false, error: "跨站请求被拒" })
        void (async () => {
          try {
            if (request.method === "GET") {
              const botId = new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get("id") ?? ""
              const goal = await goals.read(normalizeBotId(botId))
              answer(response, 200, { ok: true, goal })
              return
            }
            if (request.method === "POST") {
              const payload = await readBody(request)
              // 循环正在跑的时候不许改目标：改完会被循环的下一轮 save 冲掉，白改。
              const target = normalizeBotId(payload?.botId)
              if (expedition.status(target).running) {
                answer(response, 409, { ok: false, error: "这个 Bot 正在磨目标，先停掉再改目标（否则改动会被循环覆盖）" })
                return
              }
              const goal = await goals.create({
                botId: payload?.botId,
                objective: payload?.objective,
                acceptance: payload?.acceptance,
                constraints: payload?.constraints,
                budget: payload?.budget,
              })
              answer(response, 200, { ok: true, goal })
              return
            }
            answer(response, 405, { ok: false, error: "支持 GET / POST" })
          } catch (error) {
            answer(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
          }
        })()
      }),
      route("/crew/goal/fire", (request, response) => {
        if (!fromOwnOrigin(request, server)) return answer(response, 403, { ok: false, error: "跨站请求被拒" })
        void (async () => {
          try {
            if (request.method !== "POST") {
              answer(response, 405, { ok: false, error: "用 POST" })
              return
            }
            const payload = await readBody(request)
            const maxRounds = Number(payload?.maxRounds) > 0 ? Math.min(100, Math.trunc(Number(payload.maxRounds))) : 20
            const fired = await expedition.start(normalizeBotId(payload?.botId), { maxRounds })
            fired.done?.catch?.(() => {})
            answer(response, 202, { ok: true, maxRounds })
          } catch (error) {
            answer(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
          }
        })()
      }),
      route("/crew/goal/stop", (request, response) => {
        if (!fromOwnOrigin(request, server)) return answer(response, 403, { ok: false, error: "跨站请求被拒" })
        void (async () => {
          try {
            if (request.method !== "POST") {
              answer(response, 405, { ok: false, error: "用 POST" })
              return
            }
            const payload = await readBody(request)
            const stopped = expedition.stop(normalizeBotId(payload?.botId))
            answer(response, stopped ? 200 : 404, { ok: stopped })
          } catch (error) {
            answer(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
          }
        })()
      }),
      route("/crew/cancel", (request, response) => {
        if (!fromOwnOrigin(request, server)) return answer(response, 403, { ok: false, error: "跨站请求被拒" })
        void (async () => {
          try {
            if (request.method !== "POST") {
              answer(response, 405, { ok: false, error: "用 POST" })
              return
            }
            const payload = await readBody(request)
            const taskId = typeof payload?.taskId === "string" ? payload.taskId : ""
            const cancelled = assigner.cancel(taskId)
            answer(response, cancelled ? 200 : 404, { ok: cancelled })
          } catch (error) {
            answer(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
          }
        })()
      }),
    ]

    hostCtx.effect(() => () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* 路由表本来就要拆了 */
        }
      }
    }, "dsh-crew: routes")

    log(`dsh-crew: 花名册就绪 · data=${registry.dataDir} · 并发上限=${config.maxConcurrent}`)
  }

  if (typeof ctx.inject !== "function") {
    mount(ctx)
    return
  }
  ctx.inject(["webServer"], (hostCtx) => {
    try {
      mount(hostCtx)
    } catch (error) {
      warn(`dsh-crew: 挂载失败 ${error instanceof Error ? error.message : String(error)}`)
    }
  })
}
