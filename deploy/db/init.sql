-- pre-survey-map V1 schema
-- PostgreSQL 16 + PostGIS

CREATE EXTENSION IF NOT EXISTS postgis;

-- Site: 点要素，(site_id, option) 联合主键
-- 已知关键字段显式建列；Excel 50 列扩展统一存入 extras (JSONB)
CREATE TABLE IF NOT EXISTS site (
    site_id      TEXT        NOT NULL,
    "option"     TEXT        NOT NULL DEFAULT '',
    project      TEXT,
    site_status  TEXT,
    lati         DOUBLE PRECISION,
    longi        DOUBLE PRECISION,
    extras       JSONB       NOT NULL DEFAULT '{}'::jsonb,
    source_file  TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    geom         GEOMETRY(Point, 4326),
    PRIMARY KEY (site_id, "option")
);

CREATE INDEX IF NOT EXISTS site_geom_idx ON site USING GIST (geom);
CREATE INDEX IF NOT EXISTS site_status_idx ON site (site_status);

-- Road: 线要素，自增主键
CREATE TABLE IF NOT EXISTS road (
    id           BIGSERIAL   PRIMARY KEY,
    property     TEXT,
    extras       JSONB       NOT NULL DEFAULT '{}'::jsonb,
    source_file  TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    geom         GEOMETRY(LineString, 4326)
);

CREATE INDEX IF NOT EXISTS road_geom_idx ON road USING GIST (geom);

-- Lessor: 面要素，fid 主键
CREATE TABLE IF NOT EXISTS lessor (
    fid              TEXT        PRIMARY KEY,
    lessor_name      TEXT,
    lessor_category  TEXT,
    relationship     TEXT,
    extras           JSONB       NOT NULL DEFAULT '{}'::jsonb,
    source_file      TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    geom             GEOMETRY(Polygon, 4326)
);

CREATE INDEX IF NOT EXISTS lessor_geom_idx ON lessor USING GIST (geom);
CREATE INDEX IF NOT EXISTS lessor_relationship_idx ON lessor (relationship);

-- Countries: Natural Earth ne_10m_admin_0_countries（Spec V1.x #12 底层地理数据）
-- 用于在海里 / 不在主基准 两类清洗判定 + 主基准区域计算
-- 数据由 api 启动时从 /app/geo_data/ne_10m_admin_0_countries.geojson 一次性加载
CREATE TABLE IF NOT EXISTS countries (
    iso_a2   TEXT,
    iso_a3   TEXT,
    name     TEXT,
    name_en  TEXT,
    name_zh  TEXT,
    admin    TEXT,
    geom     GEOMETRY(MultiPolygon, 4326)
);

CREATE INDEX IF NOT EXISTS countries_geom_idx ON countries USING GIST (geom);
CREATE INDEX IF NOT EXISTS countries_iso_a2_idx ON countries (iso_a2);

-- baseline_state: 主基准固化（Spec V1.x #15）
-- 单行约束 id=1，第一次 commit 时由 imports.py 写入，F14 时清空。
-- compute_baseline_region 先读这张表 → 有就返回（~1ms），完全避开 site 全表 KNN 扫描。
CREATE TABLE IF NOT EXISTS baseline_state (
    id              INT         PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    iso_a2          TEXT        NOT NULL,
    name_zh         TEXT,
    coverage_pct    INT,
    points_used     INT,
    established_at  TIMESTAMP   DEFAULT now()
);

-- ============================================================
-- F17 · 基线恢复点与回滚（Spec V1.x #20）
-- ============================================================

-- restore_point: 恢复点元表
CREATE TABLE IF NOT EXISTS restore_point (
    id              BIGSERIAL   PRIMARY KEY,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    reason          TEXT        NOT NULL
                    CHECK (reason IN ('pre_import','pre_clear','pre_rollback','manual')),
    note            TEXT,
    site_count      INT,
    road_count      INT,
    lessor_count    INT,
    baseline_iso_a2 TEXT
);

-- site_snapshot: 镜像 site 全列 + restore_point_id
CREATE TABLE IF NOT EXISTS site_snapshot (
    restore_point_id BIGINT      NOT NULL REFERENCES restore_point(id) ON DELETE CASCADE,
    site_id          TEXT        NOT NULL,
    "option"         TEXT        NOT NULL DEFAULT '',
    project          TEXT,
    site_status      TEXT,
    lati             DOUBLE PRECISION,
    longi            DOUBLE PRECISION,
    extras           JSONB       NOT NULL DEFAULT '{}'::jsonb,
    source_file      TEXT,
    created_at       TIMESTAMPTZ,
    updated_at       TIMESTAMPTZ,
    geom             GEOMETRY(Point, 4326)
);
CREATE INDEX IF NOT EXISTS site_snapshot_rp_idx ON site_snapshot (restore_point_id);

-- road_snapshot: 镜像 road 全列 + restore_point_id
CREATE TABLE IF NOT EXISTS road_snapshot (
    restore_point_id BIGINT      NOT NULL REFERENCES restore_point(id) ON DELETE CASCADE,
    id               BIGINT,
    property         TEXT,
    extras           JSONB       NOT NULL DEFAULT '{}'::jsonb,
    source_file      TEXT,
    created_at       TIMESTAMPTZ,
    geom             GEOMETRY(LineString, 4326)
);
CREATE INDEX IF NOT EXISTS road_snapshot_rp_idx ON road_snapshot (restore_point_id);

-- lessor_snapshot: 镜像 lessor 全列 + restore_point_id
CREATE TABLE IF NOT EXISTS lessor_snapshot (
    restore_point_id BIGINT      NOT NULL REFERENCES restore_point(id) ON DELETE CASCADE,
    fid              TEXT        NOT NULL,
    lessor_name      TEXT,
    lessor_category  TEXT,
    relationship     TEXT,
    extras           JSONB       NOT NULL DEFAULT '{}'::jsonb,
    source_file      TEXT,
    created_at       TIMESTAMPTZ,
    updated_at       TIMESTAMPTZ,
    geom             GEOMETRY(Polygon, 4326)
);
CREATE INDEX IF NOT EXISTS lessor_snapshot_rp_idx ON lessor_snapshot (restore_point_id);

-- baseline_state_snapshot: 镜像 baseline_state 全列 + restore_point_id
CREATE TABLE IF NOT EXISTS baseline_state_snapshot (
    restore_point_id BIGINT      NOT NULL REFERENCES restore_point(id) ON DELETE CASCADE,
    id               INT,
    iso_a2           TEXT,
    name_zh          TEXT,
    coverage_pct     INT,
    points_used      INT,
    established_at   TIMESTAMP
);
CREATE INDEX IF NOT EXISTS baseline_state_snapshot_rp_idx
    ON baseline_state_snapshot (restore_point_id);

-- ============================================================
-- F19 · 审计日志（Spec V1.x #23）
-- ============================================================
-- 12 类操作：open / import / export_full / export_region / export_conflicts /
--          restore_point_create_auto / _manual / _delete / _rollback /
--          _undo_last_import / clear_baseline / audit_log_export
-- 写入失败不应阻塞业务（独立连接 + try/except，详见 api/audit.py）
-- 永久保留（雷 34），不做自动清理
CREATE TABLE IF NOT EXISTS audit_log (
    id          BIGSERIAL  PRIMARY KEY,
    ts          TIMESTAMP  NOT NULL DEFAULT now(),
    session_id  TEXT,
    ip          TEXT,
    user_agent  TEXT,
    action      TEXT       NOT NULL,
    details     JSONB,
    result      TEXT       NOT NULL DEFAULT 'success',
    error_msg   TEXT
);

CREATE INDEX IF NOT EXISTS audit_log_ts_idx ON audit_log (ts DESC);
CREATE INDEX IF NOT EXISTS audit_log_action_idx ON audit_log (action);
