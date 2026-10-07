#!/usr/bin/env bash
#
# 本地一次性服务端的启动/收尾（`scripts/smoke.sh` 与 `scripts/bench.sh` 共用这一份，
# 前端设计 §3.7：两处以上用到的能力收敛成一个通用件）。
#
# 这里管四件事，调用方只管自己的流程：
#   ① 定位测试库并自检（必须以 _test 结尾）——冒烟/压测都要写库，写到 dev 库就是倒垃圾；
#   ② 自己的端口（自动挑空闲，绝不占 3100/5671，也不抢别人正在用的端口）与 STORAGE_ROOT（mktemp）；
#   ③ 构建 + 起服务端 + 等 /api/health 就绪；
#   ④ trap 里收进程与临时目录，中途失败也一样。
#
# 用法：source 之后调 `local_server_up <临时目录名前缀>`，结束时 trap 会自己收；
#       连接串在 `DATABASE_URL`、服务端地址在 `PUBLIC_BASE_URL`。
set -euo pipefail

local_server_resolve_database_url() {
  if [ -n "${TEST_DATABASE_URL:-}" ]; then
    printf '%s' "$TEST_DATABASE_URL"
    return 0
  fi
  if [ -n "${DATABASE_URL:-}" ]; then
    printf '%s' "$DATABASE_URL"
    return 0
  fi
  for file in apps/server/.env.development apps/server/.env packages/db/.env; do
    [ -f "$file" ] || continue
    value="$(sed -n 's/^DATABASE_URL=//p' "$file" | head -n 1 | sed 's/^"//; s/"$//')"
    if [ -n "$value" ]; then
      printf '%s' "$value"
      return 0
    fi
  done
  return 1
}

# 库名自检（判据原文：先自检库名含 _test 才继续）。需要派生测试库名时派生后再断言一次。
local_server_use_test_database() {
  if ! DATABASE_URL="$(local_server_resolve_database_url)"; then
    echo '✘ 找不到 DATABASE_URL（环境变量或 apps/server/.env*）' >&2
    return 1
  fi
  local db_name
  db_name="$(printf '%s' "$DATABASE_URL" | sed -E 's#^[^?]+/([^?]+).*$#\1#')"
  case "$db_name" in
    *_test) ;;
    *)
      if [ -n "${TEST_DATABASE_URL:-}" ]; then
        echo "✘ 拒绝运行：TEST_DATABASE_URL 的库名必须以 _test 结尾，当前是 \"${db_name}\"。" >&2
        return 1
      fi
      DATABASE_URL="$(printf '%s' "$DATABASE_URL" | sed -E 's#^(postgresql://[^?]+/)[^?]+#\1'"${db_name}"'_test#')"
      db_name="${db_name}_test"
      ;;
  esac
  case "$db_name" in
    *_test) ;;
    *)
      echo "✘ 拒绝运行：目标库名必须以 _test 结尾，当前是 \"${db_name}\"。" >&2
      return 1
      ;;
  esac
  export DATABASE_URL
  echo "✔ 库名自检通过：${db_name}"
}

local_server_pick_port() {
  local candidate
  for candidate in $(seq 3399 3419); do
    if ! lsof -nP -iTCP:"${candidate}" -sTCP:LISTEN > /dev/null 2>&1; then
      printf '%s' "${candidate}"
      return 0
    fi
  done
  return 1
}

local_server_cleanup() {
  if [ -n "${LOCAL_SERVER_PID:-}" ]; then
    kill "$LOCAL_SERVER_PID" 2>/dev/null || true
    wait "$LOCAL_SERVER_PID" 2>/dev/null || true
    LOCAL_SERVER_PID=''
  fi
}

# 起一个只归本轮所有的服务端：端口自动挑、存储用 mktemp、构建产物跑真 Nest
local_server_up() {
  local prefix="${1:-protohub-local}"
  LOCAL_SERVER_DIR="$(mktemp -d "${TMPDIR:-/tmp}/${prefix}.XXXXXX")"
  PORT="${LOCAL_SERVER_PORT:-$(local_server_pick_port || true)}"
  if [ -z "${PORT}" ]; then
    echo '✘ 3399–3419 全被占用，用 LOCAL_SERVER_PORT=<空闲端口> 指定一个再跑' >&2
    return 1
  fi
  export PORT
  export STORAGE_ROOT="${LOCAL_SERVER_DIR}/storage"
  export PUBLIC_BASE_URL="http://127.0.0.1:${PORT}"
  export SERVE_STATIC=node
  mkdir -p "$STORAGE_ROOT"
  echo "  端口 ${PORT} · 存储 ${STORAGE_ROOT} · 临时目录 ${LOCAL_SERVER_DIR}"

  trap local_server_cleanup EXIT

  echo '… 构建服务端（nest build）'
  if ! pnpm -F @protohub/server build > "${LOCAL_SERVER_DIR}/build.log" 2>&1; then
    echo '✘ nest build 失败：' >&2
    tail -n 30 "${LOCAL_SERVER_DIR}/build.log" >&2
    return 1
  fi

  LOCAL_SERVER_LOG="${LOCAL_SERVER_DIR}/server.log"
  node apps/server/dist/main.js > "$LOCAL_SERVER_LOG" 2>&1 &
  LOCAL_SERVER_PID=$!

  echo "… 等服务端起来（${PUBLIC_BASE_URL}/api/health）"
  local ready=0
  local _try
  for _try in $(seq 1 60); do
    if curl -fsS "${PUBLIC_BASE_URL}/api/health" > /dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 0.5
  done
  if [ "$ready" -ne 1 ]; then
    echo '✘ 服务端 30s 内没起来，日志尾部：' >&2
    tail -n 40 "$LOCAL_SERVER_LOG" >&2
    return 1
  fi
  echo '✔ 服务端已就绪'
}
