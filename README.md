# Pre-Survey Map

> **站点勘测数据统一管理平台** · 给勘测数据维护工程师用的 B/S 工具
>
> 把多源勘测数据（Google Earth 标的 KMZ + 内部系统 ISDP/eSurvey 导出的 Excel）统一去重入库；
> 派工时在地图上框选目标区域导出 KMZ，邮件发给一线勘测员；
> **核心价值：避免勘测员跑到已勘测的点上做重复工作**。

---

## 🎯 当前状态

| 里程碑 | 状态 |
|--------|------|
| V1 12 个功能（F1-F12） + UI 五区块 + 数据契约 | ✅ 已交付 |
| V1.x 视觉皮肤 · Mint Tech（清新自然 + 科技感） | 🟡 实施中 |
| V2 候选（双工作区 / AI 列名识别 / 多人协同等） | 📋 已记入候选 |

详见 [Product-Spec.md](./Product-Spec.md) 的「V1 交付快照」节。

---

## 📚 文档索引

| 文件 | 内容 |
|------|------|
| [Product-Spec.md](./Product-Spec.md) | 完整产品需求 · UI 布局 · 数据规则 · 技术栈 · V2 候选 |
| [Product-Spec-CHANGELOG.md](./Product-Spec-CHANGELOG.md) | 全部变更轨迹（10 条全轻度，含 reversal 案例）|
| [.claude/CLAUDE.md](./.claude/CLAUDE.md) | Claude Code 主控 Agent 配置（角色「芒果V5」+ 工作流 + 指令集）|
| [.claude/skills/product-spec-builder/](./.claude/skills/product-spec-builder/) | 需求收集 Skill 包（含 SKILL.md / reference.md / templates/）|

---

## 🛠️ 技术栈

| 层 | 选型 |
|----|------|
| 前端 | React + OpenLayers + Vite |
| 后端 | Python + FastAPI |
| 数据库 | PostgreSQL 16 + PostGIS（`postgis/postgis:16-3.4`）|
| 部署 | Docker Compose |
| 文件解析 | fastkml / pykml（KML/KMZ）+ openpyxl（Excel）|

---

## 🚀 本地启动

需要：Docker Desktop（含 Compose 插件）

```bash
# 1. 准备环境变量
cp .env.example .env
# （可按需修改 DB_USER / DB_PASSWORD / DB_NAME）

# 2. 启动三个容器（db + api + web）
docker compose up -d --build

# 3. 等 ~10 秒数据库初始化完成（健康检查会拦住 api 启动直到 db ready）
docker compose ps
```

访问：

| 入口 | 地址 |
|------|------|
| 前端 | <http://localhost:5173> |
| 后端 API | <http://localhost:8000/docs> |
| 后端健康 | <http://localhost:8000/health> |
| 数据库 | `localhost:5433` · user/pass/db = `postgres / postgres / presurvey` |

停止：

```bash
docker compose down              # 停容器
docker compose down -v           # 停容器 + 删数据卷（清空数据库）
```

---

## 📂 项目结构

```
pre-survey-map/
├── Product-Spec.md                  # 产品需求（唯一真相源）
├── Product-Spec-CHANGELOG.md        # 变更轨迹
├── README.md                        # 本文件
├── docker-compose.yml               # 三容器编排
├── .env.example                     # 环境变量样本
│
├── web/                             # React + OpenLayers 前端
│   ├── src/                           # 组件 / 状态 / API 客户端 / 主题
│   ├── Dockerfile + nginx.conf        # Nginx 反代 /api/* → api:8000
│   ├── package.json + vite.config.ts
│   └── index.html
│
├── api/                             # FastAPI 后端
│   ├── main.py                        # 应用入口 + CORS
│   ├── routers/                       # imports / exports / sites / roads / lessors / health
│   ├── parsers/                       # kml / kmz / xlsx
│   ├── exporters/                     # kmz（含 Style + Schema + Folder 分组）
│   ├── db.py + anomaly.py + session_store.py
│   ├── requirements.txt
│   └── Dockerfile
│
├── deploy/db/                       # PostgreSQL 初始化 SQL
│   └── init.sql                       # PostGIS 扩展 + 三张业务表
│
├── data/                            # 样本数据 + demo 输出
│   ├── Integrated_Libraries_2026-05-27.kml
│   ├── Sample Data.xlsx
│   └── exports/
│       ├── export_full_demo.kmz       # 整库导出 demo
│       ├── export_region_demo.kmz     # 选区导出 demo
│       └── conflicts_demo.xlsx        # 冲突列表导出 demo
│
└── .claude/                         # Claude Code 项目配置
    ├── CLAUDE.md                      # 主控 Agent
    └── skills/
        └── product-spec-builder/      # 需求收集 Skill 包
            ├── SKILL.md
            ├── reference.md
            └── templates/
```

---

## 🧪 端到端验证

启动后跑这一遍，能覆盖 V1 全部数据路径：

1. 浏览器开 <http://localhost:5173>
2. 拖 `data/Integrated_Libraries_2026-05-27.kml` 到地图区 → 冲突弹窗弹出 → 选 [全部覆盖] → [确认导入]
3. 拖 `data/Sample Data.xlsx` 进去 → 再来一次
4. 左树看到 Site / Road / Lessor 三个文件夹及数量
5. 点 [⬛ 框选 ▾] → 选「矩形」→ 在地图上拉一个矩形
6. 点 [💾 导出 KMZ ▾] → [导出选区] → 下载 `export_region_*.kmz`
7. Google Earth 打开下载的 KMZ → 验证位置和颜色

更详细的 8 步浏览器验证清单见 CHANGELOG #4 / #5 的实施回写。

---

## 🤝 开发模式（Claude Code 双 Instance）

本项目用 Claude Code 双 Instance 协作开发：

- **需求侧 Instance（A）**：调用 `product-spec-builder` Skill（角色「芒果V5」）→ 专门改 Spec + 写 CHANGELOG
- **实施侧 Instance（B）**：独立 Claude Code 会话 → 按 Spec 写代码、跑 docker、debug

文件系统共享、对话独立。**改需求找 A；写代码找 B。**

详细工作流见 `.claude/CLAUDE.md` 的 `[实施引导阶段]`。

---

## 📊 V1 验收维度

| 维度 | 项数 | 状态 |
|------|------|------|
| 功能需求 F1-F12 | 12 | ✅ 12/12 |
| UI 五区块（toolbar / 树 / 地图 / 属性 / 输出）| 5 | ✅ 全部就位 |
| 数据契约（去重 / 合并 / 字段名规范化 / KMZ 自反一致性 / 异常处理） | 5 | ✅ 全部验证通过 |
| V1 边界声明（不做的事） | 7 | ✅ 全部确认未越界 |

---

## 📜 License

未指定（私有项目）

---

🤖 项目通过 [Claude Code](https://claude.com/claude-code) 协作开发，需求侧由 `product-spec-builder` Skill 驱动。
