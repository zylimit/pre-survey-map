-- ═════════════════════════════════════════════════════════════════════════════
-- V3__add_site_delete_undo.sql —— #49 Phase 9
--
-- site 删除回滚从 F17 全表快照改为轻量「撤销删除」：只镜像被删那几行到
-- site_delete_undo（O(删除条数)），批次号 undo_id 由序列生成，undone 标记
-- 该批是否已撤销。已部署库建表迁移（幂等，与 init.sql 同结构）。
--
-- 仅新增对象，不改 site/restore_point 等既有表结构、不动数据。
-- ═════════════════════════════════════════════════════════════════════════════

CREATE SEQUENCE IF NOT EXISTS site_delete_undo_batch_seq;

CREATE TABLE IF NOT EXISTS site_delete_undo (
    undo_id      BIGINT      NOT NULL,
    deleted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    undone       BOOLEAN     NOT NULL DEFAULT false,
    site_id      TEXT        NOT NULL,
    "option"     TEXT        NOT NULL DEFAULT '',
    project      TEXT,
    site_status  TEXT,
    operator     TEXT,
    category     TEXT,
    type         TEXT,
    lati         DOUBLE PRECISION,
    longi        DOUBLE PRECISION,
    extras       JSONB       NOT NULL DEFAULT '{}'::jsonb,
    source_file  TEXT,
    created_at   TIMESTAMPTZ,
    updated_at   TIMESTAMPTZ,
    geom         GEOMETRY(Point, 4326)
);

CREATE INDEX IF NOT EXISTS site_delete_undo_batch_idx ON site_delete_undo (undo_id);
CREATE INDEX IF NOT EXISTS site_delete_undo_deleted_at_idx ON site_delete_undo (deleted_at DESC);
