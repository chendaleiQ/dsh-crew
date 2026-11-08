# 装到哪儿、怎么装、怎么撤

## 现在的状态（2026-11-08）

- **GitHub 已发布**：<https://github.com/chendaleiQ/dsh-crew>，CI 绿
- **npm 未发布**：`@chendaleiq/dsh-crew` 还没推上去。原因是本机 npm 凭据失效
  （`npm whoami` → 401，直连 registry 也是 401）。**代码和打包都没问题**，
  只差一次登录或一次 trusted publishing 配置。
- 在 npm 发布之前，用 GitHub 装（已验证可行，见下）

## 从 GitHub 装（现在就能用）

```bash
dsh plugin --profile <profile> add github:chendaleiQ/dsh-crew
```

## 升级与回滚

- **升级**：重跑同一条 `add` 命令即可（pnpm 会拉最新提交）。
- **回滚**：`dsh plugin --profile <profile> add github:chendaleiQ/dsh-crew#<commit>`，
  commit 号在仓库提交历史里；或装回上一个 tag。
- **数据不受影响**：Bot 档案全在 `~/.dsh/crew/`，升级/重装/卸载都不动它。
  真的要清空才 `rm -rf ~/.dsh/crew`。
- **回滚代码但保留数据**是安全的：数据格式只往后兼容，老版本读到新字段会忽略。

## 三种安装位置

| 位置 | 用途 | 怎么装 |
|---|---|---|
| `crew-dev`（已验证） | 开发/试新功能 | `scripts/dev-profile.sh`（软链，改完重启即生效） |
| `desktop`（你日常在用的） | 真跑模型、真干活 | **只能通过 App 的插件管理器**，见下 |
| 别人的机器 | 分发 | `npm pack` 出 tarball，或发到 npm |

## 为什么 desktop 不能命令行装

```
$ dsh --profile desktop --dump-config
error: profile "desktop" is managed exclusively by the Electron application
```

desktop profile 由 Electron 应用独占管理（pnpm 工程 + 运行中的插件管理器都在它手里）。
命令行改它的 `package.json` / `cordis.patch.yml` 不但可能被覆盖，还可能让它启动失败——
**你正在用的 DSH 就在这个 profile 里跑，不能冒险。**

## 装进 desktop 的两种正规做法

### A. 先打成 tarball，再从 App 装（推荐，最接近正式插件）

```bash
cd ~/Desktop/mine/projects/dsh-crew
npm pack                     # 产出 dsh-crew-0.1.0.tgz
```

然后在 DSH 里：**设置 → 插件 → 安装**，把本机 tarball 的绝对路径填进去：

```
~/Desktop/mine/projects/dsh-crew/dsh-crew-0.1.0.tgz
```

插件管理器会自己处理 `dependencies`、`dsh.profile.bundles` 和 patch 层，
装完按提示重启。**Dot 不受影响**（id、slot、会话名都不冲突）。

### B. 直接把仓库软链进 desktop（快，但属于"手改"）

只有在 A 出问题时才用，而且要先把 `~/.dsh/profiles/desktop/package.json`
和 `cordis.patch.yml` 各备份一份：

```bash
cp ~/.dsh/profiles/desktop/package.json{,.bak-crew}
cp ~/.dsh/profiles/desktop/cordis.patch.yml{,.bak-crew}
```

然后在该 profile 的 `package.json` 里给 `dsh.profile.bundles` 追加 `"dsh-crew"`，
并把 `node_modules/dsh-crew` 软链到本仓库；重启 App。**出问题就用备份还原。**

## 撤销

- A 路线：设置 → 插件 → 停用/卸载 `dsh-crew`。
- B 路线：还原两个 `.bak-crew` 备份，删掉软链，重启。
- 数据不受影响：Bot 档案在 `~/.dsh/crew/`，卸载插件不会删它。要清就 `rm -rf ~/.dsh/crew`。

## 装完怎么确认成功

1. 左侧图标栏出现 **Crew** 图标（三个头像点，和 Dot 的同心圆不一样）。
2. 点进去看到「Crew · 班组」+ 收件箱 + 空花名册。
3. 新建一个 Bot → 派一件小事 → 它真的在**那个目录**里开了会话。
4. 看卡片上的 `toolPolicy`（接口里）应该是
   `{"systemPrompt":"applied","restrict":"applied","guard":"applied"}`
   ——如果 `restrict` 是 `failed:` 而 `guard` 是 `applied`，白名单仍然生效（guard 兜底）。
