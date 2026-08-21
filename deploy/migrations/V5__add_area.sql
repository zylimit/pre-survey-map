-- ═════════════════════════════════════════════════════════════════════════════
-- V5__add_area.sql —— #51 Phase 16
--
-- AREA 运营商区域面图层（F23 · 第四类实体）：2 张新表（area / area_snapshot）
-- + restore_point 加 area_count 摘要列。已部署库升级用（幂等，与 init.sql
-- 同结构）。
--
-- 仅新增对象 + restore_point 加列，不改其他既有表结构、不动数据。
-- area 全链路同 site 待遇：F17 快照/回滚纳入（api/restore/helper.py +
-- router.py 同步），reset 清单同步（deploy/deploy.sh _cloud_reset_db）。
-- ═════════════════════════════════════════════════════════════════════════════

-- area: 面要素（运营商区域划分），自增主键；去重键 = (operator, name) DB 兜底。
-- operator 导入时按目标图层盖戳（Globe/Smart/Dito），源属性忽略（同 F20 盖戳模型）。
-- geom 只收 Polygon；MultiPolygon 源由解析层取最大面/展开（Phase 17 实现时定）。
CREATE TABLE IF NOT EXISTS area (
    id          BIGSERIAL   PRIMARY KEY,
    name        TEXT        NOT NULL,
    operator    TEXT        NOT NULL,
    geom        GEOMETRY(Polygon, 4326),
    extras      JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (operator, name)
);

CREATE INDEX IF NOT EXISTS area_geom_idx ON area USING GIST (geom);

-- area_snapshot: 镜像 area 全列 + restore_point_id（F17 回滚不丢列教训：
-- 快照表必须镜像主表全列，建点/回滚逐列显式）
CREATE TABLE IF NOT EXISTS area_snapshot (
    restore_point_id BIGINT      NOT NULL REFERENCES restore_point(id) ON DELETE CASCADE,
    id               BIGINT,
    name             TEXT        NOT NULL,
    operator         TEXT        NOT NULL,
    geom             GEOMETRY(Polygon, 4326),
    extras           JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS area_snapshot_rp_idx ON area_snapshot (restore_point_id);

-- restore_point 摘要列加 area 计数（同 site_count/road_count/lessor_count 模式）。
ALTER TABLE restore_point ADD COLUMN IF NOT EXISTS area_count INT;
