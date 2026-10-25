#!/usr/bin/env bash
# 离线模拟 vs 真实 /api：逐字段对比（依赖 cargo、curl、node）
#
#   ./scripts/mp_parity.sh
#
# 会在临时数据库上启动一个独立服务，然后让 scripts/mp_parity.js 用同一串请求
# 分别打到「真实服务（HTTP）」和「离线模拟（utils/mock）」，归一化 ID / 时间 / 密钥后比较
# 响应体与 HTTP 状态码；结束后自动清理进程与数据。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT="${SC_PARITY_PORT:-4010}"
BASE="http://127.0.0.1:${PORT}"
TMP="$(mktemp -d)"
BIN="$ROOT/target/debug/smart-campus"
PID=""

cleanup() {
  local code=$?
  if [[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
  fi
  if [[ $code -ne 0 ]]; then
    echo
    echo "--- 服务日志（最后 20 行）---"
    tail -n 20 "$TMP/server.log" 2>/dev/null || true
  fi
  rm -rf "$TMP"
  exit "$code"
}
trap cleanup EXIT

echo "==> 构建"
cargo build --offline --quiet
[[ -x "$BIN" ]] || { echo "找不到可执行文件 $BIN" >&2; exit 1; }

echo "==> 启动临时服务（端口 $PORT，数据库 $TMP/test.db）"
SC_DB="$TMP/test.db" SC_STRINGS_DIR="$ROOT/strings" SC_STRINGS_DB="$TMP/strings.db" \
  SC_LANG=zh-CN SC_PORT="$PORT" SC_BIND="127.0.0.1:$PORT" "$BIN" >"$TMP/server.log" 2>&1 &
PID=$!

ready=0
for _ in $(seq 1 100); do
  if curl -sf "$BASE/api/health" >/dev/null 2>&1; then ready=1; break; fi
  if ! kill -0 "$PID" 2>/dev/null; then echo "服务进程提前退出" >&2; exit 1; fi
  sleep 0.15
done
[[ "$ready" == "1" ]] || { echo "服务未在预期时间内就绪" >&2; exit 1; }

echo "==> 对比离线模拟与真实 /api"
SC_BASE="$BASE" node scripts/mp_parity.js
