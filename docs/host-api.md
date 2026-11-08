# DSH 插件 API 速查表（dsh-crew 实测版）

> 来源：读 `dsh-dot-plugin` / `dsh-plugin-desktop-notify` 源码 + 本机 crew-dev profile 实跑，
> 并在 2026-11-08 用 crew 自己的端到端冒烟核过。标「未验证」的是没实测到的部分。

## 1. 宿主半边

```js
export const name = "dsh-crew"                 // 必须 === package 名 === patch 里的 name
export const inject = ["agents"]               // 要等的宿主服务；webServer 太晚，走 ctx.inject
export function apply(ctx, rawConfig) { ... }  // 挂载入口
```

- `Config`（schemastery）可选：`desktop-notify` 就没写，自己规范化 rawConfig。**不写也能跑**。
- profile 的 `cordis.patch.yml` 里用 `insert` 挂一行，`id` / `name` / `config` 对应 loader 行：

```yaml
- insert:
    - id: dsh-crew
      name: 'dsh-crew'
      config: { enabled: true }
```

### 服务

- `ctx.provide(name, service)` + `ctx.effect(() => ctx.provide(...), label)` 暴露给渲染侧。
  已被 `ctx.get('xxx')` 在客户端读到（dot 用 `dshDot`，crew 用 `dshCrew`）。
- 读宿主已有服务用 `ctx.get?.('服务名')`：

| 服务 | 用途 |
|---|---|
| `agents` | `create / resume / get`，程序化开会话 |
| `agentDefaultModel` | `.currentSelection() → { provider, model }`，**程序化建 agent 必须显式给模型，否则 turn 直接报 no provider/model** |
| `sessionTitle` | `.rename(session, title)`，会话列表里显示的名字 |
| `workingDirectory` | `.defaultDirectory` |
| `webServer` | `.register({ kind:'exact', path, handler }) → dispose`、`.getOrigin()`、`.port` |

### 派活的核心四步（实测通过）

```js
const selection = ctx.get?.("agentDefaultModel")?.currentSelection?.()   // { provider, model }

const handle = await ctx.agents.create({
  sessionId: "crew-writer-ab12cd34",
  meta: { cwd: bot.cwd, agentPreset: "standard" },
  agentOptions: { provider: selection.provider, model: selection.model },
})
const agent = handle.agent

ctx.get?.("sessionTitle")?.rename?.(agent.session, "小文 · 写个开头")   // 会话列表里可辨认

await agent.followup({
  id: `crew-${randomUUID()}`,
  role: "user",
  content: [{ type: "text", text: brief }],
  source: { kind: "dsh-crew", form: "notice", summary: "Crew 派活简报" },
})

agent.status              // 'running' | 'idle'
agent.session.snapshotEvents()                            // 全部事件
agent.cancel({ kind: "user", reason: "crew_cancelled" })  // 真正 abort（只 dispose 不够）
await agent.dispose()                                     // 释放句柄；会话本体保留
```

### 真实事件形状（从会话日志 zstd 解出来的）

```json
{"type":"turn/start"}
{"type":"turn/end","data":{"turn":1,"reason":{"kind":"error","error":{"message":"agent ... has no provider/model","code":"UNKNOWN"}}}}
```

- assistant 文本在 `{"type":"assistant/message","data":{"message":{"content":[{"type":"text","text":"..."}]}}}`
  （dot 的 worker-port 就是这么读的；crew 沿用）。
- **`turn/end` 且 `data.reason.kind === "error"` 才是失败信号**，别只看有没有 assistant 消息。

### HTTP 路由

```js
ctx.inject(["webServer"], (hostCtx) => {
  const server = hostCtx.webServer
  const dispose = server.register({ kind: "exact", path: "/crew/bots", handler: (req, res) => { ... } })
  hostCtx.effect(() => () => dispose(), "dsh-crew: routes")
})
```

- `ctx.inject` 等 webServer 绑定完成；`ctx.get` 会抢跑失败。
- 宿主是 loopback + 准入；外部工具要带 token 时学 desktop-notify 写 endpoint 文件。

## 2. 渲染半边

```js
window.__ModuleLoader__.load({
  id: "dsh-crew",                       // 必须 === package 名
  factory(require) {
    const React = require("react")
    return { name: "dsh-crew-client", inject: ["slots"], apply(ctx) { ... } }
  },
})
```

- `factory` 返回对象（不是 React 组件）：`{ name, inject, apply }`，核过 dot 的写法。
- 界面全是 **slot 注册**：

```js
ctx.slots.inject("sidebar.panellist", () =>
  ctx.slots.register({ name: "sidebar.panellist", id: "dsh-crew", order: 30, label: () => "Crew" }, CrewIcon))

ctx.slots.inject("main", () =>
  ctx.slots.register({ name: "main", key: "dsh-crew" }, CrewPanel))
```

- **`sidebar.panellist` 的 `id` 要和 `main` 的 `key` 相同**，壳子靠这个配对。
- 其它可用 slot：`shell.overlay`、`plugins.bundle.config`。
- 打开某个会话：`ctx.get('uiWorkspace').openSession(sessionId)`。
- 渲染进程没有 Node API；一切磁盘操作走宿主路由（同源 fetch 即可）。
- 宿主会把客户端模块作为一条 `plugins/??<id>/client.js&rev=<rev>` 提供。
  **带 `&rev=` 才 200，去掉 rev 会 404**（这条踩过，浪费了十分钟）。

## 3. 包怎么被认出来

```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": { "platform": "web", "immediately": true, "inject": [] }
}
```

开发期用软链进 profile：`~/.dsh/profiles/<p>/node_modules/<id> -> <repo>`，
profile 的 `dsh.profile.bundles` 里加包名即可，不必 `pnpm add`。
