# 统一部署系统设计方案 v1（待评审）

> 目标：一套脚本 + 配置驱动，同时支撑**公有云（腾讯云 x86 / compose）**与**内网生产（ARM64 / Docker 18.09 / 离线 / docker run）**两套环境；适配**每天 5+ 版本**的高频发版与**频繁数据迁移**；安全上**默认绝不碰 db + 危险操作双重确认 + 内网生产禁清库**。
>
> 状态：设计稿，待用户判定覆盖范围后细化 → 派部署 Agent 实现。

---

## 1. 设计约束（来自用户，按权重排序）

| # | 约束 | 对设计的硬要求 |
|---|------|--------------|
| C1 | **每天 5+ 版本，高频** | 手动步骤压到最小，理想"一条命令出版本"；版本号自动化；禁止每次手写脚本 |
| C2 | **内网服务器经常变** | 环境参数（IP/network/端口/容器名）**绝不硬编码**——配置文件 + 运行时自动探测 |
| C3 | **很多牵涉数据迁移** | db migration 升为一等公民：版本化、可追踪、迁移前自动备份、可回滚 |
| C4 | **双环境差异巨大** | x86/ARM64、compose/docker-run、联网/离线 —— 差异抽进 config，主逻辑不分叉 |
| C5 | **安全** | 默认不碰 db；`--migrate-db`/`--reset-db` 显式且双确认；内网生产 `--reset-db` 直接禁用 |
| C6 | **清理但不搞乱** | 死代码随重构一次性替换，**不孤立裸删**（不能断了在用的 #45 链路） |

---

## 2. 现状诊断 + 清理清单

**两条打架的路线 + 死代码 + 脚本增殖**：

| 文件 | 处置 | 理由 |
|------|------|------|
| `update-deploy.sh` | **并入** `deploy.sh build+publish` | 打包+CF 逻辑保留，收编为子命令 |
| `pack-arm64.sh` | **删** | 旧整包 tar.gz·compose 路线，被 update-deploy 取代 |
| `load-and-up.sh` | **删** | compose 部署，内网 Docker 18.09 跑不了 = 死代码 |
| `docker-compose.prod.yml` | **删（内网用）/ 移交 cloud** | 内网死；若公有云纳入，移到 cloud 配置 |
| `server-deploy-web-v1.0.2.sh` | **收编**为 `deploy.sh onprem --scope web` | 自动探测逻辑提炼进公共库；停止每版手写 |
| `tencent-dl-nginx.sh` | **保留**（CF 源站一次性配置） | 与发版无关 |
| `server-probe.sh` | **保留 / 收编** `deploy.sh probe` | 探测有用 |
| `init.sql` | **改造**为 `migrations/V0__baseline.sql`（见 §5） | 全量幂等 → 版本化基线 |
| `db/geo_data/` | 保留 | 数据资产 |

> ⚠️ C6：清理**在新 `deploy.sh` 跑通后**作为重构的最后一步执行，不提前裸删。#45 当前用的 `server-deploy-web-v1.0.2.sh` 在新脚本接管前不动。

---

## 3. 目标架构

```
deploy/
  deploy.sh                # 唯一入口（子命令调度）
  lib/
    common.sh              # 日志/确认/校验/版本解析
    docker.sh              # docker 封装（探测现网容器、load、run、停起）
    cf.sh                  # CF 上架/下载
    migrate.sh             # 迁移执行器（见 §5）
  config/
    release.conf           # 版本号 + 镜像 tag + 默认 scope —— 单一真源
    targets/
      cloud.conf           # x86 / compose / 腾讯云 / 测试库 / 可清库
      onprem.conf          # ARM64 / docker-run / presurvey-net / 18080 / 🔴禁清库
      onprem-<X>.conf      # 内网多机：每台一份，应对 C2"经常变"
  migrations/              # 版本化迁移（见 §5）
    V0__baseline.sql       # = 原 init.sql（全新空库）
    V1__add_layer_cols.sql # 增量，按序
    ...
  db/geo_data/
  DEPLOY-DESIGN.md         # 本文件
  README.md                # 实战手册（重写）
```

**原则**：环境差异 = 一个 `.conf`；新增内网机 = 加一份 `onprem-X.conf`，主逻辑零改动。

---

## 4. 子命令与参数

```
deploy.sh build    --version vX --scope web|full [--arch arm64|amd64]
deploy.sh publish  --version vX                  # 上架 CF + 生成自包含内网包
deploy.sh cloud    --version vX --scope web|full [--migrate-db]      # 公有云直部署
deploy.sh onprem   --version vX --scope web|full [--migrate-db] [--reset-db]
deploy.sh migrate  --target onprem --to <序号|latest>   # 单独跑迁移
deploy.sh probe    --target onprem               # 环境探测
deploy.sh ship     --target onprem --version vX --scope web   # 一键: build→publish→产出内网包(C1)
```

**`--scope`（C 已定：两者都要）**：
- `web`：只重建/替换 web 镜像，**不碰 api/db**（如 #45）。增量、秒级。
- `full`：web + api 都打/换；db 是否动由 `--migrate-db` 独立控制（正交）。

**环境差异由 target config 决定**，同一子命令两环境行为不同：
| 维度 | cloud.conf | onprem.conf |
|------|-----------|-------------|
| 架构 | amd64 | arm64 |
| 编排 | docker compose up | docker run（探测现网参数） |
| 镜像 | 本地 build | CF 下载 tar → load |
| 部署位置 | 直连 ssh | **生成自包含包 → 人工搬运到内网跑**（物理隔离，脚本到不了内网） |
| 清库 | 允许（测试库） | **禁用** |

---

## 5. DB 迁移机制（核心 · C3）

**现状问题**：init.sql 全量幂等只能"加列"，无法表达改类型/回填/拆表，且不知库在哪个版本。

**方案：轻量版本化迁移（Flyway 思路，纯 SQL + bash 执行器，不引重框架）**

### 5.1 迁移文件
```
migrations/
  V0__baseline.sql      # 原 init.sql，全新空库一次建好
  V1__xxx.sql           # 此后每个 schema/数据变更一个文件，序号递增
  V2__backfill_yyy.sql  # 数据迁移（回填/转换）也在这，保证只跑一次
```
- 序号**独立递增，与镜像版本解耦**（纯前端发版无迁移文件，不浪费序号）。
- 命名 `V<n>__<描述>.sql`；一个文件 = 一个原子变更。

### 5.2 追踪表（库内）
```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INT PRIMARY KEY,
  name       TEXT NOT NULL,
  checksum   TEXT NOT NULL,        -- 防止已应用文件被篡改
  applied_at TIMESTAMPTZ DEFAULT now()
);
```

### 5.3 执行器（`deploy.sh migrate` / 部署时 `--migrate-db`）
```
1. 连库，确保 schema_migrations 存在
2. 读已应用版本集合；扫 migrations/ 求"未应用且 > 当前"的文件，按序号排序
3. 无待应用 → 直接结束（幂等、空操作安全）
4. 有待应用：
   a. 🛡 迁移前自动建恢复点（复用 F17 create_restore_point，reason='pre_migrate'）
   b. 逐文件【单事务】执行 + 写 schema_migrations
   c. 任一文件失败 → 事务回滚该文件 + 中止 + 打印"可用恢复点 rp_id 回滚"
5. 打印从版本 X → Y
```

### 5.4 回滚
- 不写 down 脚本（双向迁移维护成本高、易错）。
- 内网生产**靠 F17 恢复点回滚**（迁移前那个 `pre_migrate` 点）——已有成熟机制，覆盖式 truncate+重灌，最可靠。
- 公有云测试库出错可直接 `--reset-db` 重来。

### 5.5 与 scope/安全的正交关系
- `--scope web/full` 控镜像；`--migrate-db` 控 db。**互不绑定**：可只换 web、可只迁移、可镜像+迁移一起。
- 默认**不传 = 不碰 db**（C5）。

---

## 6. 高频发版工作流（C1）

**目标：纯前端版（如 #45）一条命令到"可搬运内网包"。**

```bash
deploy.sh ship --target onprem --version v1.0.3 --scope web
# 内部: build(arm64 web) → publish(上架CF) → 产出自包含包:
#   presurvey-onprem-v1.0.3-web.tar  (含 web 镜像 + 内嵌 deploy-onprem.sh + onprem.conf)
# 输出: CF URL + 内网一行命令
```
- **版本号自动化**：`release.conf` 单一真源；`deploy.sh bump patch` 自增（界面 `__APP_VERSION__` 也从这取，消除 §当前 web/package.json 手改）。
- **自包含内网包**：tar 内自带部署脚本 + 配置，内网 `su -c 'bash deploy-onprem.sh'` 一条命令；脚本自动探测现网 network/端口（C2）。
- **缓存复用**：buildx layer cache + 仅变更的 scope 才重打，降低 5+/天 的构建耗时。

---

## 7. 安全护栏（C5）

| 操作 | 默认 | 触发条件 | 内网生产 |
|------|------|---------|---------|
| 换镜像 | scope 指定 | — | 允许 |
| 迁移 db | **关** | `--migrate-db` | 允许，前置自动恢复点 + 打印 X→Y 待确认 |
| 清库 reset | **关** | `--reset-db` + 交互输入目标名二次确认 | **硬禁用**（onprem.conf 标 `ALLOW_RESET=false`，脚本拒绝） |
| 全新初始化 | — | 空库自动 V0 | 仅当库为空 |

- 所有危险操作**先探测 + 打印将做什么 + 要确认**，不静默执行。
- onprem.conf 顶部 `🔴 PROD=true / ALLOW_RESET=false`，脚本对 PROD 目标拒绝任何 truncate/drop。

---

## 8. 落地计划（分阶段，派部署 Agent，不破坏现有链路）

| 阶段 | 内容 | 风险控制 |
|------|------|---------|
| P1 | 搭骨架：deploy.sh + lib/ + config/（不删旧脚本） | 新旧并存，旧链路仍可用 |
| P2 | migrations/ 机制 + V0(=init.sql) + 执行器 + schema_migrations | 在公有云测试库先验证 |
| P3 | onprem 子命令（收编 server-deploy-web 的探测逻辑）+ ship 一键 | 用一个真实版本端到端验证 |
| P4 | cloud 子命令（若纳入范围） | — |
| P5 | **清理**：删死代码 + 收编旧脚本 + 重写 README | 仅当 P1–P3 跑通后执行（C6） |

---

## 9. 决策定稿（2026-06-03）

1. **覆盖范围 = 全链路**：build / publish / cloud / onprem 四子命令全做。
2. **内网拓扑 = 同一台、参数会变**：单 `onprem.conf` + 运行时自动探测现网 network/端口/容器名；暂不做多目标，但 config 结构预留平滑扩展（未来加机 = 加一份 `.conf`，主逻辑零改）。
3. **迁移文件归属 = 随功能产出**：哪个 #编号迭代改了 schema，实施 Agent 在该迭代内产出对应 `V<n>__xxx.sql`，纳入 review，与代码同生命周期、不脱节。
4. **开工时机 = 先收尾 #45 再开工**：本设计定稿待命；待 #45 内网部署验证完成、现有链路确认 OK 后，再派部署 Agent 起 §8 的 P1（搭骨架，新旧并存不破坏现链路）。

---

## 10. 已知 backlog（评审/审查发现，待后续处理）

- **[MED · P2 审查] `--to` 缺数值校验**：误传非数字（如 `--to abc`）触发底层 bash 算术错 + `set -e` 中止（安全失败、不会错误迁移，但报错不友好）。`migrate.sh:_scan_pending` 入口加一行 `case "$target_to" in latest|[0-9]*) ;; *) die ...`。
- **[MED · P2 审查] `pre_migrate` 恢复点会被 F17 环形淘汰**：F17 环淘汰条件 `reason <> 'auto_backup'` 把 `pre_migrate` 算进"保留最近 10 个"名额，多次交互建点后该迁移恢复点可能被删（CASCADE 连快照）。"迁移后立即回滚"主场景无影响，但**长期回滚不保证**。待办：改 `api/restore_point_helper`，让 `pre_migrate` 与 `auto_backup` 同等排除出环淘汰；或文档明示长期回滚靠 pg_dump。（碰 api 代码，需测试，故未在 P2 内顺手改）
- **[LOW · P2 审查] `migrate.sh` `_baseline_tables_present` 的 `count=9` 硬编码**：与 init.sql 表清单耦合，表增减需同步。加锚定注释。
- **[MED/LOW · P1 审查] `cmd_publish` 的 trap EXIT 叠加风险 + `probe` 的 `head -1` SIGPIPE 注释 + `assert_arch` 多 arch 校验**：当前批次无害，后续批次顺手处理。
