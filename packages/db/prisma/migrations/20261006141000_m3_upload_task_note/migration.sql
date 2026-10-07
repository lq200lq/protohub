-- M3-T2 受理链路的缺口补充：版本说明要能从受理带到 commit。
--
-- `note` 属于 `proto_release`（数据库设计 §4.2.4），而 release 行是 Worker 在机制 §3.1 第 3 步才建的，
-- Worker 唯一能读到的输入就是这条任务行——§4.2.6 的列清单里没有承载位，说明就会在解压后丢失。
-- 与 `source_name`/`source_size`/`temp_key` 同一用途（将受理时的意图交给处理端），
-- 见迭代实施计划 §9 DEV-18。
ALTER TABLE "proto_upload_task" ADD COLUMN "note" VARCHAR(300);
