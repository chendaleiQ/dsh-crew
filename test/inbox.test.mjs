/**
 * 收件箱测试。重点全在「别漏报」：
 * 失败、空产出、超时、目标等人、目标停下——五种都得进清单，一条都不能悄悄躺着。
 */

import assert from "node:assert/strict"
import test from "node:test"

import { buildInbox, inboxSummary } from "../src/inbox.js"

const bots = [
  { id: "a", name: "阿A" },
  { id: "b", name: "阿B" },
  { id: "c", name: "阿C" },
]

test("没有异常时收件箱是空的，摘要说人话", () => {
  const items = buildInbox({ bots, runtime: {}, goals: {} })
  assert.deepEqual(items, [])
  assert.equal(inboxSummary(items), "没有需要你的事")
})

test("派活失败 / 空产出 / 超时都进清单，且带错误原文与会话", () => {
  const items = buildInbox({
    bots,
    runtime: {
      a: { state: "failed", error: "HTTP 401 凭据无效", sessionId: "s-a", endedAt: "2026-11-08T10:00:00Z" },
      b: { state: "empty", error: "本轮没有产出文本；no provider/model", sessionId: "s-b", endedAt: "2026-11-08T11:00:00Z" },
      c: { state: "timeout", error: "超过 900 秒没跑完", sessionId: "s-c", endedAt: "2026-11-08T12:00:00Z" },
    },
    goals: {},
  })
  assert.equal(items.length, 3)
  assert.deepEqual(items.map((item) => item.level), ["action", "action", "action"])
  // 新的排前面
  assert.deepEqual(items.map((item) => item.botId), ["c", "b", "a"])
  assert.match(items[0].detail, /超过 900 秒/)
  assert.equal(items[1].sessionId, "s-b")
})

test("done / cancelled / running 不打扰你", () => {
  const items = buildInbox({
    bots,
    runtime: {
      a: { state: "done", result: "干完了" },
      b: { state: "cancelled", error: "已取消" },
      c: { state: "running" },
    },
    goals: {},
  })
  assert.deepEqual(items, [])
})

test("目标等人 → action；目标停下 → notice，且 action 排前面", () => {
  const items = buildInbox({
    bots,
    runtime: {},
    goals: {
      a: { status: "needs-human", note: "机器能验的都过了，剩下要你：听一遍音轨", rounds: 3, updatedAt: "2026-11-08T09:00:00Z" },
      b: { status: "stopped", note: "连续 3 轮没有实质进展", rounds: 5, updatedAt: "2026-11-08T13:00:00Z" },
    },
  })
  assert.equal(items.length, 2)
  assert.equal(items[0].level, "action")
  assert.equal(items[0].kind, "goal-needs-human")
  assert.match(items[0].detail, /听一遍音轨/)
  assert.equal(items[1].level, "notice")
  assert.match(items[1].detail, /连续 3 轮/)
})

test("目标还有验收条件没过的细节不会被丢掉：note 为空时用目标正文兜底", () => {
  const items = buildInbox({
    bots,
    runtime: {},
    goals: { a: { status: "needs-human", note: "   ", objective: "把成片做出来" } },
  })
  assert.equal(items[0].detail, "把成片做出来")
})

test("同一个 Bot 既有失败派活又有等人目标：两条都要报（不许合并吞掉一条）", () => {
  const items = buildInbox({
    bots,
    runtime: { a: { state: "failed", error: "炸了", endedAt: "2026-11-08T08:00:00Z" } },
    goals: { a: { status: "needs-human", note: "等你点头", updatedAt: "2026-11-08T07:00:00Z" } },
  })
  assert.equal(items.length, 2)
  assert.deepEqual(items.map((item) => item.kind).sort(), ["goal-needs-human", "task-failed"])
})

test("摘要区分「要动手」和「只是知会」", () => {
  assert.equal(inboxSummary([{ level: "notice" }, { level: "notice" }]), "2 条知会，不用动手")
  assert.equal(inboxSummary([{ level: "action" }, { level: "notice" }]), "1 件等你处理，另有 1 条知会")
  assert.equal(inboxSummary([{ level: "action" }, { level: "action" }]), "2 件等你处理")
})

test("进程重启留下的 interrupted 也要报：跑到一半没人管的事不能沉底", () => {
  const items = buildInbox({
    bots,
    runtime: { a: { state: "interrupted", error: "上一次运行没走完就结束了", endedAt: "2026-11-08T10:00:00Z" } },
    goals: {},
  })
  assert.equal(items.length, 1)
  assert.equal(items[0].level, "action")
  assert.match(items[0].title, /被中断/)
  assert.match(items[0].detail, /没走完/)
})
