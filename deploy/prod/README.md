# 内网 ARM64 离线部署手册（runbook）

> 把 pre-survey-map 部署到**内网 ARM64 服务器**。服务器无外网、跳板机不让装 Docker → 用「第三台联网机(腾讯云 x86)跨架构构建 → 跳板机搬运 → 服务器 load」的离线链路。
> 跳板机/服务器上 git pull 本仓库后，可让 **Claude Code** 照本手册逐步执行。

## 拓扑（四角色）

```
①腾讯云 x86（联网+Docker）         ②跳板机 Win（VPN+代理+ClaudeCode，无Docker）
  bash pack-arm64.sh                   curl 下载部署包（从①）
  → presurvey-deploy-arm64.tar.gz      scp 上传到服务器（到③）
  python3 -m http.server 8088  ──HTTP──→     │ 纯搬运，不碰 Docker
         │                                    ↓
         └───────────────────────→     ③内网ARM服务器（Docker，无外网）
                                          bash server-probe.sh（先探）
                                          bash load-and-up.sh（load+up）
```

## 文件清单（本目录 deploy/prod/）

| 文件 | 在哪跑 | 作用 |
|---|---|---|
| `pack-arm64.sh` | ①腾讯云 | buildx 跨架构构建 arm64 镜像 + 打离线部署包 |
| `server-probe.sh` | ③服务器 | 探测架构/Docker/端口/资源，贴回校准 |
| `docker-compose.prod.yml` | ③服务器 | 生产 compose（用 image，不 build） |
| `.env.prod.example` | ③服务器 | 环境变量模板（复制成 `.env.prod` 改密码） |
| `load-and-up.sh` | ③服务器 | `docker load` 镜像 + `compose up` |

---

## 部署流程

### Step 0（③服务器，可选先做）探测环境
```bash
bash deploy/prod/server-probe.sh
```
确认 `uname -m = aarch64`、Docker 可用、80/8000/5433 端口空闲、磁盘 ≥5G。端口被占就记下，Step 3 改 `.env.prod`。

### Step 1（①腾讯云）跨架构打包
```bash
cd <腾讯云项目目录>
git pull origin main          # 拿最新代码 + 本脚本（非 git 仓库则 rsync 同步）
bash deploy/prod/pack-arm64.sh
```
产出 `presurvey-deploy-arm64.tar.gz`（含 arm64 镜像 tar + compose.prod + init.sql + geo_data + 部署脚本）。
> QEMU 模拟构建较慢（几~十几分钟）。若停在「postgis 无 arm64」，改用社区 `imresamu/postgis` arm64 tag（见末尾「排错」）。

### Step 2（①腾讯云）起临时下载服务
```bash
cd <tar.gz 所在目录>
python3 -m http.server 8088   # 腾讯云安全组需放行 8088；下完 Ctrl+C 关掉
```

### Step 3（②跳板机）下载 + 上传服务器
跳板机 Windows（有 curl/scp）；可让 Claude Code 执行：
```bash
# 下载（VPN+代理下访问腾讯云公网）
curl -O http://<腾讯云公网IP>:8088/presurvey-deploy-arm64.tar.gz
# 上传到内网服务器
scp presurvey-deploy-arm64.tar.gz <用户>@<服务器内网IP>:~/
```

### Step 4（③服务器）部署
```bash
ssh <用户>@<服务器内网IP>
tar xzf ~/presurvey-deploy-arm64.tar.gz && cd presurvey-deploy-arm64
cp .env.prod.example .env.prod
#  ↑ 编辑 .env.prod：改 DB_PASSWORD 强密码；端口被占改 WEB_PORT/API_PORT/DB_PORT
bash load-and-up.sh
```
脚本会 `docker load` 三镜像 → `compose up -d` → 探 health。

---

## 验证
- `docker compose -f docker-compose.prod.yml ps`：db(healthy) / api / web 都 Up
- `curl localhost:8000/health` → `{"status":"ok","db":true}`
- 浏览器 `http://<服务器内网IP>:<WEB_PORT>/` 打开平台
- 数据是空的（清库重来）→ 工程师用图层 **[导入图层]** 导真实数据

## 日常更新（以后改了代码再部署）
代码改动 → push GitHub → **重跑 Step 1~4**（腾讯云重新 pack → 搬运 → 服务器 `bash load-and-up.sh`）。
`load-and-up.sh` 的 `compose up -d` 会用新镜像滚动重建容器，**pgdata 卷保留**（数据不丢）。

## 排错
- **postgis 无 arm64**：`pack-arm64.sh` 会自检并停。改用 `imresamu/postgis`（multi-arch 含 arm64）——把 compose.prod.yml 和 pack 脚本里的 `postgis/postgis:16-3.4` 换成 `imresamu/postgis:16-3.4`（tag 以其 Docker Hub 为准），重跑 Step 1。
- **buildx 构建慢/卡**：QEMU 模拟 arm64 本就慢；前端 npm build / 后端 pip 装 native 包最耗时，耐心等，别中断。
- **服务器端口被占**：改 `.env.prod` 的 `WEB_PORT/API_PORT/DB_PORT`，重跑 `load-and-up.sh`。
- **load 报架构不符**：说明 tar 里是 x86 镜像 → pack 时 `--platform linux/arm64` 没生效，回腾讯云确认 QEMU binfmt 已装、buildx 用了 arm64 平台。
- **db 起不来**：看 `docker logs presurvey-db`；常见是 pgdata 卷有旧数据与 init.sql 冲突 → 全新部署可 `docker compose -f docker-compose.prod.yml down -v` 清卷重来（⚠️ 删数据）。
