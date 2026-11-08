/**
 * CrewAssigner 的测试。
 *
 * 用假宿主（fake ctx.agents）把派活的四种结局走一遍——done / cancelled /
 * timeout / failed——因为真实宿主里这四种里三种都不好触发，而它们恰好是
 * 面板上最需要显示准确的三种。
 */

import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { CrewAssigner } from "../src/assign.js"
import { BotRegistry } from "../src/registry.js"

const CONFIG = { maxConcurrent: 2, taskTimeoutMs: 2_000 }

/** 假 agent：followup 后过 2 个 tick 变成 idle 并产出一条 assistant 消息。 */
function makeAgent({ script = "default", onCancel } = {}) {
  const events = []
  const agent = {
    status: "idle",
    cancelled: false,
    disposed: false,
    followupCalls: 0,
    session: { snapshotEvents: () => events },
    async followup(message) {
      agent.followupCalls += 1
      agent.status = "running"
      const text = message.content?.[0]?.text ?? ""
      if (script === "hang") return
      if (script === "throw") throw new Error("模型调用失败")
      setTimeout(() => {
        events.push({ type: "assistant/message", data: { message: { content: [{ type: "text", text: `收到：${text.slice(0, 12)}` }] } } })
        agent.status = "idle"
      }, 20)
    },
    async cancel(arg) {
      agent.cancelled = true
      onCancel?.(arg)
      agent.status = "idle"
    },
    async dispose() {
      agent.disposed = true
    },
  }
  return agent
}

function makeCtx({ scripts = [], restrictThrows = false } = {}) {
  const created = []
  const systemSections = []
  const restricted = []
  const guards = []
  let cursor = 0
  return {
    created,
    systemSections,
    restricted,
    guards,
    ctx: {
      agents: {
        async create(options) {
          // 真的调用 setup：工具白名单和身份注入都是在这里生效的，不调就等于没测。
          options.setup?.({
            systemPrompt: { section: (section) => systemSections.push(section) },
            tools: {
              restrict: (policy) => {
                if (restrictThrows) throw new Error("宿主拒绝 restrict")
                restricted.push(policy)
              },
              guard: (fn) => guards.push(fn),
            },
          })
          const script = scripts[cursor++]
          const agent = makeAgent({ script })
          created.push({ options, agent })
          return { agent, dispose: () => agent.dispose() }
        },
      },
    },
  }
}

async function withCrew(fn, options) {
  const dir = await mkdtemp(join(tmpdir(), "dsh-crew-assign-"))
  const registry = new BotRegistry(dir)
  await registry.save({ id: "writer", name: "小文", persona: "你写短句。", cwd: dir })
  try {
    return await fn({ registry, dir, ...options })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test("成功派活：会话建在 Bot 的 cwd，简报进了第一条消息，结果落盘并写进记忆", async () => {
  await withCrew(async ({ registry, dir }) => {
    const { ctx, created } = makeCtx()
    const assigner = new CrewAssigner({ ctx, registry, config: CONFIG, pollMs: 5 })
    const { taskId, sessionId, done } = await assigner.start({ botId: "writer", task: "写一句开头" })
    assert.match(taskId, /^[0-9a-f-]{36}$/)
    assert.match(sessionId, /^crew-writer-[0-9a-f]{8}$/)

    const outcome = await done
    assert.equal(outcome.state, "done")
    assert.match(outcome.result, /^收到：/)

    assert.equal(created.length, 1)
    assert.equal(created[0].options.sessionId, sessionId)
    assert.equal(created[0].options.meta.cwd, dir)
    assert.equal(created[0].options.meta.agentPreset, "standard")

    const state = await registry.readState()
    assert.equal(state.bots.writer.state, "done")
    assert.match(state.bots.writer.result, /^收到：/)
    assert.equal(created[0].agent.disposed, true, "跑完要释放 agent 句柄")

    const memory = await registry.readMemory("writer")
    assert.match(memory, /做完「写一句开头」/)
  })
})

test("没写工作目录的 Bot 不许派活", async () => {
  await withCrew(async ({ registry }) => {
    await registry.save({ id: "nowhere", name: "无家", cwd: "" })
    const { ctx } = makeCtx()
    const assigner = new CrewAssigner({ ctx, registry, config: CONFIG, pollMs: 5 })
    await assert.rejects(() => assigner.start({ botId: "nowhere", task: "随便" }), /没有工作目录/)
  })
})

test("超过并发上限直接拒，不会排队到天荒地老", async () => {
  await withCrew(async ({ registry }) => {
    const { ctx } = makeCtx({ scripts: ["hang", "hang"] })
    const assigner = new CrewAssigner({ ctx, registry, config: { ...CONFIG, maxConcurrent: 1 }, pollMs: 5 })
    const first = await assigner.start({ botId: "writer", task: "第一件" })
    assert.equal(assigner.activeCount, 1)
    await assert.rejects(() => assigner.start({ botId: "writer", task: "第二件" }), /并发已满/)
    await assigner.cancel(first.taskId)
    await first.done
  })
})

test("取消：置标记后由等待循环真正 abort，状态落成 cancelled", async () => {
  await withCrew(async ({ registry }) => {
    let cancelArg
    const { ctx } = makeCtx()
    ctx.agents.create = async (options) => {
      const agent = makeAgent({ script: "hang", onCancel: (arg) => (cancelArg = arg) })
      return { agent, dispose: () => agent.dispose() }
    }
    const assigner = new CrewAssigner({ ctx, registry, config: CONFIG, pollMs: 5 })
    const { taskId, done } = await assigner.start({ botId: "writer", task: "跑很久" })
    assert.equal(assigner.cancel(taskId), true)
    const outcome = await done
    assert.equal(outcome.state, "cancelled")
    assert.equal(cancelArg?.reason, "crew_cancelled")
    assert.equal((await registry.readState()).bots.writer.state, "cancelled")
    assert.equal(assigner.cancel("不存在的任务"), false)
  })
})

test("超时：取消 agent 并在运行态里说明原因", async () => {
  await withCrew(async ({ registry }) => {
    const { ctx } = makeCtx({ scripts: ["hang"] })
    const assigner = new CrewAssigner({ ctx, registry, config: { maxConcurrent: 2, taskTimeoutMs: 30 }, pollMs: 5 })
    const outcome = await (await assigner.start({ botId: "writer", task: "永不结束" })).done
    assert.equal(outcome.state, "timeout")
    assert.match(outcome.error, /秒没跑完/)
  })
})

test("建会话就炸：错误落盘，不抛给调用方，状态是 failed", async () => {
  await withCrew(async ({ registry }) => {
    const { ctx } = makeCtx({ scripts: ["throw"] })
    const assigner = new CrewAssigner({ ctx, registry, config: CONFIG, pollMs: 5 })
    const outcome = await (await assigner.start({ botId: "writer", task: "会失败" })).done
    assert.equal(outcome.state, "failed")
    assert.match(outcome.error, /模型调用失败/)
    const state = await registry.readState()
    assert.equal(state.bots.writer.state, "failed")
    assert.match(state.bots.writer.error, /模型调用失败/)
  })
})

test("跑完但没文本：判 empty 并带上事件线索，不许显示成完成", async () => {
  await withCrew(async ({ registry }) => {
    const events = []
    const { ctx } = makeCtx()
    ctx.agents.create = async () => {
      const agent = {
        status: "idle",
        async followup() {
          agent.status = "running"
          setTimeout(() => {
            events.push({ type: "session/error", error: { message: "HTTP 401 凭据无效" } })
            events.push({ type: "turn/end" })
            agent.status = "idle"
          }, 20)
        },
        session: { snapshotEvents: () => events },
        async dispose() {},
        async cancel() {},
      }
      return { agent, dispose: () => agent.dispose() }
    }
    const assigner = new CrewAssigner({ ctx, registry, config: CONFIG, pollMs: 5 })
    const outcome = await (await assigner.start({ botId: "writer", task: "随便说句" })).done
    assert.equal(outcome.state, "empty")
    assert.equal(outcome.result, "")
    assert.match(outcome.error, /没有产出文本/)
    assert.match(outcome.error, /401/)
    assert.equal((await registry.readState()).bots.writer.state, "empty")
  })
})

test("模型选择：Bot 自己的 > 宿主默认；没有默认就交空对象让宿主报错", async () => {
  await withCrew(async ({ registry, dir }) => {
    const { ctx, created } = makeCtx({ scripts: ["default", "default", "default"] })
    let selection = { provider: "host-provider", model: "host-model" }
    const renamed = []
    ctx.get = (name) => {
      if (name === "agentDefaultModel") return { currentSelection: () => selection }
      if (name === "sessionTitle") return { rename: (session, title) => renamed.push(title) }
      return undefined
    }
    const assigner = new CrewAssigner({ ctx, registry, config: CONFIG, pollMs: 5 })

    await (await assigner.start({ botId: "writer", task: "跟随默认" })).done
    assert.deepEqual(created[0].options.agentOptions, { provider: "host-provider", model: "host-model" })

    await registry.save({ id: "own", name: "自带模型", cwd: dir, provider: "my-p", model: "my-m" })
    await (await assigner.start({ botId: "own", task: "用自己的模型" })).done
    assert.deepEqual(created[1].options.agentOptions, { provider: "my-p", model: "my-m" })

    selection = null
    await (await assigner.start({ botId: "writer", task: "宿主没默认" })).done
    assert.deepEqual(created[2].options.agentOptions, {})

    assert.equal(renamed.length, 3)
    assert.match(renamed[0], /^小文 · /)
  })
})

test("身份走 system prompt，工具白名单真的下发给宿主（bash 不给）", async () => {
  await withCrew(async ({ registry }) => {
    const { ctx, systemSections, restricted } = makeCtx()
    const assigner = new CrewAssigner({ ctx, registry, config: CONFIG, pollMs: 5 })
    await (await assigner.start({ botId: "writer", task: "写一句" })).done

    assert.equal(systemSections.length, 1)
    assert.equal(systemSections[0].name, "dsh-crew:bot")
    assert.match(systemSections[0].text, /你是 小文/)
    assert.match(systemSections[0].text, /## 边界/)

    assert.equal(restricted.length, 1)
    const allow = restricted[0].allow
    assert.ok(allow.includes("read") && allow.includes("write"))
    assert.ok(!allow.includes("bash"), "没开 allowBash 就不许有 bash")
    assert.ok(!allow.includes("working_directory"), "内部工具不进 restrict（未知名字会让它整条失败）")
  })
})

test("guard 真的会拦：不在白名单的工具被挡，内部记账工具放行", async () => {
  await withCrew(async ({ registry }) => {
    const { ctx, guards, restricted } = makeCtx()
    const assigner = new CrewAssigner({ ctx, registry, config: CONFIG, pollMs: 5 })
    await (await assigner.start({ botId: "writer", task: "写一句" })).done

    assert.equal(guards.length, 1, "每轮都要装 guard")
    const guard = guards[0]
    assert.equal(guard({ name: "read" }), undefined, "白名单内的放行")
    assert.equal(guard({ name: "working_directory" }), undefined, "内部工具放行")
    assert.match(String(guard({ name: "bash" })), /不在这个 Bot 的白名单里/)
    // restrict 不该带上内部工具名：一个不存在的名字会让它整条失败。
    assert.ok(!restricted[0].allow.includes("todo_write"))
  })
})

test("跑通后录成 routine，下一次派活的系统提示里就能看到它", async () => {
  await withCrew(async ({ registry }) => {
    const events = []
    const sections = []
    const ctx = {
      agents: {
        async create(options) {
          options.setup?.({
            systemPrompt: { section: (section) => sections.push(section) },
            tools: { restrict: () => {}, guard: () => {} },
          })
          const agent = {
            status: "idle",
            session: { snapshotEvents: () => events },
            async followup() {
              agent.status = "running"
              // 模拟真实的轨迹形状
              events.push({ type: "tool/call", data: { name: "bash", arguments: JSON.stringify({ command: "npm test" }) } })
              events.push({ type: "tool/call", data: { name: "write", arguments: JSON.stringify({ file_path: "/tmp/out.md" }) } })
              events.push({ type: "assistant/message", data: { message: { content: [{ type: "text", text: "改好了，测试通过" }] } } })
              agent.status = "idle"
            },
            async cancel() {},
            async dispose() {},
          }
          return { agent, dispose: () => agent.dispose() }
        },
      },
    }
    const assigner = new CrewAssigner({ ctx, registry, config: CONFIG, pollMs: 5 })

    await (await assigner.start({ botId: "writer", task: "把首页改完" })).done
    const routines = await registry.listRoutines("writer")
    assert.equal(routines.length, 1, "跑通就该留下一条套路")
    assert.equal(routines[0].title, "把首页改完")
    const text = await registry.readRoutine("writer", routines[0].slug)
    assert.match(text, /`bash`：npm test/)
    assert.match(text, /`write`：\/tmp\/out\.md/)

    // 第二次派活：系统提示里应该已经带上这条套路
    events.length = 0
    sections.length = 0
    await (await assigner.start({ botId: "writer", task: "再改一遍" })).done
    assert.match(sections[0].text, /## 你验证过的套路/)
    assert.match(sections[0].text, /把首页改完（草稿，未确认）/)
  })
})

test("关掉 recordRoutines 就不录", async () => {
  await withCrew(async ({ registry }) => {
    const events = []
    const { ctx } = makeCtx()
    ctx.agents.create = async (options) => {
      options.setup?.({ systemPrompt: { section: () => {} }, tools: { restrict: () => {}, guard: () => {} } })
      const agent = {
        status: "idle",
        session: { snapshotEvents: () => events },
        async followup() {
          agent.status = "running"
          events.push({ type: "tool/call", data: { name: "write", arguments: JSON.stringify({ file_path: "/tmp/a" }) } })
          events.push({ type: "assistant/message", data: { message: { content: [{ type: "text", text: "好了" }] } } })
          agent.status = "idle"
        },
        async cancel() {},
        async dispose() {},
      }
      return { agent, dispose: () => agent.dispose() }
    }
    const assigner = new CrewAssigner({ ctx, registry, config: { ...CONFIG, recordRoutines: false }, pollMs: 5 })
    await (await assigner.start({ botId: "writer", task: "随便" })).done
    assert.deepEqual(await registry.listRoutines("writer"), [])
  })
})

test("白名单没生效要说出来，不许静默", async () => {
  await withCrew(async ({ registry }) => {
    const { ctx } = makeCtx({ restrictThrows: true })
    const assigner = new CrewAssigner({ ctx, registry, config: CONFIG, pollMs: 5 })
    const outcome = await (await assigner.start({ botId: "writer", task: "写一句" })).done
    assert.equal(outcome.state, "done")
    assert.match(outcome.toolPolicy.restrict, /^failed:/, "restrict 失败要如实记下来")
    assert.equal(outcome.toolPolicy.guard, "applied", "restrict 挂了不代表没防线：guard 还在")
    const state = await registry.readState()
    assert.match(state.bots.writer.toolPolicy.restrict, /^failed:/)
  })
})

test("宿主没有 agents 服务时，available() 是 false 且给出人话错误", async () => {
  await withCrew(async ({ registry }) => {
    const assigner = new CrewAssigner({ ctx: {}, registry, config: CONFIG, pollMs: 5 })
    assert.equal(assigner.available(), false)
    await assert.rejects(() => assigner.start({ botId: "writer", task: "x" }), /没有 agents 服务/)
  })
})
