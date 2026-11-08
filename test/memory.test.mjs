/**
 * 记忆压缩测试。
 *
 * 关心的不是"压缩率"，而是三件事：
 *   1. 该压缩的时候能认出来；
 *   2. 压缩后**没丢信息**（明细进了 archive）；
 *   3. 置顶的条目永远不会被归档掉。
 */

import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { compactMemory, needsCompaction, parseMemory, summarise } from "../src/memory.js"
import { BotRegistry } from "../src/registry.js"

function entry(at, body) {
  return `## ${at}\n${body}\n`
}

const HEADER = "# 小文 的记忆\n\n<!-- 这个文件人可读可改 -->\n"

function memoryOf(count, { pinIndex = -1 } = {}) {
  let text = HEADER
  for (let index = 0; index < count; index += 1) {
    const body = `做完「第 ${index} 件事」，结论：结论 ${index}${index === pinIndex ? "\n[pin] 这条永远别丢" : ""}`
    text += "\n" + entry(`2026-11-0${(index % 9) + 1} 1${index % 10}:00`, body)
  }
  return text
}

test("解析：文件头与条目分开，条目带时间戳", () => {
  const parsed = parseMemory(memoryOf(3))
  assert.match(parsed.header, /小文 的记忆/)
  assert.equal(parsed.entries.length, 3)
  assert.match(parsed.entries[0].at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  assert.match(parsed.entries[0].body, /结论 0/)
})

test("一行结论：取第一条非空正文，压平并截断", () => {
  assert.equal(summarise({ body: "\n\n  做完「X」，结论：Y  \n第二行" }), "做完「X」，结论：Y")
  assert.equal(summarise({ body: "[pin]\n真实内容" }), "真实内容")
  assert.equal(summarise({ body: "" }), "（空条目）")
  const long = summarise({ body: "啊".repeat(300) })
  assert.equal(long.length, 120)
  assert.match(long, /…$/)
})

test("何时该压缩：条数超了、字数超了都要认出来", () => {
  assert.equal(needsCompaction(memoryOf(10)).needed, false)
  const many = needsCompaction(memoryOf(31))
  assert.equal(many.needed, true)
  assert.match(many.reason, /条目 31 条/)

  const long = needsCompaction(HEADER + entry("2026-11-01 10:00", "字".repeat(6_500)))
  assert.equal(long.needed, true)
  assert.match(long.reason, /字，超过/)
})

/** 真实记忆是每条好几行的（结论 + 细节），用这种才看得出压缩的意义。 */
function longMemory(count, { pinIndex = -1 } = {}) {
  let text = HEADER
  for (let index = 0; index < count; index += 1) {
    const body = [
      `做完「第 ${index} 件事」，结论：结论 ${index}`,
      `细节：这一步试了 ${index % 3} 种办法，最后走通了第 ${index % 3} 种。`,
      `备注：相关文件在 /tmp/work/${index}.md，下次可以直接从这儿接。`,
      index === pinIndex ? "[pin] 这条永远别丢" : "",
    ]
      .filter((line) => line !== "")
      .join("\n")
    text += "\n" + entry(`2026-11-0${(index % 9) + 1} 1${index % 10}:00`, body)
  }
  return text
}

test("压缩：保留最近 N 条 + 置顶，其余折成摘要并交出去归档", () => {
  const text = longMemory(20, { pinIndex: 2 })
  const result = compactMemory(text, { keepRecent: 5 })
  assert.equal(result.changed, true)
  // 20 条里留最近 5 条 → 旧条目 15 条，其中 1 条置顶不归档 → 归档 14 条
  assert.equal(result.archived.length, 14)
  assert.match(result.text, /## 早期摘要（已归档 14 条/)
  assert.match(result.text, /## 置顶（不归档）/)
  assert.match(result.text, /这条永远别丢/)
  // 最近的 5 条原文都在
  for (const index of [15, 16, 17, 18, 19]) assert.match(result.text, new RegExp(`结论 ${index}`))
  // 被归档的条目只留一行摘要，不再有原文段落
  assert.match(result.text, /- 2026-11-\d{2} \d{2}:\d{2} 做完「第 1 件事」/)
  assert.doesNotMatch(result.text, /结论 1\n[^\n]*结论/)
  assert.ok(result.text.length < text.length)
})

test("条目不够多时不折腾：原样返回", () => {
  const text = memoryOf(3)
  const result = compactMemory(text, { keepRecent: 5 })
  assert.equal(result.changed, false)
  assert.equal(result.text, text)
})

test("registry 压缩：先归档再覆写，归档文件能查到明细", async () => {
  const dir = await mkdtemp(join(tmpdir(), "crew-mem-"))
  const registry = new BotRegistry(dir)
  try {
    await registry.save({ id: "w", name: "小文" })
    // 直接写一份长记忆
    const { writeFile } = await import("node:fs/promises")
    await writeFile(registry.memoryFile("w"), memoryOf(30, { pinIndex: 0 }), "utf8")

    const outcome = await registry.compactMemory("w", { keepRecent: 5, maxEntries: 10 })
    assert.equal(outcome.changed, true)
    assert.match(outcome.summary, /归档 24 条/)

    const memory = await readFile(registry.memoryFile("w"), "utf8")
    assert.match(memory, /早期摘要/)
    const archive = await readFile(registry.archiveFile("w"), "utf8")
    assert.match(archive, /归档于/)
    assert.match(archive, /结论 1/, "被归档的明细必须在 archive 里找得到")

    // 再压缩一次：已经不需要了
    const again = await registry.compactMemory("w", { keepRecent: 5, maxEntries: 10 })
    assert.equal(again.changed, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
