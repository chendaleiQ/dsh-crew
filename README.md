# dsh-crew


[![npm](https://img.shields.io/npm/v/@chendaleiq%2Fdsh-crew)](https://www.npmjs.com/package/@chendaleiq/dsh-crew)
[![license](https://img.shields.io/npm/l/@chendaleiq%2Fdsh-crew)](LICENSE)
[![DeepSeek Harness plugin](https://img.shields.io/badge/DSH-plugin-4D6BFE)](https://github.com/chendaleiQ/dsh-crew)

> npm 包名是 **`@chendaleiq/dsh-crew`**：`dsh-crew` 这个名字已被另一个项目（[stuarthu/dsh-crew](https://github.com/stuarthu/dsh-crew)）占用，两者无关。

本机多 Bot 花名册插件（DeepSeek Harness）。和 `dsh-dot-plugin` 是两套东西：
**Dot 是一个经理帮你干活；Crew 是一张花名册，里面每个 Bot 有名字、人格、自己的工作目录和记忆。**

## 为什么不是复制 Grok Bot

Grok Bot 的核心卖点里有一半是云端产物（每个 Bot 一台云电脑、手机 App、Slack/X 入口、虚拟卡支付）。
本插件的范围是**只在这台 Mac 上、只有你一个人用**：

| 要 | 不要 |
|---|---|
| Bot 有自己的目录、人格、记忆 | 云 VM / 关机后继续跑 |
| 一句话派活，结果进收件箱 | 手机 App / IM / Slack |
| 花名册一眼看清谁在忙、谁在等你 | 多租户、SSO、企业管控 |
| 复用 DSH 现有审批，不绕过 | 真实支付通道 |

## 状态

- [x] 阶段 0：包骨架、dev profile、可加载（`--dump-config` 能看到 `dsh-crew` 行）
- [x] 阶段 1：Bot 档案（`bot.json`：名字/角色/人格/cwd/provider/model/preset/工具/记忆）
      —— 工具白名单**真强制**：`tools.restrict` 尽力 + `tools.guard` 兜底（按名字拦，不看宿主认不认识）
- [x] 阶段 2：派活（`ctx.agents.create` 建真会话 → 投简报 → 轮询 → 结果落盘 + 写记忆）
- [x] 阶段 3：花名册面板（侧边栏 Crew 图标 + 主面板 + **收件箱**：谁在等你、带错误原文与会话入口）
- [ ] 阶段 3.5：面板在浏览器里的人工确认（代码侧已有 11 条渲染/交互测试，但**没人肉看过像素**）
- [x] 阶段 4：**自进化目标循环**（目标持久化 + 每轮新会话 + 机器验收 + 死路沉淀 + 停的条件）
- [ ] 阶段 4.5：目标面板的人工确认
- [ ] 阶段 5：装进 desktop profile（会重启你正在用的 DSH，需你点头）
- [x] 记忆压缩：超阈值自动归档（明细留 `memory.archive.md`，`[pin]` 永不归档）
- [x] routine 录制：跑通的路径自动固化成草稿（步骤来自 `tool/call` 真实轨迹），下次同类任务注入系统提示
- [ ] launchd 常驻（等你决定：合盖就停的现实 + 预算口径）
- [ ] 真实成本记账（会话日志无逐轮 usage，宿主不暴露就拿不到）

## 自进化模式怎么工作

给它一个**目标**和**验收条件**，它一轮一轮磨：

```
decide(goal) ── 不许跑（空目标/无验收/人叫停）
   │
   ├─ 跑 → 新开一个干净会话，只带：目标 + 验收 + 死路 + 上一轮结论
   │         └─ 跑完立刻 checkAcceptance（file: 文件 / run: 命令 / human: 要人看）
   ├─ 机器验收全过 + 没有人待确认 → done（立刻停，不许再跑）
   ├─ 机器过了只剩人看          → needs-human（不许自称完成）
   ├─ 连着 3 轮没让验收变好      → stop（不许无限烧）
   └─ 超当日预算                → need-human（不是停，是问你）
```

关键设计：

- **每轮新会话**：不背着聊天记录跑，靠磁盘上的战报接续——防「上下文越长越糊涂」。
- **进展由验收定义**：只有机器验收的通过项真的变多才算 progress，模型自称不算。
- **失败变成资产**：每轮没进展就写一条死路，下一轮开工前注入，避免重复撞墙。
- **停的条件在代码里**，不在提示词里：模型可以建议停，能不能停由 `decide()` 说。

## 跑通的活会变成套路

自进化里最值钱的那块：**验证过的正确路径**（记忆会过期，死路只是别踩）。

- 跑通一次 → 从这一轮的 `tool/call` 事件里抽步骤，写成 `routines/<slug>.md` 草稿
- 头部标 `status: draft`，不冒充"最佳实践"；你认可后手改成 `confirmed`
- 下次同类任务，routine 清单注入 system prompt：「同类任务先照着走，别重新发明」
- 步骤**来自真实轨迹，不是模型复述**——所以它记的是真发生过的那条路
- 同名任务再跑通会覆盖同一份，不会堆成一堆近似文件

实测链路（dev 实例）：写入一条 routine → `GET /crew/routines` 列出 → 派活 →
解压真实会话日志，`system/message` 里确实含「你验证过的套路」和该惯例标题。

## 记忆会自己瘦身

长跑里记忆只增不减，而每轮只注入尾部 3000 字——超出的部分**永远读不到**，纯属白背。
所以每轮开工前顺手压一次：

- 超过 30 条或 6000 字 → 保留最近 10 条 + `[pin]` 置顶条，其余折成一行一条的「早期摘要」
- **先把明细写进 `memory.archive.md` 再覆写 `memory.md`**（反过来的话中途失败就真丢了）
- 机械压缩，不调模型、不创作：错的摘要比没有摘要更糟
- 实测：50 条 / 6167 字节 → 记忆 4128 字节 + archive 4862 字节，置顶与最近条目都在

## 钱怎么算（诚实版）

DSH 的会话日志里**没有逐轮 token 用量**——我解压真实会话核过：`step/end` 只有 turn/step 号，
`assistant/message` 没有 usage；`tokenUsage` 只存在于界面侧的会话描述符里，宿主插件拿不到。

所以面板不摆一个永远 ¥0.00 的假账：

- 默认显示「第 N 轮 · 死路 M 条 · 花费未接」
- 你愿意给个粗估就配 `costPerRoundCny`（每轮多少钱），面板改显示「今日约 ¥x/y」，
  超预算规则才会真的生效
- 要真账，得等宿主把 usage 暴露给插件

## 身份与白名单落在哪

- **人格/边界/记忆走 `systemPrompt.section`**，任务走用户消息（两边不重复，省下的 token 是真省的）。
- **工具白名单两道闸**：`tools.restrict({allow})` 只在宿主认得这些工具名时生效（薄 profile 上会整条失败），
  所以真正兜底的是 `tools.guard((exec) => …)`——它在调用时按名字拦，不依赖宿主工具表。
- 每次派活的 `toolPolicy` 都写进运行态：`{systemPrompt, restrict, guard}`，失败如实标 `failed: …`，
  面板/接口都能看到**白名单到底生效没有**（实测过：`systemPrompt: applied`、`guard: applied`、
  薄 profile 上 `restrict: failed: names unknown global tools …`）。

## 代码侧的"验过"到底到什么程度

| 层 | 证据 |
|---|---|
| 花名册 / 记忆 / 目标 / 收件箱 / 轨迹 / routine | 单测，纯函数，边界都钉过 |
| 派活 / 目标循环 | 假宿主跑四种结局 + 真宿主跑出真会话（状态落盘） |
| 工具白名单 | 真宿主回读 `toolPolicy.guard = applied`，guard 单测验证拦截 |
| 身份注入 | 解压真会话日志，`system/message` 里确认含人格与套路 |
| 记忆压缩 | 真实例：50 条 → 4128 字节 + archive 4862 字节 |
| 面板 | 假 React + 真 hook 运行时：首帧、带数据帧、5 条点击交互 |
| **没验的** | **面板像素**（CSS/布局/真 React 重渲染）——这只能人眼看 |

## 验过的

- **82 个单元测试**：`npm test`（档案读写 / 简报组装 / 派活结局 / 目标状态机 / 目标循环四结局 / 渲染侧接线）
- 目标循环端到端：dev 实例里建目标 → 点火 → 真跑 3 轮 → 3 条死路 → 轮次用尽 → **收件箱出现「1 件等你处理」**
- 面板真渲染（假 React + 真 hook 运行时）：首帧、拿到数据后的第二帧、子组件内容都渲染过一遍
- 端到端冒烟：crew-dev profile 里建 Bot → 派活 → 真建出会话 → 状态落盘
- 客户端模块被宿主服务出来：`plugins/??dsh-crew/client.js&rev=...` 返回 200

## 没验的

- **面板真能画出来**：需要在浏览器里看（本会话没有 neo 浏览器工具）。
- **模型真的会回话**：crew-dev 是干净 profile，没有 provider 凭据，一轮以
  `no provider/model` 结束——派活链路本身是通的，只是没有脑。要在你日常的
  desktop profile 里才有可用模型。

## 目录

```
projects/dsh-crew/
  src/index.js        宿主插件入口（name / inject / Config / apply）
  src/registry.js     Bot 花名册的磁盘格式与读写（不依赖 DSH API，可单测）
  src/goal.js         目标态：验收条件、轮次记账、该继续还是停（decide）
  src/expedition.js   目标循环：一轮一轮磨，每轮新会话
  src/turn.js         一轮执行（派活与目标循环共用）
  src/inbox.js        收件箱：把「现在需要你」的事拎出来（宁可多报，不许漏报）
  lib/client.js       渲染侧（侧边栏 Crew 面板）
  cordis.patch.yml    装进 profile 的 loader 行
  docs/               宿主侧 / 渲染侧 API 速查表
```

## 数据在哪

```
~/.dsh/crew/
  bots/<bot-id>/bot.json     档案：名字、人格、cwd、工具白名单
  bots/<bot-id>/memory.md    长期记忆（人可读可改）
  state.json                 运行态：哪个 Bot 现在跑着哪个会话
```

## 开发与验证

```bash
npm test                 # 77 个单元测试
scripts/smoke.sh         # 冒烟：起 dev 实例 → 建 Bot → 派活 → 点火 → 收件箱 → 客户端模块
scripts/dev-profile.sh   # 只建/更新 dev profile，不启动

# 装进独立 dev profile（不要装进正在用的 desktop profile）
dsh plugin --profile crew-dev add file:$HOME/Desktop/mine/projects/dsh-crew
dsh --profile crew-dev --dump-config | grep -A5 dsh-crew
dsh --profile crew-dev web --port 50999
```
