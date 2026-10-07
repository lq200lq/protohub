-- M3 发布受理需要的两列（数据库设计 §4.2.6 未给出，见 迭代实施计划 §9 偏差 DEV-15/DEV-16）
--   idempotency_key：接口设计 §1.3 约定「重复键在 10 分钟内直接返回首次结果」，
--                    没有列就无从"返回首次结果"，只能靠客户端不重复点。
--   retry_count：  原型发布与访问机制 §3.2 的「超时重置为 pending 并重试一次」需要一个计数，
--                    否则崩溃恢复会无限重投同一个任务。
ALTER TABLE "proto_upload_task" ADD COLUMN "idempotency_key" VARCHAR(64);
ALTER TABLE "proto_upload_task" ADD COLUMN "retry_count" SMALLINT NOT NULL DEFAULT 0;

-- 与既有约束同名风格：文档内联 unnamed check 由 PG 自动命名为 <table>_<column>_check
ALTER TABLE "proto_upload_task" ADD CONSTRAINT "proto_upload_task_retry_count_check" CHECK ("retry_count" BETWEEN 0 AND 1);

-- 幂等查找：按 key + 时间倒序取最近一条（10 分钟窗口在代码里按 created_at 判定，
-- 所以这里不做部分唯一索引——同一 key 在窗口外要允许再次使用）
CREATE INDEX "idx_proto_upload_task_idempotency" ON "proto_upload_task" ("idempotency_key", "created_at" DESC) WHERE "idempotency_key" IS NOT NULL;
