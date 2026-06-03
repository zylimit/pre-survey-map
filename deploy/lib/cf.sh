#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# cf.sh —— Cloudflare 下载站上架（收编自 update-deploy.sh / tencent-dl-nginx.sh）
# 被 deploy.sh source。依赖 common.sh 日志函数 + release.conf 的 CF_DOMAIN/CF_DLDIR。
# 🔴 必须 chmod 644：sudo cp 落地 0600(root)，nginx www-data 读不了会 403（实测踩过）。
# ─────────────────────────────────────────────────────────────────────────────

# cf_publish <file...>  —— 把文件上架到本机 CF 源站下载目录 + 修权限
# 仅在【腾讯云源站机】上执行有意义（本地 Mac 无 /var/www/dl，会提示并跳过）。
cf_publish() {
    : "${CF_DLDIR:?release.conf 缺 CF_DLDIR}"
    step "上架 CF 下载站：$CF_DLDIR"
    if ! command -v sudo >/dev/null 2>&1; then
        warn "无 sudo，跳过上架（非源站机环境）。文件已在本地：$*"
        return 0
    fi
    sudo mkdir -p "$CF_DLDIR" || die "无法创建 ${CF_DLDIR}（是否在源站机上跑？）"
    local f
    for f in "$@"; do
        [ -f "$f" ] || { warn "跳过不存在的文件：$f"; continue; }
        sudo cp "$f" "$CF_DLDIR/" || die "cp 失败：$f"
        info "已上架：$(basename "$f")"
    done
    # 🔴 防 403：目录 755 + 文件 644
    sudo chmod 755 /var/www "$CF_DLDIR" 2>/dev/null || true
    sudo chmod 644 "$CF_DLDIR"/* 2>/dev/null || true
    ok "上架完成，已修权限（目录755 文件644，防 nginx 403）。"
}

# cf_print_urls <file...>  —— 打印 CF 下载 URL
cf_print_urls() {
    : "${CF_DOMAIN:?release.conf 缺 CF_DOMAIN}"
    log "────────────────────────────────────────────────────────────"
    log "CF 下载 URL（内网/跳板机拉取；文件名带时间戳，绕开边缘旧缓存）："
    local f
    for f in "$@"; do
        log "  curl -L -O https://${CF_DOMAIN}/$(basename "$f")"
    done
    log "可浏览所有历史包：https://${CF_DOMAIN}/   （nginx autoindex）"
    log "────────────────────────────────────────────────────────────"
}
