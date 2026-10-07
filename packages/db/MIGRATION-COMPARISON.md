# M0-T4 迁移比对记录（Gate G5）

> 比对对象：`docs/数据库设计.md` §4 DDL（设计权威） vs `packages/db/prisma/migrations/20261006072030_init/migration.sql` 应用到 `protohub` 后的实际结构（`\d <table>` 逐表核对，PostgreSQL 17 / prisma 6.19.3，2026-10-06）。
>
> 结论：**16 张表、全部列/类型/默认值/索引名/索引 WHERE 条件/CHECK 语义/FK on-delete 行为与文档一致**；存在 4 处"表达层"差异（见文末"差异与处理"），均不影响结构语义。

## 1. 逐表比对结果

图例：✓ = 表名/列名/列类型/索引名/FK 行为逐项目视比对 `\d` 输出与 §4 DDL，无差异。

### 1.1 sys_（9 张）

| 表 | 表名 | 列名+类型 | 索引 | CHECK | FK | 结论 |
| --- | --- | --- | --- | --- | --- | --- |
| `sys_user` | ✓ | ✓（19 列逐一对齐，`last_login_ip inet`、时间全 `timestamptz(6)`） | ✓ `uk_sys_user_username`=`UNIQUE btree (lower(username)) WHERE deleted_at IS NULL`（原生 SQL）、`idx_sys_user_status ... WHERE deleted_at IS NULL`（原生 SQL） | — | 被 7 处引用 ✓ | 一致 |
| `sys_role` | ✓ | ✓（11 列；`built_in boolean default false` ✓） | ✓ `uk_sys_role_code WHERE deleted_at IS NULL`（原生 SQL） | ✓ `sys_role_data_scope_check`（原生 SQL，同 PG 内联自动命名） | 被 3 处引用 ✓ | 一致 |
| `sys_user_role` | ✓ | ✓（复合 PK `(user_id, role_id)` ✓） | ✓ `idx_sys_user_role_role` | — | ✓ 两条均 `ON DELETE CASCADE` | 一致 |
| `sys_permission` | ✓ | ✓（7 列） | ✓ `uk_sys_permission_code`（Prisma `@unique(map:)`） | — | 被引用 ✓ | 一致 |
| `sys_role_permission` | ✓ | ✓（复合 PK ✓） | ✓ `idx_sys_role_permission_perm` | — | ✓ CASCADE×2 | 一致 |
| `sys_menu` | ✓ | ✓（24 列，含 `menu_visible_with_forbidden` 等长名逐字对齐） | ✓ `uk_sys_menu_name`、`idx_sys_menu_pid (pid, sort)`；`uk_sys_menu_auth_code WHERE auth_code IS NOT NULL`（原生 SQL） | ✓ `sys_menu_type_check`（原生 SQL） | ✓ `fk_sys_menu_pid ON DELETE RESTRICT`（自引用） | 一致 |
| `sys_role_menu` | ✓ | ✓（无 created_at，与 DDL 相同） | ✓ `idx_sys_role_menu_menu` | — | ✓ CASCADE×2 | 一致 |
| `sys_login_log` | ✓ | ✓（9 列） | ✓ `(user_id, created_at DESC)`、`(created_at)` | ✓ `sys_login_log_login_type_check`（原生 SQL） | ✓ 无外键（user_id 允许指向已删用户，DDL 即未建） | 一致 |
| `sys_oper_log` | ✓ | ✓（16 列；`detail jsonb`、`duration_ms integer` ✓） | ✓ `(resource_type, resource_id, created_at DESC)`、`(created_at)` | — | ✓ 无外键 | 一致 |

### 1.2 proto_（7 张）

| 表 | 表名 | 列名+类型 | 索引 | CHECK | FK | 结论 |
| --- | --- | --- | --- | --- | --- | --- |
| `proto_project` | ✓ | ✓（10 列；`code varchar(63)` ✓） | ✓ `uk_proto_project_code WHERE deleted_at IS NULL`、`idx_proto_project_created_by WHERE deleted_at IS NULL`（均原生 SQL）、`idx_proto_project_archived` | ✓ `proto_project_code_check ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`（原生 SQL） | ✓ `created_by → sys_user`（文档未写 on delete → 取 PG 默认 NO ACTION 的等价 RESTRICT，见差异 D3） | 一致 |
| `proto_prototype` | ✓ | ✓（19 列；`policy_version integer default 1`、`password_hash text` ✓） | ✓ `uk_proto_prototype_code (project_id, code) WHERE deleted_at IS NULL`（原生 SQL）、`idx_proto_prototype_project (project_id, sort)`、`idx_proto_prototype_status WHERE deleted_at IS NULL`（原生 SQL） | ✓ `ck_proto_prototype_pwd`（原生 SQL，语义逐字一致：`access_mode <> 'password' OR password_hash IS NOT NULL`）；另有 code/status/access_mode 三个 CHECK（原生 SQL） | ✓ `project→CASCADE`、`created_by→RESTRICT`、**循环外键 `fk_proto_prototype_current_release → proto_release ON DELETE SET NULL` ✓**（与 DDL 同名同语义，Prisma 生成时即为 ALTER TABLE ADD CONSTRAINT 形式，与文档"4.2.4 之后补"顺序等价） | 一致 |
| `proto_project_member` | ✓ | ✓（5 列，复合 PK ✓） | ✓ `idx_proto_project_member_user` | ✓ `proto_project_member_member_role_check`（原生 SQL） | ✓ project→CASCADE、user→CASCADE | 一致 |
| `proto_release` | ✓ | ✓（17 列；`source_size/total_bytes bigint`、`manifest jsonb default '{}'::jsonb` ✓） | ✓ `uk_proto_release_version (prototype_id, version_no)` **保持无条件**（文档 §5：并发发布抢 version_no 的最终防线）、`(prototype_id, created_at DESC)`、`(prototype_id, source_hash)` | ✓ `proto_release_status_check`（原生 SQL） | ✓ prototype→CASCADE、created_by→RESTRICT；被 `fk_proto_prototype_current_release` 引用 ✓ | 一致 |
| `proto_release_event` | ✓ | ✓（8 列；`from/to_release_id` 无外键，与 DDL 相同） | ✓ `idx_proto_release_event_prototype (prototype_id, created_at DESC)` | ✓ `proto_release_event_event_type_check`（原生 SQL） | ✓ prototype→CASCADE、operator→RESTRICT | 一致 |
| `proto_upload_task` | ✓ | ✓（18 列；`progress smallint`、`warnings jsonb default '[]'::jsonb`、`release_id` 无外键 ✓） | ✓ `idx_proto_upload_task_todo (status, created_at) WHERE status IN ('pending','processing')`（原生 SQL，部分索引）、`idx_proto_upload_task_prototype` | ✓ status CHECK、`proto_upload_task_progress_check (0..100)`（原生 SQL） | ✓ prototype→CASCADE、created_by→RESTRICT | 一致 |
| `proto_access_log` | ✓ | ✓（16 列） | ✓ `(prototype_id, created_at DESC)`、`(created_at)` | ✓ `proto_access_log_result_check`（原生 SQL） | ✓ `prototype_id`/`release_id`/`user_id` **刻意无外键**（文档 §2 全库唯一两处弱关联，`user_id` 同为无外键列） | 一致 |

## 2. Prisma 能表达 / 不能表达的分界

- schema.prisma（`@@index`/`@unique`/`@@unique` + `map:` 保留 uk_/idx_ 命名）：20 个索引/唯一索引（含 DESC 列序），19 个 FK（`map:` 保留 fk_ 命名、`onDelete` 逐条对应文档），全部列类型/默认值（含 `jsonb default '{}'/'[]'::jsonb` 用 `dbgenerated`）。
- 迁移尾部" NATIVE SQL"段手工添加（`prisma migrate dev --create-only` 后编辑）：
  - **9 个 Prisma 无法表达的条件/部分/表达式索引**：`uk_sys_user_username`(lower+partial)、`idx_sys_user_status`、`uk_sys_role_code`、`uk_sys_menu_auth_code`、`uk_proto_project_code`、`idx_proto_project_created_by`、`uk_proto_prototype_code`、`idx_proto_prototype_status`、`idx_proto_upload_task_todo`(WHERE status IN)。
  - **14 个 CHECK 约束**：`ck_proto_prototype_pwd`（文档指定名）+ `code ~ '^[a-z0-9]+(-[a-z0-9]+)*$'` ×2 + 11 个枚举 CHECK（按文档 §1"varchar+check"约定必须落库）。名称沿用 PG 对文档内联 unnamed check 的自动命名 `<table>_<column>_check`，保证与直接执行文档 DDL 的 `pg_get_constraintdef` 输出逐字可比。

## 3. 差异与处理（共 4 处，均为表达层，无语义差异）

| # | 差异 | 处理 |
| --- | --- | --- |
| D1 | Prisma 6.19 对 `@default(autoincrement())` 生成的是 `BIGSERIAL`，文档 §1 明确要求 `generated by default as identity` | 手工把迁移 SQL 中 12 个自增主键改为 `BIGINT GENERATED BY DEFAULT AS IDENTITY`（`\d` 已确认 identity）。后续如用 `prisma db pull` 回流，identity 仍映射回 `autoincrement()`，不产生往返破坏 |
| D2 | 文档列定义写 `timestamptz`（省略精度），`\d` 显示 `timestamp(6) with time zone` | Prisma 用 `@db.Timestamptz(6)`——与 PG 未限定精度的 `timestamptz` 完全同一类型/精度，仅 `\d` 显示写法不同 |
| D3 | 文档中 `created_by/operator_id` 等 FK 未写 `on delete`（即 PG 默认 NO ACTION）；Prisma 无法表达 NO ACTION 与 RESTRICT 之差，生成 `ON DELETE RESTRICT` | 接受：两者对非延迟外键行为逐案例等价（删除父行都报 FK 违反）。`ON UPDATE` 全部显式 `NoAction`，与文档默认一致（`\d` 中不显示即 NO ACTION） |
| D4 | 迁移尾部手工 SQL 对象（9 索引 + 14 CHECK）在 schema.prisma 中不存在 | 这是文档 §"T4 细则 2" 指定的做法。注意：今后跑 `prisma migrate dev` 会把这些对象报为 drift 而试图删除——团队约定**后续迭代继续用 `--create-only` + 手工补 SQL**，且这些手工对象都已在迁移文件中固化，`migrate deploy`（生产路径）不受影响 |

## 4. 验证记录（2026-10-06 实测）

- `pnpm db:migrate` 首跑 exit 0：创建 `protohub_test`、两库各应用 `20261006072030_init`、打印两库业务表各 **16** 张。
- **二跑 exit 0 幂等**：测试库"已存在，跳过创建"；两库均 "No pending migrations to apply."；表数不变。
- `\dt`：protohub / protohub_test 各 17 行 = 16 业务表 + `_prisma_migrations`。
- `pg_indexes.indexdef` 抽样确认 WHERE 条件存活：`uk_sys_user_username`、`uk_proto_prototype_code`、`idx_proto_upload_task_todo`、`idx_sys_user_status`、`uk_sys_menu_auth_code` 等 9 个全部带原条件。
- `pg_constraint`：`ck_proto_prototype_pwd` 与 13 个 `<table>_<column>_check` 全部在列（另有 2 条 `cardinal_number_domain_check`/`yes_or_no_check` 属 PG 系统 domain，与本项目无关）。
- 外键 19 条，`pg_get_constraintdef` 逐条与 §1/§2 表格中的 on-delete 语义一致；循环外键 `fk_proto_prototype_current_release`（SET NULL）存在。

## 5. 与本任务相关但超出 schema 的一个矛盾（提请 M0-T5 处理）

计划要求 `src/index.ts` 按既有 `tsconfig.build.json` 编译为 **CJS** 到 `./dist/index.js`，此目标已达成（build/typecheck 均 exit 0）。但 `packages/db/package.json` 声明了 `"type": "module"`，二者组合后 Node 24 实测：`import('./dist/index.js')` 抛 `exports is not defined in ES module scope`，`require()` 返回空导出。这不是本任务可单方修正的（涉及改 package.json 的 type/exports，属"改进"而非"实现"），建议 M0-T5 建 server 时三选一：去掉 `"type": "module"`、exports 改指 `.cjs`、或 build 改出 ESM。**Prisma 客户端本体（generate/迁移/两库结构）不受影响。**
