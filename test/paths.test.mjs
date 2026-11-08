/**
 * 写入边界测试。
 *
 * 守的是一个真实的口子：验收里的 `run:` 由宿主进程执行，而 goal.json 在 Bot 目录里。
 * 只要 Bot 能写自己的 goal.json，没开 bash 也能让宿主替它跑命令。
 */

import assert from "node:assert/strict"
import { homedir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { WRITE_TOOLS, checkWriteTarget, crewDataDir, isInside, resolveRealTarget } from "../src/paths.js"

const CWD = "/Users/someone/work/project"

test("工作目录内放行，含相对路径与子目录", () => {
  assert.equal(checkWriteTarget({ target: `${CWD}/notes.md`, cwd: CWD }).ok, true)
  assert.equal(checkWriteTarget({ target: "notes.md", cwd: CWD }).ok, true)
  assert.equal(checkWriteTarget({ target: "sub/dir/file.txt", cwd: CWD }).ok, true)
  assert.equal(checkWriteTarget({ target: CWD, cwd: CWD }).ok, true)
})

test("工作目录外拒绝：这条挡的是「写到别处去」和「改自己的档案」", () => {
  const outside = checkWriteTarget({ target: "/tmp/evil.sh", cwd: CWD })
  assert.equal(outside.ok, false)
  assert.match(outside.reason, /只能在自己的工作目录里写/)

  const escape = checkWriteTarget({ target: "../../../etc/passwd", cwd: CWD })
  assert.equal(escape.ok, false)
})

test("crew 自己的数据目录永远拒绝（哪怕 cwd 就在里面）", () => {
  const crewBotDir = join(crewDataDir(), "bots", "writer")
  const verdict = checkWriteTarget({ target: join(crewBotDir, "goal.json"), cwd: crewBotDir })
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /crew 自己的数据目录/)
})

test("没给路径 / 没有工作目录：一律拒绝，不猜", () => {
  assert.equal(checkWriteTarget({ target: "", cwd: CWD }).ok, false)
  assert.equal(checkWriteTarget({ cwd: CWD }).ok, false)
  assert.equal(checkWriteTarget({ target: "a.md", cwd: "" }).ok, false)
  assert.equal(checkWriteTarget({ target: "a.md", cwd: undefined }).ok, false)
})

test("isInside 不会被前缀相同的目录骗到", () => {
  assert.equal(isInside("/a/b-c/file", "/a/b"), false, "/a/b-c 不属于 /a/b")
  assert.equal(isInside("/a/b/file", "/a/b"), true)
  assert.equal(isInside("/a/b", "/a/b"), true)
})

test("写类工具清单包含 write/edit，别漏了改文件这个动作", () => {
  assert.ok(WRITE_TOOLS.has("write"))
  assert.ok(WRITE_TOOLS.has("edit"))
  assert.equal(WRITE_TOOLS.has("read"), false)
})

test("数据目录固定在 ~/.dsh/crew", () => {
  assert.equal(crewDataDir(), join(homedir(), ".dsh", "crew"))
})

test("软链：工作目录写成 /tmp/x、真实目标是 /private/tmp/x，仍然算目录内", async () => {
  const { mkdtemp, mkdir, rm, symlink } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const base = await mkdtemp(join(tmpdir(), "crew-link-"))
  try {
    const real = join(base, "real")
    const link = join(base, "link")
    await mkdir(real)
    await symlink(real, link)

    // 通过软链写新文件：目标还不存在，必须按真实路径判
    const verdict = checkWriteTarget({ target: join(link, "new.md"), cwd: link })
    assert.equal(verdict.ok, true, "软链内的新文件不该被拦")

    // 真实路径与软链路径混着用也一样
    assert.equal(checkWriteTarget({ target: join(real, "other.md"), cwd: link }).ok, true)
    assert.equal(checkWriteTarget({ target: join(link, "x.md"), cwd: real }).ok, true)

    // 软链外面还是不许写
    assert.equal(checkWriteTarget({ target: join(base, "escape.md"), cwd: link }).ok, false)

    // resolveRealTarget 对已存在与不存在的路径都给出一致结果（按真实路径，含 /var → /private/var）
    const { realpathSync } = await import("node:fs")
    assert.equal(resolveRealTarget("new.md", link), join(realpathSync(real), "new.md"))
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
