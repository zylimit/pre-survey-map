-- ═════════════════════════════════════════════════════════════════════════════
-- V4__add_rbac.sql —— #50 Phase 10
--
-- 用户与角色权限（RBAC）：4 张新表（app_role / app_user / app_role_scope /
-- auth_session）+ audit_log 加 username 列。已部署库升级用（幂等，与
-- init.sql 同结构）。
--
-- 仅新增对象 + audit_log 加列，不改其他既有表结构、不动数据。
-- admin 角色/用户的 bcrypt 哈希种子不在本文件——由 api 启动时写入
-- （api/main.py lifespan → ensure_admin_seed，判空幂等）。
-- ═════════════════════════════════════════════════════════════════════════════

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

-- audit_log 加 username 列（可空，未登录请求记 NULL）
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS username TEXT;
