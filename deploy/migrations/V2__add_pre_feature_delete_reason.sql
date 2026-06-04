-- ═════════════════════════════════════════════════════════════════════════════
-- V2__add_pre_feature_delete_reason.sql —— #48 Phase 6
--
-- site 批量删除（POST /api/sites/delete）在删除前于同一事务建恢复点
-- reason='pre_feature_delete'（F17 复用），需纳入 restore_point.reason 的
-- CHECK 约束，否则建点 INSERT 被拒、删除整体回滚。
--
-- 幂等：DROP IF EXISTS + ADD，约束名与 init.sql / migrate.sh 同套
-- （restore_point_reason_check）。仅放宽取值集合，不改表结构、不动数据。
-- ═════════════════════════════════════════════════════════════════════════════

ALTER TABLE restore_point DROP CONSTRAINT IF EXISTS restore_point_reason_check;
ALTER TABLE restore_point ADD CONSTRAINT restore_point_reason_check
    CHECK (reason IN ('pre_import','pre_clear','pre_rollback','manual','auto_backup','pre_migrate','pre_feature_delete'));
