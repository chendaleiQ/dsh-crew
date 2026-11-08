/**
 * 一致性守卫：包名和版本号在四个地方各写了一遍，漂了就装不上。
 *
 * 这四处必须是同一个值：
 *   1. package.json 的 name / version
 *   2. cordis.patch.yml 里 loader 行的 name（宿主按它找包）
 *   3. src/index.js 的 `export const name`（宿主按它核对）
 *   4. lib/client.js 的模块 id 与 VERSION（渲染侧按它注册、面板按 VERSION 显示）
 *
 * 同门项目里这条是靠 CI 的 tag 校验兜的；这里也在本地钉一遍，改版本时不用靠记性。
 */

import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const read = (path) => readFile(join(root, path), "utf8")

test("包名在 package.json / patch / 宿主入口 / 渲染模块 四处一致", async () => {
  const pkg = JSON.parse(await read("package.json"))
  const patch = await read("cordis.patch.yml")
  const host = await read("src/index.js")
  const client = await read("lib/client.js")

  assert.match(patch, new RegExp(`name:\\s*'${pkg.name.replace(/[/@]/gu, "\\$&")}'`), "patch 里的 name 要和包名一致")
  assert.match(host, new RegExp(`export const name = "${pkg.name.replace(/[/@]/gu, "\\$&")}"`), "宿主导出的 name 要和包名一致")
  assert.match(client, new RegExp(`id: "${pkg.name.replace(/[/@]/gu, "\\$&")}"`), "渲染模块 id 要和包名一致")
})

test("客户端 VERSION 不许和 package.json 漂开", async () => {
  const pkg = JSON.parse(await read("package.json"))
  const client = await read("lib/client.js")
  const version = /const VERSION = "([^"]+)"/u.exec(client)?.[1]
  assert.equal(version, pkg.version, "lib/client.js 的 VERSION 必须等于 package.json 的 version")
})

test("包里该带的东西都在 files 白名单里", async () => {
  const pkg = JSON.parse(await read("package.json"))
  for (const entry of ["src/**/*.js", "lib/client.js", "cordis.patch.yml", "README.md", "LICENSE"]) {
    assert.ok(pkg.files.includes(entry), `files 缺 ${entry}`)
  }
  assert.equal(pkg.publishConfig?.access, "public", "scoped 包必须显式声明 public，否则默认私有发不出去")
})
