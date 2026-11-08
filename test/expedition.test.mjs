/**
 * 目标循环测试。
 *
 * 用假宿主把四条真实会发生的路径走一遍：
 *   1. 一轮就把验收弄过 → done（而且不许再跑第二轮）
 *   2. 连着三轮没让验收变好 → stop（不许无限烧）
 *   3. 机器能验的都过了，只剩人要看 → needs-human（不许自称完成）
 *   4. 中途叫停 → 当前轮跑完就收手
 *
 * 这四条合起来，就是「它不能骗你」的全部机械保证。
 */

import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { Expedition, classify } from "../src/expedition.js"
import { Gate } from "../src/gate.js"
import { buildInbox } from "../src/inbox.js"
import { GoalStore } from "../src/goal.js"
import { BotRegistry } from "../src/registry.js"

const CONFIG = { maxConcurrent: 2, taskTimeoutMs: 5_000 }

/**
 * 假宿主：每轮 followup 时执行 script（第几轮从 0 数），然后回一条 assistant 消息。
 */
function makeCtx({ script = async () => {}, reply = "做了一点点" } = {}) {
  let round = 0
  const created = []
  const restricted = []
  const systemSections = []
  const ctx = {
    get: (name) => (name === "agentDefaultModel" ? { currentSelection: () => ({ provider: "p", model: "m" }) } : name === "sessionTitle" ? { rename: () => {} } : undefined),
    agents: {
      async create(options) {
        options.setup?.({
          systemPrompt: { section: (section) => systemSections.push(section) },
          tools: { restrict: (policy) => restricted.push(policy) },
        })
        const index = round++
        const events = []
        const agent = {
          status: "idle",
          session: { snapshotEvents: () => events },
          title: "",
          async followup() {
            agent.status = "running"
            await script({ index, options })
            events.push({ type: "assistant/message", data: { message: { content: [{ type: "text", text: reply }] } } })
            agent.status = "idle"
          },
          async cancel() {
            agent.status = "idle"
          },
          async dispose() {},
        }
        created.push({ options, agent })
        return { agent, dispose: () => agent.dispose() }
      },
    },
  }
  return { ctx, created, restricted, systemSections, rounds: () => round }
}

async function withGoal(fn, { acceptance, script, reply } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "crew-exp-"))
  const registry = new BotRegistry(dir)
  await registry.save({ id: "builder", name: "匠", cwd: dir, persona: "你只做能验收的事。" })
  const goals = new GoalStore(registry)
  await goals.create({
    botId: "builder",
    objective: "把 out.md 造出来",
    acceptance: acceptance ?? [{ kind: "file", path: join(dir, "out.md") }],
  })
  const { ctx, created, rounds, restricted, systemSections } = makeCtx({ script, reply })
  try {
    return await fn({ dir, registry, goals, ctx, created, rounds, restricted, systemSections })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test("一轮就过验收：立刻 done，不跑第二轮", async () => {
  await withGoal(
    async ({ dir, registry, goals, ctx, rounds }) => {
      const expedition = new Expedition({ ctx, registry, goals, config: CONFIG, pollMs: 5, gapMs: 5 })
      const { accepted, done } = await expedition.start("builder", { maxRounds: 10 })
      assert.equal(accepted, true)
      const result = await done
      assert.equal(result.action, "done")
      assert.equal(rounds(), 1, "验收过了就不许再跑")
      assert.equal(result.rounds, 1)

      const goal = await goals.read("builder")
      assert.equal(goal.status, "done")
      assert.equal(goal.rounds[0].outcome, "progress")
      assert.ok(await readFile(join(dir, "out.md"), "utf8"))
    },
    {
      script: async ({ options }) => {
        // 模拟「这轮真的把活干了」：在 Bot 的 cwd 里造出验收文件。
        await writeFile(join(options.meta.cwd, "out.md"), "done", "utf8")
      },
    },
  )
})

test("三轮都没让验收变好：停手，不死循环", async () => {
  await withGoal(async ({ registry, goals, ctx, rounds }) => {
    const expedition = new Expedition({ ctx, registry, goals, config: CONFIG, pollMs: 5, gapMs: 5 })
    const result = await (await expedition.start("builder", { maxRounds: 10 })).done
    assert.equal(result.action, "stop")
    assert.match(result.reason, /连续 3 轮没有实质进展/)
    assert.equal(rounds(), 3)
    const goal = await goals.read("builder")
    assert.equal(goal.deadEnds.length, 3, "每轮没进展都要留一条死路")
    assert.match(goal.deadEnds[0], /^第 1 轮：/)
  })
})

test("机器能验的都过了、只剩人要看：needs-human，不是 done", async () => {
  await withGoal(
    async ({ registry, goals, ctx }) => {
      const expedition = new Expedition({ ctx, registry, goals, config: CONFIG, pollMs: 5, gapMs: 5 })
      const result = await (await expedition.start("builder", { maxRounds: 5 })).done
      assert.equal(result.action, "need-human")
      assert.match(result.reason, /听一遍/)
      const goal = await goals.read("builder")
      assert.equal(goal.status, "needs-human")
    },
    {
      acceptance: [
        { kind: "command", cmd: "test -f marker.txt" },
        { kind: "manual", hint: "听一遍音轨有没有破音" },
      ],
      script: async ({ options }) => {
        await writeFile(join(options.meta.cwd, "marker.txt"), "x", "utf8")
      },
    },
  )
})

test("中途叫停：当前轮跑完后不再起新一轮", async () => {
  await withGoal(async ({ registry, goals, ctx, rounds }) => {
    const expedition = new Expedition({ ctx, registry, goals, config: CONFIG, pollMs: 5, gapMs: 5 })
    const { done } = await expedition.start("builder", { maxRounds: 10 })
    // 等第一轮起来再叫停。
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(expedition.stop("builder"), true)
    const result = await done
    assert.equal(result.action, "stop")
    assert.match(result.reason, /叫停/)
    assert.ok(rounds() <= 2, `叫停后不该继续跑，实际跑了 ${rounds()} 轮`)
    assert.equal(expedition.stop("another"), false)
  })
})

test("没目标 / 没验收条件 / 已经在跑：三种点火都拒掉", async () => {
  const dir = await mkdtemp(join(tmpdir(), "crew-exp-guard-"))
  const registry = new BotRegistry(dir)
  await registry.save({ id: "builder", name: "匠", cwd: dir })
  const goals = new GoalStore(registry)
  const { ctx } = makeCtx()
  const expedition = new Expedition({ ctx, registry, goals, config: CONFIG, pollMs: 5, gapMs: 5 })
  try {
    await assert.rejects(() => expedition.start("builder"), /还没有目标/)

    await goals.create({ botId: "builder", objective: "做点什么" })
    await assert.rejects(() => expedition.start("builder"), /没有验收条件/)

    await goals.create({ botId: "builder", objective: "做点什么", acceptance: [{ kind: "manual", hint: "看" }] })
    const first = await expedition.start("builder", { maxRounds: 3 })
    await assert.rejects(() => expedition.start("builder"), /已经在磨目标/)
    expedition.stop("builder")
    await first.done
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("停下来的事实必须落盘：stop 之后目标状态是 stopped，且收件箱看得见", async () => {
  await withGoal(async ({ registry, goals, ctx }) => {
    const expedition = new Expedition({ ctx, registry, goals, config: CONFIG, pollMs: 5, gapMs: 5 })
    await (await expedition.start("builder", { maxRounds: 10 })).done

    const goal = await goals.read("builder")
    assert.equal(goal.status, "stopped", "循环停了但目标是 active = 收件箱里看不见 = 漏报")
    assert.match(goal.note, /连续 3 轮没有实质进展/)

    const inbox = buildInbox({
      bots: [{ id: "builder", name: "匠" }],
      runtime: {},
      goals: { builder: { status: goal.status, note: goal.note, objective: goal.objective, rounds: goal.rounds.length, updatedAt: goal.updatedAt } },
    })
    assert.equal(inbox.length, 1)
    assert.equal(inbox[0].level, "notice")
    assert.match(inbox[0].detail, /连续 3 轮/)
  })
})

test("轮次用尽不是静默结束：转成 needs-human，收件箱里是要动手的那一类", async () => {
  await withGoal(async ({ registry, goals, ctx }) => {
    const expedition = new Expedition({ ctx, registry, goals, config: CONFIG, pollMs: 5, gapMs: 5 })
    const result = await (await expedition.start("builder", { maxRounds: 1 })).done
    assert.equal(result.action, "exhausted")
    assert.match(result.reason, /轮次用尽/)

    const goal = await goals.read("builder")
    assert.equal(goal.status, "needs-human")
    const inbox = buildInbox({
      bots: [{ id: "builder", name: "匠" }],
      runtime: {},
      goals: { builder: { status: goal.status, note: goal.note, objective: goal.objective, rounds: goal.rounds.length, updatedAt: goal.updatedAt } },
    })
    assert.equal(inbox[0].level, "action")
    assert.match(inbox[0].detail, /要不要再点火/)
  })
})

test("每一轮都带身份和工具白名单（长跑里最容易漏的就是第二轮起）", async () => {
  await withGoal(
    async ({ registry, goals, ctx, rounds, restricted, systemSections }) => {
      const expedition = new Expedition({ ctx, registry, goals, config: CONFIG, pollMs: 5, gapMs: 5 })
      await (await expedition.start("builder", { maxRounds: 2 })).done
      assert.equal(rounds(), 2)
      assert.equal(systemSections.length, 2, "每一轮都要注入身份")
      assert.equal(restricted.length, 2, "每一轮都要下发白名单")
      assert.match(systemSections[0].text, /你是 匠/)
      assert.ok(!restricted[0].allow.includes("bash"))
    },
    {
      // 造不出来的文件：两轮都会跑，且都不会过——正好用来数「每轮有没有带身份」。
      acceptance: [{ kind: "file", path: join(tmpdir(), "crew-never-exists.md") }],
      script: async () => {},
    },
  )
})

test("配了单价就按轮记账；没配就留 0（面板据此决定显不显示金额）", async () => {
  await withGoal(
    async ({ registry, goals, ctx }) => {
      const expedition = new Expedition({ ctx, registry, goals, config: { ...CONFIG, costPerRoundCny: 1.5 }, pollMs: 5, gapMs: 5 })
      await (await expedition.start("builder", { maxRounds: 2 })).done
      const goal = await goals.read("builder")
      assert.equal(goal.rounds.length, 2)
      assert.equal(goal.budget.spentCny, 3)
    },
    { acceptance: [{ kind: "file", path: join(tmpdir(), "crew-never-2.md") }], script: async () => {} },
  )
  await withGoal(async ({ registry, goals, ctx }) => {
    const expedition = new Expedition({ ctx, registry, goals, config: CONFIG, pollMs: 5, gapMs: 5 })
    await (await expedition.start("builder", { maxRounds: 1 })).done
    assert.equal((await goals.read("builder")).budget.spentCny, 0)
  })
})

test("classify：没产出算 empty，产出但验收没变好算 no-progress", () => {
  const before = { checks: [{ ok: false }, { ok: false }] }
  const same = { checks: [{ ok: false }, { ok: false }] }
  const better = { checks: [{ ok: true }, { ok: false }] }
  assert.equal(classify({ state: "done", result: "说话了" }, before, same), "no-progress")
  assert.equal(classify({ state: "done", result: "说话了" }, before, better), "progress")
  assert.equal(classify({ state: "done", result: "" }, before, same), "empty")
  assert.equal(classify({ state: "failed", result: "x" }, before, better), "error")
})

test("两次快速点火：只有一个能跑起来（同步登记，不留竞态窗口）", async () => {
  await withGoal(async ({ registry, goals, ctx }) => {
    const gate = new Gate(1)
    const expedition = new Expedition({ ctx, registry, goals, config: CONFIG, gate, pollMs: 5, gapMs: 5 })
    const first = expedition.start("builder", { maxRounds: 2 })
    const second = expedition.start("builder", { maxRounds: 2 })
    const settled = await Promise.allSettled([first, second])
    const rejected = settled.filter((item) => item.status === "rejected")
    assert.equal(rejected.length, 1, "第二次点火必须被拒")
    assert.match(String(rejected[0].reason?.message ?? rejected[0].reason), /已经在磨目标|并发已满/)
    const accepted = settled.find((item) => item.status === "fulfilled").value
    expedition.stop("builder")
    await accepted.done
    assert.equal(gate.active, 0)
  })
})
