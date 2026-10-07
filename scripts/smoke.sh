#!/usr/bin/env bash
#
# 端到端冒烟（迭代实施计划 M5-T7）：登录 → 建项目 → 建原型 → 发布 → 三档访问 → 回滚 → 归档 → 查记录。
#
# 三条硬约束：只跑 *_test 库（入口自检，不对就一步都不做）、自己的端口与 STORAGE_ROOT（不碰人类
# 正在跑的 dev 服务）、跑完连进程带数据一起收（流程脚本只删自己建的行，绝不 truncate）。
# 端口挑选/构建/起停这些两处要用的东西收在 scripts/lib/local-server.sh（§3.7），这里只管冒烟流程。
#
# 用法：pnpm smoke
set -euo pipefail

cd "$(dirname "$0")/.."
# shellcheck source=lib/local-server.sh
source scripts/lib/local-server.sh

local_server_use_test_database

export SMOKE_USERNAME="${SMOKE_USERNAME:-smoke_admin}"
export SMOKE_PASSWORD="${SMOKE_PASSWORD:-smoke-$(date +%s)-${RANDOM}}"

local_server_up protohub-smoke

set +e
# tsx 只在 packages/db 里（依赖白名单不为了跑脚本再加一个），从那个包借它的 bin
pnpm --filter @protohub/db exec tsx "${PWD}/scripts/smoke/smoke-flow.mts"
flow_exit=$?
set -e

if [ "$flow_exit" -ne 0 ]; then
  echo '✘ 冒烟失败，服务端日志尾部：' >&2
  tail -n 40 "$LOCAL_SERVER_LOG" >&2
fi
exit "$flow_exit"
