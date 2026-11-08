/**
 * 执行轨迹 + routine 的测试。
 *
 * 轨迹这块用**真实事件形状**（从会话日志里抄的），因为 routine 的价值全在
 * "记的是真跑过的"——如果这里解析错了，录下来的就是假的成功路径。
 */

import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { BotRegistry } from "../src/registry.js"
import { buildRoutine, parseRoutine, routineSlug, routineTitle } from "../src/routine.js"
import { summariseTrace, traceWorthRecording } from "../src/trace.js"

function call(name, args) {
  return { type: "tool/call", data: { callId: `c-${name}`, name, arguments: JSON.stringify(args) } }
}

test("轨迹：从真实形状里认出工具与目标", () => {
  const events = [
    call("bash", { command: "npm test" }),
    call("read", { file_path: "/tmp/a.md" }),
    call("edit", { file_path: "/tmp/a.md", old_string: "x", new_string: "y" }),
    { type: "tool/result", data: { message: { content: [] } } },
    call("web_search", { queries: ["甲", "乙"] }),
  ]
  const trace = summariseTrace(events)
  assert.deepEqual(trace.calls.map((item) => item.name), ["bash", "read", "edit", "web_search"])
  assert.equal(trace.calls[0].target, "npm test")
  assert.equal(trace.calls[3].target, "甲 / 乙")
  assert.deepEqual(trace.files, ["/tmp/a.md"])
  assert.deepEqual(trace.commands, ["npm test"])
  assert.deepEqual(trace.touched, ["/tmp/a.md"])
})

test("轨迹：连续重复的同一调用合并，中间夹了别的就各留一条", () => {
  const trace = summariseTrace([
    call("grep", { pattern: "TODO" }),
    call("grep", { pattern: "TODO" }),
    call("grep", { pattern: "TODO" }),
    call("read", { file_path: "/tmp/b" }),
    call("grep", { pattern: "TODO" }),
  ])
  assert.deepEqual(trace.calls.map((item) => item.name), ["grep", "read", "grep"])
  assert.equal(trace.counts.grep, 2)
})

test("轨迹：参数不是合法 JSON 也不炸，只是取不到目标", () => {
  const trace = summariseTrace([{ type: "tool/call", data: { name: "bash", arguments: "{坏掉的" } }])
  assert.equal(trace.calls.length, 1)
  assert.equal(trace.calls[0].target, "")
})

test("什么样的轨迹值得录：纯只读一两条不算，改了东西或步骤够多才算", () => {
  assert.equal(traceWorthRecording(summariseTrace([call("read", { file_path: "/x" })])), false)
  assert.equal(traceWorthRecording(summariseTrace([call("read", {}), call("glob", {}), call("grep", {})])), true)
  assert.equal(traceWorthRecording(summariseTrace([call("write", { file_path: "/x" })])), true)
  assert.equal(traceWorthRecording(null), false)
})

test("slug 与标题：可读优先，汉字任务名退回短哈希", () => {
  assert.equal(routineSlug("Fix the login retry bug"), "fix-the-login-retry-bug")
  assert.match(routineSlug("把首页改完"), /^routine-[0-9a-f]{8}$/)
  assert.equal(routineTitle("  第一行\n第二行 "), "第一行")
  assert.equal(routineTitle(""), "未命名套路")
})

test("routine 草稿：标题、适用、通过验收的验收、步骤、结论、提示都在", () => {
  const trace = summariseTrace([call("bash", { command: "npm test" }), call("write", { file_path: "/tmp/out.md" })])
  const routine = buildRoutine({
    task: "把首页改完",
    acceptance: [{ label: "文件存在：/tmp/out.md", ok: true }],
    result: "改完了，测试通过。",
    trace,
    botName: "小文",
  })
  assert.equal(routine.status, "draft")
  assert.match(routine.text, /^# 把首页改完/)
  assert.match(routine.text, /status: draft/)
  assert.match(routine.text, /by: 小文/)
  assert.match(routine.text, /## 什么时候用/)
  assert.match(routine.text, /## 怎么算成功（这次真通过的验收）[\s\S]*文件存在：\/tmp\/out\.md/)
  assert.match(routine.text, /1\. `bash`：npm test/)
  assert.match(routine.text, /2\. `write`：\/tmp\/out\.md/)
  assert.match(routine.text, /## 动过的文件[\s\S]*\/tmp\/out\.md/)
  assert.match(routine.text, /改完了，测试通过。/)
  assert.match(routine.text, /草稿/)

  const parsed = parseRoutine(routine.slug, routine.text)
  assert.equal(parsed.title, "把首页改完")
  assert.equal(parsed.status, "draft")
  assert.equal(parsed.when, "把首页改完")
})

test("registry：routine 能存能列能读，坏文件不拖垮整张清单", async () => {
  const dir = await mkdtemp(join(tmpdir(), "crew-routine-"))
  const registry = new BotRegistry(dir)
  try {
    await registry.save({ id: "w", name: "小文" })
    const trace = summariseTrace([call("write", { file_path: "/tmp/x" })])
    await registry.saveRoutine("w", buildRoutine({ task: "甲任务", result: "好的", trace }))
    await registry.saveRoutine("w", buildRoutine({ task: "Fix retry logic", result: "好了", trace }))

    const list = await registry.listRoutines("w")
    assert.equal(list.length, 2)
    assert.deepEqual(list.map((item) => item.slug).sort(), ["fix-retry-logic", routineSlug("甲任务")].sort())
    assert.match(await registry.readRoutine("w", "fix-retry-logic"), /# Fix retry logic/)

    // 同名覆盖：同一个任务再跑通一次不会堆文件
    await registry.saveRoutine("w", buildRoutine({ task: "甲任务", result: "第二次", trace }))
    assert.equal((await registry.listRoutines("w")).length, 2)
    assert.match(await registry.readRoutine("w", routineSlug("甲任务")), /第二次/)

    assert.deepEqual(await registry.listRoutines("不存在的Bot").catch(() => []), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("草稿清理只清最旧的草稿，confirmed 一条都不许动", async () => {
  const dir = await mkdtemp(join(tmpdir(), "crew-prune-"))
  const registry = new BotRegistry(dir)
  const trace = summariseTrace([call("write", { file_path: "/tmp/x" })])
  try {
    await registry.save({ id: "w", name: "小文" })
    // 两条确认过的（手工写成 confirmed）
    for (const name of ["确认甲", "确认乙"]) {
      const routine = buildRoutine({ task: name, result: "ok", trace })
      await registry.saveRoutine("w", { ...routine, text: routine.text.replace("status: draft", "status: confirmed") })
    }
    // 45 条草稿，间隔写入保证 mtime 有序
    for (let index = 0; index < 45; index += 1) {
      const routine = buildRoutine({ task: `草稿 ${index}`, result: "ok", trace })
      await registry.saveRoutine("w", routine)
      await new Promise((resolve) => setTimeout(resolve, 2))
    }
    const list = await registry.listRoutines("w")
    const confirmed = list.filter((item) => item.status === "confirmed")
    const drafts = list.filter((item) => item.status === "draft")
    assert.equal(confirmed.length, 2, "确认过的必须全在")
    assert.ok(drafts.length <= 40, `草稿要清到 40 以内，实际 ${drafts.length}`)
    // 被删的是最旧的草稿，最新的还在
    assert.ok(drafts.some((item) => item.title === "草稿 44"), "最新的草稿不能被清掉")
    assert.ok(!drafts.some((item) => item.title === "草稿 0"), "最旧的草稿应该被清掉")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
