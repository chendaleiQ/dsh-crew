/**
 * BotRegistry 的单元测试。这一层不依赖 DSH，所以能直接 `node --test` 跑。
 *
 * 重点是三条铁律：
 * 1. 坏档不能拖垮整张花名册；
 * 2. 写 JSON 要么全新要么全旧，不能半截；
 * 3. 运行态可以丢，档案不能丢。
 */

import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { BotRegistry, effectiveTools, normalizeBot, normalizeBotId } from "../src/registry.js"

async function withRegistry(fn) {
  const dir = await mkdtemp(join(tmpdir(), "dsh-crew-"))
  try {
    return await fn(new BotRegistry(dir), dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test("id 规范化：合法、非法各一组", () => {
  assert.equal(normalizeBotId("Writer-01"), "writer-01")
  assert.equal(normalizeBotId(" ab "), "ab")
  for (const bad of ["", "Writer 01", "-x", "a".repeat(33), "中文", "../etc", undefined]) {
    assert.throws(() => normalizeBotId(bad), /不合法/)
  }
})

test("缺字段补默认值，工具默认给只读加写入", () => {
  const bot = normalizeBot({ id: "w" })
  assert.equal(bot.name, "w")
  assert.equal(bot.preset, "standard")
  assert.equal(bot.allowBash, false)
  assert.ok(bot.tools.includes("read"))
  assert.ok(!bot.tools.includes("bash"))
})

test("新建后能读回，且自动生成 memory.md", async () => {
  await withRegistry(async (registry) => {
    await registry.save({ id: "writer", name: "小文", persona: "你负责口播稿。", cwd: "/tmp" })
    const bot = await registry.read("writer")
    assert.equal(bot.name, "小文")
    assert.equal(bot.persona, "你负责口播稿。")
    const memory = await registry.readMemory("writer")
    assert.match(memory, /小文 的记忆/)
  })
})

test("列表按 createdAt 排序，坏档变 fault 而不是让整次读取失败", async () => {
  await withRegistry(async (registry) => {
    await registry.save({ id: "a", name: "A", createdAt: "2026-01-01T00:00:00.000Z" })
    await registry.save({ id: "b", name: "B", createdAt: "2026-02-01T00:00:00.000Z" })
    await writeFile(join(registry.botsDir, "broken", "bot.json"), "{ not json", "utf8").catch(async () => {
      const { mkdir } = await import("node:fs/promises")
      await mkdir(join(registry.botsDir, "broken"), { recursive: true })
      await writeFile(join(registry.botsDir, "broken", "bot.json"), "{ not json", "utf8")
    })
    const bots = await registry.list()
    assert.deepEqual(bots.map((bot) => bot.id), ["a", "b", "broken"])
    assert.equal(bots[2].fault, true)
    assert.match(bots[2].faultReason, /解析失败/)
  })
})

test("appendMemory 带时间戳追加，空文本不写", async () => {
  await withRegistry(async (registry) => {
    await registry.save({ id: "w" })
    assert.equal(await registry.appendMemory("w", "   "), false)
    assert.equal(await registry.appendMemory("w", "偏好：结论先行。"), true)
    const text = await readFile(registry.memoryFile("w"), "utf8")
    assert.match(text, /偏好：结论先行。/)
    assert.match(text, /^## \d{4}-\d{2}-\d{2} /m)
  })
})

test("运行态读改写：只动一个 Bot，别的不受影响", async () => {
  await withRegistry(async (registry) => {
    assert.deepEqual(await registry.readState(), { bots: {} })
    await registry.patchState("a", { state: "running", sessionId: "s1" })
    await registry.patchState("b", { state: "idle" })
    await registry.patchState("a", { state: "done" })
    const state = await registry.readState()
    assert.deepEqual(state.bots.a, { state: "done", sessionId: "s1" })
    assert.deepEqual(state.bots.b, { state: "idle" })
  })
})

test("有效工具：bash 只由 allowBash 决定，数组里写了也不算", () => {
  const bot = normalizeBot({ id: "w", tools: ["read", "bash", "write", "read"] })
  assert.deepEqual(effectiveTools(bot).sort(), ["read", "write"])
  assert.deepEqual(effectiveTools({ ...bot, allowBash: true }).sort(), ["bash", "read", "write"])
  // 默认档案给了只读+写入，但绝不默认给 bash
  assert.ok(!effectiveTools(normalizeBot({ id: "d" })).includes("bash"))
})

test("删档之后写记忆不会把 Bot 复活（只留个 memory.md 的空壳最坑）", async () => {
  await withRegistry(async (registry) => {
    await registry.save({ id: "gone", name: "已删" })
    assert.equal(await registry.exists("gone"), true)
    await registry.remove("gone")
    assert.equal(await registry.exists("gone"), false)

    assert.equal(await registry.appendMemory("gone", "这条不该写进去"), false)
    const { existsSync } = await import("node:fs")
    assert.equal(existsSync(registry.botDir("gone")), false, "目录不该被重建")

    const compacted = await registry.compactMemory("gone")
    assert.equal(compacted.changed, false)
    assert.match(compacted.summary, /已删除/)
  })
})

test("部分更新是合并：只改名字不会把人格和目录冲掉", async () => {
  await withRegistry(async (registry) => {
    await registry.save({ id: "w", name: "小文", role: "写作", persona: "你写短句。", cwd: "/tmp/work", tools: ["read"] })
    const updated = await registry.save({ id: "w", name: "小文2" })
    assert.equal(updated.name, "小文2")
    assert.equal(updated.persona, "你写短句。", "人格不能被默认值冲掉")
    assert.equal(updated.cwd, "/tmp/work", "工作目录不能丢")
    assert.deepEqual(updated.tools, ["read"])
    assert.equal(updated.role, "写作")
  })
})

test("显式传空字符串才算清空（合并语义不能把「清空」也吃掉）", async () => {
  await withRegistry(async (registry) => {
    await registry.save({ id: "w", name: "小文", persona: "旧人格" })
    const cleared = await registry.save({ id: "w", persona: "" })
    assert.equal(cleared.persona, "")
    assert.equal(cleared.name, "小文")
  })
})
