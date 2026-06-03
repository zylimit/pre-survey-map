#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# common.sh —— 公共库：日志 / 交互二次确认 / 版本解析 / 参数校验 / 读 config
# 被 deploy.sh source。不单独执行。（DEPLOY-DESIGN §3）
# 兼容 bash 3.2(macOS) 与 bash 4+(Linux)；不依赖 timeout/关联数组。
# ─────────────────────────────────────────────────────────────────────────────

# ---------- 路径锚点（由 deploy.sh 设置 DEPLOY_ROOT；这里兜底）----------
: "${DEPLOY_ROOT:?DEPLOY_ROOT 未设置（应由 deploy.sh export）}"
CONFIG_DIR="$DEPLOY_ROOT/config"
TARGETS_DIR="$CONFIG_DIR/targets"

# ---------- 日志 ----------
_c_red=$'\033[31m'; _c_grn=$'\033[32m'; _c_ylw=$'\033[33m'; _c_blu=$'\033[34m'; _c_rst=$'\033[0m'
log()  { printf '%s\n' "$*"; }
info() { printf '%s[i]%s %s\n' "$_c_blu" "$_c_rst" "$*"; }
ok()   { printf '%s[✓]%s %s\n' "$_c_grn" "$_c_rst" "$*"; }
warn() { printf '%s[!]%s %s\n' "$_c_ylw" "$_c_rst" "$*" >&2; }
die()  { printf '%s[✗]%s %s\n' "$_c_red" "$_c_rst" "$*" >&2; exit 1; }
step() { printf '\n%s== %s ==%s\n' "$_c_blu" "$*" "$_c_rst"; }

# ---------- 读 config ----------
# load_release_conf —— 把 release.conf 的 KEY=VALUE 读入当前 shell
load_release_conf() {
    local f="$CONFIG_DIR/release.conf"
    [ -f "$f" ] || die "缺少 release.conf：$f"
    # shellcheck disable=SC1090
    . "$f"
    : "${VERSION:?release.conf 缺 VERSION}"
    : "${WEB_IMAGE:?release.conf 缺 WEB_IMAGE}"
    : "${API_IMAGE:?release.conf 缺 API_IMAGE}"
    : "${DEFAULT_SCOPE:=web}"
}

# load_target_conf <target> —— 读 config/targets/<target>.conf
load_target_conf() {
    local target="$1"
    [ -n "$target" ] || die "load_target_conf：缺 target 名"
    local f="$TARGETS_DIR/${target}.conf"
    [ -f "$f" ] || die "未知 target：${target}（缺 ${f}）"
    # shellcheck disable=SC1090
    . "$f"
    TARGET="$target"
}

# ---------- 版本解析 / 校验 ----------
# normalize_version vX|X -> vX  （统一带 v 前缀）
normalize_version() {
    local v="$1"
    [ -n "$v" ] || die "版本号为空"
    case "$v" in
        v*) printf '%s' "$v" ;;
        *)  printf 'v%s' "$v" ;;
    esac
}

# version_strip_v vX -> X （镜像/界面去前缀用）
version_strip_v() { printf '%s' "${1#v}"; }

# validate_scope web|full
validate_scope() {
    case "$1" in
        web|full) : ;;
        *) die "非法 --scope：'$1'（只接受 web | full）" ;;
    esac
}

# ---------- 交互二次确认 ----------
# confirm "提示语"  —— 用户须输入 y/yes 才继续；非交互(无 tty)直接拒绝
confirm() {
    local prompt="${1:-确认继续?}" ans
    if [ ! -t 0 ]; then
        warn "非交互环境，危险操作默认拒绝：$prompt"
        return 1
    fi
    printf '%s [y/N] ' "$prompt"
    read -r ans
    case "$ans" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

# confirm_typed "<期望文本>" "提示语" —— 须原样输入期望文本（如目标库名）才通过
confirm_typed() {
    local expect="$1" prompt="${2:-请输入以确认}" ans
    if [ ! -t 0 ]; then
        warn "非交互环境，拒绝：$prompt"
        return 1
    fi
    printf '%s（输入「%s」确认）： ' "$prompt" "$expect"
    read -r ans
    [ "$ans" = "$expect" ]
}

# ---------- 安全护栏 ----------
# guard_prod_no_reset —— 对 PROD=true 的目标，拒绝任何 reset/清库操作
# 用法：在 onprem/cloud reset 路径开头调用
guard_prod_no_reset() {
    if [ "${PROD:-false}" = "true" ] || [ "${ALLOW_RESET:-true}" = "false" ]; then
        die "🔴 目标 [${TARGET:-?}] 为生产环境（PROD=${PROD:-?} / ALLOW_RESET=${ALLOW_RESET:-?}）—— 拒绝任何 reset/truncate/drop 操作。"
    fi
}

# ---------- 依赖检查 ----------
require_cmd() { command -v "$1" >/dev/null 2>&1 || die "缺少命令：$1"; }
