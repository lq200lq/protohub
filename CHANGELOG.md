# 变更日志（Changelog）

本项目的版本变更由 [changesets](https://github.com/changesets/changesets) 管理：变更记录随版本发布自动生成到各包的 `CHANGELOG.md`，本文件负责说明**约定与流程**，并汇总面向使用者的版本要点。

## 如何记录一次变更

1. 改完代码后执行 `pnpm changeset`，按提示选择受影响的包（`@protohub/admin` / `@protohub/server` / `@protohub/db` / `@protohub/shared`）、变更级别（`major` / `minor` / `patch`）与一句话描述。
2. 生成的 markdown 片段提交进 `.changeset/`，与代码同一个 PR。
3. 没有用户可见影响的改动（纯内部重构、脚本、文档）不必加 changeset。

## 发布流程

```bash
pnpm version      # changesets 消费 .changeset/* → 升版本 + 生成各包 CHANGELOG.md
pnpm install      # 刷新 lockfile
git push --follow-tags
```

- 分支模型：`main` 是唯一长期分支，`baseBranch` 在 `.changeset/config.json` 中指向 `main`。
- monorepo 内 `@vben-core/*` 与 `@vben/*` 使用 fixed 版本组，`@protohub/*` 按各自节奏演进。

## 版本要点

### Unreleased

- 首个开源版本准备中：项目 / 原型 / 版本三级模型、ZIP 发布流水线与回滚、三档访问策略、访问记录与分析、四角色权限体系、工作台与系统设置。

> 历史开发过程与里程碑验收记录见 [docs/迭代实施计划.md](./docs/迭代实施计划.md)。
