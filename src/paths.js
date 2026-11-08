/**
 * 路径边界：哪些地方 Bot 可以写。
 *
 * 起因是一个真实的权限升级口子：
 * 验收条件里的 `run:` 命令由**宿主进程**执行（`checkAcceptance` 用 execFile），
 * 而 goal.json 就放在 Bot 自己的目录里。于是一个没开 `allowBash` 的 Bot，
 * 只要能用 write 改掉自己的 goal.json，下一轮就能让宿主替它跑任意命令。
 *
 * 所以：**写入只能落在它自己的工作目录里，而且永远不许碰 crew 自己的数据目录。**
 * 读取放宽（读文档是正常需求），执行命令不看路径（由 allowBash 单独管）。
 */

import { homedir } from "node:os"
import { isAbsolute, relative, resolve } from "node:path"

/** crew 自己的数据目录：Bot 绝对不该写这里（目标、状态、记忆都在里面）。 */
export function crewDataDir() {
  return resolve(homedir(), ".dsh", "crew")
}

/** 目标路径是否落在某个根目录之内（相等也算在内）。 */
export function isInside(target, root) {
  const resolvedTarget = resolve(target)
  const resolvedRoot = resolve(root)
  const rel = relative(resolvedRoot, resolvedTarget)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

/**
 * 判断一次写入是否被允许。
 *
 * @param {object} input
 * @param {string} input.target 要写的路径（read/write/edit 的 file_path）
 * @param {string} input.cwd    Bot 的工作目录
 * @returns {{ ok: boolean, reason?: string }}
 */
export function checkWriteTarget({ target, cwd }) {
  const text = typeof target === "string" ? target.trim() : ""
  if (text === "") return { ok: false, reason: "没有给路径，拒绝写入" }
  if (cwd === undefined || cwd === null || String(cwd).trim() === "") {
    return { ok: false, reason: "这个 Bot 没有工作目录，不允许写文件" }
  }
  const resolved = resolve(String(cwd), text)
  if (!isInside(resolved, cwd)) {
    return { ok: false, reason: `只能在自己的工作目录里写：${cwd}` }
  }
  if (isInside(resolved, crewDataDir())) {
    return { ok: false, reason: "crew 自己的数据目录（目标/状态/记忆）不许 Bot 写" }
  }
  return { ok: true }
}

/** 写类工具：这些名字的参数里的路径要检查。 */
export const WRITE_TOOLS = new Set(["write", "edit", "apply_patch"])
