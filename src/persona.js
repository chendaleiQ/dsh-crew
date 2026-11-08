/**
 * 工作简报：把「这个 Bot 是谁」+「它记得什么」+「这次要它干什么」拼成一段
 * 干净的文本，作为它那个会话里的第一条用户消息。
 *
 * 为什么要有这一层而不是直接把任务丢进会话：
 * - DSH 的会话不带「人格」。要让同一个模型在不同 Bot 身上表现不同，
 *   必须在每次开工时把身份、边界、记忆显式喂进去。
 * - 这段文本是幂等的、可测的：不读磁盘、不碰网络，只做字符串组装。
 *
 * 取舍：简报宁短勿长。人格超过几百字模型就只记住开头；记忆超过一个预算
 * 就必须截断并明说「这是摘要」，否则它会拿三个月前的笔记当现状用。
 */

/** 人格描述在简报里的硬上限：再长模型就开始忽略后半段。 */
const PERSONA_LIMIT = 1200

/** 记忆注入的字符预算。超出时保留尾部（新笔记在后面），并标注被截断。 */
const MEMORY_LIMIT = 3000

/** 把多行文本压成「干净的一段」，去掉空行堆积和首尾空白。 */
function tidy(text) {
  return String(text ?? "")
    .replace(/\r\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim()
}

/** 按上限截断，并明确留下「被截断」的痕迹，避免模型以为那就是全部。 */
function clip(text, limit, note) {
  const body = tidy(text)
  if (body.length <= limit) return { text: body, clipped: false }
  return { text: `${body.slice(body.length - limit)}\n\n（${note}）`, clipped: true }
}

/**
 * 组装派活简报。
 *
 * @param {object} input
 * @param {object} input.bot      规范化的 Bot 档案（见 registry.js）
 * @param {string} [input.memory] 该 Bot 的 memory.md 内容
 * @param {string} input.task     这次要它做的事
 * @param {string} [input.extra]  额外的一次性交代（可选）
 * @returns {{ brief: string, personaClipped: boolean, memoryClipped: boolean }}
 */
export function composeBrief({ bot, memory = "", task = "", extra = "", includeIdentity = true } = {}) {
  if (!bot || typeof bot.id !== "string") throw new Error("composeBrief 需要一个已规范化的 Bot")
  const want = tidy(task)
  if (want === "") throw new Error("composeBrief 需要一句具体任务")

  const persona = clip(bot.persona, PERSONA_LIMIT, "人格描述过长，只保留最后一段")
  const memo = clip(memory, MEMORY_LIMIT, "记忆被截断，只保留最近的笔记")

  const lines = []
  if (includeIdentity) {
    lines.push(`# 你的身份：${bot.name}${bot.role === "" ? "" : `（${bot.role}）`}`)
    if (persona.text !== "") lines.push(persona.text)
    else lines.push("（这个 Bot 还没有写人格。按通用助手行事，别猜自己的设定。）")
    lines.push(
      "",
      "## 边界",
      bot.cwd === "" ? "- 工作目录未指定：只做只读的调研和写作，不要写文件。" : `- 工作目录：${bot.cwd}。可以在里面读写，但不要动目录外的任何东西。`,
      bot.allowBash ? "- 允许执行命令，但破坏性操作先说明再动手。" : "- 不要执行 shell 命令；需要跑命令时，把命令写进交付说明里让人来跑。",
      "- 需要审批的操作照常请求审批，不要绕过。",
    )
    if (memo.text !== "") {
      lines.push(
        "",
        "## 你之前记下的事",
        memo.text,
        "",
        "这些是你过去的笔记，可能过期。与当下事实冲突时，以当下为准，并在交付里指出冲突。",
      )
    }
  }

  if (tidy(extra) !== "") lines.push("", "## 额外的交代", tidy(extra))

  lines.push(
    "",
    "## 这次要做的活",
    want,
    "",
    "## 交付",
    "- 结论先行，第一段就说做完了没有 / 结论是什么。",
    "- 写清楚改了哪些文件（路径），或者为什么没改。",
    "- 不确定的地方直接说不确定，不要编造已经验证过。",
  )

  return {
    brief: lines.join("\n"),
    personaClipped: persona.clipped,
    memoryClipped: memo.clipped,
  }
}

/**
 * 系统提示：身份、边界、记忆。
 *
 * 为什么要单列一份而不是全塞进第一条用户消息：模型对 system 的服从度高于
 * 用户消息里自称的身份（后者更像"某个人说他是谁"）。所以正式的身份和边界
 * 走 system，具体任务走用户消息——两边不重复，省下的 token 才是真省的。
 */
export function composeSystemPrompt({ bot, memory = "", routines = [] } = {}) {
  if (!bot || typeof bot.id !== "string") throw new Error("composeSystemPrompt 需要一个已规范化的 Bot")
  const persona = clip(bot.persona, PERSONA_LIMIT, "人格描述过长，只保留最后一段")
  const memo = clip(memory, MEMORY_LIMIT, "记忆被截断，只保留最近的笔记")

  const lines = [
    `你是 ${bot.name}${bot.role === "" ? "" : `（${bot.role}）`}，一个只在这台机器上工作的 Bot。`,
    persona.text === "" ? "（还没有写人格。按通用助手行事，别猜自己的设定。）" : persona.text,
    "",
    "## 边界",
    bot.cwd === "" ? "- 工作目录未指定：只做只读的调研和写作，不要写文件。" : `- 工作目录：${bot.cwd}。可以在里面读写，但不要动目录外的任何东西。`,
    bot.allowBash ? "- 允许执行命令，但破坏性操作先说明再动手。" : "- 不要执行 shell 命令；需要跑命令时，把命令写进交付说明里让人来跑。",
    "- 需要审批的操作照常请求审批，不要绕过。",
  ]
  if (Array.isArray(routines) && routines.length > 0) {
    lines.push("", "## 你验证过的套路（同类任务先照着走，别重新发明）")
    for (const routine of routines.slice(0, 12)) {
      const when = routine.when === "" ? "" : ` — 适用：${routine.when.slice(0, 80)}`
      lines.push(`- ${routine.title}${routine.status === "draft" ? "（草稿，未确认）" : ""}${when}`)
    }
    lines.push("（明细在你目录的 routines/ 下，需要时自己去读。）")
  }
  if (memo.text !== "") {
    lines.push(
      "",
      "## 你之前记下的事",
      memo.text,
      "",
      "这些是你过去的笔记，可能过期。与当下事实冲突时，以当下为准，并在交付里指出冲突。",
    )
  }
  return { text: lines.join("\n"), personaClipped: persona.clipped, memoryClipped: memo.clipped }
}
