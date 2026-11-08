/**
 * 执行轨迹：把一轮会话里的工具调用压成「做过什么」。
 *
 * 为什么要这个：routine（可复用套路）如果让模型凭记忆复述一遍，它会把步骤写成
 * 它以为的样子——和真正跑通的那条路不是一回事。从 `tool/call` 事件里读，才是
 * **实际发生过**的路径。
 *
 * 真实事件形状（从会话日志核过）：
 *   {"type":"tool/call","data":{"callId":"…","name":"bash","arguments":"{\"command\":\"ls …\"}"}}
 * `arguments` 是 JSON 字符串，所以要自己 parse。
 */

/** 这些工具的参数里，哪个字段最能说明「它动了什么」。 */
const TARGET_FIELDS = {
  read: ["file_path", "path"],
  write: ["file_path", "path"],
  edit: ["file_path", "path"],
  glob: ["pattern", "path"],
  grep: ["pattern", "path"],
  bash: ["command"],
  web_fetch: ["url"],
  web_search: ["queries", "query"],
  crew_assign: ["task"],
}

/** 只读工具，不算"改了东西"。 */
const READ_ONLY = new Set(["read", "glob", "grep", "web_search", "web_fetch", "working_directory"])

/** 从一条 tool/call 里取出「目标」：参数优先，取不到就空着。 */
function targetOf(name, args) {
  const fields = TARGET_FIELDS[name] ?? ["file_path", "path", "command", "url", "query", "task"]
  for (const field of fields) {
    const value = args?.[field]
    if (typeof value === "string" && value.trim() !== "") return value.trim()
    if (Array.isArray(value) && value.length > 0) return value.map(String).join(" / ")
  }
  return ""
}

/** 参数是 JSON 字符串；解析失败就当没有。 */
function parseArguments(raw) {
  if (raw === null || raw === undefined) return {}
  if (typeof raw === "object") return raw
  try {
    const parsed = JSON.parse(String(raw))
    return parsed !== null && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * 把事件列表压成执行轨迹。
 *
 * 连续重复的同一调用会被合并（模型经常同一个 grep 连打三次），
 * 但间隔出现的会各留一条——那是因为中间做了别的事，是有意义的顺序。
 *
 * @returns {{ calls: Array<{name: string, target: string}>, counts: object, files: string[], commands: string[], touched: string[] }}
 */
export function summariseTrace(events = [], { limit = 60 } = {}) {
  const calls = []
  const counts = {}
  const files = []
  const commands = []

  for (const event of events) {
    if (event?.type !== "tool/call") continue
    const name = String(event?.data?.name ?? "").trim()
    if (name === "") continue
    const args = parseArguments(event?.data?.arguments)
    const target = targetOf(name, args)

    const previous = calls.at(-1)
    if (previous !== undefined && previous.name === name && previous.target === target) continue

    calls.push({ name, target })
    counts[name] = (counts[name] ?? 0) + 1
    if (name === "bash" && target !== "") commands.push(target)
    else if (["read", "write", "edit"].includes(name) && target !== "") files.push(target)
  }

  return {
    calls: calls.slice(0, limit),
    counts,
    files: [...new Set(files)],
    commands: [...new Set(commands)],
    /** 真正改动了东西的文件（写/改），不是只读过的。 */
    touched: [
      ...new Set(
        calls
          .filter((call) => call.name === "write" || call.name === "edit")
          .map((call) => call.target)
          .filter((target) => target !== ""),
      ),
    ],
  }
}

/** 轨迹是否「有东西可记」：只有一两条只读调用不算一步流程。 */
export function traceWorthRecording(trace) {
  if (trace === undefined || trace === null) return false
  const meaningful = trace.calls.filter((call) => !READ_ONLY.has(call.name))
  return trace.calls.length >= 3 || meaningful.length > 0
}
