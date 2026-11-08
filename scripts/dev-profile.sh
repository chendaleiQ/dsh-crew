#!/usr/bin/env bash
# 在建一个独立的 crew-dev profile 里跑 dsh-crew，绝不碰你正在用的 desktop profile。
#
# 用法：
#   scripts/dev-profile.sh            # 建好/更新 dev profile（幂等）
#   scripts/dev-profile.sh --dump     # 建好后打印组合后的配置片段
#
# 为什么用软链而不是 pnpm add：这是个本机自用的插件，软链让「改完立刻生效」
# 少一层打包/安装步骤。要发给别人时再走 npm 打包（见 README）。
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="${DSH_CREW_PROFILE:-$HOME/.dsh/profiles/crew-dev}"
DSH_BIN="${DSH_BIN:-$HOME/.local/bin/dsh}"

echo "repo     : $REPO_DIR"
echo "profile  : $PROFILE"

if [ ! -f "$REPO_DIR/package.json" ]; then
  echo "找不到 $REPO_DIR/package.json，脚本可能放错位置了" >&2
  exit 1
fi

mkdir -p "$PROFILE/node_modules"

# profile 的 bundle 清单：沿用 web 模板的两层，再挂上 dsh-crew。
if [ ! -f "$PROFILE/package.json" ]; then
  cat > "$PROFILE/package.json" <<'JSON'
{
  "name": "dsh-profile-crew-dev",
  "private": true,
  "dependencies": {
    "@chendaleiq/dsh-crew": "file:../../../Desktop/mine/projects/dsh-crew"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@chendaleiq/dsh-crew"
      ]
    }
  }
}
JSON
  echo "已写 $PROFILE/package.json"
else
  echo "已存在 $PROFILE/package.json，保留不动"
fi

# pnpm 的 workspace 边界：profile 目录自己就是根。
if [ ! -f "$PROFILE/pnpm-workspace.yaml" ]; then
  cat > "$PROFILE/pnpm-workspace.yaml" <<'YAML'
packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
YAML
  echo "已写 $PROFILE/pnpm-workspace.yaml"
fi

# 用户覆盖层：空数组 = 不额外改任何东西。
if [ ! -f "$PROFILE/cordis.patch.yml" ]; then
  printf '%s\n' '[]' > "$PROFILE/cordis.patch.yml"
  echo "已写 $PROFILE/cordis.patch.yml"
fi

# 软链本体。ln -sfn 是幂等的，不会删除任何东西。
mkdir -p "$PROFILE/node_modules/@chendaleiq"
ln -sfn "$REPO_DIR" "$PROFILE/node_modules/@chendaleiq/dsh-crew"
echo "已链接 $PROFILE/node_modules/@chendaleiq/dsh-crew -> $REPO_DIR"

if [ "${1:-}" = "--dump" ]; then
  echo "--- dump-config（只看 dsh-crew 这一段）---"
  "$DSH_BIN" --profile crew-dev --dump-config 2>&1 | grep -n -A 10 "@chendaleiq/dsh-crew" || {
    echo "dump-config 没看到 dsh-crew，说明 bundle 没被加载" >&2
    exit 1
  }
fi

echo "完成。启动：$DSH_BIN --profile crew-dev web --port 50999"
