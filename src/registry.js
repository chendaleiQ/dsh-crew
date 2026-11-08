/**
 * Bot 花名册的磁盘格式与读写。
 *
 * 这一层刻意**不依赖任何 DSH API**：它只认文件系统，所以能单独跑测试，
 * 也能被宿主插件、命令行脚本、备份工具共用。DSH 相关的编排逻辑放在
 * index.js / assign.js 里。
 *
 * 布局（默认 ~/.dsh/crew）：
 *   bots/<id>/bot.json   档案
 *   bots/<id>/memory.md  长期记忆，人可读可改
 *   state.json           运行态（哪个 Bot 跑着哪个会话）
 *
 * 设计取舍：
 * - 一个 Bot 一个目录，而不是一个 json 里塞全部：这样你直接用 Finder/编辑器
 *   就能改人格和记忆，插件不必提供一切编辑入口。
 * - bot.json 里只存「稳定事实」，运行态一律进 state.json，避免两个写者抢同一个文件。
 */

import { appendFile, mkdir, readFile, readdir, rename, rm, stat as statFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"

/** Bot id 的允许形状：小写字母数字和连字符，决定目录名，必须安全。 */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/

/** 没写任何工具配置时，Bot 默认能用的工具：先读写，命令类要显式给。 */
const DEFAULT_TOOLS = ["read", "glob", "grep", "write", "edit", "web_search", "web_fetch"]

/** 展开 ~ 与相对路径；空值回落到 fallback。 */
export function expandPath(value, fallback = "") {
  const text = typeof value === "string" ? value.trim() : ""
  if (text === "") return fallback
  if (text === "~") return homedir()
  if (text.startsWith("~/")) return join(homedir(), text.slice(2))
  return isAbsolute(text) ? text : resolve(text)
}

/** 校验并规范化 Bot id。 */
export function normalizeBotId(value) {
  const id = typeof value === "string" ? value.trim().toLowerCase() : ""
  if (!ID_PATTERN.test(id)) {
    throw new Error(`Bot id 不合法：${JSON.stringify(value)}（只允许小写字母、数字、连字符，1-32 位）`)
  }
  return id
}

/** 展示名兜底：没写名字就用 id。 */
function displayName(value, id) {
  const text = typeof value === "string" ? value.trim() : ""
  return text === "" ? id : text
}

/**
 * 把一份可能残缺的 bot.json 规范成内部形状。
 * 缺字段补默认值，缺到没法用的（id）直接抛错——宁可启动时报错，也不要养出一个半残的 Bot。
 */
export function normalizeBot(raw, { id: fallbackId = "" } = {}) {
  if (!raw || typeof raw !== "object") throw new Error("bot.json 必须是对象")
  const id = normalizeBotId(raw.id ?? fallbackId)
  const persona = typeof raw.persona === "string" ? raw.persona.trim() : ""
  const tools = Array.isArray(raw.tools) ? raw.tools.filter((t) => typeof t === "string" && t.trim() !== "").map((t) => t.trim()) : []
  const fault = raw.fault === true
  return {
    id,
    name: displayName(raw.name, id),
    role: typeof raw.role === "string" ? raw.role.trim() : "",
    persona,
    cwd: expandPath(raw.cwd),
    // provider/model 留空 = 跟随宿主当前的默认模型；填了就是这只 Bot 的专用模型。
    provider: typeof raw.provider === "string" ? raw.provider.trim() : "",
    model: typeof raw.model === "string" ? raw.model.trim() : "",
    preset: typeof raw.preset === "string" && raw.preset.trim() !== "" ? raw.preset.trim() : "standard",
    tools: tools.length > 0 ? [...new Set(tools)] : [...DEFAULT_TOOLS],
    allowBash: raw.allowBash === true,
    color: typeof raw.color === "string" ? raw.color.trim() : "",
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
    // 标记坏档：读取失败时用它占位，面板上要显眼，而不是静默消失。
    fault,
    faultReason: typeof raw.faultReason === "string" ? raw.faultReason : "",
  }
}

/**
 * 这个 Bot 实际被允许用的工具。
 *
 * `bot.tools` 是「白名单」，但 `bash` 单独由 `allowBash` 决定——因为它是唯一
 * 一个能造成不可逆后果的工具，不该靠一个容易漏改的数组顺带放开。
 */
export function effectiveTools(bot) {
  const base = Array.isArray(bot?.tools) ? bot.tools : [...DEFAULT_TOOLS]
  const tools = new Set(base.filter((name) => typeof name === "string" && name.trim() !== "").map((name) => name.trim()))
  if (bot?.allowBash === true) tools.add("bash")
  else tools.delete("bash")
  return [...tools]
}

/** 序列化回磁盘时的字段顺序，diff 友好。 */
function toDisk(bot) {
  return {
    id: bot.id,
    name: bot.name,
    role: bot.role,
    persona: bot.persona,
    cwd: bot.cwd,
    provider: bot.provider,
    model: bot.model,
    preset: bot.preset,
    tools: bot.tools,
    allowBash: bot.allowBash,
    color: bot.color,
    createdAt: bot.createdAt,
    updatedAt: bot.updatedAt,
  }
}

/** 写文件先写临时文件再 rename，避免半截 JSON 被读到。 */
async function writeJsonAtomic(file, value) {
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8")
  await rename(temp, file)
}

export class BotRegistry {
  constructor(dataDir) {
    this.dataDir = expandPath(dataDir, join(homedir(), ".dsh", "crew"))
    this.botsDir = join(this.dataDir, "bots")
    this.statePath = join(this.dataDir, "state.json")
  }

  /** 首次使用时把目录建好。幂等。 */
  async ensure() {
    await mkdir(this.botsDir, { recursive: true })
    return this
  }

  botDir(id) {
    return join(this.botsDir, normalizeBotId(id))
  }

  botFile(id) {
    return join(this.botDir(id), "bot.json")
  }

  memoryFile(id) {
    return join(this.botDir(id), "memory.md")
  }

  /** 列出全部 Bot；单个档坏了不影响其他 Bot，坏档以 fault 形式返回。 */
  async list() {
    await this.ensure()
    const entries = await readdir(this.botsDir, { withFileTypes: true })
    const bots = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const id = entry.name
      try {
        bots.push(await this.read(id))
      } catch (error) {
        bots.push({
          ...normalizeBot({ id }),
          fault: true,
          faultReason: error instanceof Error ? error.message : String(error),
        })
      }
    }
    bots.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    return bots
  }

  async read(id) {
    const file = this.botFile(id)
    const text = await readFile(file, "utf8")
    let raw
    try {
      raw = JSON.parse(text)
    } catch (error) {
      throw new Error(`bot.json 解析失败（${file}）：${error instanceof Error ? error.message : String(error)}`)
    }
    return normalizeBot(raw, { id })
  }

  /** 新建或更新。新建时会一并建目录、写一份空的 memory.md。 */
  async save(input) {
    const bot = normalizeBot({ ...input, updatedAt: new Date().toISOString() })
    await mkdir(this.botDir(bot.id), { recursive: true })
    await writeJsonAtomic(this.botFile(bot.id), toDisk(bot))
    try {
      await readFile(this.memoryFile(bot.id), "utf8")
    } catch {
      await writeFile(this.memoryFile(bot.id), `# ${bot.name} 的记忆\n\n<!-- 这个文件人可读可改，Bot 每次开工前会读它。 -->\n`, "utf8")
    }
    return bot
  }

  /** 删档。默认只删档案目录，Bot 的工作目录不动（那是你的东西）。 */
  async remove(id) {
    await rm(this.botDir(id), { recursive: true, force: true })
  }

  async readMemory(id) {
    try {
      return await readFile(this.memoryFile(id), "utf8")
    } catch {
      return ""
    }
  }

  /** 档案还在不在（删档后各种后台写操作都要先问这一句，否则会把目录重新建出来）。 */
  async exists(id) {
    try {
      await readFile(this.botFile(id), "utf8")
      return true
    } catch {
      return false
    }
  }

  /** 追加一条带时间戳的记忆。空文本忽略；档案已删则不写（避免复活一个空壳 Bot）。 */
  async appendMemory(id, text) {
    const body = typeof text === "string" ? text.trim() : ""
    if (body === "") return false
    if (!(await this.exists(id))) return false
    await this.ensure()
    const line = `\n## ${new Date().toISOString().slice(0, 16).replace("T", " ")}\n\n${body}\n`
    const previous = await this.readMemory(id)
    await writeFile(this.memoryFile(id), `${previous}${line}`, "utf8")
    return true
  }

  /** 归档文件路径：被压缩掉的记忆明细都进这里，保留可追溯性。 */
  archiveFile(id) {
    return join(this.botDir(id), "memory.archive.md")
  }

  /**
   * 压缩一个 Bot 的记忆。
   *
   * 顺序很重要：**先把要归档的明细写进 archive，再覆写 memory.md**。
   * 反过来的话，中途断电就真的丢了。
   */
  async compactMemory(id, limits = {}) {
    const botId = normalizeBotId(id)
    if (!(await this.exists(botId))) return { changed: false, summary: "档案已删除，跳过压缩" }
    const text = await this.readMemory(botId)
    const { needsCompaction, compactMemory } = await import("./memory.js")
    const verdict = needsCompaction(text, limits)
    if (!verdict.needed) return { changed: false, summary: verdict.reason === "" ? "不需要压缩" : verdict.reason }

    const result = compactMemory(text, limits)
    if (!result.changed) return { changed: false, summary: result.summary }

    const archive = this.archiveFile(botId)
    const stamp = new Date().toISOString()
    const body = result.archived.map((entry) => `### ${entry.at}${entry.body === "" ? "" : `\n${entry.body}`}`).join("\n\n")
    await appendFile(archive, `\n<!-- 归档于 ${stamp} -->\n${body}\n`, "utf8")
    await writeFile(this.memoryFile(botId), result.text, "utf8")
    return { changed: true, summary: result.summary, archivedPath: archive }
  }

  /** 一个 Bot 的 routine 目录：跑通的套路放这儿，下次开工前会被列进系统提示。 */
  routinesDir(id) {
    return join(this.botDir(normalizeBotId(id)), "routines")
  }

  routineFile(id, slug) {
    const safe = String(slug ?? "").replace(/[^a-z0-9-]/gu, "")
    if (safe === "") throw new Error("routine 的 slug 不合法")
    return join(this.routinesDir(id), `${safe}.md`)
  }

  /** 写一份 routine。同名直接覆盖（同一个任务重跑通了就更新那一份）。 */
  async saveRoutine(id, routine) {
    const dir = this.routinesDir(id)
    await mkdir(dir, { recursive: true })
    await writeFile(this.routineFile(id, routine.slug), routine.text, "utf8")
    await this.#pruneRoutines(id).catch(() => {})
    return routine
  }

  /**
   * 草稿太多就按最旧的清掉，但**永不动 confirmed**。
   *
   * 自动录的草稿是"可能有用"，你确认过的才是"确实有用"；把后者清掉等于失忆。
   * 上限只约束草稿，所以长跑不会无限堆文件，也不会把你认可的东西弄丢。
   */
  async #pruneRoutines(id, maxDrafts = 40) {
    const dir = this.routinesDir(id)
    const { parseRoutine } = await import("./routine.js")
    const entries = await readdir(dir).catch(() => [])
    const drafts = []
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue
      const file = join(dir, entry)
      try {
        const [text, stat] = await Promise.all([readFile(file, "utf8"), statFile(file)])
        if (parseRoutine(entry.replace(/\.md$/u, ""), text).status === "confirmed") continue
        drafts.push({ file, at: stat.mtimeMs })
      } catch {
        /* 读不到就跳过，不在清理路径上抛错 */
      }
    }
    if (drafts.length <= maxDrafts) return 0
    drafts.sort((left, right) => left.at - right.at)
    const doomed = drafts.slice(0, drafts.length - maxDrafts)
    for (const item of doomed) await rm(item.file, { force: true }).catch(() => {})
    return doomed.length
  }

  /** 列出 routine 摘要（按文件名排序，稳定）。 */
  async listRoutines(id) {
    const dir = this.routinesDir(id)
    let entries
    try {
      entries = await readdir(dir)
    } catch {
      return []
    }
    const { parseRoutine } = await import("./routine.js")
    const routines = []
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue
      try {
        const text = await readFile(join(dir, entry), "utf8")
        routines.push(parseRoutine(entry.replace(/\.md$/u, ""), text))
      } catch {
        // 单个坏文件不该让整张清单消失
      }
    }
    return routines.sort((left, right) => left.slug.localeCompare(right.slug))
  }

  async readRoutine(id, slug) {
    return readFile(this.routineFile(id, slug), "utf8")
  }

  /** 运行态：{ bots: { <id>: { sessionId, state, taskId, since, lastResult } } } */
  async readState() {
    try {
      const text = await readFile(this.statePath, "utf8")
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed === "object" && parsed.bots && typeof parsed.bots === "object") return parsed
    } catch {
      // 没状态文件、或文件坏了，都从空状态起步：运行态可以丢，档案不能丢。
    }
    return { bots: {} }
  }

  async writeState(state) {
    await this.ensure()
    await writeJsonAtomic(this.statePath, state ?? { bots: {} })
  }

  /** 只改一个 Bot 的运行态，读改写一次，避免整份状态被覆盖。 */
  async patchState(id, patch) {
    const state = await this.readState()
    const key = normalizeBotId(id)
    state.bots[key] = { ...(state.bots[key] ?? {}), ...(patch ?? {}) }
    await this.writeState(state)
    return state.bots[key]
  }
}
