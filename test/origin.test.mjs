/**
 * 同源判断测试。
 *
 * 这几行代码守着的是「本机上别的页面能不能指挥你的 Bot」。风险不在远程，
 * 在于你浏览器里开着的任何一个标签页都能向 127.0.0.1 发请求。
 */

import assert from "node:assert/strict"
import test from "node:test"

import { isOwnOrigin } from "../src/origin.js"

const OWN = "http://127.0.0.1:50865"

test("没有 Origin：curl / 本地脚本 / 宿主自己 → 放行", () => {
  assert.equal(isOwnOrigin({ headers: {} }, OWN), true)
  assert.equal(isOwnOrigin({ headers: { origin: "" } }, OWN), true)
  assert.equal(isOwnOrigin({}, OWN), true)
})

test("同源放行，跨站拒绝（含端口不同）", () => {
  assert.equal(isOwnOrigin({ headers: { origin: OWN } }, OWN), true)
  assert.equal(isOwnOrigin({ headers: { origin: "http://127.0.0.1:8080" } }, OWN), false)
  assert.equal(isOwnOrigin({ headers: { origin: "https://evil.example" } }, OWN), false)
  assert.equal(isOwnOrigin({ headers: { origin: "https://127.0.0.1:50865" } }, OWN), false, "协议不同也不是同源")
})

test("Origin: null 一律拒绝——那是沙箱 iframe / opaque origin", () => {
  assert.equal(isOwnOrigin({ headers: { origin: "null" } }, OWN), false)
  assert.equal(isOwnOrigin({ headers: { origin: " NULL " } }, OWN), false)
})

test("宿主拿不到自己的 origin 时放行（靠宿主的连接准入兜底）", () => {
  assert.equal(isOwnOrigin({ headers: { origin: "http://127.0.0.1:50865" } }, undefined), true)
  assert.equal(isOwnOrigin({ headers: { origin: "http://127.0.0.1:50865" } }, ""), true)
})

test("Origin 头畸形（不是合法 URL）→ 拒绝，不猜", () => {
  assert.equal(isOwnOrigin({ headers: { origin: "不是URL" } }, OWN), false)
})

test("重复的 Origin 头（数组）取第一个，不因为数组就放行", () => {
  assert.equal(isOwnOrigin({ headers: { origin: ["http://127.0.0.1:50865", "https://evil.example"] } }, OWN), true)
  assert.equal(isOwnOrigin({ headers: { origin: ["https://evil.example"] } }, OWN), false)
})
