#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
# migrate.sh —— 版本化数据库迁移执行器（DEPLOY-DESIGN §5，核心 · C3）
#
# 思路：轻量 Flyway（纯 SQL + bash 执行器，不引重框架）。
#   - migrations/V<n>__<desc>.sql 序号独立递增，一个文件 = 一个原子变更
#   - 库内 schema_migrations 追踪已应用版本 + checksum（防已应用文件被篡改）
#   - 有待应用文件时：① 迁移前自动建恢复点(reason='pre_migrate') ② 逐文件【单事务】
#     psql 执行 + 登记 ③ 任一文件失败 → 该文件事务回滚 + 中止 + 打印恢复点回滚指引
#
# 安全（§7）：
#   - 仅在 deploy.sh migrate / onprem --migrate-db 显式调用时才连库（默认不碰 db）
#   - 迁移前【必建】恢复点，无法建点则不迁移
#   - PROD 目标迁移前打印 X→Y 二次确认；非交互默认拒绝
#   - 失败中止、不留半迁移静默状态，打印可用恢复点 id
#
# 连库方式：docker exec <DB_CTN> psql —— 不依赖宿主 psql / 端口暴露，cloud+onprem 通用。
# 被 deploy.sh source；依赖 common.sh 的日志/confirm。不单独执行。
# ═════════════════════════════════════════════════════════════════════════════

MIGRATIONS_DIR="$DEPLOY_ROOT/migrations"

# ---------- checksum：sha256（macOS shasum / Linux sha256sum 自适配）----------
_sha256() {
    local f="$1"
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$f" | awk '{print $1}'
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$f" | awk '{print $1}'
    else
        die "缺少 sha256sum / shasum，无法计算迁移文件 checksum"
    fi
}

# ---------- psql 封装（docker exec 进 db 容器跑）----------
# 依赖（由 load_target_conf 注入）：DB_CTN / DB_USER / DB_NAME
_migrate_require_dbcfg() {
    : "${DB_CTN:?target conf 缺 DB_CTN（db 容器名）}"
    : "${DB_USER:?target conf 缺 DB_USER}"
    : "${DB_NAME:?target conf 缺 DB_NAME}"
    require_cmd docker
    docker inspect "$DB_CTN" >/dev/null 2>&1 \
        || die "db 容器不存在：$DB_CTN（docker ps 看一下；migrate 默认不会自起容器）"
}

# _psql_q "<SQL>" —— 跑一条 SQL，-tAq 返回裸值（无表头/对齐）。出错即 die。
# ⚠️ </dev/null：psql 经 -c 不读 stdin，但 docker exec -i 仍会霸占调用方 stdin
#    （如外层 while-read 的 here-doc），必须显式断开，否则吞掉循环剩余输入。
_psql_q() {
    docker exec -i "$DB_CTN" psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 -tAqc "$1" </dev/null \
        || die "psql 执行失败：$1"
}

# _psql_file_tx <file> —— 在【单事务】内执行整个 sql 文件（任一语句失败回滚整文件）。
#   --single-transaction + ON_ERROR_STOP=1：psql 把整个 stdin 包进 BEGIN/COMMIT，
#   遇错 ON_ERROR_STOP 即非零退出 → psql 回滚（不 COMMIT），不留半迁移。
_psql_file_tx() {
    local f="$1"
    docker exec -i "$DB_CTN" psql -U "$DB_USER" -d "$DB_NAME" \
        --single-transaction -v ON_ERROR_STOP=1 -q -f - < "$f"
}

# ---------- schema_migrations 追踪表 ----------
_ensure_migrations_table() {
    _psql_q "CREATE TABLE IF NOT EXISTS schema_migrations (
                version    INT PRIMARY KEY,
                name       TEXT NOT NULL,
                checksum   TEXT NOT NULL,
                applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
             );" >/dev/null
}

# ---------- 迁移前恢复点（复刻 F17 create_restore_point，纯 SQL · 单事务）----------
# DEPLOY-DESIGN §5.3a：reason='pre_migrate'，建 restore_point 行 + 快照主表。
# 列与现 *_snapshot 表结构对齐（见 deploy/db/init.sql / api/restore_point_helper.py）。
# ⚠️ restore_point.reason 的 CHECK 约束需含 'pre_migrate'，否则 INSERT 被拒——
#    本函数在建点【前】幂等放宽该约束（加入 pre_migrate），不破坏既有取值集合。
# ⚠️ area 段按表存在性动态包含：#51(V5) 起 area 必须进快照——漏了则 pre_migrate 点
#    area_snapshot 零行，回滚到该点 area 被 TRUNCATE 后重灌 0 行 = 静默丢数据；
#    但 V5 前环境（area/area_snapshot 尚不存在）须跳过 area 段，否则建点直接失败（向后兼容）。
# 整段在一个事务里：建点失败则什么都不留，绝不在"无恢复点"状态下继续迁移。
# 成功后把新 rp_id 写入全局 PRE_MIGRATE_RP_ID。
# _baseline_tables_present —— restore_point + 四张主表是否都已存在（区分"全新空库初始化"）。
#   返回 0=都在（可建恢复点）；1=缺表（全新库，V0 尚未建 schema，无数据可备份）。
_baseline_tables_present() {
    local n
    n=$(_psql_q "SELECT count(*) FROM information_schema.tables
                 WHERE table_schema='public'
                   AND table_name IN ('restore_point','site_snapshot','road_snapshot',
                                      'lessor_snapshot','baseline_state_snapshot',
                                      'site','road','lessor','baseline_state');")
    [ "$n" = "9" ]
}

_create_pre_migrate_restore_point() {
    step "🛡 迁移前自动建恢复点（reason='pre_migrate'，复刻 F17）"

    # 1) 幂等放宽 reason CHECK，纳入 'pre_migrate'（与 init.sql 同套约束名）
    _psql_q "ALTER TABLE restore_point DROP CONSTRAINT IF EXISTS restore_point_reason_check;" >/dev/null
    _psql_q "ALTER TABLE restore_point ADD CONSTRAINT restore_point_reason_check
             CHECK (reason IN ('pre_import','pre_clear','pre_rollback','manual','auto_backup','pre_migrate','pre_feature_delete'));" >/dev/null

    # 2) 探测 area 表组是否存在（#51/V5 引入）。存在 → 快照必须含 area 段（否则回滚静默丢
    #    area 数据）；不存在 → V5 前环境，跳过 area 段（向后兼容，建点不因缺表失败）。
    local area_present
    area_present=$(_psql_q "SELECT (to_regclass('public.area') IS NOT NULL
                                AND to_regclass('public.area_snapshot') IS NOT NULL)::text;")
    [ "$area_present" = "true" ] || \
        warn "area/area_snapshot 表不存在（V5 前环境）—— pre_migrate 快照跳过 area 段（向后兼容）。"

    # 3) 单事务：建点 + 快照主表（一条 CTE）→ \gset 取 id → 回填摘要（第二条语句）→ 回显 id。
    #    psql --single-transaction 把整段 -f 输入包进同一 BEGIN/COMMIT：任一语句失败整体回滚。
    #    ⚠️ 摘要回填【必须】单独成句：CTE 内 UPDATE 看不到同语句另一 CTE 刚 INSERT 的 rp 行
    #       （每个子语句见的是语句开始前的快照），会更新 0 行 → 计数列 NULL。拆成第二句即可见。
    local rp_id
    if [ "$area_present" = "true" ]; then
    rp_id=$(docker exec -i "$DB_CTN" psql -U "$DB_USER" -d "$DB_NAME" \
                --single-transaction -v ON_ERROR_STOP=1 -tAq -f - <<'SQL'
WITH rp AS (
    INSERT INTO restore_point (reason, note)
    VALUES ('pre_migrate', 'auto restore point before schema migration')
    RETURNING id
), s_site AS (
    INSERT INTO site_snapshot
        (restore_point_id, site_id, "option", project, site_status,
         operator, category, type, lati, longi, extras, source_file,
         created_at, updated_at, geom)
    SELECT (SELECT id FROM rp), site_id, "option", project, site_status,
           operator, category, type, lati, longi, extras, source_file,
           created_at, updated_at, geom
    FROM site
    RETURNING 1
), s_road AS (
    INSERT INTO road_snapshot
        (restore_point_id, id, property, extras, source_file, created_at, geom)
    SELECT (SELECT id FROM rp), id, property, extras, source_file, created_at, geom
    FROM road
    RETURNING 1
), s_lessor AS (
    INSERT INTO lessor_snapshot
        (restore_point_id, fid, lessor_name, lessor_category, relationship,
         extras, source_file, created_at, updated_at, geom)
    SELECT (SELECT id FROM rp), fid, lessor_name, lessor_category, relationship,
           extras, source_file, created_at, updated_at, geom
    FROM lessor
    RETURNING 1
), s_area AS (
    -- #51：area 纳入快照（逐列显式对齐 api/restore/helper.py，回滚不丢列）
    INSERT INTO area_snapshot
        (restore_point_id, id, name, operator, geom, extras, created_at)
    SELECT (SELECT id FROM rp), id, name, operator, geom, extras, created_at
    FROM area
    RETURNING 1
), s_base AS (
    INSERT INTO baseline_state_snapshot
        (restore_point_id, id, iso_a2, name_zh, coverage_pct, points_used, established_at)
    SELECT (SELECT id FROM rp), id, iso_a2, name_zh, coverage_pct, points_used, established_at
    FROM baseline_state
    RETURNING 1
)
SELECT id AS rp_id FROM rp \gset
UPDATE restore_point SET
    site_count      = (SELECT count(*) FROM site),
    road_count      = (SELECT count(*) FROM road),
    lessor_count    = (SELECT count(*) FROM lessor),
    area_count      = (SELECT count(*) FROM area),
    baseline_iso_a2 = (SELECT iso_a2 FROM baseline_state WHERE id = 1)
WHERE id = :rp_id;
SELECT :rp_id;
SQL
)
    else
    # V5 前环境变体：无 area 段、无 area_count 回填（area_count 列保持 NULL，同 V5 前存量点）。
    rp_id=$(docker exec -i "$DB_CTN" psql -U "$DB_USER" -d "$DB_NAME" \
                --single-transaction -v ON_ERROR_STOP=1 -tAq -f - <<'SQL'
WITH rp AS (
    INSERT INTO restore_point (reason, note)
    VALUES ('pre_migrate', 'auto restore point before schema migration')
    RETURNING id
), s_site AS (
    INSERT INTO site_snapshot
        (restore_point_id, site_id, "option", project, site_status,
         operator, category, type, lati, longi, extras, source_file,
         created_at, updated_at, geom)
    SELECT (SELECT id FROM rp), site_id, "option", project, site_status,
           operator, category, type, lati, longi, extras, source_file,
           created_at, updated_at, geom
    FROM site
    RETURNING 1
), s_road AS (
    INSERT INTO road_snapshot
        (restore_point_id, id, property, extras, source_file, created_at, geom)
    SELECT (SELECT id FROM rp), id, property, extras, source_file, created_at, geom
    FROM road
    RETURNING 1
), s_lessor AS (
    INSERT INTO lessor_snapshot
        (restore_point_id, fid, lessor_name, lessor_category, relationship,
         extras, source_file, created_at, updated_at, geom)
    SELECT (SELECT id FROM rp), fid, lessor_name, lessor_category, relationship,
           extras, source_file, created_at, updated_at, geom
    FROM lessor
    RETURNING 1
), s_base AS (
    INSERT INTO baseline_state_snapshot
        (restore_point_id, id, iso_a2, name_zh, coverage_pct, points_used, established_at)
    SELECT (SELECT id FROM rp), id, iso_a2, name_zh, coverage_pct, points_used, established_at
    FROM baseline_state
    RETURNING 1
)
SELECT id AS rp_id FROM rp \gset
UPDATE restore_point SET
    site_count      = (SELECT count(*) FROM site),
    road_count      = (SELECT count(*) FROM road),
    lessor_count    = (SELECT count(*) FROM lessor),
    baseline_iso_a2 = (SELECT iso_a2 FROM baseline_state WHERE id = 1)
WHERE id = :rp_id;
SELECT :rp_id;
SQL
)
    fi
    # 注：CTE 里 INSERT...SELECT 都在同一语句 → 单事务原子；任一失败 psql 回滚、无 rp_id 输出。
    rp_id="$(printf '%s' "$rp_id" | tr -d '[:space:]')"
    case "$rp_id" in
        ''|*[!0-9]*) die "建恢复点失败（未拿到 rp_id）—— 拒绝在无恢复点状态下迁移。" ;;
    esac
    PRE_MIGRATE_RP_ID="$rp_id"
    if [ "$area_present" = "true" ]; then
        ok "恢复点已建：rp_id=${PRE_MIGRATE_RP_ID}（site/road/lessor/area/baseline_state 已快照）"
    else
        ok "恢复点已建：rp_id=${PRE_MIGRATE_RP_ID}（site/road/lessor/baseline_state 已快照；area 段按 V5 前环境跳过）"
    fi
}

# ---------- 扫描待应用迁移 ----------
# 输出（按版本号升序）到全局数组式临时文件：每行 "version<TAB>filepath"
# 跳过已应用版本；对已应用版本做 checksum 比对，不一致即 die。
# --to <序号|latest> 上限由调用方传入 MIGRATE_TARGET_TO（空=latest）。
_scan_pending() {
    local target_to="${1:-latest}"
    [ -d "$MIGRATIONS_DIR" ] || die "migrations 目录不存在：$MIGRATIONS_DIR"

    # 已应用版本 + checksum（version|checksum 每行）
    local applied
    applied=$(_psql_q "SELECT version || '|' || checksum FROM schema_migrations;")

    PENDING_LIST=""   # "version\tpath\tname" 多行
    local f base ver name csum
    # 用 ls 排序（V0,V1,...,V10 需数值序，下面用 sort -t_ 数值）
    for f in "$MIGRATIONS_DIR"/V*__*.sql; do
        [ -e "$f" ] || continue
        base=$(basename "$f")
        # 解析 V<n>__<name>.sql
        ver=$(printf '%s' "$base" | sed -n 's/^V\([0-9][0-9]*\)__.*\.sql$/\1/p')
        name=$(printf '%s' "$base" | sed -n 's/^V[0-9][0-9]*__\(.*\)\.sql$/\1/p')
        [ -n "$ver" ] || die "迁移文件名不合规（应 V<数字>__<描述>.sql）：$base"

        # --to 上限过滤
        if [ "$target_to" != "latest" ]; then
            if [ "$ver" -gt "$target_to" ]; then continue; fi
        fi

        csum=$(_sha256 "$f")
        # 是否已应用？
        local prev_csum=""
        prev_csum=$(printf '%s\n' "$applied" | sed -n "s/^${ver}|//p")
        if [ -n "$prev_csum" ]; then
            # 已应用 → checksum 必须一致（防篡改）
            if [ "$prev_csum" != "$csum" ]; then
                die "🔴 迁移文件被篡改：V${ver}（${base}）已应用 checksum=${prev_csum}，当前=${csum}。已应用的迁移文件不可改——回退该文件或新建 V<更高序号>。"
            fi
            continue
        fi
        # 待应用
        PENDING_LIST="${PENDING_LIST}${ver}	${f}	${name}
"
    done

    # 按 version 数值升序排序
    if [ -n "$PENDING_LIST" ]; then
        PENDING_LIST=$(printf '%s' "$PENDING_LIST" | sort -t'	' -k1,1n)
    fi
}

# ---------- 当前/目标版本（打印 X→Y 用）----------
_current_version() {
    local v
    v=$(_psql_q "SELECT COALESCE(max(version), -1) FROM schema_migrations;")
    printf '%s' "${v:--1}"
}

# ═════════════════════════════════════════════════════════════════════════════
# run_migrations <target> [<to: 序号|latest>]
#   主入口。被 cmd_migrate / cmd_onprem(--migrate-db) 调用。
#   前置：调用方已 load_target_conf <target>（注入 DB_*/PROD/ALLOW_RESET/TARGET）。
# ═════════════════════════════════════════════════════════════════════════════
run_migrations() {
    local target="$1" to="${2:-latest}"
    PRE_MIGRATE_RP_ID=""

    _migrate_require_dbcfg
    step "迁移目标：target=${target}  db=[${DB_CTN}:${DB_NAME}]  --to=${to}  (PROD=${PROD:-?})"

    _ensure_migrations_table

    local cur; cur=$(_current_version)
    _scan_pending "$to"

    if [ -z "$PENDING_LIST" ]; then
        ok "无待应用迁移（当前版本 V${cur}）。空操作，库未触碰。"
        return 0
    fi

    # 计算目标最高版本
    local last_ver
    last_ver=$(printf '%s\n' "$PENDING_LIST" | tail -1 | cut -f1)

    info "待应用迁移（当前 V${cur} → 目标 V${last_ver}）："
    local _v _p _n
    while IFS='	' read -r _v _p _n; do
        [ -n "$_v" ] || continue
        log "    V${_v}  $(basename "$_p")"
    done <<EOF
$PENDING_LIST
EOF

    # —— 安全：PROD 目标二次确认（打印 X→Y）；非交互默认拒绝 ——
    if [ "${PROD:-false}" = "true" ]; then
        warn "🔴 目标 [${target}] 为生产环境（PROD=true）。即将迁移 V${cur} → V${last_ver}。"
        if ! confirm "确认在生产库 [${DB_CTN}:${DB_NAME}] 上执行以上迁移？"; then
            die "用户未确认（或非交互环境）—— 已中止，库未触碰。"
        fi
    fi

    # —— 🛡 迁移前必建恢复点 ——（建点失败会在内部 die，不会继续）
    # 例外：全新空库（restore_point/主表都还没建）= V0 首次初始化，无数据可备份，跳过建点。
    if _baseline_tables_present; then
        _create_pre_migrate_restore_point
    else
        warn "全新空库（基线表尚未建）—— 这是 V0 首次初始化，无既有数据可备份，跳过建恢复点。"
        PRE_MIGRATE_RP_ID="(无·全新库初始化)"
    fi

    # —— 逐文件单事务执行 + 登记 ——
    # ⚠️ 循环体内 docker exec 会读 stdin → 这里用 FD 3 喂 PENDING_LIST，与子进程 stdin(FD0)
    #    彻底隔离，否则首个 docker exec 会吞掉后续行（实测 V1 被跳过）。
    local applied_count=0
    while IFS='	' read -r _v _p _n <&3; do
        [ -n "$_v" ] || continue
        local base; base=$(basename "$_p")
        local csum; csum=$(_sha256 "$_p")
        step "应用 V${_v} —— ${base}（单事务）"
        if ! _psql_file_tx "$_p"; then
            warn "🔴 V${_v}（${base}）执行失败 → 该文件事务已回滚（未提交，无半迁移）。"
            warn "已成功应用 ${applied_count} 个文件；V${_v} 起未应用。"
            die "中止。回滚指引：用恢复点 rp_id=${PRE_MIGRATE_RP_ID} 覆盖式回滚到迁移前状态（reason='pre_migrate'）。"
        fi
        # 文件事务已 COMMIT；单独登记 schema_migrations（幂等：同 version 冲突则更新 checksum/时间）
        _psql_q "INSERT INTO schema_migrations (version, name, checksum)
                 VALUES (${_v}, '$(printf '%s' "$_n" | sed "s/'/''/g")', '${csum}')
                 ON CONFLICT (version) DO UPDATE
                   SET name='$(printf '%s' "$_n" | sed "s/'/''/g")', checksum='${csum}', applied_at=now();" >/dev/null
        ok "V${_v} 已应用并登记（checksum=${csum:0:12}…）"
        applied_count=$((applied_count + 1))
    done 3<<EOF
$PENDING_LIST
EOF

    ok "迁移完成：V${cur} → V${last_ver}（共应用 ${applied_count} 个文件）。恢复点 rp_id=${PRE_MIGRATE_RP_ID} 备查。"
}
