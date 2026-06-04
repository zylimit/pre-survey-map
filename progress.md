# Project: Pre-Survey Map
_Last updated: 2026-06-04_

> 项目记忆文件。维护规则见 `.claude/CLAUDE.md [项目记忆规则]`，由 progress-recorder agent 增量维护。
> 指令：`/record` 增量合并 · `/archive` 快照归档（条目 >100 时）· `/recap` 回顾当前状态。
> 受保护区块（Pinned/Decisions）不可自动修订；TODO 的 #ID 单调递增不复用。

## Pinned（高置信"必须遵守"；受保护不可修订）
- 定位：B/S 站点勘测数据统一管理平台；单一用户=勘测数据维护工程师；核心价值=避免勘测员重复跑已勘测的点
- 技术栈：前端 OpenLayers + TS/React（`web/`）；后端 Python FastAPI + PostgreSQL/PostGIS（`api/`）；Docker 部署
- 主基准区域算法：先入为主，一次性固化、**永不重算**；换基线唯一通道 = F14 清除基线
- 身份识别 = IP + User-Agent + Session ID（V1 不做登录，浏览器限制）
- 不可逆操作（导入 commit / 清除基线 / 回滚）前自动建恢复点（F17，保留最近 10 个）
- 数据导入 V1 一次一个文件，单文件 ≤100MB
- V1 边界（不做）：账号鉴权 / 双工作区 / 多人协同 / AI能力 / 单要素删除 / 邮件自动发送

## Decisions（按时间追加，历史不可改）
- 2026-06-04: `.claude` 抽出为独立私有配置库 sitemaster-config，纯备份/版本管理，与主仓各自演进
- 2026-06-04: progress-recorder 采用「瘦 agent + 厚 skill」架构；progress.md 统一为八区块模板
- 2026-06-02: 引入语义化版本号（#38），界面=镜像 tag=部署包前缀三处一致
- 2026-05-31: F20 图层体系重构（深层图层树 + 盖戳导入），取代 F7 浅树
- 2026-05-29: 主基准区域「先入为主」固化策略确立

## TODO（权威待办清单）
- [P0][OPEN][#1] 给 #47 圆形框选补回归测试（前端 fromCircle 多边形 → 后端 ST_Contains 严格包含）（Context：api/ web/）
- [P1][OPEN][#2] 建立后端 pytest 基建常态化（ruff/pytest 当前环境未装）（Context：api/tests/）
- [P1][OPEN][#3] `.claude` 架构改进 #2：流程三处重复 → 单一事实源（剩四步走/设计优先级）（Context：sitemaster-config）
- [P1][OPEN][#4] `.claude` 架构改进 #4：纸面纪律可机械校验项下沉为 hook（Context：sitemaster-config）
- [P2][OPEN][#5] `.claude` 架构改进 #5：CLAUDE.md 瘦身 + Sub-Agent 模型分级（Context：sitemaster-config）
- [P2][OPEN][#6] V2 候选评估：双工作区 / 多人协同 / AI能力 / 单要素删除 / 邮件派工

## In Progress
- [P1][DOING][#7] `.claude` 框架架构改进（配置库演进中，#1/#3 已完成，#2/#4/#5 待续）（Context：sitemaster-config）

## Done（最近完成放前面）
- 2026-06-04: [#8] 补建 progress-recorder：瘦 agent + 厚 skill + 重建 progress.md 八区块 + CLAUDE.md 登记
- 2026-06-04: [#9] `.claude` #3 进化引擎 3 条 feedback 毕业为硬规则（evidence：sitemaster-config 668b46e）
- 2026-06-04: [#10] `.claude` #1 commit 门禁按技术栈分发，覆盖 Python 后端（evidence：19eb884）
- 2026-06-04: [#11] `.claude` 抽出为独立私有配置库 sitemaster-config（evidence：1c47e70）
- 2026-06-03: [#12] #47 圆形框选导出 KMZ → v1.0.4 部署内网+腾讯云（evidence：CHANGELOG #47 / git c85b16a）
- 2026-06-03: [#13] #43–#46 列表框拉伸 / 图层配色 / NP辐射圈半径可配 / 范围圈导出 + 项目首份 pytest
- 2026-06-02: [#14] F20 图层体系重构收尾（#24–#42）+ F21 定时自动备份
- 2026-05-30: [#15] F17 恢复点回滚 / F18 双语界面 / F19 审计日志（#20–#23）
- 2026-05-28: [#16] V1 主体交付：F1–F12 + UI 五区块 + 数据规则（四 Stage 累积完成）

## Risks & Assumptions
- Risk：新功能快速 ship 但回归测试网刚起步（#46 才首份测试，#47 无测试就部署）（Mitigation：落实「测试是打包前闸门」铁律 + TODO #1/#2）
- Assumption：当前内网+腾讯云 beta 部署，底图走未授权 tile 临时方案；公有云商用需替换 Google Maps API Key（Confidence：High）

## Notes（简要要点）
- 2026-06-04: progress.md 由初始化扫描（Product-Spec.md + CHANGELOG）建立，后续由 progress-recorder agent 维护
- 2026-06-04: 修复悬空引用——progress-recorder agent 原缺 skills 字段且未登记调度表，本次补全闭环

## Context Index（轻量索引）
- Spec：./Product-Spec.md · Changelog：./Product-Spec-CHANGELOG.md · Plan：./DEV-PLAN.md
- 框架配置库：github.com/zylimit/sitemaster-config
- Archive：./progress.archive.md（暂未创建）
