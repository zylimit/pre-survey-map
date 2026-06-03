#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# docker.sh —— docker 封装：跨架构 build / 架构断言 / 探测现网 / load / 停老起新
# 被 deploy.sh source。依赖 common.sh 的日志函数。（DEPLOY-DESIGN §3 / §4）
# 🔴 onprem 路径只用 docker load/inspect/run/ps —— 不用 compose、不用 --platform（18.09 兼容）
# ─────────────────────────────────────────────────────────────────────────────

# ---------- buildx 跨架构构建（收编自 update-deploy.sh）----------
# 仅 build 子命令在【联网打包机】用；onprem 路径绝不调用。
buildx_bootstrap() {
    require_cmd docker
    step "QEMU + buildx 引导"
    docker run --privileged --rm tonistiigi/binfmt --install arm64 >/dev/null 2>&1 || true
    docker buildx use pmb 2>/dev/null || docker buildx create --use --name pmb
    docker buildx inspect --bootstrap >/dev/null
}

# buildx_image <platform> <tag> <context_dir>
buildx_image() {
    local platform="$1" tag="$2" ctx="$3"
    info "构建 ${tag} （platform=${platform}，ctx=${ctx}）"
    docker buildx build --platform "$platform" -t "$tag" --load "$ctx" \
        || die "构建失败：$tag"
}

# assert_arch <tag> <expect_arch>  —— 断言镜像架构（QEMU 没生效会被拦下）
assert_arch() {
    local tag="$1" expect="$2" actual
    actual=$(docker image inspect "$tag" --format '{{.Architecture}}' 2>/dev/null) \
        || die "镜像不存在，无法校验架构：$tag"
    info "$tag 架构 = ${actual}（期望 ${expect}）"
    [ "$actual" = "$expect" ] || die "架构不符：$tag 是 ${actual}，期望 ${expect}（QEMU/buildx 没生效？）"
}

# docker_save <out_tar> <tag...> —— 打包镜像为 tar
docker_save() {
    local out="$1"; shift
    info "docker save -> $out （$*）"
    docker save "$@" -o "$out" || die "docker save 失败"
}

# ---------- 探测现网容器参数（收编+泛化自 server-deploy-web-v1.0.2.sh）----------
# probe_container_net <ctn>  —— 回显探测到的 network 名（探测不到回显空）
# 优先 .HostConfig.NetworkMode；为空/default(compose 容器)时回落 .NetworkSettings.Networks 首个 key
probe_container_net() {
    local ctn="$1" net=""
    docker inspect "$ctn" >/dev/null 2>&1 || { printf ''; return; }
    net=$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$ctn" 2>/dev/null || true)
    if [ -z "$net" ] || [ "$net" = "default" ] || [ "$net" = "null" ]; then
        net=$(docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{"\n"}}{{end}}' "$ctn" 2>/dev/null | head -1)
    fi
    printf '%s' "$net"
}

# probe_container_hostport <ctn> <container_port>  —— 回显宿主端口（探测不到回显空）
probe_container_hostport() {
    local ctn="$1" cport="${2:-80}" port=""
    docker inspect "$ctn" >/dev/null 2>&1 || { printf ''; return; }
    port=$(docker inspect -f "{{(index (index .NetworkSettings.Ports \"${cport}/tcp\") 0).HostPort}}" "$ctn" 2>/dev/null || true)
    printf '%s' "$port"
}

# resolve_net_port <ctn> <container_port> <fallback_net> <fallback_port>
# 探测现网 → 校验 → 无效则回落默认。结果写入全局 RESOLVED_NET / RESOLVED_PORT。
resolve_net_port() {
    local ctn="$1" cport="$2" fbnet="$3" fbport="$4"
    local net port
    step "探测现网容器 [$ctn] 的 network / 端口（停删前探测，删了就探不到）"
    if docker inspect "$ctn" >/dev/null 2>&1; then
        net=$(probe_container_net "$ctn" )
        port=$(probe_container_hostport "$ctn" "$cport")
        info "探测到：network=[$net]  hostport=[$port]"
    else
        warn "老容器 [$ctn] 不存在，无法探测，将用回落默认。"
        net=""; port=""
    fi
    if [ -z "$net" ] || [ "$net" = "default" ] || [ "$net" = "null" ]; then
        warn "network 探测无效（值=[$net]），回落默认：$fbnet"
        net="$fbnet"
    fi
    if [ -z "$port" ] || [ "$port" = "null" ]; then
        warn "端口探测无效（值=[$port]），回落默认：$fbport"
        port="$fbport"
    fi
    RESOLVED_NET="$net"
    RESOLVED_PORT="$port"
    info "▶ 最终采用：network=$RESOLVED_NET  端口映射=${RESOLVED_PORT}:${cport}"
}

# ---------- load / 停老起新 ----------
# docker_load_tar <tar>
docker_load_tar() {
    local tar="$1"
    [ -f "$tar" ] || die "tar 不存在：$tar"
    step "docker load 新镜像：$tar"
    docker load -i "$tar" || die "docker load 失败"
}

# assert_image_loaded <image:tag>
assert_image_loaded() {
    local image="$1"
    docker image inspect "$image" >/dev/null 2>&1 \
        || { docker images || true; die "未找到镜像 ${image}，load 失败。"; }
    ok "镜像就绪：$image"
}

# stop_rm_container <ctn>  —— 幂等停删（只动指定容器）
stop_rm_container() {
    local ctn="$1"
    info "停删老容器（幂等）：$ctn"
    docker stop "$ctn" 2>/dev/null || true
    docker rm   "$ctn" 2>/dev/null || true
}

# run_container <ctn> <network> <hostport> <container_port> <image>
# Docker 18.09 兼容 docker run —— 不用 compose、不用 --platform
run_container() {
    local ctn="$1" net="$2" hostport="$3" cport="$4" image="$5"
    step "起新容器：${ctn} （network=${net}  端口=${hostport}:${cport}  镜像=${image}）"
    if ! docker run -d --name "$ctn" --network "$net" -p "${hostport}:${cport}" "$image"; then
        warn "docker run 失败。供人工核对："
        warn "  network = $net"
        warn "  端口    = ${hostport}:${cport}"
        warn "  镜像    = $image"
        die "排查：端口被占用？network 不存在？docker network ls / docker ps -a 看一下。"
    fi
}

# verify_http <ctn> <hostport>  —— 容器在跑 + curl 状态码
verify_http() {
    local ctn="$1" hostport="$2" code
    step "验证：$ctn 运行状态 + HTTP"
    if docker ps | grep -q "$ctn"; then
        ok "容器运行中：$(docker ps --filter name="$ctn" --format '{{.Names}}  {{.Status}}  {{.Ports}}')"
    else
        docker ps -a | grep "$ctn" || true
        die "容器未在运行，看日志：docker logs $ctn"
    fi
    code=$(curl -s -o /dev/null -w '%{http_code}' -I "http://localhost:${hostport}" 2>/dev/null || echo "000")
    info "curl -I http://localhost:${hostport}  ->  HTTP $code"
    case "$code" in
        200|301|302) ok "HTTP $code 就绪。" ;;
        403) die "返回 403（nginx 静态文件权限）。修复：docker exec $ctn chmod -R 755 /usr/share/nginx/html 后重试。" ;;
        *)   die "HTTP $code 非预期。看日志：docker logs $ctn" ;;
    esac
}
