#!/usr/bin/env bash
#
# 性能基线（迭代实施计划 M5-T9）：项目列表 1000 条的耗时 / 20MB 包发布耗时 / 原型访问 TTFB。
#
# 与冒烟同一套隔离：只跑 *_test 库（入口自检）、自己的端口与 STORAGE_ROOT、跑完连数据一起收。
# 起停共用 scripts/lib/local-server.sh（§3.7）；测量与对照在 scripts/bench.mts。
# 用法：pnpm bench
set -euo pipefail

cd "$(dirname "$0")/.."
# shellcheck source=lib/local-server.sh
source scripts/lib/local-server.sh

local_server_use_test_database

export BENCH_USERNAME="${BENCH_USERNAME:-bench_admin}"
export BENCH_PASSWORD="${BENCH_PASSWORD:-bench-$(date +%s)-${RANDOM}}"

local_server_up protohub-bench

set +e
pnpm --filter @protohub/db exec tsx "${PWD}/scripts/bench.mts"
bench_exit=$?
set -e

if [ "$bench_exit" -ne 0 ]; then
  echo '✘ 压测失败，服务端日志尾部：' >&2
  tail -n 40 "$LOCAL_SERVER_LOG" >&2
fi
exit "$bench_exit"
