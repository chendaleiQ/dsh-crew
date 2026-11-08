/**
 * 目标态测试。这里的每条断言都对应一次「它想骗你」的具体机会：
 * 空目标、连续无进展、超预算、只有人能验的验收、跨天预算清零。
 */

import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import {
  GOAL_LIMITS,
  MAX_ROUNDS_KEPT,
  GoalStore,
  addDeadEnd,
  checkAcceptance,
  consecutiveNoProgress,
  decide,
  emptyGoal,
  recordRound,
  rollDay,
} from "../src/goal.js"
import { BotRegistry } from "../src/registry.js"

function goalWith(rounds = [], patch = {}) {
  return {
    // 默认带一条人工验收：没有验收条件的目标按设计是不许开跑的（另一条测试专门验它）。
    ...emptyGoal({ botId: "w", objective: "把首页改完", acceptance: [{ kind: "manual", hint: "看一眼首页" }] }),
    rounds: rounds.map((outcome, index) => ({ n: index + 1, outcome, sessionId: "", startedAt: "", endedAt: "", note: "", costCny: 0 })),
    ...patch,
  }
}

test("空目标不许跑：没目标就别烧钱", () => {
  assert.deepEqual(decide(goalWith([], { objective: "" })), { action: "stop", reason: "目标是空的，没什么可做" })
})

test("没有验收条件的目标不许开跑：否则「做到」只能靠自称", () => {
  const goal = { ...goalWith(), acceptance: [] }
  const verdict = decide(goal)
  assert.equal(verdict.action, "need-human")
  assert.match(verdict.reason, /验收条件/)
})

test("人叫停就停，优先级最高", () => {
  assert.equal(decide(goalWith([], { status: "stopped" })).action, "stop")
  assert.equal(decide(goalWith([], { status: "done" })).action, "done")
  assert.match(decide(goalWith([], { status: "blocked", note: "缺账号" })).reason, /缺账号/)
})

test("连续 3 轮没进展就停；中间有一次进展就重新计数", () => {
  assert.equal(consecutiveNoProgress(goalWith(["progress", "no-progress", "no-progress"])), 2)
  assert.equal(consecutiveNoProgress(goalWith(["progress", "error", "empty", "no-progress"])), 3)
  assert.equal(decide(goalWith(["progress", "no-progress", "no-progress", "no-progress"])).action, "stop")
  assert.equal(decide(goalWith(["no-progress", "no-progress"])).action, "continue")
})

test("超预算不是停，是要你点头", () => {
  const goal = goalWith([], { budget: { capCny: 50, spentCny: 50.5, day: new Date().toISOString().slice(0, 10) } })
  const verdict = decide(goal)
  assert.equal(verdict.action, "need-human")
  assert.match(verdict.reason, /50\.50/)
})

test("跨天预算清零，但不删历史明细", () => {
  const goal = recordRound(goalWith(), { outcome: "progress", costCny: 12 })
  assert.equal(goal.budget.spentCny, 12)
  const nextDay = rollDay(goal, "2099-01-01")
  assert.equal(nextDay.budget.spentCny, 0)
  assert.equal(nextDay.budget.day, "2099-01-01")
  assert.equal(nextDay.rounds.length, 1)
})

test("记账轮次自增，成本并进当日预算", () => {
  let goal = goalWith()
  goal = recordRound(goal, { outcome: "progress", costCny: 3 })
  goal = recordRound(goal, { outcome: "error", costCny: 2 })
  assert.deepEqual(goal.rounds.map((round) => round.n), [1, 2])
  assert.equal(goal.budget.spentCny, 5)
})

test("死路最多留 30 条，空文本不记", () => {
  let goal = goalWith()
  goal = addDeadEnd(goal, "   ")
  assert.equal(goal.deadEnds.length, 0)
  for (let index = 0; index < 40; index += 1) goal = addDeadEnd(goal, `死路 ${index}`)
  assert.equal(goal.deadEnds.length, 30)
  assert.equal(goal.deadEnds.at(-1), "死路 39")
})

test("验收：文件存在才算过，空文件不算", async () => {
  const dir = await mkdtemp(join(tmpdir(), "crew-goal-"))
  try {
    const exists = join(dir, "out.md")
    const emptyFile = join(dir, "empty.md")
    await writeFile(exists, "内容", "utf8")
    await writeFile(emptyFile, "   ", "utf8")
    const goal = {
      ...emptyGoal({ botId: "w", objective: "写个文件" }),
      acceptance: [
        { kind: "file", path: exists },
        { kind: "file", path: emptyFile },
        { kind: "file", path: join(dir, "nope.md") },
      ],
    }
    const result = await checkAcceptance(goal)
    assert.equal(result.ok, false)
    assert.deepEqual(result.checks.map((check) => check.ok), [true, false, false])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("验收：命令在 Bot 的 cwd 里跑，失败带 stderr", async () => {
  const dir = await mkdtemp(join(tmpdir(), "crew-goal-cmd-"))
  try {
    await writeFile(join(dir, "marker.txt"), "x", "utf8")
    const goal = {
      ...emptyGoal({ botId: "w", objective: "命令验收" }),
      acceptance: [
        { kind: "command", cmd: "test -f marker.txt", label: "marker 在" },
        { kind: "command", cmd: "test -f missing.txt", label: "missing 在" },
      ],
    }
    const result = await checkAcceptance(goal, { cwd: dir })
    assert.deepEqual(result.checks.map((check) => check.ok), [true, false])
    assert.equal(result.ok, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("只有人能验的验收：没确认就不算完成，确认后才算", async () => {
  const goal = {
    ...emptyGoal({ botId: "w", objective: "听一遍成片" }),
    acceptance: [{ kind: "manual", hint: "听一遍音轨有没有破音" }],
  }
  const before = await checkAcceptance(goal)
  assert.equal(before.ok, false)
  assert.equal(before.manualPending.length, 1)
  assert.match(before.manualPending[0], /听一遍音轨/)

  const after = await checkAcceptance(goal, { manualApproved: ["听一遍音轨有没有破音"] })
  assert.equal(after.ok, true)
})

test("GoalStore 落盘能读回，坏 JSON 明确报错", async () => {
  const dir = await mkdtemp(join(tmpdir(), "crew-goal-store-"))
  const registry = new BotRegistry(dir)
  await registry.save({ id: "writer", name: "小文", cwd: dir })
  const store = new GoalStore(registry)
  try {
    assert.equal(await store.exists("writer"), false)
    await store.create({ botId: "writer", objective: "把首页改完", acceptance: [{ kind: "manual", hint: "看一遍" }] })
    const goal = await store.read("writer")
    assert.equal(goal.objective, "把首页改完")
    assert.equal(goal.status, "active")
    assert.equal(goal.acceptance.length, 1)
    assert.equal(goal.rounds.length, 0)

    await writeFile(store.file("writer"), "{ 坏掉的", "utf8")
    await assert.rejects(() => store.read("writer"), /解析失败/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("病态输入不许把循环拖死：目标与验收都有规模上限", () => {
  const goal = emptyGoal({
    botId: "w",
    objective: "啊".repeat(50_000),
    acceptance: Array.from({ length: 200 }, (_, index) => ({ kind: "command", cmd: `test ${index}` })),
    constraints: Array.from({ length: 200 }, (_, index) => `约束 ${index}`),
  })
  assert.equal(goal.objective.length, GOAL_LIMITS.objectiveChars)
  assert.equal(goal.acceptance.length, GOAL_LIMITS.acceptance)
  assert.equal(goal.constraints.length, GOAL_LIMITS.constraints)
})

test("验收条件缺字段的条目被丢掉，而不是变成一定会过的空检查", () => {
  const goal = emptyGoal({
    botId: "w",
    objective: "x",
    acceptance: [{ kind: "file" }, { kind: "command", cmd: "  " }, { kind: "weird" }, { kind: "manual" }],
  })
  assert.equal(goal.acceptance.length, 1)
  assert.equal(goal.acceptance[0].kind, "manual")
})

test("轮次历史有上限：跑到几百轮也不会把 goal.json 撑成日志，折叠量单独记", () => {
  let goal = goalWith()
  for (let index = 0; index < MAX_ROUNDS_KEPT + 30; index += 1) {
    goal = recordRound(goal, { outcome: "no-progress", costCny: 0 })
  }
  assert.equal(goal.rounds.length, MAX_ROUNDS_KEPT)
  assert.equal(goal.roundsTrimmed, 30, "折叠的轮次要单独记数，不能悄悄丢掉")
  // 最近一轮的编号仍然连续，decide() 才会算对「连续几轮没进展」
  assert.equal(goal.rounds.at(-1).n, MAX_ROUNDS_KEPT + 30)
  assert.equal(consecutiveNoProgress(goal), MAX_ROUNDS_KEPT, "保留的最近轮次都算得出来")
})

test("折叠量能落盘再读回来（不许读一次就归零）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "crew-rounds-"))
  const registry = new BotRegistry(dir)
  const store = new GoalStore(registry)
  try {
    await registry.save({ id: "w", name: "小文", cwd: dir })
    let goal = await store.create({ botId: "w", objective: "磨", acceptance: [{ kind: "manual", hint: "看" }] })
    goal = { ...goal, roundsTrimmed: 7 }
    await store.save(goal)
    const back = await store.read("w")
    assert.equal(back.roundsTrimmed, 7)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
