/**
 * CLI 测试：真的 spawn `node bin/crew.js`，不是 mock。
 *
 * 为什么值得：CLI 是这条插件唯一不依赖 UI 的入口，而它一旦坏了没人会发现
 * （面板正常、接口正常，就命令行哑了）。所以这里跑真进程，断言退出码和输出。
 */

import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { BotRegistry } from "../src/registry.js"
import { GoalStore } from "../src/goal.js"
import { buildRoutine } from "../src/routine.js"

const run = promisify(execFile)
const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const BIN = join(root, "bin", "crew.js")

/** 跑一次 CLI，返回 { code, out, err }；非零退出不抛，交给测试自己判断。 */
async function crew(dataDir, args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [BIN, ...args], {
      env: { ...process.env, DSH_CREW_DIR: dataDir },
    })
    return { code: 0, out: stdout, err: stderr }
  } catch (error) {
    return { code: error.code ?? 1, out: error.stdout ?? "", err: error.stderr ?? "" }
  }
}

async function withDataDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "crew-cli-"))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test("空花名册：list 会告诉你下一步做什么", async () => {
  await withDataDir(async (dir) => {
    const { code, out } = await crew(dir, ["list"])
    assert.equal(code, 0)
    assert.match(out, /花名册是空的/)
    assert.match(out, /crew add/)
  })
})

test("add → show → memory 全链路，且重复 add 只写 id 会被挡", async () => {
  await withDataDir(async (dir) => {
    const added = await crew(dir, ["add", "w", "--name", "甲", "--cwd", "/tmp", "--persona", "旧人格"])
    assert.equal(added.code, 0)
    assert.match(added.out, /已写入/)

    const dup = await crew(dir, ["add", "w"])
    assert.equal(dup.code, 1, "只写 id 的重复添加必须被挡")
    assert.match(dup.out, /已经存在/)
    assert.match(dup.out, /旧人格/)

    // 带了字段就是有意更新，且合并语义保留没提到的字段
    const updated = await crew(dir, ["add", "w", "--name", "乙"])
    assert.equal(updated.code, 0)
    const shown = await crew(dir, ["show", "w"])
    const bot = JSON.parse(shown.out)
    assert.equal(bot.name, "乙")
    assert.equal(bot.persona, "旧人格")

    assert.match((await crew(dir, ["memory", "w", "--append", "偏好：结论先行"])).out, /已追加/)
    assert.match((await crew(dir, ["memory", "w"])).out, /偏好：结论先行/)
  })
})

test("非法 id：报错并给非零退出码", async () => {
  await withDataDir(async (dir) => {
    const { code, err } = await crew(dir, ["add", "有空格 的", "--name", "x"])
    assert.equal(code, 1)
    assert.match(err, /不合法/)
  })
})

test("goal 与 routine：没有时给提示，有时能读", async () => {
  await withDataDir(async (dir) => {
    await crew(dir, ["add", "w", "--name", "甲", "--cwd", "/tmp"])
    assert.match((await crew(dir, ["goal", "w"])).out, /还没有目标/)
    assert.match((await crew(dir, ["routine", "w"])).out, /还没有录下任何套路/)

    const registry = new BotRegistry(dir)
    const goals = new GoalStore(registry)
    await goals.create({ botId: "w", objective: "把首页改完", acceptance: [{ kind: "manual", hint: "看一眼" }] })
    await registry.saveRoutine(
      "w",
      buildRoutine({ task: "跑通一次", result: "好了", trace: { calls: [{ name: "write", target: "/tmp/x" }], touched: ["/tmp/x"] } }),
    )

    const goalOut = (await crew(dir, ["goal", "w"])).out
    assert.match(goalOut, /把首页改完/)
    assert.match(goalOut, /验收/)
    const routineList = (await crew(dir, ["routine", "w"])).out
    assert.match(routineList, /draft/)
    const slug = routineList.trim().split(/\s+/u)[0]
    assert.match((await crew(dir, ["routine", "w", slug])).out, /跑通的步骤/)
  })
})

test("rm：删档但不动工作目录", async () => {
  await withDataDir(async (dir) => {
    await crew(dir, ["add", "w", "--name", "甲", "--cwd", "/tmp"])
    const removed = await crew(dir, ["rm", "w"])
    assert.equal(removed.code, 0)
    assert.match(removed.out, /只删档案/)
    const list = await crew(dir, ["list"])
    assert.match(list.out, /花名册是空的/)
  })
})

test("坏档不会让 list 崩掉，而是标出来", async () => {
  await withDataDir(async (dir) => {
    await crew(dir, ["add", "w", "--name", "甲", "--cwd", "/tmp"])
    await writeFile(join(dir, "bots", "broken", "bot.json"), "{ 不是 JSON", "utf8").catch(async () => {
      const { mkdir } = await import("node:fs/promises")
      await mkdir(join(dir, "bots", "broken"), { recursive: true })
      await writeFile(join(dir, "bots", "broken", "bot.json"), "{ 不是 JSON", "utf8")
    })
    const { code, out } = await crew(dir, ["list"])
    assert.equal(code, 0)
    assert.match(out, /坏档/)
  })
})
