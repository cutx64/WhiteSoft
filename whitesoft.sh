#!/usr/bin/env bash
#
# WhiteSoft — 本地白板启动脚本
#
#   ./whitesoft.sh                 在 127.0.0.1:8787 启动，并提示界面地址
#   ./whitesoft.sh --open          启动后自动打开浏览器
#   ./whitesoft.sh --port 9000     指定端口（默认就是 8787）
#   ./whitesoft.sh --auto-port     端口被占用时自动往后找一个空闲端口
#   ./whitesoft.sh --root ~/notes  指定工作区目录（存放 .note / .pdf）
#
# 脚本就在仓库根目录，可以从任意工作目录调用：
#   /path/to/WhiteSoft/whitesoft.sh
#
# 其余无法识别的参数会原样传给 node server.mjs。
#
set -euo pipefail

APP_NAME="WhiteSoft"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# 服务端与脚本同在仓库根目录
APP_DIR="$HERE"
SERVER="$APP_DIR/server.mjs"

PORT="${PORT:-8787}"
HOST="127.0.0.1"
ROOT=""
OPEN=0
AUTO_PORT=0
EXTRA=()

usage() {
  # 打印文件开头的注释块作为说明
  awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' "${BASH_SOURCE[0]}"
  cat <<'EOF'

选项：
  -p, --port <n>     监听端口（默认 8787，也可用环境变量 PORT）
  -H, --host <addr>  监听地址（默认 127.0.0.1）
  -r, --root <dir>   工作区目录（默认本仓库的上一级目录）
      --open         启动后自动打开默认浏览器
      --auto-port    端口被占用时自动顺延到下一个空闲端口
  -h, --help         显示本帮助
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    -p|--port) PORT="${2:?--port 需要一个端口号}"; shift 2 ;;
    --port=*) PORT="${1#*=}"; shift ;;
    -H|--host) HOST="${2:?--host 需要一个地址}"; shift 2 ;;
    --host=*) HOST="${1#*=}"; shift ;;
    -r|--root) ROOT="${2:?--root 需要一个目录}"; shift 2 ;;
    --root=*) ROOT="${1#*=}"; shift ;;
    --open) OPEN=1; shift ;;
    --auto-port) AUTO_PORT=1; shift ;;
    --) shift; EXTRA+=("$@"); break ;;
    *) EXTRA+=("$1"); shift ;;
  esac
done

die() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

# --- 前置检查 -------------------------------------------------------------
command -v node >/dev/null 2>&1 || die "找不到 node，请先安装 Node.js 18 或更高版本。"
node -e 'const m=+process.versions.node.split(".")[0]; process.exit(m>=18?0:1)' \
  || die "Node.js 版本过低（当前 $(node -v)），需要 18 或更高。"
[ -f "$SERVER" ] || die "找不到服务端文件：$SERVER"

# 默认工作区是仓库的上一级，也就是存放 .note / .pdf 的目录
if [ -z "$ROOT" ]; then ROOT="$(cd "$APP_DIR/.." && pwd)"; fi
[ -d "$ROOT" ] || die "工作区目录不存在：$ROOT"
ROOT="$(cd "$ROOT" && pwd)"

# --- 端口 -----------------------------------------------------------------
# 端口是否已被占用。整个探测放在子 shell 里：即使 exec 打开 /dev/tcp 失败，
# 退出的也是子 shell，不会把脚本本身带下去。
port_in_use() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") >/dev/null 2>&1
}

case "$PORT" in
  ''|*[!0-9]*) die "--port 需要一个数字，收到：$PORT" ;;
esac

if port_in_use "$PORT"; then
  if [ "$AUTO_PORT" = "1" ]; then
    start="$PORT"
    while port_in_use "$PORT"; do
      PORT=$((PORT + 1))
      [ "$PORT" -gt $((start + 50)) ] && die "从 $start 起连续 50 个端口都被占用，请用 --port 指定。"
    done
    printf '\033[33m端口 %s 已被占用，改用 %s。\033[0m\n' "$start" "$PORT"
  else
    die "端口 $PORT 已被占用。用 --port 换一个，或加 --auto-port 自动顺延。"
  fi
fi

URL="http://${HOST}:${PORT}/"

# --- 启动横幅 -------------------------------------------------------------
NOTES=()
while IFS= read -r -d '' f; do NOTES+=("${f#"$ROOT"/}"); done \
  < <(find "$ROOT" -maxdepth 2 -name '*.note' -not -path '*/.*' -print0 2>/dev/null | sort -z)

printf '\n\033[1m%s\033[0m — 本地白板\n' "$APP_NAME"
printf '%s\n' '──────────────────────────────────────────────'
printf '界面地址 : \033[36m%s\033[0m\n' "$URL"
printf '工作区   : %s\n' "$ROOT"
if [ "${#NOTES[@]}" -gt 0 ]; then
  printf '发现白板 : %s\n' "$(printf '%s, ' "${NOTES[@]}" | sed 's/, $//')"
else
  printf '发现白板 : （该目录下暂无 .note 文件，可用「导入 PDF」新建）\n'
fi
printf '停止服务 : Ctrl+C\n'
printf '%s\n\n' '──────────────────────────────────────────────'

if [ "$OPEN" = "1" ]; then
  ( sleep 1
    if command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1 || true
    elif command -v open >/dev/null 2>&1; then open "$URL" >/dev/null 2>&1 || true
    fi ) &
fi

cd "$APP_DIR"
exec node "$SERVER" --port "$PORT" --host "$HOST" --root "$ROOT" ${EXTRA[@]+"${EXTRA[@]}"}
