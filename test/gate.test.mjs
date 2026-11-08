/**
 * 并发闸门测试。
 *
 * 存在的理由：派活和目标循环原本各记各的配额，上限 2 实际能跑 4 个会话——
 * 在本机这就是真核数和真钱。这里钉住"一份配额、两条路径共用"。
 */

import assert from "node:assert/strict"
import test from "node:test"

import { Gate } from "../src/gate.js"

test("占到上限就拒，还回来才能再占", () => {
  const gate = new Gate(2)
  gate.acquire("a")
  gate.acquire("b")
  assert.equal(gate.active, 2)
  assert.equal(gate.remaining, 0)
  assert.throws(() => gate.acquire("c"), /并发已满（上限 2）/)
  gate.release("a")
  assert.equal(gate.remaining, 1)
  assert.doesNotThrow(() => gate.acquire("c"))
})

test("同一个持有者不许重复占位（重复占位会偷偷吃掉配额）", () => {
  const gate = new Gate(2)
  gate.acquire("a")
  assert.throws(() => gate.acquire("a"), /已经占着位置/)
})

test("重复归还不会把别人的额度还回去", () => {
  const gate = new Gate(1)
  gate.acquire("a")
  gate.release("a")
  gate.release("a")
  gate.acquire("b")
  assert.equal(gate.active, 1)
  gate.release("不存在的人")
  assert.equal(gate.active, 1, "归还一个没占过的 id 不该动计数")
})

test("上限被夹到至少 1，非法值不会变成 0（0 会让整个插件永久不可用）", () => {
  assert.equal(new Gate(0).limit, 1)
  assert.equal(new Gate(Number.NaN).limit, 1)
  assert.equal(new Gate(-3).limit, 1)
})

test("快照能看出谁占着位置（排障用）", () => {
  const gate = new Gate(3)
  gate.acquire("crew-writer-g1")
  assert.deepEqual(gate.snapshot(), { limit: 3, active: 1, holders: ["crew-writer-g1"] })
})

test("acquire 需要持有者标识，空值直接拒", () => {
  assert.throws(() => new Gate(1).acquire(""), /需要一个持有者标识/)
})
