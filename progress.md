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
- 多 repo 提交隔离：本项目含两个独立 git repo——主仓 pre-survey-map（origin=https://github.com/zylimit/pre-survey-map）+ 配置库 .claude/=sitemaster-config（origin=ssh git@github.com:zylimit/sitemaster-config）。多个独立 repo 的 add/commit/push 必须各自独立执行、分别验收远程同步状态，禁止耦合进同一脚本（认证差异 ssh/https 会掩盖单点失败，造成"半成功"烂局）（2026-06-04）
- #48 约束红线（本期禁止）：改 site_id/option 主键 / 改 operator/category/type 盖戳三列 / 凭空建点 三者本期不做（2026-06-04）

## Decisions（按时间追加，历史不可改）
- 2026-06-04: `.claude` 抽出为独立私有配置库 sitemaster-config，纯备份/版本管理，与主仓各自演进
- 2026-06-04: progress-recorder 采用「瘦 agent + 厚 skill」架构；progress.md 统一为八区块模板
- 2026-06-02: 引入语义化版本号（#38），界面=镜像 tag=部署包前缀三处一致
- 2026-05-31: F20 图层体系重构（深层图层树 + 盖戳导入），取代 F7 浅树
- 2026-06-04: #48 LayerFeatureList 增删改需求拍板——编辑范围=业务属性+坐标（后端重算 PostGIS geom）；主键 site_id/option + 盖戳三列 operator/category/type 本期锁死不可改；删除=删前自动建 reason=pre_feature_delete 恢复点（复用 F17）可回滚；操作粒度=checkbox 多选/编辑单行/删除批量/勾选子集导出 KMZ；本期仅 site 图层可编辑，road/lessor 仍只读；列宽=拖表头分隔线，存 localStorage，与 #31 等比拉伸混排共存
- 2026-06-04: #48 审计联动——F19 审计事件类型由 12 类扩至 14 类（新增 edit_site / delete_site）；后端新增接口 PATCH /api/sites/{site_id}/{option}、POST /api/sites/delete（批量+恢复点）；勾选导出按主键子集导 KMZ
- 2026-05-29: 主基准区域「先入为主」固化策略确立

## TODO（权威待办清单）
- [P0][OPEN][#1] 给 #47 圆形框选补回归测试（前端 fromCircle 多边形 → 后端 ST_Contains 严格包含）（Context：api/ web/）
- [P1][OPEN][#2] 建立后端 pytest 基建常态化（ruff/pytest 当前环境未装）（Context：api/tests/）
- [P1][OPEN][#3] `.claude` 架构改进 #2：流程三处重复 → 单一事实源（剩四步走/设计优先级）（Context：sitemaster-config）
- [P1][OPEN][#4] `.claude` 架构改进 #4：纸面纪律可机械校验项下沉为 hook；建议给 mark-review-needed hook 加路径过滤（只对 api/ web/ 下改动标记 review，避免 /tmp 下临时脚本误触发）（Context：sitemaster-config）
- [P2][OPEN][#5] `.claude` 架构改进 #5：CLAUDE.md 瘦身 + Sub-Agent 模型分级（Context：sitemaster-config）
- [P2][OPEN][#6] V2 候选评估：双工作区 / 多人协同 / AI能力 / 单要素删除 / 邮件派工
- [P0][OPEN][#18] #48 后端接口实现：PATCH /api/sites/{site_id}/{option}（单条编辑+坐标重算 geom）、POST /api/sites/delete（批量删除+自动建恢复点）（Context：api/）
- [P0][OPEN][#19] #48 前端 LayerFeatureList 改造：checkbox 多选 + 行内编辑 + 批量删除 + 勾选子集导出 KMZ + 列宽可拖拽（存 localStorage）（Context：web/）
- [P1][OPEN][#20] #48 审计联动：F19 新增 edit_site/delete_site 两类事件（12→14 类）（Context：api/）
- [P1][OPEN][#21] #48 回归测试：编辑保存后数据完整性、删除+回滚链路验证（含 site 数据完整性，呼应 #43 教训）（Context：api/tests/ web/）

## In Progress
- [P1][DOING][#7] `.claude` 框架架构改进（配置库演进中，#1/#3 已完成，#2/#4/#5 待续）（Context：sitemaster-config）

## Done（最近完成放前面）
- 2026-06-04: [#22] #48 需求文档层完成：Product-Spec.md + Product-Spec-CHANGELOG.md 已更新；代码尚未实现（evidence：Product-Spec.md / Product-Spec-CHANGELOG.md）
- 2026-06-04: [#17] 记录 feedback「多 repo 提交隔离」（evidence：.claude/feedback/multi-repo-commit-isolation.md）
- 2026-06-04: [#8] 补建 progress-recorder 闭环：瘦 agent（161→31 行，加 skills 字段）+ 厚 skill + 重建 progress.md 八区块 + CLAUDE.md 登记（调度表/项目记忆规则/技能表）；修复悬空引用（agent 原缺 skills 字段且未登记，/record /archive 跑不通）（evidence：sitemaster-config c992ef8）
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
- Risk：#48 坐标编辑触发 PostGIS geom 重算，若经纬度输入异常可能导致 geom 字段损坏（Mitigation：后端校验坐标范围 + 回归测试覆盖 TODO #21）
- Risk：#48 删除走恢复点回滚链路，回滚后 site 数据完整性需验证（呼应 #43 快照列清单教训）（Mitigation：TODO #21 回归测试含回滚场景）
- Assumption：当前内网+腾讯云 beta 部署，底图走未授权 tile 临时方案；公有云商用需替换 Google Maps API Key（Confidence：High）

## Notes（简要要点）
- 2026-06-04: progress.md 由初始化扫描（Product-Spec.md + CHANGELOG）建立，后续由 progress-recorder agent 维护
- 2026-06-04: 修复悬空引用——progress-recorder agent 原缺 skills 字段且未登记调度表，本次补全闭环
- 2026-06-04: mark-review-needed hook 只按文件扩展名匹配、不看路径，/tmp 下 .sh 临时脚本误触发了 stop-gate review 闸门；是 TODO #4（纸面纪律 vs hook 覆盖）的活样本，#4 落地时应给该 hook 加路径过滤
- 2026-06-04: #48 需求来源——用户要求在 LayerFeatureList（点图层右侧眼睛弹出浮动列表框）给 site 节点加删除/编辑功能；追加要求列宽可拖拽调整（类 Excel）；road/lessor 本期仍只读
- 2026-06-04: #48 当前状态——仅 Spec+CHANGELOG 文档完成，后端接口/前端改造/恢复点联动/审计/测试均未实现；下一步待用户确认是否进入 dev-planner/dev-builder
- Needs-Confirmation：主仓 progress.md 本地 commit 完成（evidence：cab162e）但 https 无凭证导致 push 失败；待用户改 ssh 远程或配置 https 凭证后推送至 origin

## Context Index（轻量索引）
- Spec：./Product-Spec.md · Changelog：./Product-Spec-CHANGELOG.md · Plan：./DEV-PLAN.md
- 框架配置库：github.com/zylimit/sitemaster-config
- Archive：./progress.archive.md（暂未创建）
