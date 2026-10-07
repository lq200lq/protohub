# 参与贡献指南

感谢你愿意让 ProtoHub 变得更好！提交 Issue、反馈文档问题、发 PR 都是贡献。

请先阅读 [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)。

## 1. 准备开发环境

1. 环境要求与初始化步骤见 [README.zh-CN.md · 快速开始](./README.zh-CN.md#快速开始)：Node `^22.18 || ^24`、pnpm `>= 11`、PostgreSQL 17。
2. `pnpm install` 会自动执行 `prepare` 钩子安装 lefthook（pre-commit / commit-msg）。
3. 跑通一遍 `pnpm dev`，能登录管理端、能上传发布一个原型，再开始改代码。

## 2. 分支与提交

### 分支

- `main` 是唯一长期分支，发布与部署都从它切出。
- 功能/修复走短生命周期分支：`feat/<简述>`、`fix/<简述>`、`docs/<简述>`、`chore/<简述>`。
- 保持一个分支只做一件事，方便评审与回滚。

### 提交信息

用 `pnpm commit` 走交互式提交（czg），提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/)（commitlint 在 commit-msg 钩子校验）：

```text
feat(admin): 工作台增加访问量环比
fix(server): 密码档解锁限流按原型隔离
docs: 补充部署与运维方案的 nginx 片段
chore(db): 种子数据补 viewer 的访问记录只读码
```

- 类型：`feat` / `fix` / `docs` / `style` / `refactor` / `perf` / `test` / `build` / `ci` / `chore`。
- scope 可选，建议用包名（`admin`、`server`、`db`、`shared`）或 `project` / `deploy` / `other`。
- 描述用中文，说清"为什么"，不超过 72 字符为宜。

## 3. 代码规范

- **TypeScript 严格**：不写 `any`、不用 `@ts-ignore`（docs/前端设计.md §3.7 红线）。
- **消费 design token**：颜色 / 字号 / 圆角 / 间距一律用 token 与 Tailwind 工具类，不硬编码色值与魔法数字；新增界面可用 computed style 集合自检，不靠肉眼。
- **组件复用**：相似能力收敛到基础组件参数化渲染，不要复制出几个几乎一样的卡片/列表。
- **文案走 i18n**：业务文案写进 `apps/admin/src/locales/langs/{zh-CN,en-US}/proto.json`，中英两份同步改，不把中文写死在模板里（菜单标题例外，按框架约定直接写中文）。
- **接口契约**：前后端共享类型放 `packages/shared`，响应体与错误码按 `docs/后端接口设计.md`，不要前后端各定义一份。
- **权限**：新增操作要同时落权限码（`packages/shared`）、后端 `@RequirePermission`、菜单/按钮节点，并跑 `pnpm check:consistency`（7 条规则会查这三处是否一致）。
- **注释**：只解释"为什么"和非显然的约束，不复述代码在做什么。

## 4. 提交前检查

```bash
pnpm check     # type + 循环依赖 + 一致性 + 测试，总门禁
pnpm lint      # ESLint / Stylelint / Prettier
```

- pre-commit 钩子（lefthook）会自动跑 `pnpm lint` 与 `pnpm check:type`；它没过就别 `--no-verify`。
- 改了单测覆盖的逻辑，测试要一起改；修 UI 必须真开浏览器点一遍（登录 → 操作 → 断言），交付说明里如实写哪些路径没点到。
- 纯文案/文档改动至少自己通读一遍渲染效果（表格、图片路径、链接）。

## 5. Pull Request

1. PR 描述按模板填写：动机、改动点、验证方式（跑过的命令 + 手动验证步骤）。
2. 关联 Issue（`Closes #123`）；没有 Issue 的小改动（错字、注释）可以直接提。
3. UI 改动请附前后截图，涉及布局/滚动的附关键读数（如页面高度、溢出范围）。
4. 设计有变化时同步更新 `docs/`（docs-first：先改设计文档，再改代码，或在同一 PR 里一起改）。
5. 保持 PR 单一主题；一个 PR 混多条工作线会被要求拆分。

## 6. Issue

- 用 `.github/ISSUE_TEMPLATE` 里的模板：bug 请给复现步骤、期望/实际、环境信息与截图/日志。
- 安全问题**不要**开公开 issue，按 [SECURITY.md](./SECURITY.md) 私密上报。
- 文档看不懂也算问题，欢迎提 `docs` 类 issue。

## 7. 设计文档

`docs/` 是本项目的权威设计来源，阅读顺序见 [docs/README.md](./docs/README.md)。动手前先确认相关设计文档里怎么说；实现与文档冲突时，在同一个 PR 里把两边对齐。
