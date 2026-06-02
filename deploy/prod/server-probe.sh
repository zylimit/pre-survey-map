#!/usr/bin/env bash
# 内网 ARM 服务器环境探测 —— 在【内网服务器】上跑：bash server-probe.sh
# 把全部输出整段贴回给规划侧（或交给 Claude Code 分析），用于校准 compose 端口/资源。
set +e
echo "===== 架构（关键，应为 aarch64 = ARM64）====="; uname -m
echo "===== OS / 内核 ====="; (cat /etc/os-release 2>/dev/null | grep -E '^(NAME|VERSION)='); uname -r
echo "===== Docker ====="; docker --version 2>&1; (docker compose version 2>&1 || docker-compose --version 2>&1)
echo "===== Docker 引擎 ====="; docker info 2>/dev/null | grep -E 'Server Version|Architecture|Operating System|Total Memory|Cgroup'
echo "===== 免 sudo? ====="; docker ps >/dev/null 2>&1 && echo "OK 免sudo" || echo "需 sudo / 加 docker 组"
echo "===== CPU / 内存 ====="; nproc; free -h 2>/dev/null | head -2
echo "===== 磁盘（/ 与 docker 数据目录，需 ~5G+）====="; df -h / /var/lib/docker 2>/dev/null
echo "===== 端口占用（80 / 8000 / 5433）====="; ( (ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null) | grep -E ':80 |:8000|:5433' ) || echo "都空闲"
echo "===== 内网 IP（前端访问用）====="; (hostname -I 2>/dev/null || ip a 2>/dev/null | grep 'inet ')
