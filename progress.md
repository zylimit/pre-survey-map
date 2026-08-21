# Project: Pre-Survey Map
_Last updated: 2026-08-20_

> 项目记忆文件。维护规则见 `.claude/CLAUDE.md [项目记忆规则]`，由 progress-recorder agent 增量维护。
> 指令：`/record` 增量合并 · `/archive` 快照归档（条目 >100 时）· `/recap` 回顾当前状态。
> 受保护区块（Pinned/Decisions）不可自动修订；TODO 的 #ID 单调递增不复用。

## Pinned（高置信"必须遵守"；受保护不可修订）
- 定位：B/S 站点勘测数据统一管理平台；单一用户=勘测数据维护工程师；核心价值=避免勘测员重复跑已勘测的点
- 技术栈：前端 OpenLayers + TS/React（`web/`）；后端 Python FastAPI + PostgreSQL/PostGIS（`api/`）；Docker 部署
- 主基准区域算法：先入为主，一次性固化、**永不重算**；换基线唯一通道 = F14 清除基线
- ~~身份识别 = IP + User-Agent + Session ID（V1 不做登录）~~ **#50 起作废**：登录页（账号密码）+ RBAC；审计身份=真实 username + IP/UA/Session 三件套（2026-08-18）
- 不可逆操作（导入 commit / 清除基线 / 回滚）前自动建恢复点（F17，保留最近 10 个）
- 数据导入 V1 一次一个文件，单文件 ≤100MB
- V1 边界（不做）：~~账号鉴权（#50 已做）~~ / 双工作区 / 多人协同并发冲突处理（#50 只做多账号登录，后写赢）/ AI能力 / 单要素删除 / 邮件自动发送
- 多 repo 提交隔离：本项目含两个独立 git repo——主仓 pre-survey-map（origin=https://github.com/zylimit/pre-survey-map）+ 配置库 .claude/=sitemaster-config（origin=ssh git@github.com:zylimit/sitemaster-config）。多个独立 repo 的 add/commit/push 必须各自独立执行、分别验收远程同步状态，禁止耦合进同一脚本（认证差异 ssh/https 会掩盖单点失败，造成"半成功"烂局）（2026-06-04）
- #48 约束红线（本期禁止）：改 site_id/option 主键 / 改 operator/category/type 盖戳三列 / 凭空建点 三者本期不做（2026-06-04）
- #49 约束：site_delete_undo 表环形队列保留最近 200 批；delete 接口去掉建恢复点（改为写 undo 表）；evict 容错 try/except（不连累主删除事务）（2026-06-04）

## Decisions（按时间追加，历史不可改）
- 2026-08-18: #51 AREA 运营商区域面图层拍板——新表 area（第四类实体：name 去重键[同运营商内]+operator 盖戳+polygon+extras）；全链路同 site 待遇（F13 清洗面以质心判定/冲突向导/F17 快照/KMZ 自反契约扩第四类 schema #area/几何护栏只收面）；按运营商分色（Globe 蓝/Smart 绿/Dito 红 半透明）；权限 scope 值域扩 site:<op>:AREA、继承自动涵盖已有角色零配置变更
- 2026-08-18: #50 用户与角色权限拍板——登录页（账号+密码，bcrypt，auth_session DB token 7天滑动可吊销，非JWT）；功能权限4开关（import/export/edit_delete/danger）+ 数据权限=图层树任意文件夹节点子级继承、查看=编辑同权、无权限完全隐藏（后端SQL过滤）；仅内置 admin 角色（全权限不可删），其余角色 admin 界面手建；F19审计3×ESC / F21备份3×B 隐藏入口废除收编进 [⚙管理] Modal；并发不管后写赢；审计 15→20 类（+login/login_failed/logout/user_manage/role_manage）
- 2026-06-04: `.claude` 抽出为独立私有配置库 sitemaster-config，纯备份/版本管理，与主仓各自演进
- 2026-06-04: progress-recorder 采用「瘦 agent + 厚 skill」架构；progress.md 统一为八区块模板
- 2026-06-02: 引入语义化版本号（#38），界面=镜像 tag=部署包前缀三处一致
- 2026-05-31: F20 图层体系重构（深层图层树 + 盖戳导入），取代 F7 浅树
- 2026-06-04: #48 LayerFeatureList 增删改需求拍板——编辑范围=业务属性+坐标（后端重算 PostGIS geom）；主键 site_id/option + 盖戳三列 operator/category/type 本期锁死不可改；删除=删前自动建 reason=pre_feature_delete 恢复点（复用 F17）可回滚；操作粒度=checkbox 多选/编辑单行/删除批量/勾选子集导出 KMZ；本期仅 site 图层可编辑，road/lessor 仍只读；列宽=拖表头分隔线，存 localStorage，与 #31 等比拉伸混排共存
- 2026-06-04: #48 审计联动——F19 审计事件类型由 12 类扩至 14 类（新增 edit_site / delete_site）；后端新增接口 PATCH /api/sites（改业务属性+坐标重算geom，key走body）、POST /api/sites/delete（批量删除+恢复点）；勾选导出按主键子集导 KMZ
- 2026-06-04: #49 轻量撤销方案拍板——#48 delete 复用 F17 全表快照（O(全表)），改为新表 site_delete_undo 只存被删行（O(删除数)）；撤销 UX 定为工具栏「删除历史」按钮 → 持久面板逐批撤（非 toast），保留最近 200 批，每批显示时间/删N条/图层/站点名摘要，撤销后移出面板；审计新增 undo_delete_site 类型
- 2026-05-29: 主基准区域「先入为主」固化策略确立

## TODO（权威待办清单）
- [P1][OPEN][#40] #51 实现待办：area 表+快照 / 树骨架加 AREA / 导入盖戳+清洗+冲突 / F17 快照链路 / KMZ 导出自反 / 权限三处映射表 / 按运营商分色渲染 / 回归测试。**前置依赖：等用户提供 Smart 区域划分样例 KMZ**（Context：api/ web/ deploy/db/）
- [P1][OPEN][#3] `.claude` 架构改进 #2：流程三处重复 → 单一事实源（剩四步走/设计优先级）（配置库事项，不阻塞本仓；Context：sitemaster-config）
- [P1][OPEN][#4] `.claude` 架构改进 #4：纸面纪律可机械校验项下沉为 hook；建议给 mark-review-needed hook 加路径过滤（只对 api/ web/ 下改动标记 review，避免 /tmp 下临时脚本误触发）（配置库事项，不阻塞本仓；Context：sitemaster-config）
- [P2][OPEN][#5] `.claude` 架构改进 #5：CLAUDE.md 瘦身 + Sub-Agent 模型分级（配置库事项，不阻塞本仓；Context：sitemaster-config）

## In Progress
- [P1][DOING][#7] `.claude` 框架架构改进（本仓已迁移 .opencode；#3/#4/#5 属 sitemaster-config 配置库事项，与本仓代码无关，不阻塞本仓）（Context：sitemaster-config）

## Done（最近完成放前面）
- 2026-08-18: [#39] #51 需求文档层完成：Product-Spec.md（F23 行 + 「AREA 区域面图层（F23 · V1.x #51）」节）+ Product-Spec-CHANGELOG.md #51 条目；代码未实现，等样例 KMZ + 开发排期（evidence：Product-Spec.md / Product-Spec-CHANGELOG.md）
- 2026-08-18: [#38] backlog 全清（#36/#26/#2/#35/#6 五连 DONE）——#36 deploy reset 清单补 RBAC 4 表+site_delete_undo（review 顺手抓出同类遗漏）+README 修订；#26 前端拖拽 document listeners unmount cleanup（三 handler 配平）+rebindSelected 收敛进 refresh（3 处显式调用→0，结构性免疫）；#2 ruff==0.16.3 引入+零风险修复 10 条（存量 118 条列清单不修：UP045×82 大头）；#35 api/ 平铺→feature 包大重构（11 包：core/geo/audit/backups/restore/baseline/imports/sites/roads/lessors/exports，routers/ 消除，纯搬迁零逻辑改动，reviewer 六路攻击击不破+亲跑 151 passed）；#6 V2 评估落 Spec（双工作区搁置/多人冲突不做/单要素删除关闭/邮件派工=最有价值候选/工作空间+点聚合+模糊去重等真实信号）（evidence：commits 09cf8c3 + 17e1c47 + c9c71c9）
- 2026-08-18: [#37] P0 测试债清零 + 一处缺陷 red-locks 修复——tester 独立补 #47 圆形框选回归测试 17 条（fromCircle 64 段夹具保真/GEOS 严格包含语义含边界排除/全链路+审计不记几何+scope 受限路径；新增 shapely==2.0.6 依赖做不连库的空间谓词代理）（evidence：commit 2a7c942）；tester 顺带发现 export_selection polygon 缺 coordinates 下沉 DB 500 缺陷 → 红测试 3 条锁定 → implementer 修绿（应用层 400 校验）（evidence：commit 674666d）；全量 151 passed/1 skipped；已推远端
- 2026-08-18: [#34] #50 RBAC 六 Phase 全流程完成入库——Phase 10 数据层 4 表（e726262）/ Phase 11 认证 api/auth 包 login+logout+me+change-password+401 中间件+滑动 token+5 次锁定（315c39a）/ Phase 12 admin 包 users/roles CRUD+permissions/scopes 门控全落点（f83316f）/ Phase 13 前端登录页+apiFetch token 管线+401 拦截+启动闸门+强制改密（51663a1）/ Phase 14 AdminModal 四 tab+ScopeTree 三态权限树（5e118d9）/ Phase 15 前端 scopes.ts 全链路门控+3×ESC/3×B/mangosv5 连根拔除+审计补 5 事件+username 列（91e8656）+ V4 部署接线/文档（cd5ef35）；每 Phase 走 implementer→code-reviewer→修复闭环；tester 独立全量回归 131 passed/1 skipped（test_auth_50 16 + test_admin_50 29 + test_scope_filter_50 38 新增，既有零回归）；deployer 重打镜像 + V4 迁移实测幂等（内网 v1.0.6 直升路径验证）；主 Agent 独立验收冒烟全过（admin login 200+must_change_password / 建 Globe PM 角色+用户 / 非 admin 调 admin 接口 403 / 无 danger 调清基线 403 / 审计 login 带 username / web 产物含 token 管线 / 无 token /api/sites 401）（evidence：commit e726262..cd5ef35 + 本机 Docker 部署 2026-08-18）
- 2026-08-18: [#32] #50 需求文档层完成：Product-Spec.md（F22 节 + F19/F21 收编注记 + V1 边界认证行 + V2 候选认证条 + #48 权限条 + Toolbar [⚙管理]）+ Product-Spec-CHANGELOG.md（#50 条目）已更新；代码尚未实现（evidence：Product-Spec.md / Product-Spec-CHANGELOG.md）
- 2026-08-17: [#31] v1.0.6 本机 WSL Docker 部署完成——测试卡点 tester 独立跑 48 passed/1 skipped/0 fail（python:3.12-slim 容器跑 pytest，因系统 Python 3.14 与 requirements pin 无 cp314 wheel 不兼容）；首轮 api 构建 pypi 官方源超时，改清华源 build-arg（未改项目文件）后成功；主 Agent 独立核查三件套全过（容器 Created 2026-08-17 22:20:34 晚于 commit 5bf1434 / api:8000/health 200 / web:5173 200 / 前端产物含 "1.0.6" / #49 新端点 delete-history→[] 与 undo-delete/999→404 符合预期）；本次为全新空卷 pre-survey-map-opencode_presurvey_pgdata（旧 119 条测试数据不可恢复，空库基线需重新导入）；镜像 tag 为 compose 默认 latest 未带 v1.0.6（evidence：Docker 本机 WSL 部署 2026-08-17，commit 5bf1434）
- 2026-06-04: [#30] #49 ARM64 v1.0.6 离线包发布——deployer 打包 api 镜像 35fdb6c/web 镜像 4d42e2b（均 arm64），发布 img.mangosv5.app：presurvey-api/web-v1.0.6-20260604-183508-arm64.tar + server-deploy-api/web-v1.0.6.sh + V2+V3 迁移 sql；主 Agent 独立核查全绿（arm64 api 镜像 diff==工作树含#49码排除0.42s缓存旧码嫌疑、6链接 HEAD200、脚本含 alias+V2+V3 迁移、bash -n 通过）（evidence：commit 729acc4 + img.mangosv5.app 2026-06-04）
- 2026-06-04: [#29] v1.0.5→v1.0.6 版本 bump 推送远端——版本 bump 至 v1.0.6（evidence：commit 729acc4 推送 origin/main）
- 2026-06-04: [#28] #49 本机 Docker 重部署 + 受控 live 冒烟净零——deployer 本机重部署（镜像 e3cfe75，V3 迁移）；主 Agent 独立核查 infra + 受控 live 冒烟全过（delete→{deleted,undo_id}→GET delete-history 列批次→undo-delete/5 {restored:1} 三列完整→404 路径→审计 delete_site/undo_delete_site）；顺带用 F17 恢复点 34 把#49开发期丢失的1条测试 site 捞回（本机 119 条）；net-zero 归位（evidence：Docker 本机部署 2026-06-04，commit 8518b9d）
- 2026-06-04: [#27] #49 Phase 9 全流程完成入库——后端：新表 site_delete_undo（序列批次+undone字段）+DELETE 改单条 CTE（DELETE...RETURNING 喂 undo 插入，原子无竞态，去 create_restore_point，环形200，evict try/except容错）+GET /api/delete-history+POST /api/undo-delete/{id}（404/ON CONFLICT/undone/restored=1/requested=1）+V3 迁移；前端：Toolbar 「删除历史」按钮+DeleteHistoryPanel（仿恢复点对话框）+load 容错；测试：49 passed；流程：CCB coder 编码→主 Agent 独立验收→reviewer(codex) 两阶段（高=evict失败连累删除，中=capture/DELETE并发串批）→coder 修复（evict try/except+审计前置，DELETE RETURNING单CTE消竞态，面板catch，补测试）→主 Agent 独立复核 49 passed→reviewer 复审可入库→commit（evidence：commit 8518b9d）
- 2026-06-04: [#25] v1.0.5 版本 bump + 推送远端 + ARM64 离线包发布——版本 v1.0.4→v1.0.5（deploy/config/release.conf + web/package.json）；7 个 commit 推送 origin/main 对齐（a502d93/cacd835/ec49328/42a1cea/7a51f59/e1705fa/7066539）；deployer 出 ARM64 方案B 离线包：presurvey-api-v1.0.5-20260604-152609-arm64.tar(68M)、presurvey-web-v1.0.5-20260604-152609-arm64.tar(22M)、server-deploy-api-v1.0.5.sh、server-deploy-web-v1.0.5.sh、V2__add_pre_feature_delete_reason.sql，发布至 /var/www/dl/ + img.mangosv5.app；主 Agent 独立核查通过（arm64 api 镜像含#48新码 docker cp diff==工作树排除缓存复用旧码嫌疑、镜像 arch=arm64、5条下载链接 HEAD200、api脚本含 --network-alias api+幂等 reason CHECK 迁移 pre_feature_delete、bash -n 通过）（evidence：commit 7066539）
- 2026-06-04: [#21] #48 四步走收尾全部完成——③测试完整性：reviewer(codex) 作独立测试方写 api/tests/test_site_crud_48.py（15用例，handler直调+monkeypatch范式，delete调用序列[tx_enter→restore_point→delete→tx_exit]硬断言锁死，关键断言反向验证防伪覆盖）；主 Agent 独立复跑全量 tests/ 45 passed（含#46/#47）无回归（evidence：commit 7a51f59）；④功能测试：deployer 完整重部署本机 Docker（api镜像13af.../web镜像9bd2...，V2 reason CHECK迁移生效，network-alias api在，119条数据未丢）；主 Agent 独立核查 infra（别名/镜像时间戳/迁移/三端点真注册/web反代）+ 受控自愈 live 冒烟全过（PATCH改site_status+坐标→geom重算→还原；delete 1条 119→118→恢复点回滚→119，三列Globe/存量/Macro完整找回；selection_ids导出合法KMZ；审计edit_site/delete_site/export_region/restore_point_rollback全落库）；数据净零归位119条（evidence：commit 7a51f59 + Docker 本机部署 2026-06-04）
- 2026-06-04: [#24] #48 Phase 8 列宽可拖拽调整完成入库——列宽拖拽手柄(min48px/rAF/stopPropagation)，手动列固定宽退出 #31 等比、未拖列仍等比，双击还原自动，localStorage 持久化(key presurvey.lfl.col.{kind}.{colKey})；顺带修 Phase 7 三低：rebindSelected(编辑/删除后按 id 重绑，找不到置 null)、表头 indeterminate 三态、坐标前端范围校验；reviewer 判可入库，遗留 2 低 backlog（列宽拖动 unmount 未移除 document listeners / rebindSelected 仅 edit/delete 路径）（evidence：commit 42a1cea）
- 2026-06-04: [#23] #48 Phase 7 前端列表框 site 增删改+勾选导出完成入库——LayerFeatureList 行前多选 checkbox+表头全选+操作列[编辑]+批量条[删除/导出]，全 isSite 门控(road/lessor 纯只读)；SiteEditModal 改 project/site_status/lati/longi(主键+盖戳只读)；api.ts updateSite/deleteSites/exportSelectionIds；state.ts doUpdateSite/doDeleteSites/doExportSelectionIds 成功后 refresh() 同步地图+树；en/zh 双语；reviewer 判可入库，遗留 3 低（evidence：commit ec49328）
- 2026-06-04: [#19] #48 前端 LayerFeatureList 改造全部完成（Phase 7 + Phase 8，覆盖 checkbox 多选/行内编辑/批量删除/勾选子集导出 KMZ/列宽可拖拽存 localStorage）（evidence：commits ec49328 + 42a1cea）
- 2026-06-04: [#18] #48 Phase 6 后端接口全部完成并入库——PATCH /api/sites（改业务属性+坐标重算 geom，key 走 body，Pydantic 校验坐标范围，拒改盖戳/主键，单条 UPDATE...RETURNING 原子寻址）、POST /api/sites/delete（批量删，同事务先建 pre_feature_delete 恢复点再删，审计 delete_site）、POST /api/export/selection_ids（按主键子集导 KMZ，复用 _build_kmz_meta region，审计 export_region mode=list）；reason CHECK 三处对齐（init.sql/migrate.sh/V2迁移）（evidence：commit cacd835）
- 2026-06-04: [#20] #48 审计联动完成：edit_site / delete_site 两类事件已随 Phase 6 后端代码实现（evidence：commit cacd835）
- 2026-06-04: [#22] #48 需求文档层完成：Product-Spec.md + Product-Spec-CHANGELOG.md 已更新；代码尚未实现（evidence：Product-Spec.md / Product-Spec-CHANGELOG.md / commit a502d93）
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
- Risk：#48 坐标编辑触发 PostGIS geom 重算，若经纬度输入异常可能导致 geom 字段损坏（Mitigation：Pydantic 坐标校验已实现 + pytest 15用例覆盖 geom重算/坐标校验边界 + live冒烟已验证；已关闭 2026-06-04）
- Risk：#48 删除走恢复点回滚链路，回滚后 site 数据完整性需验证（Mitigation：live冒烟验证回滚 119→118→119 + 三列Globe/存量/Macro完整找回；已关闭 2026-06-04）
- Risk：#48 三 Phase 编码+审查入库但四步走测试/功能测试未执行（Mitigation：[#21] 已完成，45 passed + live冒烟全过；已关闭 2026-06-04）
- Assumption：当前内网+腾讯云 beta 部署，底图走未授权 tile 临时方案；公有云商用需替换 Google Maps API Key（Confidence：High）
- Assumption：v1.0.6 离线包 api 脚本已内置 V2+V3 幂等迁移，内网服务器从 v1.0.4 直升 v1.0.6 可安全执行（Confidence：High）

## Notes（简要要点）
- 2026-08-18: review 发现的重复犯错模式——TRUNCATE reset 清单连续漏新表（V3 site_delete_undo、V4 RBAC 4 表），根因=清单硬编码；长期解法候选：information_schema 动态枚举或建表登记（记 feedback 或留 Notes 供进化引擎扫描）
- 2026-08-18: 用户反馈「模块化分包」已记录 feedback（.opencode/feedback/feature-modular-package-structure.md）——#50 新代码落地为 api/auth/ + api/admin/ + web/src/components/admin/ 包结构；存量老文件平铺整体重构记 backlog（TODO #35）
- 2026-08-18: #50 review 接受项留痕——登录锁定 IP 键可被 XFF 轮换绕过（符合 Spec「内网够用即止」威胁模型，已记 DEV-PLAN）；export-only 角色列表框无法勾选（多选列绑 edit_delete，spec 字面如此，框选导出可用）
- 2026-08-18: fast-mode 120h 已开（用户拍板全速开发，到期自动失效）
- 2026-08-18: deployer 遗留 backlog——deploy.sh `_cloud_reset_db` TRUNCATE 清单未含 RBAC 4 表；deploy/README.md 有 V2 时代陈旧描述（已立 TODO #36）
- 2026-08-17: 本机跑测试的固化方式 = python:3.12-slim 容器 + 清华源 + trusted-host（企业 MITM 代理导致 GitHub/pypi 官方源 SSL/超时不可用；系统 Python 3.14 无法装 pin 依赖）
- 2026-08-17: 本机 WSL 部署痛点——api 镜像 pip 需清华源 build-arg（compose 未配 build.args）；镜像 tag=latest 不带版本号是 compose 现状
- 2026-06-04: progress.md 由初始化扫描（Product-Spec.md + CHANGELOG）建立，后续由 progress-recorder agent 维护
- 2026-06-04: 修复悬空引用——progress-recorder agent 原缺 skills 字段且未登记调度表，本次补全闭环
- 2026-06-04: mark-review-needed hook 只按文件扩展名匹配、不看路径，/tmp 下 .sh 临时脚本误触发了 stop-gate review 闸门；是 TODO #4（纸面纪律 vs hook 覆盖）的活样本，#4 落地时应给该 hook 加路径过滤
- 2026-06-04: #48 需求来源——用户要求在 LayerFeatureList（点图层右侧眼睛弹出浮动列表框）给 site 节点加删除/编辑功能；追加要求列宽可拖拽调整（类 Excel）；road/lessor 本期仍只读
- 2026-06-04: #48 Phase 6 开发流程——CCB coder 编码 → 主 Agent 独立验收（import+路由+坐标校验实测）→ reviewer(codex) 两阶段审查（挑 2 中 2 低）→ coder 修复（PATCH 改 body 传 key / Pydantic 坐标校验 / 消 SELECT+UPDATE 竞态）→ 主 Agent 独立复核 → reviewer 复审「可入库」→ commit
- 2026-06-04: #48 Phase 8 reviewer 遗留 2 低（backlog，未阻断入库）：① 列宽拖动 unmount 未移除 document listeners（与现有 #30/#43 同款技术债）；② rebindSelected 仅覆盖 edit/delete 路径（其他更新路径尚未复用）
- 2026-06-04: #48 Phase 7 reviewer 遗留 3 低（未阻断入库）；三低已随 Phase 8 修复（rebindSelected/表头 indeterminate/坐标前端校验）
- 2026-06-04: #48 Phase 6 reviewer 低风险残留备注（未阻断入库）：lati/longi 显式传 null 会被接受走 COALESCE 不改值但记 changed field，后续可收紧校验逻辑
- 2026-06-04: #48 四步走全部完成，5个commit入库（a502d93/cacd835/ec49328/42a1cea/7a51f59），本机 Docker 已上新版，http://localhost:5173 可访问
- 2026-06-04: #48 收尾测试范式——handler直调+monkeypatch（不启动真实 HTTP server），delete 调用序列硬断言（防测试伪过），关键断言含反向验证
- 2026-06-04: v1.0.5 内网离线包发布至 img.mangosv5.app；#48 vs v1.0.4 关键差异：api 部署脚本内置幂等 reason CHECK 迁移（老库 CHECK 不含 pre_feature_delete 会拒绝 delete 建点），脚本 step4 自动执行；内网服务器实际部署（curl取包→换api含迁移→换web→冒烟）由用户在跳板机 Claude Code 执行，本次未完成，待用户操作
- 2026-06-04: #49 根因——#48 delete 复用 F17 全表快照，3W节点删1个仍复制整表（O(全表)）；#49 改 site_delete_undo 只存被删行（O(删除数)），DELETE...RETURNING 单 CTE 原子喂 undo 表，消竞态
- 2026-06-04: #49 v1.0.6 离线包关键：api 脚本按序幂等执行 V2（reason CHECK）+V3（site_delete_undo 建表），兼容目标机停在 v1.0.4（跨2个版本升级可安全执行）
- 2026-06-04: #49 状态——公网本机 Docker 已 v1.0.6，commit 729acc4 推送 origin/main；ARM 离线包发布待内网取用（一条龙提示词已给用户）；backlog #26 残留（列宽 unmount listener / rebindSelected 全路径）

## Context Index（轻量索引）
- Spec：./Product-Spec.md · Changelog：./Product-Spec-CHANGELOG.md · Plan：./DEV-PLAN.md
- 框架配置库：github.com/zylimit/sitemaster-config
- Archive：./progress.archive.md（暂未创建）
