# Pre-Survey Map · 部署方案（手动 / 内部环境）

> 三服务 Docker Compose：`db`(PostGIS) + `api`(FastAPI) + `web`(Nginx)。
> 入口是 web（`http://<host>:5173`），Nginx 反代 `/api`、`/health` → `api:8000`。

---

## 0. 架构 & 端口

| 服务 | 镜像/构建 | 宿主端口 | 容器端口 | 说明 |
|------|-----------|---------|---------|------|
| db   | postgis/postgis:16-3.4 | 5433 | 5432 | 首次启动自动跑 `deploy/db/init.sql` |
| api  | 构建 `./api`（python:3.12-slim） | 8000 | 8000 | 启动时把 Natural Earth 国界一次性灌进 PostGIS |
| web  | 构建 `./web`（node 构建 → nginx:1.27） | 5173 | 80 | 唯一对用户暴露的入口 |

数据持久化：命名卷 `presurvey_pgdata`。
地理底数据：`deploy/db/geo_data/ne_10m_admin_0_countries.geojson`（13MB，已在仓库，挂载给 api 只读）。

---

## 1. 前置要求

- 目标机装好 **Docker** + **Docker Compose v2**（`docker compose version` 能输出版本）。
- 至少 ~2GB 空闲内存、~3GB 磁盘（PostGIS 镜像 + pgdata + 镜像层）。
- 决定部署方式：
  - **方案 A（在目标机直接构建）** —— 目标机能联网（或挂香港代理）拉 PyPI / npm / Docker Hub。
  - **方案 B（离线导入镜像）** —— 目标机不能联网，先在联网机构建好镜像，`docker save` 拷过去 `docker load`。**内部隔离环境通常走这个。**

---

## 2. ⚠️ 构建前注意 api 的 pip 源

`api/Dockerfile` 已把 pip 源做成可覆盖参数，默认官方 PyPI：

```dockerfile
ARG PIP_INDEX=https://pypi.org/simple
RUN pip install --no-cache-dir -i ${PIP_INDEX} -r requirements.txt
```

内网/内部机不挂代理拉不动官方源时，构建时用 `--build-arg` 切到国内镜像（**不用改文件**）：

```bash
# 单独构建 api
docker build --build-arg PIP_INDEX=https://mirrors.aliyun.com/pypi/simple -t presurvey-api ./api
```

compose 构建时通过 `docker-compose.yml` 给 api 服务加 build args（或临时改默认值）：

```yaml
  api:
    build:
      context: ./api
      args:
        PIP_INDEX: https://mirrors.aliyun.com/pypi/simple
```

> web 端已经配了 `npmmirror`，不用动；api 端用上面的 `PIP_INDEX` 覆盖即可。

---

## 3. 配置 .env（必做）

仓库里 `.env` 被 gitignore 了，目标机上要手动建：

```bash
cp .env.example .env
```

`.env` 内容（**生产务必改密码**）：

```ini
DB_USER=presurvey
DB_PASSWORD=<换成强密码>
DB_NAME=presurvey
```

---

## 4A. 方案 A —— 目标机直接构建启动

```bash
# 1. 拿到代码（git clone 或拷贝整个目录，注意带上 deploy/db/geo_data/*.geojson）
cd pre-survey-map

# 2. 建 .env（见第 3 节）；内网拉不动 PyPI 时给 api 传 PIP_INDEX（见第 2 节）

# 3. 一键构建 + 启动
docker compose up -d --build

# 4. 看状态（等 db healthy、api/web Up）
docker compose ps
docker compose logs -f api   # 看到 countries 加载完成 / Uvicorn running 即就绪
```

访问：`http://<目标机IP>:5173`

---

## 4B. 方案 B —— 离线导入镜像（内部隔离机）

**在能联网的构建机上：**

```bash
cd pre-survey-map
# 内网拉不动 PyPI 时给 api 传 PIP_INDEX / 挂代理后
docker compose build                       # 构建 presurvey-api、presurvey-web 两个本地镜像
docker pull postgis/postgis:16-3.4         # db 用现成镜像

# 导出三个镜像为 tar
docker save pre-survey-map-api pre-survey-map-web postgis/postgis:16-3.4 -o presurvey-images.tar
# 注：本地构建镜像名通常是 <目录名>-<服务名>，用 `docker images` 确认实际名字
```

把 `presurvey-images.tar` + 整个项目目录（含 `deploy/`、`docker-compose.yml`、`.env`）拷到内部机。

**在内部机上：**

```bash
docker load -i presurvey-images.tar
cd pre-survey-map
# 确认 .env 已就位
docker compose up -d            # 不带 --build，直接用导入的镜像
docker compose ps
```

> 若 `docker images` 显示的本地镜像名跟 compose 期望的不一致，给镜像打 tag 对齐，或在 compose 里给 api/web 加 `image:` 字段指定名字。

---

## 5. 验收

```bash
curl http://localhost:8000/health        # {"status":"ok","db":true}
curl http://localhost:5173/health        # 经 nginx 反代，同上
```

浏览器开 `http://<host>:5173`：
- 左树 / 地图 / 工具栏出来 → 前端 OK
- 切底图（矢量 / OSM / 卫星）出图 → 底图源可达（内部机要确认能访问 cartocdn / arcgisonline，或提前挂代理）
- 导入一个 KML/Excel 跑通清洗 → 全链路 OK
- 暗/亮主题切换正常（默认暗色，地图恒亮）

---

## 6. 数据备份 / 恢复

```bash
# 备份（导出整库）
docker compose exec db pg_dump -U presurvey presurvey > backup_$(date +%Y%m%d).sql

# 恢复
cat backup_YYYYMMDD.sql | docker compose exec -T db psql -U presurvey -d presurvey
```

> pgdata 在命名卷 `presurvey_pgdata`，`docker compose down` 不会删数据；`down -v` 会**清空数据库**，慎用。

---

## 7. 升级 / 重新部署

```bash
git pull                       # 或拷新代码
docker compose up -d --build   # 重建有变化的镜像，db 数据保留
```

> ⚠️ `deploy/db/init.sql` **只在 pgdata 卷为空（首次）时执行**。后续改了表结构不会自动重跑 —— 要么写迁移 SQL 手动 `psql` 执行，要么 `down -v` 重置（清数据）。

---

## 8. 生产加固建议（按内部安全要求取舍）

- **改默认密码**：`.env` 里 `DB_PASSWORD` 必须改。
- **关掉 db 对外端口**：生产不需要从宿主直连数据库，可在 `docker-compose.yml` 删掉 db 的 `ports: 5433:5432`（api 走容器内网 `db:5432`，不受影响）。
- **CORS**：`api/main.py` 现在 `allow_origins=["*"]`，内部单域名访问可收紧为具体域名。
- **HTTPS**：如需对外，前面再套一层反代（内部 Nginx / 网关）做 TLS，web 容器维持 80。
- **底图可达性**：内部隔离网若访问不了 cartocdn/arcgisonline，底图会空白 —— 需放通这两个域名或挂代理；离线场景需自建瓦片服务（V1 范围外）。

---

## 9. 常见故障

| 现象 | 原因 | 处理 |
|------|------|------|
| `docker compose build` 卡在 pip | api 没配镜像源/没代理 | 见第 2 节 |
| api 日志 `countries 加载失败` | geo_data 没拷过去 / 卷挂载路径错 | 确认 `deploy/db/geo_data/*.geojson` 存在；加载失败不阻塞启动，但海陆判定会退化 |
| 前端能开但导入/接口 500/502 | api 没起来 or db 没 healthy | `docker compose logs api db` 排查 |
| 底图空白 | 内部网访问不了瓦片源 | 放通 cartocdn / arcgisonline 或挂代理 |
| 改了 init.sql 没生效 | 卷非空不重跑 | 手动 psql 执行，或 `down -v` 重置（清数据） |
