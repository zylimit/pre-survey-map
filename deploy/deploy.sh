#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
# deploy.sh —— pre-survey-map 统一部署系统 · 唯一入口（DEPLOY-DESIGN §3/§4）
#
# 本批(P1)实现：build / publish / onprem / ship
# 本批 stub：cloud / migrate（打印"后续批次实现"并退出）
# 未实现：migration 机制(P2) / cloud 完整(P4) / 旧脚本清理(P5)
#
# 子命令（DEPLOY-DESIGN §4）：
#   deploy.sh build   --version vX --scope web|full [--arch arm64|amd64]
#   deploy.sh publish --version vX [--scope web|full]
#   deploy.sh onprem  --version vX --scope web|full [--migrate-db] [--reset-db]
#   deploy.sh ship    --target onprem --version vX --scope web
#   deploy.sh cloud   ...   (stub)
#   deploy.sh migrate ...   (stub)
# ═════════════════════════════════════════════════════════════════════════════
set -euo pipefail

# ---------- 路径锚点 ----------
DEPLOY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJ_ROOT="$(cd "$DEPLOY_ROOT/.." && pwd)"
export DEPLOY_ROOT PROJ_ROOT

# ---------- 载入库 ----------
# shellcheck disable=SC1091
. "$DEPLOY_ROOT/lib/common.sh"
# shellcheck disable=SC1091
. "$DEPLOY_ROOT/lib/docker.sh"
# shellcheck disable=SC1091
. "$DEPLOY_ROOT/lib/cf.sh"

usage() {
    cat <<'EOF'
pre-survey-map 统一部署系统 deploy.sh

用法：
  deploy.sh build   --version vX --scope web|full [--arch arm64|amd64]
  deploy.sh publish --version vX [--scope web|full]
  deploy.sh onprem  --version vX --scope web|full [--migrate-db] [--reset-db]
  deploy.sh ship    --target onprem --version vX --scope web
  deploy.sh cloud   ...    (本批 stub)
  deploy.sh migrate ...    (本批 stub)

通用参数：
  --version vX        版本号（带不带 v 前缀都行；不传则用 release.conf 的 VERSION）
  --scope web|full    web=只换前端镜像；full=web+api（不传用 release.conf DEFAULT_SCOPE）
  --arch arm64|amd64  目标架构（build 用；不传由 target/scope 推断）
  --target onprem     目标环境（读 config/targets/<target>.conf）
  --migrate-db        触发 db 迁移（本批仅打印"P2 待实现"，不执行）
  --reset-db          清库（对 PROD 目标直接拒绝退出）
  -h | --help         本帮助
EOF
}

# ---------- 参数解析（通用，给各子命令复用）----------
ARG_VERSION=""; ARG_SCOPE=""; ARG_ARCH=""; ARG_TARGET=""
ARG_MIGRATE_DB=false; ARG_RESET_DB=false; ARG_TAR=""

parse_args() {
    while [ $# -gt 0 ]; do
        case "$1" in
            --version) ARG_VERSION="${2:-}"; shift 2 ;;
            --scope)   ARG_SCOPE="${2:-}";   shift 2 ;;
            --arch)    ARG_ARCH="${2:-}";    shift 2 ;;
            --target)  ARG_TARGET="${2:-}";  shift 2 ;;
            --tar)     ARG_TAR="${2:-}";     shift 2 ;;
            --migrate-db) ARG_MIGRATE_DB=true; shift ;;
            --reset-db)   ARG_RESET_DB=true;   shift ;;
            -h|--help) usage; exit 0 ;;
            *) die "未知参数：$1（看 deploy.sh --help）" ;;
        esac
    done
}

# 解析最终 version/scope（优先命令行，其次 release.conf）
resolve_version_scope() {
    load_release_conf
    if [ -n "$ARG_VERSION" ]; then
        VER=$(normalize_version "$ARG_VERSION")
    else
        VER=$(normalize_version "$VERSION")
    fi
    SCOPE="${ARG_SCOPE:-$DEFAULT_SCOPE}"
    validate_scope "$SCOPE"
}

# ═════════════════════════════════════════════════════════════════════════════
# 子命令：build —— buildx 跨架构打镜像 + 架构断言（收编 update-deploy.sh）
# ═════════════════════════════════════════════════════════════════════════════
cmd_build() {
    resolve_version_scope
    local arch="${ARG_ARCH:-arm64}"      # 内网默认 arm64
    local platform="linux/$arch"
    info "build：version=$VER  scope=$SCOPE  arch=$arch"

    buildx_bootstrap

    local web_tag="$WEB_IMAGE:$VER" api_tag="$API_IMAGE:$VER"

    step "构建 web（scope=$SCOPE 必含 web）"
    buildx_image "$platform" "$web_tag" "$PROJ_ROOT/web"
    assert_arch "$web_tag" "$arch"

    if [ "$SCOPE" = "full" ]; then
        step "构建 api（scope=full）"
        buildx_image "$platform" "$api_tag" "$PROJ_ROOT/api"
        assert_arch "$api_tag" "$arch"
    else
        info "scope=web：跳过 api 构建（不碰 api/db）。"
    fi

    ok "build 完成：$web_tag$( [ "$SCOPE" = "full" ] && echo "  $api_tag" )"
}

# ═════════════════════════════════════════════════════════════════════════════
# 子命令：publish —— 上架 CF + 产出自包含内网包（tar 含镜像 + 内嵌脚本 + onprem.conf）
# ═════════════════════════════════════════════════════════════════════════════
cmd_publish() {
    resolve_version_scope
    require_cmd docker
    local ts; ts=$(date +%Y%m%d-%H%M%S)
    local arch=arm64                      # 内网包恒为 arm64
    local web_tag="$WEB_IMAGE:$VER" api_tag="$API_IMAGE:$VER"

    info "publish：version=$VER  scope=$SCOPE"

    # 1) 待打包镜像（按 scope）
    local imgs="$web_tag"
    [ "$SCOPE" = "full" ] && imgs="$web_tag $api_tag"
    local i
    for i in $imgs; do
        docker image inspect "$i" >/dev/null 2>&1 || die "镜像不存在：${i}（先跑 deploy.sh build --version ${VER} --scope ${SCOPE}）"
    done

    # 2) 组装自包含内网包内容到临时目录
    local work; work="$(mktemp -d)"
    trap 'rm -rf "$work"' EXIT
    local img_tar="$work/images.tar"
    step "save 镜像到自包含包内：$imgs"
    docker_save "$img_tar" $imgs

    # 内嵌 onprem.conf（单一真源拷贝）
    cp "$TARGETS_DIR/onprem.conf" "$work/onprem.conf"
    # 内嵌部署脚本（内网一行命令跑；自带探测，离线）
    _emit_embedded_onprem_script "$work/deploy-onprem.sh" "$VER" "$SCOPE"
    chmod +x "$work/deploy-onprem.sh"

    # 3) 打成单个自包含 tar（文件名带时间戳，绕开 CF 旧缓存）
    local pkg="presurvey-onprem-${VER}-${SCOPE}-${ts}-${arch}.tar"
    local pkg_path="$PROJ_ROOT/$pkg"
    step "打自包含内网包：$pkg"
    tar -C "$work" -cf "$pkg_path" images.tar onprem.conf deploy-onprem.sh \
        || die "打包失败"
    local sz; sz=$(du -h "$pkg_path" | cut -f1)
    ok "自包含内网包：${pkg}（${sz}）含 images.tar + onprem.conf + deploy-onprem.sh"

    # 4) 上架 CF（源站机才真上架，否则提示跳过）+ 打印 URL
    cf_publish "$pkg_path"
    cf_print_urls "$pkg_path"

    log ""
    log "内网一行命令（拉取后 root 跑，脚本自动探测现网 network/端口）："
    log "  curl -L -O https://${CF_DOMAIN}/${pkg}"
    log "  tar -xf ${pkg} && su -c 'bash deploy-onprem.sh'"
}

# 生成内嵌到内网包里的离线部署脚本（自带探测，复刻 server-deploy-web 行为，泛化 scope）
_emit_embedded_onprem_script() {
    local out="$1" ver="$2" scope="$3"
    cat > "$out" <<EOF
#!/usr/bin/env bash
# 自包含内网部署脚本（由 deploy.sh publish 内嵌生成，version=${ver} scope=${scope}）
# 🔴 内网生产：默认不碰 db；只 load + 探测 + 停老起新。Docker 18.09 兼容（无 compose/--platform）。
# 用法（解包目录内、root 跑）：su -c 'bash deploy-onprem.sh'
set -euo pipefail
VER="$ver"
SCOPE="$scope"
EOF
    # 追加（用未展开 heredoc，保留运行期变量）
    cat >> "$out" <<'EOF'
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# 读内嵌 onprem.conf 拿回落默认 + 安全标志
. "$HERE/onprem.conf"
IMG_TAR="$HERE/images.tar"
[ -f "$IMG_TAR" ] || { echo "!! 缺 images.tar"; exit 1; }

echo "== 0. 安全自检 =="
echo "   PROD=$PROD  ALLOW_RESET=$ALLOW_RESET  scope=$SCOPE"
# 本脚本不含任何 db/reset 逻辑——默认不碰 db（C5）。

echo "== 1. docker load 镜像 =="
docker load -i "$IMG_TAR"

deploy_one() {
    # $1=容器名 $2=镜像 $3=容器内端口 $4=回落network $5=回落hostport
    local CTN="$1" IMAGE="$2" CPORT="$3" FBNET="$4" FBPORT="$5"
    echo "== 探测现网 [$CTN] network/端口（停删前）=="
    local NET="" PORT=""
    if docker inspect "$CTN" >/dev/null 2>&1; then
        NET=$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$CTN" 2>/dev/null || true)
        if [ -z "$NET" ] || [ "$NET" = "default" ] || [ "$NET" = "null" ]; then
            NET=$(docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{"\n"}}{{end}}' "$CTN" 2>/dev/null | head -1)
        fi
        PORT=$(docker inspect -f "{{(index (index .NetworkSettings.Ports \"${CPORT}/tcp\") 0).HostPort}}" "$CTN" 2>/dev/null || true)
        echo "   探测到 network=[$NET] hostport=[$PORT]"
    else
        echo "   老容器 [$CTN] 不存在，用回落默认。"
    fi
    if [ -z "$NET" ] || [ "$NET" = "default" ] || [ "$NET" = "null" ]; then NET="$FBNET"; fi
    if [ -z "$PORT" ] || [ "$PORT" = "null" ]; then PORT="$FBPORT"; fi
    echo "   ▶ 采用 network=$NET 端口=${PORT}:${CPORT}"
    docker image inspect "$IMAGE" >/dev/null 2>&1 || { echo "!! 缺镜像 $IMAGE"; exit 1; }
    echo "== 停删老 ${CTN}（幂等，只动本容器）=="
    docker stop "$CTN" 2>/dev/null || true
    docker rm   "$CTN" 2>/dev/null || true
    echo "== 起新 $CTN =="
    docker run -d --name "$CTN" --network "$NET" -p "${PORT}:${CPORT}" "$IMAGE" || { echo "!! run 失败 net=$NET port=${PORT}:${CPORT} img=$IMAGE"; exit 1; }
    sleep 2
    docker ps | grep -q "$CTN" || { echo "!! $CTN 未运行，docker logs $CTN"; exit 1; }
    if [ "$CPORT" = "80" ]; then
        CODE=$(curl -s -o /dev/null -w '%{http_code}' -I "http://localhost:${PORT}" 2>/dev/null || echo 000)
        echo "   HTTP $CODE"
        case "$CODE" in 200|301|302) echo "   ✓ $CTN 就绪";; 403) echo "!! 403 权限：docker exec $CTN chmod -R 755 /usr/share/nginx/html"; exit 1;; *) echo "!! HTTP $CODE 非预期，docker logs $CTN"; exit 1;; esac
    else
        echo "   ✓ $CTN 运行中（非 http 端口，跳过 curl 校验）"
    fi
}

deploy_one "$WEB_CTN" "presurvey-web:$VER" 80 "$NETWORK" "$WEB_PORT"
if [ "$SCOPE" = "full" ]; then
    deploy_one "$API_CTN" "presurvey-api:$VER" 8000 "$NETWORK" "$API_PORT"
fi
echo ""
echo "✅ onprem 部署完成（scope=${SCOPE}，version=${VER}）。db 未触碰。"
EOF
}

# ═════════════════════════════════════════════════════════════════════════════
# 子命令：onprem —— 在内网机本地跑：load + 探测现网 + 停老起新（收编 server-deploy-web）
# 默认不碰 db；--migrate-db 本批仅打印 P2 待实现；--reset-db 对 PROD 直接拒绝。
# ═════════════════════════════════════════════════════════════════════════════
cmd_onprem() {
    resolve_version_scope
    load_target_conf onprem
    require_cmd docker
    info "onprem：version=$VER  scope=$SCOPE  target=${TARGET}（PROD=${PROD} ALLOW_RESET=${ALLOW_RESET}）"

    # —— 安全护栏：reset 对 PROD 直接拒绝（先于任何操作）——
    if [ "$ARG_RESET_DB" = "true" ]; then
        guard_prod_no_reset   # PROD=true 会在此 die
        warn "（理论分支：非 PROD 才会到此，本批 onprem 仍不实现 reset 执行。）"
    fi
    # —— migrate-db 本批 stub ——
    if [ "$ARG_MIGRATE_DB" = "true" ]; then
        warn "--migrate-db：DB 迁移机制为 P2 待实现，本批不执行任何迁移。已忽略该标志。"
    fi
    info "默认不碰 db —— 本子命令只换镜像（C5）。"

    # —— tar 来源 ——
    local tar="$ARG_TAR"
    if [ -z "$tar" ]; then
        # 约定：内网包解出的 images.tar 在当前目录
        tar="./images.tar"
    fi
    docker_load_tar "$tar"

    # —— web（scope 必含）——
    assert_image_loaded "$WEB_IMAGE:$VER"
    resolve_net_port "$WEB_CTN" 80 "$NETWORK" "$WEB_PORT"
    stop_rm_container "$WEB_CTN"
    run_container "$WEB_CTN" "$RESOLVED_NET" "$RESOLVED_PORT" 80 "$WEB_IMAGE:$VER"
    verify_http "$WEB_CTN" "$RESOLVED_PORT"

    # —— api（scope=full）——
    if [ "$SCOPE" = "full" ]; then
        assert_image_loaded "$API_IMAGE:$VER"
        resolve_net_port "$API_CTN" 8000 "$NETWORK" "$API_PORT"
        stop_rm_container "$API_CTN"
        run_container "$API_CTN" "$RESOLVED_NET" "$RESOLVED_PORT" 8000 "$API_IMAGE:$VER"
        ok "api 已起（network=$RESOLVED_NET 端口=${RESOLVED_PORT}:8000）。"
    else
        info "scope=web：未触碰 api/db。"
    fi

    ok "onprem 部署完成（scope=${SCOPE} version=${VER}）。db 未触碰。"
}

# ═════════════════════════════════════════════════════════════════════════════
# 子命令：ship —— 一键 build→publish 出包 + URL（C1 高频刚需）
# ═════════════════════════════════════════════════════════════════════════════
cmd_ship() {
    local target="${ARG_TARGET:-onprem}"
    [ "$target" = "onprem" ] || die "ship 本批仅支持 --target onprem（cloud 后续批次）"
    resolve_version_scope
    info "ship：target=$target  version=$VER  scope=$SCOPE  →  build → publish"
    step "ship 步骤 1/2：build"
    cmd_build
    step "ship 步骤 2/2：publish"
    cmd_publish
    ok "ship 完成：内网包已产出并（在源站机上）上架 CF。见上方下载 URL + 内网一行命令。"
}

# ═════════════════════════════════════════════════════════════════════════════
# 子命令：cloud / migrate —— 本批 stub
# ═════════════════════════════════════════════════════════════════════════════
cmd_cloud() {
    warn "cloud 子命令：后续批次实现（DEPLOY-DESIGN §8 P4）。本批未实现，退出。"
    exit 0
}
cmd_migrate() {
    warn "migrate 子命令：DB 迁移机制为后续批次实现（DEPLOY-DESIGN §8 P2）。本批未实现，退出。"
    exit 0
}

# ═════════════════════════════════════════════════════════════════════════════
# 调度
# ═════════════════════════════════════════════════════════════════════════════
main() {
    [ $# -ge 1 ] || { usage; exit 1; }
    local sub="$1"; shift
    case "$sub" in
        -h|--help|help) usage; exit 0 ;;
    esac
    parse_args "$@"
    case "$sub" in
        build)   cmd_build ;;
        publish) cmd_publish ;;
        onprem)  cmd_onprem ;;
        ship)    cmd_ship ;;
        cloud)   cmd_cloud ;;
        migrate) cmd_migrate ;;
        *) die "未知子命令：${sub}（看 deploy.sh --help）" ;;
    esac
}
main "$@"
