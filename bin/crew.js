#!/usr/bin/env node
/**
 * crew —— 不进 UI 也能管花名册的终端入口。
 *
 * 面板还没做出来的时候，这是唯一顺手的建 Bot 方式；面板做好之后它仍然有用：
 * 备份、批量改、脚本里用。
 *
 * 数据目录与插件一致：$DSH_CREW_DIR，否则 ~/.dsh/crew。
 *
 * 用法：
 *   crew list
 *   crew add <id> --name 小文 --role 口播稿 --persona "..." --cwd ~/some/dir [--bash]
 *   crew show <id>
 *   crew memory <id>                 打印记忆
 *   crew memory <id> --append "..."  追加一条记忆
 *   crew rm <id>                     只删档案，不删工作目录
 *   crew goal <id>                   看这个 Bot 的目标、轮次、死路
 *   crew routine <id>                列出它录下的套路
 *   crew routine <id> <slug>         看某一条套路的全文
 */

import { parseArgs } from "node:util"

import { BotRegistry, expandPath } from "../src/registry.js"

const registry = new BotRegistry(process.env.DSH_CREW_DIR || "")

function formatBot(bot) {
  const flags = [bot.fault ? "坏档" : "", bot.allowBash ? "可执行命令" : "", bot.cwd === "" ? "无工作目录" : ""]
    .filter(Boolean)
    .join(" · ")
  const head = `${bot.id.padEnd(16)} ${bot.name}${bot.role === "" ? "" : ` — ${bot.role}`}`
  return flags === "" ? head : `${head}  [${flags}]`
}

async function main(argv) {
  const [command, ...rest] = argv

  if (command === undefined || command === "-h" || command === "--help") {
    console.log(`用法：
  crew list
  crew add <id> --name <名字> [--role <角色>] [--persona <人格>] [--cwd <目录>] [--bash]
  crew show <id>
  crew memory <id> [--append <文本>]
  crew rm <id>
  crew goal <id>
  crew routine <id> [<slug>]

数据目录：${registry.dataDir}`)
    return 0
  }

  if (command === "list") {
    const [bots, state] = await Promise.all([registry.list(), registry.readState()])
    if (bots.length === 0) {
      console.log("花名册是空的。用 `crew add <id> --name <名字>` 建第一个 Bot。")
      return 0
    }
    for (const bot of bots) {
      const runtime = state.bots[bot.id]
      const suffix = runtime?.state ? `  ← ${runtime.state}` : ""
      console.log(formatBot(bot) + suffix)
    }
    return 0
  }

  if (command === "add") {
    const id = rest[0]
    if (id === undefined) throw new Error("crew add 需要一个 id")
    const { values } = parseArgs({
      args: rest.slice(1),
      options: {
        name: { type: "string" },
        role: { type: "string" },
        persona: { type: "string" },
        cwd: { type: "string" },
        bash: { type: "boolean", default: false },
      },
      strict: false,
    })
    let existing = undefined
    try {
      existing = await registry.read(id)
    } catch {
      existing = undefined
    }
    const bot = await registry.save({
      ...(existing ?? {}),
      id,
      name: values.name ?? existing?.name ?? id,
      role: values.role ?? existing?.role ?? "",
      persona: values.persona ?? existing?.persona ?? "",
      cwd: values.cwd ?? existing?.cwd ?? "",
      allowBash: values.bash || existing?.allowBash === true,
    })
    console.log(`已写入 ${registry.botFile(bot.id)}`)
    console.log(formatBot(bot))
    return 0
  }

  if (command === "show") {
    const id = rest[0]
    if (id === undefined) throw new Error("crew show 需要一个 id")
    const bot = await registry.read(id)
    console.log(JSON.stringify(bot, null, 2))
    return 0
  }

  if (command === "memory") {
    const id = rest[0]
    if (id === undefined) throw new Error("crew memory 需要一个 id")
    const { values } = parseArgs({
      args: rest.slice(1),
      options: { append: { type: "string" } },
      strict: false,
    })
    if (values.append !== undefined) {
      const ok = await registry.appendMemory(id, values.append)
      console.log(ok ? "已追加" : "空文本，没写")
      return 0
    }
    const text = await registry.readMemory(id)
    console.log(text === "" ? "（还没有记忆）" : text.trimEnd())
    return 0
  }

  if (command === "rm") {
    const id = rest[0]
    if (id === undefined) throw new Error("crew rm 需要一个 id")
    const bot = await registry.read(id)
    if (bot.cwd !== "") console.log(`注意：只删档案，工作目录 ${bot.cwd} 保持不动`)
    await registry.remove(id)
    console.log(`已删除 ${id}`)
    return 0
  }

  if (command === "goal") {
    const id = rest[0]
    if (id === undefined) throw new Error("crew goal 需要一个 id")
    const { GoalStore } = await import("../src/goal.js")
    const goals = new GoalStore(registry)
    if (!(await goals.exists(id))) {
      console.log("这个 Bot 还没有目标。")
      return 0
    }
    const goal = await goals.read(id)
    console.log(`目标：${goal.objective}`)
    console.log(`状态：${goal.status}${goal.note === "" ? "" : `（${goal.note}）`}`)
    console.log(`轮次：${goal.rounds.length} 轮 · 死路 ${goal.deadEnds.length} 条 · 今日花费 ${goal.budget.spentCny === 0 ? "未接" : `约 ¥${goal.budget.spentCny.toFixed(2)}`}`)
    if (goal.acceptance.length > 0) {
      console.log("验收：")
      for (const check of goal.acceptance) console.log(`  - [${check.kind}] ${check.label}`)
    }
    for (const round of goal.rounds.slice(-5)) {
      console.log(`  · 第 ${round.n} 轮 ${round.outcome}${round.note === "" ? "" : `：${round.note.slice(0, 80)}`}`)
    }
    return 0
  }

  if (command === "routine") {
    const id = rest[0]
    if (id === undefined) throw new Error("crew routine 需要一个 id")
    const slug = rest[1]
    if (slug === undefined) {
      const routines = await registry.listRoutines(id)
      if (routines.length === 0) {
        console.log("还没有录下任何套路。让它跑通一次活，会自动生成草稿。")
        return 0
      }
      for (const routine of routines) {
        console.log(`${routine.slug.padEnd(28)} [${routine.status}] ${routine.title}`)
      }
      return 0
    }
    process.stdout.write(await registry.readRoutine(id, slug))
    return 0
  }

  throw new Error(`不认识的命令：${command}`)
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    console.error(`crew: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  },
)
