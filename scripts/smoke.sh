#!/usr/bin/env bash
# dsh-crew 冒烟脚本：在 dev profile 上把「建 Bot → 派活 → 建目标 → 点火 → 收件箱」跑一遍。
#
# 用途：每次改完代码，一条命令确认链路没断，而不是靠记忆里的 curl。
# 只动 dev profile（默认 crew-dev，端口 50999），不碰你日常在用的 desktop profile。
#
# 用法：
#   scripts/smoke.sh              # 起实例、跑一遍、关掉
#   scripts/smoke.sh --keep       # 跑完不关，留着看面板
set -uo pipefail

PORT="${CREW_PORT:-50999}"
PROFILE="${CREW_PROFILE:-crew-dev}"
DSH_BIN="${DSH_BIN:-$HOME/.local/bin/dsh}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG=/tmp/crew-smoke.log
BASE="http://127.0.0.1:$PORT"
KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1

say() { printf '\n=== %s ===\n' "$1"; }
fail() { printf '✖ %s\n' "$1" >&2; FAILED=1; }
FAILED=0

cleanup() {
  # 收工：把冒烟留下的 Bot 和工作目录清掉，别在你的花名册里留垃圾。
  rm -rf "$REPO_DIR/.smoke-work"
  rm -rf "${HOME}/.dsh/crew/bots/smoke" 2>/dev/null
  if [ "$KEEP" = "1" ]; then
    printf '\n实例留在 %s（token 见 %s）\n' "$BASE" "$LOG"
    return
  fi
  [ -n "${PID:-}" ] && kill "$PID" 2>/dev/null
  pkill -f "profile $PROFILE" 2>/dev/null
  printf '\n已关闭实例\n'
}
trap cleanup EXIT

say "启动 $PROFILE on :$PORT"
: > "$LOG"
"$DSH_BIN" --profile "$PROFILE" --port "$PORT" --no-open > "$LOG" 2>&1 &
PID=$!
# 就绪判断：端口能应答就算起来——根路径要 token，401 也是「活着」。
ready() { [ "$(curl -s -o /dev/null -m 1 -w '%{http_code}' "$BASE/" 2>/dev/null)" != "000" ]; }
for _ in $(seq 1 80); do
  ready && break
  sleep 0.5
done
ready || { echo "实例没起来，见 ${LOG}" >&2; exit 1; }
echo "起来了"

# token 那行比端口就绪晚一点写进日志，所以这里要等——否则第 5 步会拿 401 页面瞎猜。
TOKEN=""
for _ in $(seq 1 40); do
  TOKEN=$(grep -o "token=[A-Za-z0-9_-]*" "$LOG" 2>/dev/null | head -1 | cut -d= -f2)
  [ -n "$TOKEN" ] && break
  sleep 0.25
done
if [ -z "$TOKEN" ]; then
  echo "拿不到 web token（见 $LOG），后面所有接口都会 401，先停" >&2
  exit 1
fi
if [ -n "$TOKEN" ]; then
  echo "面板地址：$BASE/?token=$TOKEN"
else
  echo "（没抓到 token，见 ${LOG}）"
fi

WORK="$REPO_DIR/.smoke-work"
rm -rf "$WORK"; mkdir -p "$WORK"

say "1. 建 Bot（只给 read，不给 bash）"
BOT=$(curl -s -X POST "$BASE/crew/bots" -H 'content-type: application/json' \
  -d "{\"id\":\"smoke\",\"name\":\"冒烟\",\"persona\":\"你只做能验收的事。\",\"cwd\":\"$WORK\",\"tools\":[\"read\",\"glob\",\"grep\"]}")
echo "$BOT" | grep -q '"ok":true' && echo "✔ 建好了" || fail "建 Bot 失败：$BOT"

say "2. 派活（薄 profile 上没有模型，预期是 empty + 白名单状态）"
curl -s -X POST "$BASE/crew/assign" -H 'content-type: application/json' \
  -d '{"botId":"smoke","task":"随便看一眼"}' >/dev/null
sleep 5
curl -s "$BASE/crew/bots" | python3 -c "
import sys, json
data = json.load(sys.stdin)
bot = (data.get('state') or {}).get('bots', {}).get('smoke', {})
print('  state      :', bot.get('state'))
print('  toolPolicy :', json.dumps(bot.get('toolPolicy'), ensure_ascii=False))
assert bot.get('state') is not None, '派活没有留下运行态'
print('✔ 运行态已落盘')
" || fail "派活没留下状态"

say "3. 建目标 + 点火 1 轮"
curl -s -X POST "$BASE/crew/goal" -H 'content-type: application/json' \
  -d "{\"botId\":\"smoke\",\"objective\":\"造出 out.md\",\"acceptance\":[{\"kind\":\"file\",\"path\":\"$WORK/out.md\"}]}" >/dev/null
curl -s -X POST "$BASE/crew/goal/fire" -H 'content-type: application/json' \
  -d '{"botId":"smoke","maxRounds":1}' >/dev/null
sleep 5

say "4. 收件箱（轮次用尽必须变成「等你处理」，不许静默）"
curl -s "$BASE/crew/bots" | python3 -c "
import sys, json
data = json.load(sys.stdin)
print('  inboxSummary:', data.get('inboxSummary'))
for item in data.get('inbox', []):
    print(f\"  [{item['level']}] {item['title']} :: {item['detail'][:70]}\")
goal = (data.get('goals') or {}).get('smoke', {})
print('  goal:', goal.get('status'), '| rounds', goal.get('rounds'))
assert goal.get('status') in ('needs-human', 'stopped', 'done'), f\"目标状态异常：{goal.get('status')}\"
print('✔ 目标停止原因已落盘')
" || fail "目标状态没落盘"

say "5. 面板客户端模块是否被宿主收下"
# 客户端模块的 URL 形如 plugins/??<包名>/client.js&rev=<rev>；rev 在带 token 的首页清单里。
# 用 grep 抓，不用 python 的转义地狱——这行本身踩过一次。
JAR=$(mktemp)
curl -sL -c "$JAR" -b "$JAR" "$BASE/?token=$TOKEN" -o /tmp/crew-smoke-index.html
REV=$(grep -o "plugins/??@chendaleiq/dsh-crew/client.js&rev=[0-9a-f]*" /tmp/crew-smoke-index.html | head -1 | sed 's/.*rev=//')
if [ -z "$REV" ]; then
  fail "首页清单里没有 @chendaleiq/dsh-crew（客户端半边没被加载）"
else
  CODE=$(curl -s --path-as-is -b "$JAR" -o /tmp/crew-smoke-client.js -w '%{http_code}' "$BASE/plugins/??@chendaleiq/dsh-crew/client.js&rev=$REV")
  SIZE=$(wc -c < /tmp/crew-smoke-client.js | tr -d ' ')
  if grep -q "Crew · 班组" /tmp/crew-smoke-client.js; then
    echo "✔ 客户端模块可取（HTTP $CODE, $SIZE 字节）"
  else
    fail "取到的不是我们的模块"
  fi
fi
rm -f "$JAR"

say "结果"
if [ "$FAILED" = "0" ]; then
  echo "✔ 冒烟全过"
else
  echo "✖ 有检查没过，见上面" >&2
fi
exit "$FAILED"
