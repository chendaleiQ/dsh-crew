/**
 * 记忆压缩：让一个 Bot 的记忆能长期用下去，而不是越跑越贵。
 *
 * 为什么必须做：目标循环每一轮都会把 memory.md 的尾部（最多 3000 字）注入 system prompt。
 * 不压缩的话，跑五十轮以后每轮都在读一篇越来越长、越来越没用的流水账——
 * 又贵又糊，还会让「最近的结论」被稀释。
 *
 * 两条铁律：
 * 1. **压缩不等于丢弃**：被归档的条目先写进 memory.archive.md，事后还能翻。
 * 2. **机械压缩不编内容**：这里不调模型、不总结语义，只做「保留最近的 + 置顶的，
 *    其余折成一行结论」——错的摘要比没有摘要更糟，所以宁可只搬运，不创作。
 *
 * 需要真正「提炼成几句话」时再挂模型，那是后面的事，进来只需替换 summarise()。
 */

/** 条目头：我们 appendMemory 写的是 `## 2026-11-08 18:40`。 */
const ENTRY_HEAD = /^##\s+(\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2})?)\s*$/

/** 置顶标记：写在条目正文里，压缩时永远不归档。 */
const PIN_MARK = "[pin]"

/**
 * 默认阈值。
 *
 * 关键约束：注入预算只有 3000 字（persona.js 的 MEMORY_LIMIT），所以记忆文件一旦
 * 远超这个数，超出的部分**永远不会被读到**——那只是白占磁盘、白让人错觉"记了很多"。
 * 所以阈值定在注入预算的 2 倍：留一点余量给上下文，再多就该归档了。
 */
export const DEFAULT_LIMITS = { maxChars: 6_000, maxEntries: 30, keepRecent: 10 }

/**
 * 把 memory.md 切成「文件头 + 条目」。
 *
 * 文件头是第一个条目之前的内容（我们写的是 `# 小文 的记忆` + 一段注释），
 * 它每次都保留；条目按出现顺序排。
 */
export function parseMemory(text) {
  const source = String(text ?? "")
  const lines = source.split("\n")
  const header = []
  const entries = []
  let current = null
  for (const line of lines) {
    const head = ENTRY_HEAD.exec(line)
    if (head !== null) {
      if (current !== null) entries.push(current)
      current = { at: head[1], body: [] }
      continue
    }
    if (current === null) header.push(line)
    else current.body.push(line)
  }
  if (current !== null) entries.push(current)
  return {
    header: header.join("\n").trim(),
    entries: entries.map((entry) => ({ at: entry.at, body: entry.body.join("\n").trim() })),
  }
}

/** 一条记忆的「一行结论」：取第一条非空正文，压平截断。 */
export function summarise(entry) {
  const line = String(entry?.body ?? "")
    .split("\n")
    .map((item) => item.trim())
    .find((item) => item !== "" && item !== PIN_MARK)
  if (line === undefined) return "（空条目）"
  const flat = line.replace(/\s+/gu, " ")
  return flat.length > 120 ? `${flat.slice(0, 119)}…` : flat
}

/** 是否该压缩。返回原因，方便面板/日志说人话。 */
export function needsCompaction(text, limits = {}) {
  const { maxChars, maxEntries } = { ...DEFAULT_LIMITS, ...limits }
  const parsed = parseMemory(text)
  if (parsed.entries.length > maxEntries) {
    return { needed: true, reason: `条目 ${parsed.entries.length} 条，超过 ${maxEntries}` }
  }
  if (String(text ?? "").length > maxChars) {
    return { needed: true, reason: `正文 ${String(text).length} 字，超过 ${maxChars}` }
  }
  return { needed: false, reason: "" }
}

/**
 * 机械压缩：保留置顶条目 + 最近 keepRecent 条，其余折成一行一条的「早期摘要」。
 *
 * @returns {{ text: string, archived: Array<{at: string, body: string}>, changed: boolean, summary: string }}
 */
export function compactMemory(text, limits = {}) {
  const { keepRecent } = { ...DEFAULT_LIMITS, ...limits }
  const parsed = parseMemory(String(text ?? ""))
  const total = parsed.entries.length
  if (total <= keepRecent) {
    return { text: String(text ?? ""), archived: [], changed: false, summary: "条目不多，不用压缩" }
  }

  const recent = parsed.entries.slice(total - keepRecent)
  const older = parsed.entries.slice(0, total - keepRecent)
  const pinned = older.filter((entry) => entry.body.includes(PIN_MARK))
  const archived = older.filter((entry) => !entry.body.includes(PIN_MARK))

  const parts = []
  if (parsed.header !== "") parts.push(parsed.header)

  if (archived.length > 0) {
    parts.push(
      `## 早期摘要（已归档 ${archived.length} 条，明细见 memory.archive.md）`,
      ...archived.map((entry) => `- ${entry.at} ${summarise(entry)}`),
    )
  }
  if (pinned.length > 0) {
    parts.push("## 置顶（不归档）", ...pinned.map((entry) => `## ${entry.at}\n${entry.body}`))
  }
  parts.push(...recent.map((entry) => `## ${entry.at}\n${entry.body}`))

  return {
    text: `${parts.join("\n\n").trimEnd()}\n`,
    archived,
    changed: archived.length > 0,
    summary: archived.length > 0 ? `归档 ${archived.length} 条，保留最近 ${recent.length} 条` : "只有置顶可归档",
  }
}
