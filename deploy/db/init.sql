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
    operator     TEXT,
    category     TEXT,
    type         TEXT,
    lati         DOUBLE PRECISION,
    longi        DOUBLE PRECISION,
    extras       JSONB       NOT NULL DEFAULT '{}'::jsonb,
    source_file  TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    geom         GEOMETRY(Point, 4326),
    PRIMARY KEY (site_id, "option")
);

-- F20 (V1.x #24/#25) · 图层三列：已有 volume 升级用幂等 ADD COLUMN（盖戳前为 NULL）
ALTER TABLE site ADD COLUMN IF NOT EXISTS operator TEXT;
ALTER TABLE site ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE site ADD COLUMN IF NOT EXISTS type     TEXT;

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
                    CHECK (reason IN ('pre_import','pre_clear','pre_rollback','manual','auto_backup','pre_migrate','pre_feature_delete')),
    note            TEXT,
    site_count      INT,
    road_count      INT,
    lessor_count    INT,
    baseline_iso_a2 TEXT
);

-- #42：reason 增加 'auto_backup'（定时自动备份）。
-- 部署系统 P2（DEPLOY-DESIGN §5）：reason 增加 'pre_migrate'（迁移前自动恢复点）。
-- #48：reason 增加 'pre_feature_delete'（site 批量删除前自动恢复点）。
-- 已部署库 CREATE TABLE IF NOT EXISTS 不会重跑 → 用幂等 ALTER 重建 CHECK 约束。
-- 内联 CHECK 的默认约束名 = restore_point_reason_check。
ALTER TABLE restore_point DROP CONSTRAINT IF EXISTS restore_point_reason_check;
ALTER TABLE restore_point ADD CONSTRAINT restore_point_reason_check
    CHECK (reason IN ('pre_import','pre_clear','pre_rollback','manual','auto_backup','pre_migrate','pre_feature_delete'));

-- site_snapshot: 镜像 site 全列 + restore_point_id
CREATE TABLE IF NOT EXISTS site_snapshot (
    restore_point_id BIGINT      NOT NULL REFERENCES restore_point(id) ON DELETE CASCADE,
    site_id          TEXT        NOT NULL,
    "option"         TEXT        NOT NULL DEFAULT '',
    project          TEXT,
    site_status      TEXT,
    operator         TEXT,
    category         TEXT,
    type             TEXT,
    lati             DOUBLE PRECISION,
    longi            DOUBLE PRECISION,
    extras           JSONB       NOT NULL DEFAULT '{}'::jsonb,
    source_file      TEXT,
    created_at       TIMESTAMPTZ,
    updated_at       TIMESTAMPTZ,
    geom             GEOMETRY(Point, 4326)
);
-- F20 (V1.x #24/#25) · 快照同步三列：否则 F17 回滚静默丢列（回滚后分层全空）
ALTER TABLE site_snapshot ADD COLUMN IF NOT EXISTS operator TEXT;
ALTER TABLE site_snapshot ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE site_snapshot ADD COLUMN IF NOT EXISTS type     TEXT;
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
    username    TEXT,
    action      TEXT       NOT NULL,
    details     JSONB,
    result      TEXT       NOT NULL DEFAULT 'success',
    error_msg   TEXT
);
-- #50：已部署库升级用幂等加列（未登录请求记 NULL）
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS username TEXT;

CREATE INDEX IF NOT EXISTS audit_log_ts_idx ON audit_log (ts DESC);
CREATE INDEX IF NOT EXISTS audit_log_action_idx ON audit_log (action);

-- ============================================================
-- #49 Phase 9 · 轻量「撤销删除」（替代 site 删除的 F17 全表快照）
-- ============================================================
-- site 批量删除只镜像【被删那几行】到 site_delete_undo（O(删除条数)，
-- 不再 create_restore_point 复制整表）。批次号 undo_id 由序列生成；
-- undone 标记该批是否已撤销；环形保留最近 200 批（delete_sites 中清理）。
-- 持久「删除历史」面板按 undo_id 列出、逐批撤销（INSERT 回 site，ON CONFLICT DO NOTHING）。
CREATE SEQUENCE IF NOT EXISTS site_delete_undo_batch_seq;
CREATE TABLE IF NOT EXISTS site_delete_undo (
    undo_id      BIGINT      NOT NULL,                 -- 批次号（同一次删除共享）
    deleted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    undone       BOOLEAN     NOT NULL DEFAULT false,
    -- 镜像 site 全列
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

-- ============================================================
-- #50 Phase 10 · 用户与角色权限（RBAC：登录 + 功能权限 × 数据权限）
-- ============================================================
-- 只建结构；admin 角色/用户的 bcrypt 哈希种子由 api 启动时写入
-- （api/main.py lifespan → ensure_admin_seed，判空幂等）。

-- app_role: 角色表。perms 4 开关键：import / export / edit_delete / danger，
-- 布尔值，缺省 false。is_admin=true 的角色拥有全部权限（不可改/删，见 Phase 12）。
CREATE TABLE IF NOT EXISTS app_role (
    id          BIGSERIAL   PRIMARY KEY,
    name        TEXT        UNIQUE NOT NULL,
    is_admin    BOOLEAN     DEFAULT false,
    perms       JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at  TIMESTAMPTZ DEFAULT now()
);

-- app_user: 用户表。must_change_password 默认 true（建号/种子后首登强制改密）。
CREATE TABLE IF NOT EXISTS app_user (
    id                   BIGSERIAL   PRIMARY KEY,
    username             TEXT        UNIQUE NOT NULL,
    password_hash        TEXT        NOT NULL,
    role_id              BIGINT      REFERENCES app_role(id),
    disabled             BOOLEAN     DEFAULT false,
    must_change_password BOOLEAN     DEFAULT true,
    created_at           TIMESTAMPTZ DEFAULT now()
);

-- app_role_scope: 数据权限（图层文件夹节点，子级继承）。
-- scope_node 取值域：site / site:Globe / site:Smart / site:Dito /
--   site:<运营商>:<EXISTING|PLANNED|SURVEY> / road / lessor
CREATE TABLE IF NOT EXISTS app_role_scope (
    id          BIGSERIAL   PRIMARY KEY,
    role_id     BIGINT      REFERENCES app_role(id) ON DELETE CASCADE,
    scope_node  TEXT        NOT NULL,
    UNIQUE (role_id, scope_node)
);

-- auth_session: 登录会话（token = URL-safe 随机 32 字节，7 天滑动过期）。
CREATE TABLE IF NOT EXISTS auth_session (
    token       TEXT        PRIMARY KEY,
    user_id     BIGINT      REFERENCES app_user(id) ON DELETE CASCADE,
    expires_at  TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_session_expires_at_idx ON auth_session (expires_at);
