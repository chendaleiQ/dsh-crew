/**
 * 脏数据 / 坏档矩阵。
 *
 * 目标里点名要覆盖这一块，因为这是「本机长期使用」最真实的故障形态：
 * 你手改了一个文件、断电写了一半、备份工具塞进奇怪的东西、某个 Bot 的
 * 目标文件被编辑器写坏。每一种都不该让整个插件瘫掉——最坏的结果应该是
 * 「那一只 Bot 显示坏了」，而不是「面板一片空白」。
 */

import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { existsSync } from "node:fs"

import { GoalStore } from "../src/goal.js"
import { BotRegistry } from "../src/registry.js"
import { compactMemory, parseMemory } from "../src/memory.js"

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "crew-corrupt-"))
  try {
    return await fn(dir, new BotRegistry(dir), new GoalStore(new BotRegistry(dir)))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test("state.json 坏掉：退回空状态，不抛（运行态可以丢，档案不能丢）", async () => {
  await withDir(async (dir, registry) => {
    await registry.ensure()
    for (const junk of ["{ 半截", "[]", '"字符串"', "null", "\u0000\u0001"]) {
      await writeFile(join(dir, "state.json"), junk, "utf8")
      assert.deepEqual(await registry.readState(), { bots: {} }, `state.json=${junk} 时应退回空状态`)
    }
  })
})

test("bot.json 坏掉：列表里标 fault，其它 Bot 和整张表都还在", async () => {
  await withDir(async (dir, registry) => {
    await registry.save({ id: "good", name: "好的", cwd: "/tmp" })
    await mkdir(join(dir, "bots", "bad"), { recursive: true })
    await writeFile(join(dir, "bots", "bad", "bot.json"), "{ 不是 JSON", "utf8")

    const bots = await registry.list()
    assert.deepEqual(bots.map((bot) => bot.id).sort(), ["bad", "good"])
    const bad = bots.find((bot) => bot.id === "bad")
    assert.equal(bad.fault, true)
    assert.match(bad.faultReason, /解析失败/)
    await assert.rejects(() => registry.read("bad"), /解析失败/)
  })
})

test("bots 目录里混进普通文件：跳过，不当成 Bot", async () => {
  await withDir(async (dir, registry) => {
    await registry.save({ id: "good", name: "好的", cwd: "/tmp" })
    await writeFile(join(dir, "bots", "README.txt"), "这里是随手放的文件", "utf8")
    const bots = await registry.list()
    assert.deepEqual(bots.map((bot) => bot.id), ["good"])
  })
})

test("goal.json 坏掉：目标读不出来要明确报错，但花名册照常", async () => {
  await withDir(async (dir, registry, goals) => {
    await registry.save({ id: "w", name: "小文", cwd: "/tmp" })
    await writeFile(goals.file("w"), "{ 坏掉的目标", "utf8")
    await assert.rejects(() => goals.read("w"), /解析失败/)
    assert.equal((await registry.list()).length, 1, "花名册不能跟着挂")
  })
})

test("goal.json 字段是垃圾：规范化后仍然可用，非法枚举退回安全默认", async () => {
  await withDir(async (dir, registry, goals) => {
    await registry.save({ id: "w", name: "小文", cwd: "/tmp" })
    await writeFile(
      goals.file("w"),
      JSON.stringify({
        objective: "把事做完",
        acceptance: [null, 42, { kind: "weird" }, { kind: "manual", hint: "看看" }],
        status: "莫名其妙的状态",
        rounds: [{ outcome: "???" }, { n: "abc", outcome: "progress" }],
        deadEnds: [null, 3, "真的死路"],
        budget: { capCny: "很多", spentCny: -5 },
      }),
      "utf8",
    )
    const goal = await goals.read("w")
    assert.equal(goal.status, "active", "非法状态退回 active")
    assert.equal(goal.acceptance.length, 1, "无效验收被丢弃")
    assert.equal(goal.rounds.length, 2)
    assert.equal(goal.rounds[0].outcome, "error", "非法 outcome 退回 error")
    assert.deepEqual(goal.deadEnds, ["真的死路"])
    assert.equal(goal.budget.spentCny, 0)
    assert.ok(goal.budget.capCny > 0)
  })
})

test("memory.md 是二进制垃圾：能读、能压缩、不崩", async () => {
  await withDir(async (dir, registry) => {
    await registry.save({ id: "w", name: "小文", cwd: "/tmp" })
    await writeFile(registry.memoryFile("w"), Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x02]), "binary")
    const text = await registry.readMemory("w")
    assert.equal(typeof text, "string")
    const parsed = parseMemory(text)
    assert.equal(parsed.entries.length, 0, "认不出条目就当没有，不乱猜")
    const compacted = compactMemory(text, { keepRecent: 3 })
    assert.equal(compacted.changed, false)
  })
})

test("记忆超大（1MB）也能压缩到阈值内", async () => {
  const entry = (index) =>
    `## 2026-11-0${(index % 9) + 1} 1${index % 10}:00\n做完第 ${index} 件事，结论：结论 ${index}\n细节：${"很长的细节。".repeat(200)}\n`
  let text = "# 记忆\n\n"
  for (let index = 0; index < 120; index += 1) text += entry(index)
  assert.ok(text.length > 100_000, `构造出来的记忆要够大（实际 ${text.length} 字）`)

  const compacted = compactMemory(text, { keepRecent: 5 })
  assert.equal(compacted.changed, true)
  assert.ok(compacted.text.length < text.length, "必须变小")
  assert.match(compacted.text, /结论 39/, "最近一条要在")
})

test("routines 目录里塞垃圾：列表不崩，非 md 与空文件都被忽略或降级", async () => {
  await withDir(async (dir, registry) => {
    await registry.save({ id: "w", name: "小文", cwd: "/tmp" })
    await mkdir(registry.routinesDir("w"), { recursive: true })
    await writeFile(join(registry.routinesDir("w"), "not-a-routine.txt"), "x", "utf8")
    await writeFile(join(registry.routinesDir("w"), "empty.md"), "", "utf8")
    const list = await registry.listRoutines("w")
    assert.deepEqual(list.map((item) => item.slug), ["empty"], "只认 .md，且空文件降级为草稿")
    assert.equal(list[0].status, "draft")
  })
})

test("未知 slug / 不存在的 Bot：读 routine 明确失败，不静默返回空", async () => {
  await withDir(async (dir, registry) => {
    await registry.save({ id: "w", name: "小文", cwd: "/tmp" })
    await assert.rejects(() => registry.readRoutine("w", "没有这个"), /slug 不合法/iu, "中文 slug 不合法就要说清楚")
    await assert.rejects(() => registry.readRoutine("不存在的Bot", "x"), /不合法|ENOENT/iu)
  })
})

test("slug 里带路径穿越：直接拒绝，不清洗、不写到目录外", async () => {
  await withDir(async (dir, registry) => {
    await registry.save({ id: "w", name: "小文", cwd: "/tmp" })
    await assert.rejects(() => registry.readRoutine("w", "../../etc/passwd"), /slug 不合法|ENOENT/iu)
    const target = join(dir, "escape.md")
    await assert.rejects(() => registry.saveRoutine("w", { slug: "../escape", text: "x" }), /slug 不合法/)
    assert.equal(existsSync(target), false)
  })
})

test("删掉整个数据目录后仍能自我重建（不会永久残废）", async () => {
  await withDir(async (dir, registry) => {
    await registry.save({ id: "w", name: "小文", cwd: "/tmp" })
    await rm(join(dir, "bots"), { recursive: true, force: true })
    assert.deepEqual(await registry.list(), [])
    await registry.save({ id: "w2", name: "重建", cwd: "/tmp" })
    assert.equal((await readFile(join(dir, "bots", "w2", "bot.json"), "utf8")).length > 0, true)
  })
})
