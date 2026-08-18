# pre-survey-map 统一部署系统（实战手册）

> 一套脚本 + 配置驱动，同时支撑**公有云（腾讯云 x86 / docker compose）**与**内网生产（ARM64 / Docker 18.09 / 离线 / docker run）**。
> 唯一入口：`deploy/deploy.sh`。环境差异全部抽进 `config/targets/*.conf`，主逻辑不分叉。
> 设计依据见 `DEPLOY-DESIGN.md`。

---

## 目录结构

```
deploy/
  deploy.sh                # 唯一入口（子命令调度）
  lib/
    common.sh              # 日志 / 确认 / 校验 / 版本解析
    docker.sh              # docker 封装（探测现网容器、buildx、load、run、停起）
    cf.sh                  # Cloudflare 下载站上架 / 下载
    migrate.sh             # 版本化迁移执行器
  config/
    release.conf           # 版本号 + 镜像名 + 默认 scope —— 单一真源
    targets/
      cloud.conf           # x86 / compose / 腾讯云 / 测试库 / 可清库
      onprem.conf          # ARM64 / docker-run / 18.09 / 🔴禁清库 / 运行时探测
  migrations/              # 版本化迁移 V<n>__<desc>.sql（见下「DB 迁移」）
  db/
    init.sql               # 🔴 root docker-compose.yml 挂载的库初始化脚本（勿删，见下）
    geo_data/              # Natural Earth 底层地理数据（api 启动时灌库）
  prod/
    tencent-dl-nginx.sh    # CF 源站一次性配置（与发版无关）
    server-probe.sh        # 内网服务器环境探测（贴回校准 onprem.conf）
  DEPLOY-DESIGN.md         # 设计方案
  README.md                # 本文件
```

---

## 子命令一览

```bash
deploy.sh build   --version vX --scope web|full [--arch arm64|amd64]
deploy.sh publish --version vX [--scope web|full]
deploy.sh onprem  --version vX --scope web|full [--migrate-db] [--reset-db]
deploy.sh ship    --target onprem --version vX --scope web
deploy.sh migrate --target <t> [--to <序号|latest>]
deploy.sh cloud   --version vX --scope web|full [--migrate-db] [--reset-db]
deploy.sh --help
```

| 子命令 | 干什么 |
|--------|--------|
| `build`   | buildx 跨架构打镜像（按 scope，带架构断言） |
| `publish` | 镜像导出 tar → 上架 CF 下载站（内网拉取来源） |
| `onprem`  | 在内网机本地：load 镜像 + 探测现网参数 + 停老起新（docker run，18.09 兼容） |
| `ship`    | **一键** build → publish → 产出自包含内网包（高频发版主入口） |
| `migrate` | 单独跑 db 迁移（应用 `migrations/` 里未应用的文件） |
| `cloud`   | 公有云直部署：rsync 工作区 → 远端 `docker compose build/up` → curl 验证 |

### 通用参数

| 参数 | 说明 |
|------|------|
| `--version vX` | 版本号（带不带 `v` 前缀都行）。不传 → 用 `release.conf` 的 `VERSION` |
| `--scope web\|full` | `web`=只换前端镜像（最高频、秒级）；`full`=web+api。不传 → `release.conf` 的 `DEFAULT_SCOPE` |
| `--arch arm64\|amd64` | build 目标架构。不传由 target/scope 推断 |
| `--target <t>` | 目标环境，读 `config/targets/<t>.conf`（`onprem` / `cloud`） |
| `--to <序号\|latest>` | migrate 上限版本。默认 `latest` = 应用全部待应用迁移 |
| `--migrate-db` | 触发 db 迁移（与 scope 正交；onprem 迁移前自动建恢复点 + 二次确认） |
| `--reset-db` | 清库（对 `PROD=true` 的目标直接拒绝退出） |

> **scope 与 migrate-db 正交**：`--scope` 控镜像，`--migrate-db` 控 db，互不绑定。
> 默认**不传 `--migrate-db` = 不碰 db**（安全默认）。

---

## 配置（单一真源）

- **版本号只改 `config/release.conf` 的 `VERSION`**——镜像 tag 即用此值。子命令 `--version` 可临时覆盖。
- **新增/变更环境 = 改对应 `config/targets/*.conf`，主逻辑零改动**。未来加内网机 = 加一份 `onprem-<X>.conf`。

| 维度 | cloud.conf | onprem.conf |
|------|-----------|-------------|
| 架构 | amd64 | arm64 |
| 编排 | `docker compose build/up`（远端 rsync 后跑） | `docker run`（探测现网 network/端口/容器名，18.09 兼容，无 compose / 无 --platform） |
| 镜像来源 | 远端本地 build | CF 下载 tar → `docker load` |
| 部署位置 | 直连 ssh（`coder` @ 43.163.3.9） | **生成自包含包 → 人工搬运到内网跑**（物理隔离） |
| 清库 | 允许（测试库 `ALLOW_RESET=true`） | 🔴 **禁用**（`PROD=true` / `ALLOW_RESET=false`，脚本拒绝任何 truncate/drop） |

---

## DB 迁移机制（版本化 · Flyway 思路，纯 SQL + bash）

- 迁移文件放 `migrations/`，命名 `V<n>__<描述>.sql`，**序号独立递增、与镜像版本解耦**（纯前端发版无迁移文件，不浪费序号）。一个文件 = 一个原子变更。
- 库内 `schema_migrations` 表追踪已应用版本（含 checksum 防篡改）。
- 执行器（`migrate` 子命令 / `--migrate-db`）：扫 `migrations/` 求「未应用且 > 当前版本」的文件，按序号单事务逐个执行并记账；无待应用 = 空操作安全。
- **回滚不写 down 脚本**：内网生产靠迁移前自动建的 `pre_migrate` 恢复点（F17 机制）回滚；公有云测试库出错可直接 `--reset-db` 重来。

> ⚠️ **`deploy/db/init.sql` 不可删**：root `docker-compose.yml`（cloud 与本地）通过
> `./deploy/db/init.sql:/docker-entrypoint-initdb.d/01-init.sql:ro` 挂载它做空库首次初始化。
> 它的内容已拷贝为 `migrations/V0__baseline.sql`（版本化基线）；两者同步，删 init.sql 会断 cloud/本地建库链路。

> ⚠️ **测试库 V2 残留说明（历史）**：腾讯云测试库 `schema_migrations` 曾含 version 2 `tmp_verify`（P2/P4 端到端验证遗留）。
> 本地 `migrations/` 现为 V0–V4（V2 起已有正式业务迁移）。若该测试库仍残留 tmp_verify 的 V2 记账行，
> 真实 V2 在该库会被视为"已应用"而跳过（V3/V4 正常应用）——需人工核对：直接 `--reset-db` 重来或清掉该行即可；新建库无此问题。

> 📌 **升级到含 #50（RBAC）的版本（应用 V4 迁移后）**：首次访问会弹出登录页。
> 内置 admin 账号：`admin` / 初始密码 `admin123`（由 api 启动时自动种子，判空幂等），**首登强制改密**后才能进主界面。
> 用户 / 角色 / 数据权限在右上角「⚙ 管理」界面维护（仅 admin 角色可见入口）。

---

## 高频发版工作流（每天 5+ 版本）

纯前端版（最常见）一条命令到「可搬运内网包」：

```bash
deploy/deploy.sh ship --target onprem --version v1.0.3 --scope web
# 内部：build(arm64 web) → publish(上架 CF) → 产出自包含包（含 web 镜像 + 内嵌部署脚本 + onprem.conf）
# 输出：CF URL + 内网一行命令
```

内网（物理隔离、无外网）：跳板机从 CF 拉包搬到内网机 → 内网机解压 → `bash` 跑包内自带的离线部署脚本（自动探测现网 network/端口）。先探可选 `bash deploy/prod/server-probe.sh`。

公有云测试环境：

```bash
deploy/deploy.sh cloud --version v1.0.3 --scope web              # 只换前端
deploy/deploy.sh cloud --version v1.0.3 --scope full --migrate-db  # web+api+迁移
```

---

## 保留的一次性配置脚本（`prod/`）

| 文件 | 在哪跑 | 作用 |
|------|--------|------|
| `tencent-dl-nginx.sh` | 腾讯云源站 | 配置 CF 回源的 nginx 下载站（包/init.sql 落 `/var/www/dl` + chmod 644，不 chmod 会 403）。与发版无关，一次性 |
| `server-probe.sh` | 内网服务器 | 探测架构 / Docker 版本 / 端口占用 / 资源，结果贴回校准 `onprem.conf` |

---

## 排错

- **buildx 慢/卡**：QEMU 模拟 arm64 本就慢，前端 npm build / 后端 pip native 包最耗时，耐心等别中断。
- **load 报架构不符**：tar 里是 x86 镜像 → build 时架构断言应已拦截；确认 `--arch arm64` 且 QEMU binfmt 已装。
- **CF 下载 403**：源站 `/var/www/dl` 下文件没 chmod 644，重跑 `tencent-dl-nginx.sh` 或手动 chmod。
- **迁移失败**：执行器单事务回滚该文件并中止，按提示用 `pre_migrate` 恢复点回滚（内网）或 `--reset-db` 重来（测试库）。
- **cloud db 起不来**：`ssh coder` 看 `docker logs presurvey-db`；pgdata 卷有旧数据与 init.sql 冲突时，测试库可 `docker compose down -v` 清卷重来（⚠️ 删数据）。
