/**
 * composeBrief 的测试。这一层纯字符串，所以可以钉得死一点：
 * 截断行为、空人格兜底、bash 权限措辞、交付要求必须在场。
 */

import assert from "node:assert/strict"
import test from "node:test"

import { composeBrief, composeSystemPrompt } from "../src/persona.js"

const bot = {
  id: "writer",
  name: "小文",
  role: "口播稿",
  persona: "你写口语化中文，句子短。",
  cwd: "/tmp/work",
  allowBash: false,
}

test("基本简报包含身份、边界、任务、交付四段", () => {
  const { brief, personaClipped, memoryClipped } = composeBrief({ bot, task: "写一期开头 30 字" })
  assert.match(brief, /# 你的身份：小文（口播稿）/)
  assert.match(brief, /你写口语化中文/)
  assert.match(brief, /## 边界/)
  assert.match(brief, /工作目录：\/tmp\/work/)
  assert.match(brief, /## 这次要做的活\n写一期开头 30 字/)
  assert.match(brief, /## 交付/)
  assert.equal(personaClipped, false)
  assert.equal(memoryClipped, false)
})

test("没写人格时给兜底，不让模型自己编设定", () => {
  const { brief } = composeBrief({ bot: { ...bot, persona: "" }, task: "查一下" })
  assert.match(brief, /还没有写人格/)
})

test("没写工作目录时降级为只读", () => {
  const { brief } = composeBrief({ bot: { ...bot, cwd: "" }, task: "查一下" })
  assert.match(brief, /不要写文件/)
})

test("allowBash 决定措辞", () => {
  assert.match(composeBrief({ bot, task: "跑一下" }).brief, /不要执行 shell 命令/)
  assert.match(composeBrief({ bot: { ...bot, allowBash: true }, task: "跑一下" }).brief, /破坏性操作先说明/)
})

test("记忆超预算时保留尾部并标注截断", () => {
  const memory = `${"旧笔记。".repeat(1200)}最新的一条：用户要求结论先行。`
  const { brief, memoryClipped } = composeBrief({ bot, memory, task: "开工" })
  assert.equal(memoryClipped, true)
  assert.match(brief, /记忆被截断/)
  assert.match(brief, /用户要求结论先行/)
})

test("空任务直接报错，不生成半截简报", () => {
  assert.throws(() => composeBrief({ bot, task: "   " }), /需要一句具体任务/)
})

test("空记忆时整段不出现，简报不留空壳标题", () => {
  const { brief } = composeBrief({ bot, memory: "  \n\n ", task: "开工" })
  assert.doesNotMatch(brief, /你之前记下的事/)
})

test("系统提示带身份、边界、记忆；简报可以不要身份（避免同一段话重复烧两遍 token）", () => {
  const system = composeSystemPrompt({ bot, memory: "他喜欢结论先行。" })
  assert.match(system.text, /你是 小文（口播稿）/)
  assert.match(system.text, /## 边界/)
  assert.match(system.text, /他喜欢结论先行/)

  const slim = composeBrief({ bot, memory: "他喜欢结论先行。", task: "写个开头", includeIdentity: false })
  assert.doesNotMatch(slim.brief, /你的身份/)
  assert.doesNotMatch(slim.brief, /## 边界/)
  assert.doesNotMatch(slim.brief, /他喜欢结论先行/)
  assert.match(slim.brief, /## 这次要做的活/)
  assert.match(slim.brief, /## 交付/)
})
