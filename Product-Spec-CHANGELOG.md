# Product Spec CHANGELOG

> 需求变更记录

---

## 2026-06-04 (#49)

### 删除回滚改轻量「撤销删除」（取代 #48 全表快照）

**类型**：重度变更（删除的回滚机制重构；新增 `site_delete_undo` 表 + undo 端点 + 改 delete 实现，前端删除提示改可点撤销；触碰 api/db/web，需重打镜像）。

**触发**：用户指出 #48 的批量删除"纳入恢复点"复用了 F17 全表快照——**3W 节点时删 1 个节点要复制整张表（O(全表)）**，环形保留 10 个点最坏堆 30W 行快照，效率太低。

**根因**：F17 `create_restore_point`（restore_point_helper.py:35-76）是 `INSERT INTO site_snapshot SELECT * FROM site` 全表快照，给导入/清库这类"动大量数据"设计；#48 拿它给"删几个节点"用，杀鸡用牛刀，且 F17 回滚是 `TRUNCATE 全表 + 重灌`，天生全量、无法局部。

**变更**：
- **删除不再建 F17 恢复点**：改为事务内**只把被删的那几行**捕获进新表 `site_delete_undo`（O(删除数)，与库规模无关）→ 再 DELETE。
- **新表 `site_delete_undo`**：镜像 site 列 + `undo_id`（批次）+ `deleted_at`；环形保留**最近 200 个删除批次**（每批只几行，占用极小）。
- **新端点 `GET /api/sites/delete-history`**：列最近删除批次给面板（undo_id/时间/条数/图层/站点名摘要/undone，倒序）。
- **新端点 `POST /api/sites/undo-delete/{undo_id}`**：把该批次行再插回 site；主键已被重新占用则 `ON CONFLICT DO NOTHING` 跳过；该批次标记 `undone`；返回实际恢复数。
- **delete 返回 `{deleted, undo_id}`**（原为 `{deleted, restore_point_id}`）。
- **前端 = 持久「删除历史」面板**（非瞬时 toast）：**工具栏新增 [🗑️ 删除历史] 按钮**（与 [🕘 恢复点] 并列）打开面板，列最近 200 批（时间·删N条·图层·站点名摘要），每批 [撤销]；撤销后标记已撤销移出。删除成功提示仍提示"可在删除历史撤销"。`site_delete_undo` 加 `undone` 标记列。
- **审计**：新增 `undo_delete_site`（F19 14→15 类）；`delete_site` details 记 `undo_id`（原记 restore_point_id）。
- **`pre_feature_delete` 恢复点 reason 弃用**：留在 CHECK 无害（内网已部署，不回退），但删除不再产生该 reason 的点。

**决策（用户拍板）**：回滚机制=轻量「撤销删除」只存被删几条（非软删、非硬删无 undo）；保留=最近 **200 个删除批次**（用户从 10→30→20→最终 200）。

**冲突检测**：
- **vs #48 测试**：`test_site_crud_48.py` 的 delete 测试断言了 `create_restore_point 在 DELETE 前` 的调用序列——#49 删除不再建恢复点，该断言要重写为「捕获 undo 在 DELETE 前、同事务」+ 新增 undo 端点测试。
- **vs F17**：F17 恢复点体系（导入/清库/手动）**不动**，仅删除从中解耦。
- **vs 已部署 v1.0.5**：内网若已部署 v1.0.5（含 pre_feature_delete CHECK），#49 升级需加 `site_delete_undo` 建表迁移；CHECK 不回退。

**Spec 改动**：「批量删除」节改轻量撤销 + 新表 + undo 端点 + 后端接口/审计同步；F20 表格条、#48 摘要条、F17 restore_point reason（标弃用）、F19 审计 14→15 类 同步。

---

## 2026-06-04 (#48)

### 图层要素列表（site）增删改 + 勾选导出 + 列宽可调

**类型**：重度变更（「查看图层要素」列表框由只读升级为可操作；新增 site 单条 update / 批量 delete 后端接口 + 恢复点联动 + 审计两类，需重打 web + api 镜像）。

**触发**：用户要求在「图层节点右边眼睛点开的列表框」里给每个节点加删除、编辑功能；追加要求列宽可拖拽调整（类 Excel）。兑现 Spec 原有「本版只读……编辑能力是下一步独立需求」的占位。

**决策（AskUserQuestion 四问拍板）**：
- **编辑范围 = 业务属性 + 坐标**：可改 PROJECT/SITE STATUS 等业务字段 + LATI/LONGI（后端重算 geom）；**锁死** SITE ID/OPTION（主键）+ OPERATOR/CATEGORY/TYPE（盖戳三列，本期不开跨层移动）。
- **删除语义 = 纳入恢复点可回滚**：删除前自动建 `pre_feature_delete` 恢复点（复用 F17），删错可整体回滚。
- **操作粒度**：行前加 **checkbox 多选**；**编辑一次一行**；**删除支持勾选批量**；勾选子集还可**导出 KMZ**。
- **图层范围 = 本期仅 site**；road/lessor 仍只读，待 site 验证后复制。
- **列宽可调（追加）**：拖表头列分隔线手动调列宽（类 Excel），手动宽存 localStorage、不再参与 #31 等比拉伸；双击分隔线自适应；三个 kind 通用（与增删改正交）。

**变更**：
- **前端（LayerFeatureList）**：行前多选列 + 表头全选/反选；site 行 [✏️ 编辑]（弹表单，业务属性 + 坐标可改、主键/盖戳置灰）；[🗑️ 删除选中]（确认 modal → 批量删）；[💾 导出选中]（勾选子集导 KMZ，NP 圈照 #46 随点出）；表头列宽拖拽手柄 + localStorage 持久化 + 双击自适应。
- **后端（api，site）**：`PATCH /api/sites/{site_id}/{option}`（更新业务属性 + 坐标重算 geom；拒改盖戳）；`POST /api/sites/delete`（批量，先建 pre_feature_delete 恢复点再事务删）；勾选导出按主键子集走导出链路（现有 export_selection 仅吃 polygon → 加按 id 列表导出通道）。
- **恢复点**：新增 `reason=pre_feature_delete`；批量删一次 = 一个恢复点。
- **审计**：新增 `edit_site` / `delete_site`（F19 由 12 类 → 14 类）；勾选导出复用 export_region（mode=list）或新增 export_selection_ids。

**冲突检测**：
- **vs #31（列宽等比拉伸）**：手动列宽与自动等比**混排共存**——拖过的列固定、没拖的列继续等比；非替换关系，已在 Spec 写明交互。
- **vs 盖戳模型（F20 #24）**：编辑锁死 operator/category/type，不破坏"要素归属由盖戳定"的强类型前提；新建仍只能走导入（保留护栏 + 去重）。
- **vs F17 快照列清单（#43 教训）**：site 表无新增列（仅改值/删行），不触发"快照三处显式列清单要同步"的坑；但删除走恢复点链路，回滚 SQL 复用现有 site_snapshot 重灌，需回归验证回滚后 site 数据完整。

**Spec 改动**：「查看图层要素」节只读条改为指向 #48 + 新增「要素增删改与勾选导出（site · V1.x #48）」子节（含列宽可调）；F20 表格 [查看图层要素] 描述更新；F19 审计 12→14 类；F17 restore_point reason 加 pre_feature_delete。

**待办（进入 dev-planner / dev-builder）**：本条仅完成 Spec + CHANGELOG；后端三接口、前端列表框改造、恢复点/审计联动、回归测试（含回滚验证）尚未实现。

---

## 2026-06-03 (#47)

### 框选导出 KMZ 支持圆形选区

**类型**：中度变更（现有 F9 框选加一种选区模式；前端为主，后端零改动）

**触发**：用户要求框选导出支持圆形选区（现有 F9 只有自由多边形/矩形）。

**变更**：
- **新增圆形框选**：工具栏 [框选 ▾] 下拉增 [圆形]；交互 = **点圆心拖半径**（OpenLayers `Draw` Circle 类型，松手完成），与矩形「按住拖拽」体验一致。
- **复用现有通道（后端零改动）**：圆画完用 OL `fromCircle` 转为**近似圆多边形**（≥64 段），仍发 GeoJSONPolygon → 后端现有 `ST_Contains` 严格包含过滤。与多边形/矩形语义完全一致，**不改 api/db**。
- **审计衔接**：`export_region` 的 `mode` 由 `"polygon" | "rect"` 扩为加 `"circle"`。
- **前端类型**：`DrawMode` 由 `"polygon" | "rectangle"` 增 `"circle"`。

**决策（用户拍板）**：后端实现 = 近似多边形走现有 ST_Contains 通道（非 center+radius ST_DWithin，避免后端分叉，复用矩形已验证的多边形选区路径）；交互 = 点圆心拖半径。

**冲突检测**：无功能冲突。圆形**选区** ≠ NP **辐射圈**（#45/#46，后者是显示用、Spec 已写明"不是选区"），两者独立。唯一衔接点 = 审计 mode 扩值。

**Spec 改动**：F9 条加圆形 + 实现说明；UI 工具栏 [框选 ▾] 下拉、L2 交互层、派工流程步骤、审计 export_region mode 四处同步。

---

## 2026-06-03 (#46)

### NP 范围圈导出 KMZ + 默认半径 50m→200m

**类型**：中度变更（扩展现有 KMZ 导出 + 导入器加忽略规则 + 默认值调整；触碰导出/导入器，需重打 web + api 镜像）

**触发**：一线 PM 提需求——派工 KMZ 发给勘测员后，对方在 Google Earth 只能看到 NP 点、看不到辐射覆盖范围；要求把 NP 范围圈也一并导出。顺带把默认半径从 50m 提到 200m。

**变更**：
- **默认半径 50m → 200m**：下拉选项不变（50/100/150/200/250），默认值改 200m；`localStorage` 无值/非法值回落值同步改 200m。
- **导出范围圈**：框选/整库导出 KMZ 时，为纳入范围的每个 Macro NP / Micro NP 点，按**导出时 `localStorage` 当前半径**（所见即所得，不再弹选项）生成近似圆多边形。
- **以点为基准**：框住哪些 NP 点就导出哪些圈；整库导出则全部 NP 点带圈。非 NP 站型不画不导。
- **样式**：紫 `#a855f7` 半透明填充（与屏幕 #44 规划类一致）+ 紫描边；KMZ 新增内置 Style `poly-np-ring`。
- **独立 Folder 装载**：圈统一装入独立 KML Folder `np-radius-rings`（显示名「NP 范围圈」），不挂 `#site/#road/#lessor` schema；每圈带 `<ExtendedData>` `ring_of`（来源 SITE ID+OPTION）+ `ring_radius_m`。
- **只出不进**：导入器遇 `np-radius-rings` Folder 或带 `ring_of` 标记的 Polygon → **整体跳过**（不入库/不去重/不计冲突），**优先于** schema 缺失 Polygon→lessor 兜底，防止圈被误当租户面灌库。

**决策（用户拍板）**：半径=导出时当前选中值（所见即所得）；样式=实心半透明面、跟屏幕 NP 一致；契约=只导出不导入、硬导入忽略；范围=以点为基准框住即导。

**审查 & 修复（CCB reviewer=codex 两轮）**：
- a06d097 首审：Stage1/Stage2 通过；提 3 个 LOW。
- 10d7856 修复并复审通过：(1) `_np_ring_placemark` 加 `math.isfinite` + 经纬度范围守卫，防 nan/inf/越界产出垃圾圈；(2) 导出半径改以 App 内存 `npRadiusM` state 为单一真源（`doExportAll/doExportSelection` 接参，不再导出时读 localStorage，localStorage 仅持久化+初值），杜绝写失败时"所见≠所得"；(3) 清理 utils.ts 注释 50m 漂移。
- **已知残留（评估后接受，WONTFIX）**：① 圈点在 lat=±90/lng=±180 边界附近理论上溢出 ±90/±180；② 极区 `cos(lat)` 近 0 时 dlng 失真。二者均因部署区固定菲律宾（~5–21°N）、真实勘测站点不可达极点/日期变更线而无现实影响，不引入测地线/经度 wrap。③ 重导入后 site `type` 不随 KML 回灌→再导出不重绘圈，属契约边界外（契约只约束 Site/Road/Lessor 三类实体等价）。

**Spec 改动**：「NP 辐射圈」节默认值 50→200（含 F20 表格条、要素样式条、localStorage 回落值 4 处）；新增「NP 范围圈导出 KMZ（#46）」子节；KML/KMZ 处理节新增范围圈导出条 + schema 兜底例外条；**自反一致性契约新增 #46 边界补丁**（契约只约束 Site/Road/Lessor 三类实体，NP 范围圈纯装饰、导出携带导入忽略、不破坏契约）。

---

## 2026-06-03 (#45)

### NP 辐射圈半径可配（50/100/150/200/250m）

**类型**：中度变更（现有功能逻辑调整 + 新增配置入口；纯前端，不动 api/db）

**触发**：一线 PM 要求规划 NP 站点的辐射圈半径不再写死 50m，可按需放大。

**变更**：
- **修改**：`utils.RADIATION_RADIUS_M` 由固定常量 `50`（原注释"固定不可配"）改为可变半径，地图渲染（MapView NP 圈）读运行时值，改值后所有 NP 圈实时刷新。
- **新增**：**顶部工具栏**新增 NP 半径下拉（全局唯一入口），选项 50/100/150/200/250 米，默认 50m。
- **全局统一**：单一值作用于三运营商（Globe/Smart/Dito）的 Macro NP + Micro NP 全部 NP 圈；改任一处全部同步。
- **持久化**：仅前端 `localStorage`（key: `presurvey.np_radius_m`），刷新记得住；无值/非法值回落 50m。**不入库、不改 api/db、无需重部署后端**（仅重打 web 镜像）。

**决策（AskUserQuestion）**：粒度=全局统一一个值；入口=**顶部工具栏**（用户修正：纯显示偏好 + 不入库 + 全局一个值，挂图层树站点/节点别扭且重复，放工具栏最合理）；持久化=仅前端 localStorage（放弃后端存，省 api/db 改动 + 重部署）。

**Spec 改动**：「NP 辐射圈（规划类专属）」章节由"50m 固定不可配"改写为"半径可配 + 配置入口 + localStorage"；F20 表格条、要素样式条、树结构图、#44 渲染条 4 处"50m"措辞同步软化为"可配/默认 50m"。

---

## 2026-06-03 (#44 收尾 + nginx)

### 存量/规划图层去展开箭头 + 0要素checkbox禁用 + nginx缓存根治

**类型**：收尾 fix（#44 连带 + 部署体验）

- **存量/规划图层去箭头**：#44 后存量/规划 site 图层无样式子节点（叶子）→ LayerRow 加 `hasChildren`（site 图层=`cat==="勘测"`、road/lessor=true）；无子用 `leaf-spacer` 占位（无 chevron 不可展开），勘测 + Road/Lessor 仍可展开。
- **0 要素节点 checkbox 禁用**：`triOf([])` 返回 all → 0 要素节点显绿勾但 `toggleIds([])` 空操作（点不动、误导）→ `ids.length===0` 时 checkbox `disabled` 置灰（CB/StyleRow + CSS `:disabled` not-allowed）。
- **nginx 缓存根治**：`web/nginx.conf` 加 `index.html` `no-cache` + 带 hash 的 assets `immutable` 长缓存 → 发版后普通浏览器刷新即见新版，**不再要无痕**。

**Spec 改动**：CHANGELOG 记录；实现细节修（#44/#36 连带），Spec 主体不变。

---

## 2026-06-03 (#44)

### 样式仅勘测显示 + 存量橙/规划紫图层色 + Macro NP/Micro NP 半透明 55%

**类型**：重度变更（渲染策略 + 树结构，来自一线 PM；本质是"做减法"——不做自定义样式 UI，硬编码交差）

**触发**：PM 要求 status 状态分色只在勘测图层用；存量/规划改图层默认色。

**变更**：
- **样式节点仅勘测显示**：仅 Survey（勘测）的 Macro-ongoing/Micro-ongoing 图层下渲染 🎨 样式节点（positive/negative/undermine + Other）；存量(Existing)、规划(Planned)全部图层 → 树上无样式子节点。
- **数据不动、纯前端开关**：site_status 照存、siteMap 照归类（statusBucket→other 不变），只 LayerTree 渲染加 `&& cat==="勘测"`、MapView 颜色按 category 分叉。**恢复 = 去条件，零成本**（防 PM 反悔）。
- **图层默认色（按类别 2 色）**：存量 = 橙 `#f97316`（实心 ▲●■）、规划 = 紫 `#a855f7`（△○）。避开状态绿/红/黄、road 棕、#34 选中蓝。形状仍 siteShape(type)，勘测仍 × status 色。
- **规划 NP 半透明 55%**：Macro NP/Micro NP 原空心 → 紫色半透明填充 `withAlpha(紫, 0.55)` + 紫描边，卫星底图显眼；50m 辐射圈跟随变紫、逻辑不变。
- **Road/Lessor 不动**；不做自定义样式 UI（硬编码 LAYER_COLOR）。

**决策（AskUserQuestion）**：配色=按类别 2 色（存量橙/规划紫）；透明度=半透明填充 55%；Road/Lessor 不动。配色经 WebSearch（ColorBrewer 定性 + 卫星底图避绿避蓝）。

**Spec 改动**：#33 样式骨架条加显示范围收窄；Phase5 渲染条加 category 分叉 + 半透明。

---

## 2026-06-03 (#43 + 导入框 fix)

### 列表框八方向拉伸 #43 + 导入框 commit 关框时机/防重入/眼睛位置修复

**类型**：1 需求增强（#43）+ 1 bug 修复（内网首版后手验）

**#43 列表框浮窗八方向拉伸**：#30 的浮窗 resize 从「仅右下角」扩成**四边 + 四角八方向**。`onResizePointerDown(dir)` 按 e/w/n/s 组合算 size+pos，**含 w/n 的方向同步改 left/top**（锚点在对侧，防窗口反向跳）；8 个 handle 贴边/角 + 对应光标；clamp（MIN 480×320 / 视口−32）、rAF 节流、localStorage 持久化复用 #30。

**导入框 fix（#39/#40 缺陷修正）**：
- **commit 成功立即关框**：原 `await commit → await refresh()(重载 13300 条慢) → finally 关框`，框在 refresh 期间还挂着 → 用户以为失败再点 commit → 二次提交 sid 已消费 → **404**。改为 commit 成功 `closeFrame()` 立即关框 +「导入成功」，`refresh()` 移到关框后 `if(ok)` 后台跑（带 try/catch）。
- **同步防重入**：`committingRef`（入口 return + finally 清），补 React `busy` 异步 setState 空窗，狂点不二次提交。
- **后端友好返回**：二次 commit（session 已消费）返回明确提示，非裸 404。
- **样式节点眼睛紧跟节点**：#40 的 [查看] 原被 `.style-label{flex:1}` 推到右框 → 改 `flex:0 1 auto` + `.style-row .folder-count{margin-left:auto}`，眼睛紧跟 label（与图层节点一致）。

**Spec 改动**：#30「可缩放」条改八方向。

---

## 2026-06-02 (#42)

### 定时自动备份（独立于 F17 恢复点）

**类型**：重度变更（新增后台功能模块 + 隐藏恢复入口）

**触发**：内网上线后用户要"后台按时间自动备份，和恢复点分开"。

**变更**：
- **自动备份**：每 **12 小时**一次，后端定时调度（api 进程内 APScheduler / asyncio 定时，随 api 部署）。**复用 F17 snapshot 机制**（site→site_snapshot 等全表镜像），写 restore_point 标 `reason='auto_backup'` 区分。
- **保留 30 天**：滚动清理（删 30 天前的 auto_backup 恢复点 + 其 snapshot，约 60 个备份周期）。
- **与 F17 恢复点分开**：F17 是操作级手动/自动恢复点（pre_import 等），本功能是时间驱动全库备份；**独立定时、独立恢复入口、独立列表、独立保留策略**，靠 reason 区分。
- **恢复入口（隐藏）**：**连按 3 次 `B`**（B=Backup，与 F19 审计的 3×ESC 区分）→ 弹密码框 → 输入 `mangosv5`（写死，同 F19 密码）→ 备份恢复 Modal（按时间倒序列出备份 → 选一个 → 还原全库）。
- 还原前自动建一个 pre_rollback 恢复点（防误还原可再退回）。

**决策（AskUserQuestion）**：备份形式=复用 snapshot 机制（稳、复用 F17 helper、服务器 18.09 友好）；快捷键=连按 3×B。

**Spec 改动**：F 功能表加 F21；新增「定时自动备份（F21 · V1.x #42）」节。

---

## 2026-06-02 (#41)

### Other 节点（收纳非标准 site_status，修"其他状态值在树消失"）

**类型**：中度变更（修 bug + 树节点补全）

**触发**：用户要"非 positive/negative/undermine 的其他状态新增 Other 节点，方便隐藏灰色点"。

**根因（bug）**：#33/#37 后，site_status 非空、但非 pos/neg/und 的值（如 pending/hold）在 siteMap 有 key，但**没有任何 StyleRow 渲染** → 这些点在树里"消失"、不计入任何样式节点、无法勾选显隐。原 nullKey 只收空值。

**变更**：
- 新增 **Other 节点**（🎨 灰 ⚪，label「Other / 其他」），收纳所有 `site_status ∉ {positive,negative,undermine}` 的点（**空值 + 任何其他值**）。
- **有才显示**（该图层存在此类点时才挂，动态），灰色 `STATUS_COLOR[""]`。
- **可勾选显隐**（复选框，不勾地图上隐藏这批灰点）。
- 替代 #33 只收空值的 nullKey：siteMap 把非三标准 status 统一归到 Other 桶。

**Spec 改动**：「样式节点是固定骨架（#33）」节的灰色未分类条改为 Other 节点（涵盖范围扩到所有非三标准值）。

---

## 2026-06-02 (#40)

### 样式节点加 [查看]（按 site_status 筛选子集）

**类型**：中度变更（树节点功能扩展）

**触发**：用户要"图层下的样式子节点也带个眼睛，不带导入，相当于基于 Site Status 的筛选"。

**变更**：
- 🎨 StyleRow 加 **[查看] 眼睛按钮**（lucide Eye，复用 #32 图标 + #34 toggle），**不带导入按钮**。
- `ViewLayerTarget` 加可选 **`status` 字段**；StyleRow 的 [查看] 传 `{kind:'site', operator, category, type, status}`。
- LayerFeatureList 本层筛选：当 `target.status` 存在时，再按 `site_status` 收窄（与 siteMap 同口径，含 Other=非三标准）。
- 列表框标题路径带上状态（如 `Globe / 存量 / Macro / positive`）。

**Spec 改动**：「三种节点」表 🎨 行加 [查看]；「[查看图层要素]」节加样式节点查看 + status 筛选。

---

## 2026-06-02 (#39)

### 导入流程 UX 强化（提交态 + 屏蔽 ESC + 精确进度）

**类型**：中度变更（导入流程 UX + 后端进度上报，来自内网手验）

**触发**：用户报导入第二步提交后大量写库卡几十秒、按钮可重复点、进度只转圈不知道要等多久、以为失败；且担心 ESC 取消导入。

**变更（三项）**：

1. **提交态防呆**：ConflictDialog/CleaningDialog 确认按钮点击后 **disabled + loading**（"正在写入…"），**对话框不可关闭**直到完成；防重复提交（现状按钮无 disabled 可反复点）。state 的 `committing` phase 接进对话框控制按钮态。
2. **导入中屏蔽 ESC**：导入进行中（busy/committing）**暂停 `useEscTrigger`**（防 3×ESC 误弹 F19 审计干扰 / 防未来对话框 ESC 关闭中断导入）。
3. **精确百分比进度**：后端 `/api/import/{sid}/commit` 现状是**一次性大事务**写 13300 行（无分批无上报）→ 改为**单事务内分批写**（保原子性，全成功或全回滚）+ 每批把 `done/total` 写入 session（独立连接，不在事务内）；前端**轮询 `/api/import/{sid}/progress`** 显示 `写入 8000/13300 · 60%`，替代现在的 indeterminate 转圈。

**决策（AskUserQuestion）**：进度=精确百分比（后端分批+轮询），彻底消除"卡死感"。

**Spec 改动**：F11 / 导入向导 / 底部输出面板 加导入流程 UX 三项。

---

## 2026-06-02 (#38)

### 软件版本号 + 构建时间（底部状态条显示）

**类型**：中度变更（新增版本标识能力，来自内网部署后的运维痛点）

**触发**：内网首次部署上线后，用户提"软件要有版本号，不然更新不更新都不知道"。

**变更**：

- **底部输出面板折叠条右侧**（DB 状态圆点旁）显示 `v1.0.0 · 构建 2026-06-02 14:30`。
- **版本格式**：语义化 major.minor.patch，本次内网首发 **v1.0.0** 起步（修 bug→patch / 加功能→minor / 大重构→major）。
- **构建信息**：版本号 + 构建时间（构建时间变 = 新版已生效，直接解"不知道更没更"的痛点）。
- **单一真源**：`web/package.json` 的 `version`；构建时间由 Vite `define`（`__APP_VERSION__` / `__BUILD_TIME__`）构建时注入，不手填。
- **与部署打通**：版本号同时作镜像 tag / 部署包前缀（`update-deploy.sh <版本>`），界面=镜像=部署包三处一致。

**决策（AskUserQuestion）**：格式=语义化 v1.0.0；位置=底部状态条角落；带构建时间。

**Spec 改动**：「底部输出面板」节加「版本号显示（V1.x #38）」条。

---

## 2026-06-02 (#37)

### F20 收尾 · 站型图标改自绘 SVG + 修 site_status 大小写致样式计数全 0

**类型**：中度变更（1 视觉升级 + 1 数据匹配 bug，来自腾讯云手验）

**触发**：用户报 ① 图层站型图标（▲●■ Unicode 字符）"又丑又小"；② 图层下样式节点计数都是 0。

**两件事**：

1. **站型图标改自绘 SVG**（业界 GIS 实践，WebSearch 印证 QGIS 用 SVG 矢量符号）：
   - #29 的 Unicode 字符（▲●■△○◆◇）当图标受字体摆布、糊且小 → 改**自绘内联 SVG 几何符号**。
   - 形状语义**对照 `utils.TYPE_SHAPE` 单一真源**、与地图 RegularShape 一一对应；**实心=fill / 空心=stroke**（存量实心、规划空心）；统一 16px 灰（currentColor，hover/选中跟 color）。
   - 新建 `SiteShapeIcon` 组件，替换 LayerRow 的 `iconFor()` 文本。#29 字符方案作废（地图 RegularShape 不变）。
2. **site_status 大小写 bug（样式计数全 0 + 颜色退灰）**：
   - **根因**：源 site_status 首字母大写（`Negative`），后端 `_norm_site_status` 只处理 Unknown→undermine、**没统一小写** → 入库仍 `Negative`；前端按小写枚举 `[positive,negative,undermine]` 精确匹配 → 大写对不上 → 样式节点全 0、这些点在树里消失（status 非空也不进未分类）；地图/列表框查 `STATUS_COLOR[Negative]` 落空 → 退灰。
   - **修法**：后端 `_norm_site_status` 统一小写化（治本）；前端 `siteMap` 分组 + `utils.siteStatusColor` + LayerFeatureList site 状态列 加 `toLowerCase()` 兜底（兼容已入库大写历史数据，不必清库）。**仅 site_status；Lessor 的 Unfriendly/Normal（STATUS_COLOR 大写 key）绝不 toLowerCase。**

**决策（AskUserQuestion 拍板）**：站型图标 = 自绘 SVG 几何符号。

**⚠️ 部署**：含后端改动（imports.py），rebuild **api + web**。

**Spec 改动**：「完整树结构」加站型图标 SVG 条；`site_status 复用` 条加入库小写化说明。

---

## 2026-06-02 (#36)

### F20 收尾 · 树节点对齐重构（修叶子跑前面 + 图标统一 lucide 对齐）

**类型**：中度偏重变更（树行布局重构 + 图标族统一，来自腾讯云手验）

**触发**：用户报树缩进乱——① 叶子节点（🎨 样式）缩进跑到父节点前面、checkbox 对准父图标；② 要求每个节点图标（含 checkbox、文件夹）一样大、对齐、缩进规整。

**根因**：
- 🎨 样式行（StyleRow）JSX **缺展开符占位**——FolderRow/LayerRow 首列是 16px 展开符 `±`，StyleRow 直接 checkbox → 样式行整体左移约 `16+gap`，每级仅缩进 14px 补不回 → 叶子缩回对准父图标。
- 五种图标尺寸/基线各异：展开符字符 / 原生 checkbox / 📁 彩色 emoji（尺寸不可控）/ 站型字符 1.1em / 圆点 10px → 列对不齐。

**变更（树行布局重构）**：
- **统一行结构**（各列 flex-shrink:0 固定宽）：`[缩进 paddingLeft=BASE+depth×INDENT] [展开符 16px] [checkbox 统一尺寸] [类型图标 16px居中] [label flex:1] [count]`。
- **展开符 → lucide** ChevronDown/ChevronRight；**StyleRow 补 16px 空占位**对齐。
- **文件夹 → lucide** Folder/FolderOpen（从 label 抽出 📁 emoji 到独立图标列），灰描线 16px。
- **类型图标列统一 16px 居中**：Folder=lucide / Layer=站型字符 / Style=圆点。
- **checkbox 统一尺寸**（固定 w/h + flex-shrink:0）三行一致；**缩进基准统一**（margin-left/box-sizing/paddingLeft 公式）。
- 全树图标灰描线，与 #29/#32 图标族统一。lucide-react 已装（#32），不加依赖。

**决策（AskUserQuestion 拍板）**：图标方案 = lucide 统一图标族（emoji 是"不一样大"主因）。

**Spec 改动**：「完整树结构」加「树节点对齐重构（V1.x #36）」条。

---

## 2026-06-02 (#35)

### F20 收尾 · xlsx 新模板兼容 + 文件夹节点显要素总数 + Legacy→Existing

**类型**：中度变更（1 后端解析兼容 + 2 前端，来自腾讯云手验）

**三件事**：

1. **xlsx 新模板解析兼容（bug → 兼容增强）**：新模板 `1234.xlsx` 解析报 `ParseError: 必填字段 SITE ID 找不到`。
   - **根因**：解析器 `api/parsers/xlsx.py` 写死"第 1 行分类横幅（跳过）+ 第 2 行字段名"。旧模板 `Sample Data.xlsx` 表头在第 2 行；**新模板表头直接在第 1 行（无横幅）+ 多了 OPERATOR/SITE CATEGORY/SITE TYPE 盖戳列**，解析器把真表头当横幅跳过、把数据行当表头 → 找不到 SITE ID。
   - **修法**：改为**自动探测表头行**——扫描前若干行（如前 5 行），定位第一个含精确 `SITE ID` 的行作表头，其下为数据。旧模板落第 2 行、新模板落第 1 行都能认。`SITE CATEGORY` 加入 `_CORE` 排除集（盖戳列源值按 F20 忽略，不进 extras）。
2. **运营商/类别节点显示子树要素总数**：📁 运营商（Globe/Smart/Dito）、📁 类别（存量/规划/勘测）节点目前无数字 → 右侧补"子树下所有叶子要素总数"（口径 = `siteMap.get(key).length`，与图层🔺/样式🎨节点计数同源）。强调是**叶子要素计数，不是直接子节点个数**。🔺图层、🎨样式节点已有计数不变。
3. **Legacy → Existing**：存量类别英文文案 `i18n.ts` `lt.tree.cat.legacy` 由 `Legacy` 改 `Existing`（中文"存量"不变）。

**决策（AskUserQuestion 拍板）**：加数范围 = 运营商 + 类别都加。

**⚠️ 部署注意**：本次含**后端改动**（xlsx.py），部署要 rebuild **api**（不只 web）。

**Spec 改动**：F2 加表头自动探测；三种节点表 📁 文件夹行加子树要素总数 + Legacy→Existing 文案条。

---

## 2026-06-02 (#34)

### F20 优化 · 选中态独立蓝色（避绿撞色）+ 眼睛按钮 toggle 开关

**类型**：中度变更（两个易用性优化，来自腾讯云手验）

**触发**：用户提两条优化：① 选中节点高亮是绿色（`--accent` emerald），和 positive 绿要素撞色，要换独立显眼色；② 图层 [查看图层要素] 眼睛按钮，点同一节点再点应能关闭列表框（toggle），提升易用性。

**变更**：

1. **选中态独立蓝色（`--selected: #3b82f6`）**：根因——`--accent: #10b981`(emerald 绿) 同时被"选中态"和全局主题（按钮 hover/复选框/focus）用，绿选中撞 positive 绿。修法是**引入独立选中色变量、只换选中态**，不动全局 accent：
   - theme.css 新增 `--selected`(:root 主题无关) + `--selected-bg`(淡蓝垫底，暗 rgba/亮 blue-50) + `--selected-glow`(蓝辉光/亮 none)；`--feat-selected-stroke` 由 `var(--accent)` 改指 `var(--selected)`。
   - styles.css 选中态四处换 selected 系：`.node.selected` / `.layer-row.node-highlighted` / `.style-row.node-highlighted` / `.lfl-row.selected`（border-left/color/bg/glow）。
   - **三处统一**（同一 selectedId）：树高亮 / 地图选中描边（MapView 经 `cssVar("--feat-selected-stroke")` 自动跟，不改 .tsx）/ 列表框选中行。
   - hover 态的 `--accent-bg`、全局 `--accent` 一律不动。选中蓝避开全部状态色（绿/红/黄/棕）。
2. **眼睛按钮 toggle**：state.ts 新增 `sameTarget(a,b)`(比 kind/operator/category/type) + `toggleLayerFeatures(target, anchor)`（当前 viewLayer.target 与点击 target 相等→set null 关，否则 set 新→开/切）；App.tsx `onViewLayer` 由 `openLayerFeatures` 改接 `toggleLayerFeatures`。✖ 关闭按钮 / closeLayerFeatures 保留。不破坏 #30 切层行为（异 target 仍同窗口换内容）。

**决策（AskUserQuestion 拍板）**：选中色 = 蓝 #3b82f6；覆盖范围 = 树+地图+列表框统一。

**Spec 改动**：「完整树结构」加「选中态独立色（V1.x #34）」条；「浮动窗口交互」加「眼睛按钮 toggle 开关（V1.x #34）」条。

---

## 2026-06-02 (#33)

### F20 修正 · 样式节点固定骨架 + 撤销 #32 空层 leaf + 状态色红黄对调

**类型**：中度偏重变更（撤销刚做的 #32 改动1 + 改 STATUS_COLOR 单一真源 + 样式节点骨架化，来自腾讯云手验纠正）

**触发**：用户指出 #32 改动1（空层 disclose 显 leaf `−`）的设计前提是错的——图层下面**一定有节点（🎨 样式类目）**，不存在"空层无子"的情况。

**根因**：`StyleRow` 写了 `if (ids.length===0) return null`（空样式就隐藏），**违背 Spec 369 行"每个 Site 图层下固定挂 3 个状态样式节点"原意**。正因样式节点被错误隐藏、空层展开变空，#32 才打了"leaf 显 `−`"这个错误补丁。根因在样式节点没按 Spec 固定挂。

**变更（三件事）**：

1. **样式节点改固定骨架（不随计数消失）**：撤销 `StyleRow` 的 `ids.length===0 return null`。
   - Site：positive / negative / undermine 三节点**恒显示**（即使全 0，显示计数 0 + 复选框 + 色点）。
   - 灰色「未分类 ⚪」**例外**：catch-all，仅当存在空值/区配不上的点时才显（保 Spec 369 原口径）。
   - Road（棕线）、Lessor（Unfriendly 红 / Normal 黄）样式节点**一并固定显示**。
   - → 图层节点永远有子、永远可展开。
2. **撤销 #32 改动1（空层 leaf）**：图层永远可展开后 leaf 逻辑无意义，回退——disclose 恢复始终 `+`/`−` 可点；删 `lt.layer.empty` i18n、`.folder-disclose.leaf` CSS、`:not(.leaf):hover` 改回 `:hover`。**#32 其余三条（空层 [查看] 置灰 / 两按钮图标化）保留不变。**
3. **状态色红黄对调**：`utils.STATUS_COLOR` 单一真源——negative `#ffb300`(黄)→`#f44336`(红)、undermine `#f44336`(红)→`#ffb300`(黄)。仅这两行（Lessor 的 Unfriendly红/Normal黄 不动）。地图/列表框/树三处自动跟。**不动数据库**（site_status 存储值不变，仅渲染映射变）。

**决策（AskUserQuestion 拍板）**：颜色 = 真改 neg红/und黄（非口误）；灰色未分类 = 有要素才显；Road/Lessor 样式 = 一并固定；空层 [查看] = 仍置灰。

**Spec 改动**：「图层体系（F20）→ 完整树结构」加「样式节点是固定骨架（V1.x #33）」条 + #32 改动1 标作废；颜色三处（139/338/433/464 行）红黄对调。

---

## 2026-06-02 (#32)

### F20 收尾手验 · 图层树节点交互细化（空层 disclose/置灰 + 按钮图标化）

**类型**：中度变更（树节点视觉 + 交互逻辑，来自腾讯云手验）

**触发**：用户手验图层树报 4 点：① 空图层展开符还是 `+`，误以为下面有节点 ② 一个要素都没有的层 [查看] 按钮仍可点 ③ [导入图层] 想要箭头图标 ④ [查看图层要素] 也想要图标。

**根因**：#24 树骨架 disclose 写死 `open ? "−" : "+"`，没区分有无子节点；view 按钮漏了 `disabled`；两按钮一直是纯文字（#27 只调了 hover 显隐，没图标化）。

**变更**：

- **空层 disclose leaf 态**：🔺 图层节点 cnt=0（展开后 🎨 样式行全空）→ 展开符固定灰 `−`、不可点；cnt>0 才 `+`/`−` 可展开。仅图层节点；📁 文件夹层骨架恒有下层图层行，照常可展开。
- **空层 [查看] 置灰**：view 按钮 `disabled = busy || cnt===0`（CSS `.layer-btn:disabled` 已有，自动套用）。导入按钮不受要素数影响。
- **按钮图标化（纯图标 + lucide SVG）**：[导入图层] → lucide `Download`（箭头入托盘，导入惯例）；[查看图层要素] → lucide `Eye`（view 惯例）。去文字，i18n 全称移到 `title` + `aria-label`。引入 `lucide-react`（描线单色、stroke=currentColor 随 hover 变 accent，与 #29 灰色图标族统一）。

**决策（AskUserQuestion 拍板）**：图标形式 = **纯图标**（hover tooltip 显全称，省树宽）；图标方案 = **lucide SVG**（不土、和地图风格统一，接受加 lucide-react 依赖）。

**惯例依据（WebSearch）**：导入 = 向下箭头（数据进入当前界面，Lucide/Material 用 arrow-down-tray），导出才向上；view/preview = 眼睛图标（比列表图标更不易和"菜单"混淆）。

**Spec 改动**：「图层体系（F20）→ 完整树结构」节加「图层节点交互细化（V1.x #32）」条。

---

## 2026-06-02 (#31)

### F20 收尾手验 · 列表框表格随窗口宽度自适应

**类型**：中度变更（列表框内部布局调整，来自腾讯云手验）

**触发**：用户手验 #30 可拖可缩窗口后，发现表格是**固定列宽**（各列 `col.w` 之和 = 死宽度）：窗口拉宽 → 表格右侧留**空白**不填满；窗口缩窄 → 横滚。要求表格跟着窗口大小变，但留一个最小尺寸（= 表格自然宽），比它还小才出横向滚动条。

**根因**：#30 只规定了窗口可拖可缩 + body 纵向虚拟滚，没规定表格列宽与窗口宽的关系 → 实现用固定 `width: col.w`、表宽 = `totalW` 死值，窗口宽于表则右侧留白。

**变更**：表格列宽**跟随窗口宽度伸缩填满**：

- 各列按基准宽 `col.w` **等比拉伸**占满内容区（不再固定列宽 + 右侧留白）
- 表格**最小宽 = 该列集各列基准宽之和**（Site≈802 / Road=400 / Lessor=420），列不压到基准以下
- 窗口内容区**窄于最小宽** → body 出**横向滚动条**（纵向虚拟滚 + 横向按需滚）
- 窗口 `MIN_W`(480) 与表格最小宽**各自独立**（窗口可缩到 480，表格保最小宽、溢出横滚）
- 表头 / 虚拟化行 / 选中行随列宽一起伸缩（宽度统一 = `max(totalW, 内容区宽)`）

**Spec 改动**：「图层体系（F20）→ [查看图层要素] → 浮动窗口交互」节加「表格随窗口宽度自适应（V1.x #31）」条。

---

## 2026-06-02 (#30)

### F20 收尾手验 · 列表框改为可拖可缩浮动窗口（修 6 个易用性问题）

**类型**：轻度变更（UI 易用性，来自腾讯云手验）

**触发**：用户手验列表框，报 6 个问题：太窄（9 列横滚显示不全）、不能缩放、不能拖动、挡住地图看不到点、没滚动条、高度随行数变（土）。

**根因**：#24/#27 只写了"浮动列表框"，没规定尺寸/缩放/拖动/滚动行为 → 实现做成固定 560px 居中、无固定高度（随行数变）、不可拖缩。

**变更**：列表框改为**正经的可拖可缩浮动窗口**：

- **弹出位置**靠近触发的图层节点 [查看] 按钮（点哪从哪弹），不再居中
- **固定尺寸窗口**（默认 ~840×460，宽够 Site 9 列一屏）；内容多走 body 区**内部虚拟化滚动 + 可见滚动条**，窗口不随行数变高
- **header 可拖动**挪位置（挡地图拖开）、**右下角可缩放**（复用 ResizeHandle，最小 480×320）
- 尺寸 **localStorage 持久化**（复用 #11 面板套路）

**边界确认（product-spec-builder 迭代补全）**：

- **重复打开 = 用户拍板**：已开窗口再点另一图层 [查看] → **同窗口切内容、位置尺寸不动**（单窗口复用 viewLayer 单 state，首次靠近节点、之后切层不乱跳）
- 其余默认：最大尺寸视口 − 32px / 拖动至少留 header 在视口（防拖丢）/ 拖动 rAF 节流 / z-index 600（低于 Modal 1000）/ 空层仍固定窗口 + 暂无要素 / **仅尺寸持久化、位置不持久化**

**Spec 改动**：「图层体系（F20）→ [查看图层要素]」节加「浮动窗口交互」条（含上述边界）。

---

## 2026-06-02 (#29)

### F20 收尾手验 · 树图层节点图标按站型形状（替代统一 🔺）

**类型**：轻度变更（UI 细化，来自腾讯云手验）

**触发**：用户手验发现树的图层节点图标全是统一 🔺（红三角 emoji），不区分站型，与地图的形状×颜色渲染对不上。

**变更**：🔺 图层节点图标改为**按站型形状渲染**，与地图一致：

- Site 站型：▲Macro / ●Micro / ■IBS / △Macro NP / ○Micro NP / ◆Macro-ongoing / ◇Micro-ongoing
- Road 图层根：线形（▬/─）；Lessor 图层根：面形（◼/▰）
- **统一灰色**（#9e9e9e 级）：图层含多状态点，图标只表形状不表状态；状态分色仍在下面 🎨 样式节点
- 实现：Unicode 字符（▲●■◆ 实心 / △○◇ 空心，天然对应"存量实心/规划空心"）+ CSS color 灰，不需 SVG

**性质**：#24 完整树结构原写 🔺 emoji 为示意，实现照做没违规；本次按用户期望细化为站型形状，便于树图对照。

**Spec 改动**：「图层体系（F20）→ 完整树结构」说明加图层节点图标按站型形状条。

---

## 2026-06-02 (#28)

### F20 收尾 · 禁用地图拖拽导入（堵旁路）+ 五 Phase 统一改清单

**类型**：轻度变更（堵一条绕过盖戳的导入旁路 + 汇总 F20 收尾改动）

**触发**：F20 五 Phase 全部 push 后，派 code-reviewer 对照 Spec 全面查漏。报告结论：**主体完整**（清单 1-7 逐行核对，除一处外全通过），用户"做丢东西"精确落在 3 处可定位差距，非普遍性缺失。

**拖拽导入旁路（code-review 揪出，用户拍板禁用）**：

- 问题：地图拖文件进来 → `MapView.onDrop` → `state.importFiles`（不传 stamp）→ 后端 `target_kind=None` → 跳过几何护栏 + 三列写 NULL → 落"未分类"。这是一条绕开 #24「导入必在图层上」硬规则的活旁路，产 NULL 三列脏数据。
- **用户拍板 = 禁用地图拖拽导入**（三选项里最干净、最符合 #24）。拖文件进地图 → 提示"请用图层 [导入图层] 按钮"，不导入。
- Spec 改动：「图层体系（F20）→ [导入图层]」节第 6 条补"地图拖拽导入禁用"。

**F20 收尾统一改清单（一轮改完，路由实施 Agent）**：

| # | 严重度 | 项 | 文件 |
|---|--------|----|------|
| 1 | 中 | 禁用地图拖拽导入（本条决策）| MapView.tsx / App.tsx / state.ts / i18n.ts |
| 2 | 中 | #27-1 列表框多列表头（含 Road 起点经纬度）| LayerFeatureList.tsx / styles.css |
| 3 | 低 | #27-2 图层按钮紧跟文字 + hover 显示 | LayerTree.tsx / styles.css |
| 4 | 低 | 清理：imports.py 死代码 + state.ts geometry_guard 类型 + theme.css 11 死变量 | imports.py / api.ts / state.ts / theme.css |

**code-review 主体结论**：Phase1-5 在 Spec compliance 上**主体完整**（数据层三列+F17同步、盖戳导入全链路、深层树、列表框、渲染形状×颜色+50m圈+去Friendly+移除全局导入+色表收敛、#19护栏 均逐行核对通过），无 High 阻断、无安全问题。差距集中在上表 4 项。

---

## 2026-06-02 (#27)

### F20 手验回写 · 列表框多列表头 + 图层按钮 hover 紧跟（规格补漏）

**类型**：轻度变更（补 #24 漏写的两处 UI 规格，来自腾讯云部署后的浏览器手验）

**触发**：F20 五 Phase 部署到腾讯云、浏览器手验时，用户发现两处「规格没写细、实现做简了」——经对照确认是 Spec 漏写，非实施侧违规。

**1. [查看图层要素] 列表框 = 多列表格（带表头）**

- #24 原文只写「列出该层全部要素」，未规定多列表头 → 实施侧做了最简单行（圆点+显示名+状态）
- 补：列表框为**多列表格 + 固定 sticky 表头**。列集：
  - Site：`PROJECT` / `SITE ID` / `OPTION` / `SITE STATUS` / `LATI` / `LONGI` / `OPERATOR` / `CATEGORY` / `TYPE`
  - Road：`Property`（+ 起点经纬度）
  - Lessor：`Lessor Name` / `Lessor Category` / `Relationship`
- 虚拟化保持（固定行高，多列行）

**2. 🔺 图层两按钮：紧跟节点文字 + hover 显示**

- #24 原文只写「图层有 2 按钮」，未规定位置/显示时机 → 实施侧默认靠右常驻
- 补：[导入图层]/[查看图层要素] **紧跟节点文字后**；**hover 该节点行才显示，平时隐藏**（保持树整洁）

**性质**：两处均 Spec 漏写、非实施侧违规。归入 **F20 收尾统一改 bug 轮**（连同 theme.css 死变量清理、code-review 查漏一起改）。

**Spec 改动位置**：
- 「图层体系（F20）→ 三种节点类型」表 🔺 行补按钮交互
- 「图层体系（F20）→ [查看图层要素]」节补多列表格 + 列集 + sticky 表头

---

## 2026-06-02 (#26)

### F20 Phase 1+2 实施回写（数据层 + 盖戳导入器）

**类型**：轻度变更（实施回写 · 固化 Phase 1/2 落地的工程决策与顺带修复）

**来源**：实施侧 Phase 1（`ada2030`）+ Phase 2（`d93c681`）完成报告；规划侧逐项读 diff 验收通过（Phase 1 F17 三处同步、Phase 2 14/14）。

**Phase 1 · 数据层**：
- 三列 `TEXT` 可空无 DEFAULT；`init.sql` 用 `CREATE` 内建 + `ALTER ADD COLUMN IF NOT EXISTS` 双写，已有 volume 幂等升级
- 快照/回滚 SQL 全用显式列名，不依赖列位置（CREATE 与 ALTER 列序不一致无影响）
- `extras` 白名单取源侧大写别名超集 `OPERATOR/CATEGORY/TYPE/SITE TYPE`——`type` 源属性名是 `SITE TYPE`，必须连同排除否则属性面板重复显示
- `api/db.py` 仅连接池，无 site 显式列读写，无需改

**Phase 2 · 盖戳导入器（7 项工程决策）**：
1. `type` 参数必须 `alias="type"`（变量 `type_`），否则遮蔽内置 `type()`，异常处理 `type(e).__name__` 静默出错
2. `target_kind=None` 退回 F1 全局导入（不护栏/不盖戳），保 F1–F19 调用方 + KMZ 自反测试不破；Phase 5 移除全局按钮后自然废弃
3. 空 Property 的 road 无去重身份（`_road_key` 返回 `''` 不入索引 → 当新行插），退化数据可能重复，可接受
4. Road overwrite 按 `WHERE id` 精确更新（proceed 多查 road.id），不按 property，否则同 property 多行被一条 UPDATE 误伤
5. 状态规范化（`Unknown→undermine`/`Friendly→Normal`）置于 `_site_dict`/`_lessor_dict` 单一漏斗，清洗预览/冲突列表/入库三处一致
6. **顺带修复 KMZ road 自反一致性**（旧隐患）：旧版 road 无去重，导出重导入会重复插入破坏自反契约；Property 去重让 road 也自反（验收 conflict=2/non_conflict=0）
7. 盖戳「将错就错」+ 防重复显示双验：源带 `OPERATOR=Dito` 导入 Globe 图层 → operator=Globe（Dito 忽略）且 extras={}

**部署相关（按已定 / 本机坑 / 待定 三类区分）**：
- **已定 → DEPLOY.md 第 7 节**：命名卷 + initdb 只首跑，`restart` 不重跑 init.sql；已有库升级用 `docker exec ... psql -f /docker-entrypoint-initdb.d/01-init.sql` re-apply（F20 起全幂等可安全重入）。此机制 Linux/ARM 服务器通用
- **本机开发坑（不进 DEPLOY.md）**：Docker Desktop crash-loop 是实施侧 macOS x86 本机联调问题（import 资源尖峰 + docker exec 触发），与服务器部署无关；本机联调建议调大内存或走宿主端口直连
- **跨架构部署链路 [待开发完细化]**：本机 x86 / 内部 Beta 服务器 ARM64 / 公司 Windows PC 作跳板（装不了 Docker Desktop）/ 服务器全隔离不通外网。预想链路：Mac `buildx` 出 arm64 镜像 → 公有云对象存储中转 → 内网 Windows 下载 + 开 VPN 上传 → ARM 服务器 `load`+`up`（Windows 仅搬运 tar，不需 Docker）。**按「先本地开发调通再议部署」的决定，DEPLOY.md 跨架构节留到开发收尾再写**

**测试遗留**（不影响交付）：dev 库残留 P2*/ZZTEST_F20 测试行 + pre_import 恢复点，DELETE 被安全 hook 拦；#25 清库重来上线前会清

**仍开放**：F13 清洗 keep/discard 两路径未单独造数据（仅测 auto_fix），Phase 2 未碰清洗决策应用逻辑，按「未改动即不回归」处理

---

## 2026-06-02 (#25)

### F20 实施前敲定 · 两个待定雷拍板（形状映射 + 存量数据归属）

**类型**：轻度变更（关闭 #24 标注的两个「实施前需确认」待定项，零新增功能）

**触发**：F20（#24）写入 Spec 时留了两个明确待敲定项，dev-planner 拆 Phase 前先与用户逐项拍板。

**拍板 1 · 站型形状映射 = 接受默认**

- #24「样式与渲染」表的默认形状（Macro ▲ / Micro ● / IBS ■ / Macro NP △ / Micro NP ○ / Macro-ongoing ◆ / Micro-ongoing ◇）**用户确认接受，不调整**。
- 设计逻辑确认成立：**实心 = 存量、空心 = 规划、菱形 = 勘测**；颜色另由 site_status 决定（positive 绿 / negative 黄 / undermine 红 / 空灰）。
- 实施侧用 OpenLayers `RegularShape`（points/radius/angle 控形状 + fill/stroke 控实心/空心）即可，零额外资产。

**拍板 2 · 存量旧数据归属 = 清库重来（不做库内迁移）**

- 现有库 site 数据为**开发/测试数据**，确认可丢。
- F20 代码上线后：F14「清除基线」truncate `site`/`road`/`lessor` + `baseline_state` → 按新图层树逐层 [导入图层] 重新灌入（导入时盖戳写 operator/category/type）。
- **不新增「未分类」兜底层**，固定骨架保持 Globe/Smart/Dito 三家纯净（不违背 #24「写死三家、不增加」的设计）。

**连带简化（对 #24 实施硬约束的影响）**：

| #24 硬约束 | #25 后状态 |
|-----------|-----------|
| #4 存量站点默认归属策略 | **取消**（清库重来，无旧数据可迁移）|
| #3 状态值迁移脚本（库内 Unknown→undermine / Friendly→Normal）| **降级**：库内迁移不需要（清库）；但**导入器层面**源文件值规范化仍保留（源 KML 可能仍含 Unknown/Friendly，导入时映射到 undermine/Normal）|
| #1 F17 快照链路三处同步（site_snapshot + 建点 SQL + 回滚 SQL 加三列）| **不变 · 仍必做**（新列必须进快照，否则回滚丢列）|
| #2 extras 白名单并入三列 / #5 几何护栏+盖戳 / #6 虚拟化重心 | **不变** |

**Spec 改动位置**：

- 「图层体系（F20）→ 样式与渲染」：形状表标注从「未与用户逐一敲定」改为「已敲定，接受默认」
- 「图层体系（F20）→ 配色与状态迁移」：存量旧数据条改为「清库重来，不做库内迁移，不加兜底层」

**仍开放（非本次范围）**：列表框「编辑要素属性」（#24 标注的下一步独立需求）不在本次拍板内。

---

## 2026-06-01 (#24)

### V1.x 重度变更 · F20 图层体系（固定深层图层树 + 按导入盖戳 + 列表框查看）

**类型**：**重度变更**（替换 F7 树结构 + 新增 3 个核心列 + 改去重规则 + 移除全局导入入口 + 收窄图例模型 + 新增浮动列表框）

**触发**：用户提出把 F7 的浅树（Site/Road/Lessor 三平铺文件夹）重构为按"运营商 → 类别 → 站型"的深层图层体系，并按图层导入、按图层查看要素。菲律宾市场运营商写死 Globe/Smart/Dito（不会增加）。

**需求分析过程（慢节奏、先想清再写）**：本次先做了完整需求分析才落笔。核心纠结点是"盖戳 vs 不盖戳/数据驱动 vs 按导入存"，最终用户拍板**本版用实用折中**，理想态记录为未来方向。

**变更内容**：

**1. 新增 F20 图层体系，替换 F7 浅树**

- 固定深层树（~100 个节点骨架，不随数据生长）：
  - Site → 运营商（Globe/Smart/Dito）→ 类别（存量/规划/勘测）→ 站型图层 → 状态样式
  - 类别→站型写死：存量={Macro,Micro,IBS}、规划={Macro NP,Micro NP}、勘测={Macro-ongoing,Micro-ongoing}
  - Road / Lessor = 与 Site 平级的图层根（无运营商划分）
- 三种节点：📁 文件夹（无按钮）/ 🔺 图层（2 按钮）/ 🎨 样式（按状态分色图例，无按钮）
- **树搜索框移除**；**树不再需要虚拟化**（节点降到 ~100 个）

**2. 数据模型变更**

- `site` 表**新增 3 个强类型核心列**：`operator`（Globe/Smart/Dito）/ `category`（存量/规划/勘测）/ `type`（=SITE TYPE=图层名）
- `site_status` 复用为 🎨 样式分色（positive/negative/undermine + 空值灰）
- **Road 改为按 `Property` 去重**（原"V1 不做去重"作废）
- **Lessor 样式收窄**：relationship 仅 Unfriendly/Normal（**去掉 Friendly**）
- Site 去重键不变：`SITE ID + OPTION` **全局**去重（跨图层，非按层）

**3. 图层两按钮**

- **[导入图层]**：按导入方式**强制盖戳** operator/category/type（**忽略源属性、将错就错、不智能校正**）；几何护栏前置（类型不符的要素跳过 + 输出窗口报告）；沿用 F13 清洗 → F4 冲突两步向导；全局去重不变
- **[查看图层要素]**：浮动列表框，**本版只读** + 本层**筛选** + 点击行定位（复用 F12）+ 虚拟化（承接原树的大数据量）

**4. 渲染 = 形状 × 颜色**

- 形状来自图层（站型 type，默认建议 ▲●■/△○/◆◇，可微调）× 颜色来自状态（site_status）
- 规划类 Macro NP / Micro NP 额外画 **50m 透明辐射圈**（仅渲染不入库、固定 50m）

**5. 移除顶部全局 [📁 导入] 按钮**

- 导入唯一入口下沉到图层的 [导入图层]（"导入一定发生在图层上，不在文件夹上"）

**6. 筛选 vs 搜索口径区分**

- 列表框「筛选」= 仅本图层；F16 右上「搜索」= 全库三类（不变）

**用户拍板（关键决策）**：

- 运营商写死 Globe/Smart/Dito，不会增加 ✓
- 本版 = 忽略属性、按导入盖戳、将错就错；导出空的就导出空的、不智能修正 ✓
- 导入只发生在图层上，不在文件夹上 ✓
- 图层下要素平铺，只有 3 种样式（状态分色）✓
- 单要素删除太复杂 → 推迟 V2（软删除 + 回收站）✓
- 列表框编辑要素属性 = 下一步独立需求 ✓
- 配色 positive=绿/negative=黄/undermine=红/空=灰 ✓

**⚠️ 反转声明（推翻两轮前锁定 · 遵循 #8 反转纪律）**：

- **旧锁（作废）**：「导入节点不改要素属性 / 空的导出空的（不盖戳）」——要素归属由其自身属性决定
- **新锁（本版生效）**：「按导入方式强制盖戳 operator/category/type，忽略源属性」
- **兼容**：导出仍"空的就导出空的"忠实回放，但回放对象是**盖戳后库里实际值**（非源文件值），二者不再矛盾
- 用户原话："忽略属性，按照导入解决，强制导入 / 导出就按照当前空的就导出空的就好了 / 不去智能修正"；并明确"1认可反转"

**Spec 改动位置**：

- 功能需求表：新增 F20 行；F7 行标记被取代
- 「图层体系（F20 · V1.x #24）」新独立大节（设计前提/三节点/完整树/数据模型/两按钮/样式渲染/50m圈/筛选搜索/配色迁移/实施硬约束/边界与未来/反转声明）
- 「数据库设计」site 表加 3 列、road 去重键、lessor 两态
- 「去重规则」Road 改 Property
- 「中间地图·要素样式」改形状×颜色 + 去 Friendly + 50m 圈
- 「顶部 Toolbar」移除导入按钮（含 ASCII 图）
- 「左侧树」整节按 F20 重写
- 「V2 候选·UI 增强」加单要素删除（软删除+回收站）
- 「V1 边界声明」Road 去重移出（已做）+ 单要素删除归 V2

**对实施侧的硬约束（必须连带处理，否则数据/回滚出错）**：

1. **F17 快照链路三处同步**：`site` 加 3 列后，`site_snapshot` 表结构 + `restore_point_helper.py` 建点 SQL + `restore_points.py` 回滚 SQL（三处显式列清单）都要加 `operator/category/type`，否则回滚静默丢这三列、回滚后分层全空
2. **`extras` 白名单扩展**：新增 3 列并入 `_SITE_CORE`，防属性面板重复显示
3. **状态值迁移（幂等）**：`site_status` 旧值 `Unknown` → `undermine`；Lessor `Friendly` → `Normal`
4. **存量站点默认归属**：旧 site 数据无 operator/category/type，需给迁移默认（建议落"存量/未分类"兜底层）——**此默认策略未与用户逐项敲定，实施前需确认**
5. **几何护栏 + 盖戳导入器**：按目标图层类型校验几何并强制写三列、忽略源属性
6. **虚拟化重心**：从树移到「查看图层要素」列表框

**已知潜在风险 / 待敲定**：

- 形状映射（▲●■/△○/◆◇）为默认建议，未与用户逐型确认
- 存量数据默认归属策略未敲定
- 列表框"编辑要素属性"是紧邻的下一步需求，会再次触及单要素写入/盖戳与去重交互，届时单独立项

**未来方向（仅记录，不实现）**："数据驱动树"——节点位置由属性派生、数据与表现一致：站点根节点导入（无属性挂根）；改运营商/状态属性即重新挂载到对应节点。本版反其道而行（按导入盖戳），是实用折中，将来再演进。

---

## 2026-05-31 (#22)

### F18 双语覆盖补全（底图标签 + 基线国家名 + LayerTree）

**类型**：轻度变更（F18 范围内的遗漏补全）

**触发**：实测发现底图切换按钮（"Esri 卫星"/"Google 卫星"）及基线国家名（如"菲律宾"）在英文模式下仍显示中文。

**变更内容**：

- **F18 覆盖补全**：底图切换标签、LayerTree tooltip / 过滤框 placeholder、基线状态栏国家名，纳入双语体系
- **底图标签**：`"Esri 卫星"` → `tFn("map.basemap.esri")`（EN: "Esri Sat"），`"Google 卫星"` → `tFn("map.basemap.google")`（EN: "Google Sat"）；同时修复拖拽提示 "释放鼠标导入文件"
- **基线国家名**：后端 `GET /api/baseline-state` 新增 `name_en` 字段（JOIN countries 表取 `name_en`），前端按当前语言选 `name_en`（英文）/ `name_zh`（中文）
- **清洗对话框国家名**：`country_name_en` 从后端透传至 `CleaningRow` / `BaselineRegion`，按语言显示；`not_in_baseline` 清洗条目 "Outside Baseline (Philippines)" 英文正确显示
- **LayerTree**：过滤框 placeholder、文件夹 tooltip（全选/展开/折叠）、节点 checkbox tooltip、"暂无数据" 全部接入 i18n

**不变**：数据字段名、字段值、文件名不翻译（F18 既有约定）

---

## 2026-05-28

### V2 候选 · 整理与新增

**类型**：轻度变更（V1 范围不变）

**变更内容**：

- **新增** 「V2 候选功能」章节，按三类组织：工作流 / AI 能力 / UI 增强
- **新增** 工作流类候选项：**基线 / 个人空间双工作区**（Git-like staging area）
  - 来源：用户对话中提出"导入操作影响个人空间副本，对比基线 diff 后批量同步"的需求
  - 动机：① 避免频繁写后端库；② 提交前可视化对比变更
  - V1 决策：不做
  - V2 设计待定项：个人空间存储形态（前端 IndexedDB vs 后端 workspace 表）、身份识别方式、同步冲突解决、派工导出空间归属
- **重构** 原散落在「AI 系统提示词」「V1 边界声明」中的 V2 候选项，统一收纳到「V2 候选功能」章节
- **重构** 「V1 边界声明」改为类别表格，便于扫读

**影响**：

- 「AI 系统提示词」章节简化，仅保留"本项目不使用 AI"声明 + 指向 V2 候选章节
- 「V1 边界声明」结构变更，内容等价

---

## 2026-05-28 (#2)

### 数据库设计 · 细化 `extras JSONB` 策略

**类型**：轻度变更（与 V1 功能范围一致，仅细化数据库结构表达）

**变更内容**：

- `site` 表新增 `extras JSONB` 字段，承载 Excel 50 列扩展数据
- 字段集策略明确为两层：**强类型核心列**（KML 公共字段）+ **`extras JSONB` 扩展列**（Excel 长尾字段）
- 属性面板渲染顺序明确：先强类型列，后 `extras` key-value
- 镜像选型写入 Spec：`postgis/postgis:16-3.4`（明确排除 `pgvector/pgvector:pg16`）

**来源**：

Instance B（实施侧）骨架搭建阶段的实现决策反馈：
- docker-compose 起 3 个容器全 Started + db Healthy
- `GET /health` `GET /api/sites/roads/lessors` 全部验证通过
- 宿主端口 5433 → 容器 5432（避让本机 Postgres，但端口是部署细节不上 Spec）

**理由**：

- 硬编码 50 个 Excel 列会导致表结构脆弱（不同来源 Excel 字段会变）
- JSONB 容纳长尾扩展、去重和空间查询仍走强类型核心列
- 镜像选型在 Spec 里固化，避免 pgvector / postgis 这种容易混淆的错配

---

## 2026-05-28 (#3)

### Stage 1 实施回写 · 字段名兼容 + 异常处理增补

**类型**：轻度变更（V1 范围不变，仅补齐数据规则）

**变更内容**：

- **新增** 「字段名兼容」表：把原 KML 数据里的拼写错误（`Lessor Cagegory` → `Lessor Category`）写入 Spec，明确导入时必须做映射、导出 KMZ 时使用规范拼写
- **扩展** 「数据异常处理」表：
  - 新增 **LATI/LONGI 字段写反** 异常（`G5226` 行实例），明确检测规则（LATI 绝对值 > 90 但 LONGI 在合法范围 / 或两者交换后都合法）
  - 新增 **KML schema 标签缺失** 异常，明确按几何类型兜底分类（Point→site / LineString→road / Polygon→lessor）
  - 给每条异常补 "检测方式" 列
- **KML/KMZ 处理** 节补一条：解析时按 `<SchemaData schemaUrl="#site|#road|#lessor">` 区分类型；schema 缺失时按几何类型兜底

**来源**：

Instance B（实施侧）Stage 1 完成报告：
- 解析样本 KML 时发现 `Lessor Cagegory` 拼写错误，代码层已兼容
- 解析样本 XLSX 时发现 `G5226` 行 LATI/LONGI 字段写反
- 用样本 KML + XLSX 端到端验证：site 14 + road 1 + lessor 4 入库正确

**理由**：

- 这些坑是真实数据里捞出来的，不写进 Spec → 下一个新人写 Stage 2/3 代码踩同样的坑
- "字段名兼容" 是数据治理事项，比单纯代码注释更值得 Spec 化
- 异常检测的"检测方式"列让实施侧有明确判定规则，不靠猜

---

## 2026-05-28 (#4)

### Stage 2 实施回写 · 冲突列表 UI 用底色替代 checkbox

**类型**：轻度变更（V1 范围不变，UI 设计微调）

**变更内容**：

- 主流程 1 step 5 中删除 `[选择]` 列概念
- 改为：每行单条 `[覆盖] [忽略]` 按钮 + **点击后行底色立即反馈**（黄=覆盖 / 白=忽略）
- 顶部 `[反选]` 行为明确为"翻转每行当前决策"

**来源**：

Instance B（实施侧）Stage 2 完成报告：
- 两阶段 session 协议（`POST /api/import` + `POST /commit` + `DELETE`）按 Spec F4 落地
- API 端到端验证通过（全忽略 / 部分覆盖 / 取消 三条路径）
- 7 条坐标 warning 全被检出（1 条漏小数点 + 6 条 LATI/LONGI 写反）

**理由**：

- 用按钮 + 行底色比 checkbox + 按钮更直观：一眼看出每行当前决策
- 减少 UI 元素，对 50+ 行冲突列表更友好
- 实质等价：[反选] 仍能批量翻转，单条仍能精准控制

---

## 2026-05-28 (#5)

### Stage 3 实施回写 · KMZ 自反一致性契约 + extras 展开规则 + 文件命名

**类型**：轻度变更（V1 范围不变，导出格式契约固化）

**变更内容**：

「KML / KMZ 处理」节新增三条契约：

1. **`extras JSONB` 展开规则**：导出 KMZ 时 `extras` 字段全部展开到 `<ExtendedData><SchemaData>`，不丢字段；`<Schema>` 字段定义取所有同类要素 `extras` 字段集的**并集**
2. **自反一致性契约**：导出 KMZ 重新导入回本平台必须 100% 命中冲突（同类型已去重要素全部识别为重复）—— 列为核心契约，破坏视为回归 bug
3. **导出文件命名规则**：固化为 `export_full_YYYYMMDD_HHMMSS.kmz` / `export_region_YYYYMMDD_HHMMSS.kmz`

**来源**：

Instance B（实施侧）Stage 3 完成报告：
- 整库导出：21 placemark = 14 site + 3 road + 4 lessor ✓
- 自反导入验证：site 14/14 + lessor 4/4 全冲突；road 3 个 non_conflict（V1 不去重，符合 Spec）✓
- 选区导出 ST_Contains 严格生效：G5226 写反坐标的 4 行被正确排除 ✓
- Lessor Cagegory → Lessor Category 规范化按 #3 变更落地 ✓

**理由**：

- "自反一致性"是 Spec 隐含但极重要的设计契约，写入 Spec 防止 V2 改导出器时不知情破坏
- "extras 展开规则"让后续团队知道 Schema 字段定义不是固定列表而是动态 union（解释了为什么不同导出 KMZ 的 Schema 节可能不同）
- 文件命名规则固化避免后续团队随意改名导致下游脚本（比如客户自动化处理）失效

---

## 2026-05-28 (#6)

### Stage 4 实施回写 + V1 交付锁版

**类型**：轻度变更 + **版本快照**

**变更内容**：

1. 「合并策略」表新增一行：**同一批次多文件内重复 → 后者覆盖前者**（dict 折叠规则，与"同一文件内"相同）
2. 「主流程 1」step 6/7 明确**事务边界**：决策按钮只改 UI 状态，[确认导入] 才是真正的数据库写入时刻
3. **新增「V1 交付快照」章节**：宣布 V1 锁版，列出四个 Stage 的累积实现映射

**来源**：

Instance B（实施侧）Stage 4 完成 + V1 完整对账报告：

- **F5 冲突 Excel 导出**落地：双 sheet 设计（Site Conflicts / Lessor Conflicts），[DB] / [新] 列对照，淡蓝/淡黄底色，左 3 列冻结
- **全局搜索**（顶部 🔍）按 site_id/option/lessor_name/property 模糊匹配
- **左树补全**：搜索过滤 / 节点 checkbox 显隐 / 文件夹三态控制
- **地图补全**：底图切换（OSM / 高德 / Esri 卫星）/ 比例尺 / 鼠标坐标 / 定位按钮
- **输出面板补全**：清空日志按钮
- **F1-F12 + UI 五区块 + 数据规则 + V1 边界**全部对账通过

**理由**：

- 多文件批次的 dict 折叠规则是 V1 实际行为，写入 Spec 防止 V2 维护者误解
- 事务边界明确："决策即时反馈 ≠ 即时入库" 是冲突处理 UI 的核心契约，必须显式写入
- **V1 锁版宣告**：Spec 进入"维护版本"状态，后续任何改动必须通过 CHANGELOG 记录，避免"无声变更"

---

## V1 累积变更回顾（#1 ~ #6）

| # | 主题 | 类型 |
|---|------|------|
| 1 | V2 候选功能整理 + 基线/个人空间双工作区入档 | 轻度 |
| 2 | 数据库设计 · `extras JSONB` 两层字段策略 + 镜像选型固化 | 轻度 |
| 3 | 字段名兼容（`Lessor Cagegory` → `Lessor Category`）+ 异常处理表扩展（LATI/LONGI 写反 + KML schema 缺失兜底）| 轻度 |
| 4 | 冲突列表 UI · 行底色替代 checkbox | 轻度 |
| 5 | KMZ 自反一致性契约 + extras 展开规则 + 导出文件命名 | 轻度 |
| 6 | Stage 4 收尾 + 事务边界 + 多文件折叠 + **V1 锁版** | 轻度 + 快照 |

V1 全程无重度变更——所有改动都是对现有契约的细化或补全，**核心需求自首轮收集后未发生颠覆性调整**。

---

## 2026-05-28 (#7)

### V1.x 视觉皮肤 · Dark Pro（V1 锁版后首次增量）

**类型**：轻度变更（**纯皮肤层，零功能影响、零布局变更、零 API 变更**）

**变更内容**：

新增「V1.x 视觉皮肤 · Dark Pro」章节：

1. **主色板**：VS Code Dark+ 基因 —— 应用 `#1e1e1e` 底、面板 `#252526`、accent `#4ec9b0`（青绿）、警告/错误/成功各有柔和色
2. **底图配套**：默认底图从 OSM 浅 → **CartoDB Dark Matter**；高德 → 深色样式；Esri 卫星图保留（本就深）
3. **字体**：UI 用 Inter，数据展示用 JetBrains Mono
4. **微交互**：80ms 颜色过渡，2px accent 左边框选中态，进度条 accent 横向脉冲
5. **冲突列表行底**：覆盖 `#5a4a1a` 半透明 / 忽略 `#2d2d30`
6. **模式**：V1.x 只做 Dark，Light/Dark 双模留 V2

**来源**：

用户在 V1 锁版后提出"炫酷皮肤"需求：
- 芒果V5给 4 个候选（Tactical HUD / Dark Pro / Cyberpunk Neon / Linear Minimal）
- 用户选 **Dark Pro**
- 芒果V5出完整配置方案（色板 + 底图 + 字体 + 微交互 + 模式）
- 用户"全同意"

**理由**：

- VS Code/Bloomberg 是工程师工具的视觉公约数，零学习成本
- "OSM 浅底图嵌在深 UI 上像贴膏药"—— 底图必须跟着换深色，否则视觉不一体
- 用 **CSS Variables** 而非硬编码，为 V2 双模切换打底
- 限定"零功能/布局/API 变更"是为了让 B 能快速落地且不引入回归

---

## 2026-05-28 (#8)

### V1.x 视觉皮肤 · **方向反转** · Mint Tech

**类型**：轻度变更（皮肤层 reversal，零功能影响）

**变更内容**：

「V1.x 视觉皮肤」章节**完全重写**，从 Dark Pro 反转为 Mint Tech：

| 维度 | 原 Dark Pro (#7) | 新 Mint Tech (#8) |
|------|-----------------|------------------|
| 整体调性 | VS Code Dark+ 工程师风 | 清新自然 + 科技感 |
| 应用底色 | `#1e1e1e`（深黑） | `#fafafa`（浅净） |
| 面板背景 | `#252526` | `#ffffff` |
| 主文字 | `#d4d4d4` | `#0f172a` |
| Accent | `#4ec9b0`（青绿） | **`#10b981`**（薄荷绿） |
| 默认底图 | CartoDB Dark Matter | **CartoDB Positron**（浅净） |
| 模式 | 仅 Dark | 仅 Light |
| 几何 | 无明确圆角约束 | **统一 6px 圆角** + 极轻阴影 |
| 科技感细节 | 未明确 | **数据强制等宽** + 千分位数字 + 纯色圆点 |

**来源**：

- 用户对 #7 实施后反馈："太黑了，地图也看不清楚，黑黑的"
- 进入修复对话：芒果V5给三选项（Light Pro / Slate / 仅换地图）
- 用户先选"仅换地图"，立刻改口"**清新自然，科技感**"—— 后者覆盖前者
- 芒果V5直接拍 Mint Tech 完整方案（薄荷绿 accent + 浅底 + 等宽数据 + 6px 圆角）
- 用户"全同意"

**理由**：

- 用户对 Dark Pro 的拒绝信号清晰（"太黑、看不清"），不是配色微调能救的，必须反转方向
- "清新自然 + 科技感"组合最稳的解码 = 浅底 + emerald accent + 数据等宽字体 + 极简几何
- **保留 #7 已落地的 CSS Variables 体系**，B 只需改变量值 + 换底图 URL + 补几何细节，组件代码理论零修改
- 字体方案（Inter + JetBrains Mono）跨深浅底都适用，沿用 #7 不变

**对实施侧的硬约束**：

- #7 的硬约束全部保留：禁止硬编码、禁止改功能/布局/API/文案/命名/事务边界/契约
- **额外强调**：CSS Variables 只换值不换键，组件代码不应该被改动
- 几何细节（6px 圆角 + 阴影 + 纯色状态点）是新增要求，组件可能要补 1-2 个 utility class
- 科技感细节（数据等宽 + 千分位 + 圆点替代 emoji）是新增硬要求，组件需要补对应处理

**对话顺序教训**：

用户在同一轮表达了两个互斥意图（先选选项 + 立刻新指令），这是需求收集中常见的"思考边走边变"。芒果V5正确做法是 **以最新一句为准、明确告知 reversal**，避免文档与意图脱节。本次 reversal 已通过 #8 显式记录，下次同类情况也按此处理。

---

## 2026-05-28 (#9)

### 清理 AI Studio 死代码 · Spec + CLAUDE.md

**类型**：轻度变更（删除无效残留，零功能影响）

**触发**：用户切换机器前的最后清理请求"你帮我把 AI Studio 相关的内容清理了吧"

**变更内容**：

**Product-Spec.md** 删除两节：
- 「AI 系统提示词」节（曾仅说"本项目不使用 AI"，无信息价值）
- 「Google AI Studio 能力配置」节（曾仅说"本项目不使用 Builder"，无信息价值）

V1 不用 AI 已在「V1 边界声明」表格清楚标注，V2 AI 候选已在「V2 候选功能」章节 —— 删除两节零信息损失。

**.claude/CLAUDE.md** 清理大量流程残留：

| 段 | 改动 |
|----|------|
| [角色] | "指导用户在 Google AI Studio 中创建项目" → "直接用 Claude Code 写代码" |
| [任务] | 5 步流程缩为 4 步，删除"AI Studio 开发"步骤 |
| [技能] | 删除"AI系统提示词一致性"项 |
| [文件结构] | 删除"从 AI Studio 下载解压的代码文件"；改为 `web/` + `api/` + `docker-compose.yml`；`reference.md` 注释改为"V2 候选参考" |
| [总体规则] | 删除"AI Studio 操作指南"，流程描述精简 |
| [自动触发规则] | 删除整段"自动输出 AI Studio 操作指南" |
| [项目状态检测] | 路由文案改为"提示用户启动 Claude Code 按 Spec 实施" |
| **[AI Studio 指南输出阶段]** | **整段删除（~54 行）**，替换为 [实施引导阶段]（~30 行），新指南给出"双 instance 协作模式 + 实施侧第一句话模板" |
| [代码检查阶段] | 删除：目的中的"AI 系统提示词一致性"、constants.ts/App.tsx/gemini-services.ts 检查目标、第四步 A/B/C 三段 AI 一致性检查、Part 2 报告模板 |
| [指令集] /check | "AI 实现一致性" → "数据契约一致性" |

**保留不动**：

- `.claude/skills/product-spec-builder/` 整个 Skill 包（含 `reference.md` 的 Google AI Studio 能力清单 + `system-prompt-template.md`）—— 这是通用 Skill 资产，跨项目复用
- Spec「V2 候选功能 · AI 能力类」（列名识别 / 坐标 AI 检测 / 模糊去重）—— V2 仍可能用 AI

**理由**：

- AI Studio 路径在本项目已彻底退役，相关章节是"死代码"误导未来读者和会话恢复
- [代码检查阶段] 原本的"AI 一致性"逻辑针对的是"Builder 生成的 React App + constants.ts + gemini-services.ts"结构，本项目根本没有这些文件，留着 `/check` 会去查不存在的目标
- [实施引导阶段] 替换 AI Studio 指南，把 Spec 完成后的指引精简到"开第二个 instance 写代码"，与实际工作模式吻合
- 切换机器前清理一次 = 给新机器接手的 Claude Code 一份没有历史包袱的项目配置

**统计**：

- Spec：删除 ~12 行（两节合计）
- CLAUDE.md：从 ~335 行 → ~270 行，净缩减约 20%
- `grep -ni "AI Studio\|Google AI Studio"` 两个文件 → 0 匹配

---

## 2026-05-28 (#10)

### 角色品牌改名 · 废才 → 芒果V5

**类型**：轻度变更（命名替换，零功能/零结构影响）

**变更内容**：

全项目"废才"统一替换为"芒果V5"：

| 文件 | 替换数 |
|------|-------|
| `.claude/CLAUDE.md` | 1 处 |
| `.claude/skills/product-spec-builder/SKILL.md` | 2 处（[角色] 段定义 + 输出风格示例引用） |
| `Product-Spec-CHANGELOG.md` | 5 处（早前 CHANGELOG 条目中的叙述引用，含本条之前的对话顺序教训等）|
| `Product-Spec.md` | 0 处（Spec 主体未直接引用角色名）|

**来源**：

用户清理 AI Studio 后下一句话："把所有废才 改成 芒果V5"

**理由**：

- 角色名是个人偏好/品牌选择，不影响 Skill 行为
- 替换后保留原"直接、冷静、不奉承"的人设特性，只是叫法变了
- 项目级 SKILL.md（不是全局 `~/.claude/skills/`）改名只影响本项目，跨项目 Skill 资产不受波及

**验证**：

- `grep -rn "废才" pre-survey-map/` → 0 匹配
- `芒果V5` 总数：CLAUDE.md 1 + SKILL.md 2 + CHANGELOG 5 = **8 处全部就位**

---

## 2026-05-29 (#11)

### V1.x 易用性增量 · 导入上限 + 面板缩放 + 属性面板再打开规则

**类型**：轻度变更（参数 + UI 增强 + 行为明确化，零数据规则影响）

**变更内容**：

**1. F1 导入上限：1MB → 100MB**

- F1 描述补一句"单文件上限 100MB"
- 此前实施侧用了较小默认值（约 1MB），用户实测嫌小
- 100MB 上限覆盖典型场景：含 10000+ placemark 的 KML、50 列 × 10000 行的 Excel

**2. 三个面板可拖拽缩放**

- 「UI 布局 → 整体布局」节新增「面板可拖拽缩放」小节，含范围表：

  | 面板 | 最小 | 最大 |
  |------|------|------|
  | 左树 | 200px | 500px |
  | 右属性 | 240px | 600px |
  | 底部输出（展开态） | 120px | 500px |
  | 底部输出（折叠态） | 28px 固定 | — |

- 4px 拖拽条 + 鼠标光标变 `↔` / `↕`
- 拖动时**地图区自动 invalidate 重绘**（避免地图静止不刷新）
- 尺寸 `localStorage` 持久化，下次打开恢复
- 左树、右属性、底部输出三个节各自的描述里也补一行"面板可拖拽（XX 范围，localStorage 持久化）"

**3. 属性面板再打开规则明确**

- F8 描述改：增加"可 ✖ 关闭，**关闭后无常驻入口**，再次点击要素或树节点自动重新打开"
- 「右侧属性面板」节补两条：
  - "关闭后无常驻入口"
  - "点击新要素时面板自动展开 + 切换到新要素内容"
- 即：用户无需在 toolbar 找按钮重新打开面板，依赖"点击节点"作为唯一打开入口

**来源**：

用户换机器前最后一轮反馈：
1. "导入文件要在 100M 以内，1M 太小了"
2. "相关窗口可以缩放大家，树 Panel，属性 Panel，输出 Panel"
3. "属性窗口关闭，就找不到了，只能点击某个节点自动打开"

**理由**：

- 100MB 是 PostgreSQL/PostGIS + FastAPI/Starlette 中等量级文件的稳定上限，再大就要走分块上传，V1.x 不做
- 面板拖拽缩放是 GIS 类工具的标配能力（QGIS/ArcGIS Online 都有），用户工作时常需要根据当前任务调整 panel 大小（如查冲突列表时缩窄树、看属性时拉宽右侧）
- 属性面板"关闭后无常驻入口"是用户**主动接受**的行为，不是 bug —— 把这个行为写进 Spec 防止下次有人误以为是缺失功能开始加按钮
- `localStorage` 持久化让用户的布局偏好跨会话保留，不用每次进来重新拖

**对实施侧的硬约束**：

- 100MB 上限要在前端 + 后端**两端校验**：前端上传前判断、后端 FastAPI / Starlette `max_request_size` 配置 + nginx `client_max_body_size`
- 面板拖拽必须触发地图 `invalidateSize()` / `map.updateSize()`，否则地图渲染会错位
- localStorage key 建议命名：`presurvey.panel.left` / `presurvey.panel.right` / `presurvey.panel.bottom`，初次无值时回落到默认（20% / 25% / 28px）

---

## 2026-05-29 (#12)

### V1.x 重度变更 · 导入流程改为两步向导 + 单文件 + F13 数据清洗

**类型**：**重度变更**（V1 后首次重度变更，反转 F1 行为 + 新增功能模块 + 改写主流程）

**变更内容**：

**1. F1 单文件反转**

- F1 描述：`多格式文件导入 · 一次多文件` → `单文件导入 · V1 一次只能一个`
- 拖入多个文件 → 只接受第一个 + 输出面板 warn"已忽略其他 X 个文件"
- 顶部 Toolbar `📁 导入文件` 描述同步改为单选

**理由**：多文件同时导入会让"基线对照 + 文件间交叉冲突"混淆，用户无法判断"谁和谁比" → V1 反转，简化到一次一个

**2. 新增 F13 数据清洗向导（步骤 1）**

- 解析后扫描 4 类脏数据：
  - **坐标写反**（LAT/LONG 颠倒）→ 默认 **[自动修复]**（入库时 swap）
  - **坐标漏小数点**（绝对值 > 180）→ 默认 **[丢弃]**（不可自动修）
  - **在海里**（PostGIS `ST_Within(geom, landmass)` = false）→ 默认 **[丢弃]**
  - **不在主基准区域**（不在基线国家境内）→ 默认 **[保留]**（可能是合法跨境点）
- 默认动作策略 = A + B 混合：基础"保留"，但**不可修复 / 完全不合理的点位** 默认 [丢弃]，**可修复的** 默认 [自动修复] 待用户确认
- 行操作按钮：写反 3 个（[自动修复] [原样保留] [丢弃]）；其他 3 类 2 个（[保留] [丢弃]）
- 行底色：绿 = 自动修复 / 黄 = 保留 / 灰 = 丢弃

**3. 主基准区域算法："先入为主"**

```
if 基线 (site 表) ≥ 1 个点:
    主基准 = 基线 ≥ 70% 点位所在的国家（若无则取最大占比）
else (首次导入):
    主基准 = 本文件 ≥ 70% 点位所在的国家
    本次导入完成后，该基准随入库点固化为基线基准
```

**4. 底层地理数据集**

- 决策：用 **Natural Earth 开源离线数据集**（雷 17 选 A）
- `ne_10m_land`（陆地多边形）→ PostGIS 表 `landmass`
- `ne_10m_admin_0_countries`（国家边界）→ PostGIS 表 `countries`
- docker init 时一次性加载，体积 50–80MB
- 不调外部 API，不引入 MCP

**5. 导入流程从 1 步变 2 步向导**

- 单 modal、顶部 step 进度条：`[1. 数据清洗] → [2. 冲突检测] → [完成]`
- 步骤 2 (F4) 仅对清洗后"活着的点"做冲突检测
- 步骤 2 底部加 `[← 返回步骤 1]` 按钮
- 主流程 1 第 5-7 步完全重写

**6. F4 标注为"步骤 2"**

- F4 表格描述前缀 "（步骤 2）"
- 内部逻辑不变（覆盖 / 忽略 / 取消三选一仍是核心契约）

**7. 「数据异常处理」节拆分重构**

- 原节拆为两段：
  - 「解析期异常」 — Excel 列名 / KML schema / 100MB / 网络断开 → 解析失败直接拒绝
  - 「数据清洗规则（F13）」 — 4 类坐标问题 → 进清洗向导让用户决策
- 新增「主基准区域算法」「底层地理数据」两个独立小节

**来源**：

用户切机器前给出的最后一组功能反馈：
1. "V1 版本，暂时不支持多文件导入，因为都是导入的文件直接和基线比，导入多个，不知道谁和谁比了，容易混淆"
2. "除了提供导入文件重复识别意外，还要提供导入文件数据清洗能力，主要针对经纬度，有些是反了，有些在海里，有些根本不在菲律宾"
3. "区域以 70% 以上点位所在位置为基准"
4. "导入就是向导来了，第一步清洗数据，第二步判断重复"

**用户拍板（追问轮次）**：

- 雷 17（地理数据）：**A 内置 Natural Earth** + 补充"先入为主基准"
- 雷 18（默认动作）：**A + B 混合** —— 默认保留，但不可修复的 / 完全不合理的默认丢弃；可自动修复的待用户确认
- 雷 19（多文件拖入）：**A 接受第一个 + warn**
- 推论 1（自动修复）：默认接受（写反 swap 入库；漏小数点不修）
- 推论 2（向导 UI）：默认接受（单 modal 多步 + 步骤 2 可返回步骤 1）

**对实施侧的硬约束**：

- 后端 session 协议从两阶段（`/import` + `/commit`）扩展为三阶段：
  - `POST /api/import` → 解析 + 清洗扫描 → 返回 `cleanings[]` + `baseline_region`
  - `POST /api/import/{sid}/proceed-to-conflicts {decisions}` → 应用清洗决策 → 返回 `conflicts[]`
  - `POST /api/import/{sid}/commit {decisions}` → 应用冲突决策 → 入库（事务点）
  - `DELETE /api/import/{sid}` → 取消整个导入
- Session TTL 仍是 30 分钟，覆盖向导整个时长
- PostGIS 加 `landmass` + `countries` 表，docker init 加载 Natural Earth 数据
- 前端清洗向导 UI 按 F13 实现，复用 Stage 2 的"行底色 + 按钮"模式（多一种"自动修复"绿色）
- 默认动作策略**写死在前端**（不来回拉后端）：解析返回后前端按规则映射默认动作
- 主基准区域计算**写在后端**（PostGIS 空间查询），前端只显示 banner

**对现有契约的影响**：

| 现有契约 | 影响 |
|---------|------|
| 去重规则（site_id+option / fid）| 不变 |
| 合并策略（后者覆盖前者）| 不变 |
| 字段名规范化（Lessor Cagegory）| 不变 |
| KMZ 自反一致性 | **可能受影响**：现有 KMZ 导出的点重新导入，写反 / 在海里 / 不在基准的点会进清洗向导。导出 KMZ 内的点理论上不应触发任何清洗规则（已是干净数据），需 B 验证
| 多文件批次内 dict 折叠（#6）| **作废**（V1 单文件，不存在批次内）

**V1 边界声明更新**：

- 多文件导入移入"V1 不做"（V2 候选）—— Spec V1 边界声明表已隐含（数据列原 `Road（线）去重` 等其他项不动）

**V1 交付快照说明**：

- V1 交付快照（2026-05-28）保持不变，那是历史状态
- 本变更视为 **V1.x 功能增量**，未来通过 README + Spec 标注当前实际版本

**潜在风险**：

- Natural Earth 数据集体积大（50–80MB），docker 镜像或 deploy/db/geo_data 文件夹要预存
- 清洗向导 UI 比冲突向导复杂（3 类按钮 + 顶部 banner + step 导航），B 实施要小心 UX 一致性
- "先入为主"基准在基线为空时第一次导入定型，万一第一次导入了一个错误的国家，后续都会被卡 → **V1 通过 F14「清除基线」按钮兜底**（清空后下次导入重新固化主基准）

---

### #12 后续追问决策（提交 B 前细化）

**Q2：文件内自冲突处理 = 方案 A（推荐）**

- 维持「同一文件内重复 → 后者覆盖前者，静默处理」现状
- **清洗向导顶部 banner 第 2 行显示去重摘要**：「文件解析 N 个 site；文件内重复自动去重 X 组（保留后者，丢弃 Y 个）；待清洗 Z 个，检测异常 W 条」
- 用户能看到丢了什么，但不强制决策（避免 UI 过载）
- 方案 B（每对冲突让用户决策）记入 V2 候选

**Q3：底层地理数据 = 方案 Y（统一表 + buffer，推荐）**

- 丢弃 `ne_10m_land` / `landmass` 表设计，**单一 `countries` 表**（`ne_10m_admin_0_countries`）
- 判定 SQL 改为 `ST_DWithin(geom, country.geom, 0.01)`，**1km buffer 容错**
- 数据集体积从 50-80MB 减到 ~30MB
- 解决 Natural Earth 10m 分辨率漏小岛的问题（菲律宾 7000+ 岛中大量小岛会被 buffer 容错覆盖）
- 单表判定避免"land 说在海里、countries 说在某国"的矛盾

**新增 F14：清除基线（用户当轮提出）**

- Toolbar 加 [🗑️ 清除基线] 按钮（红色，destructive 样式）
- 点击 → 弹确认 modal：「此操作将清空 site / road / lessor 三表，主基准也会重置。不可撤销，确定吗?」
- 确认后 → 后端 `DELETE /api/baseline` → truncate 三表
- 后端响应：`{"deleted": {"site": N, "road": M, "lessor": K}}`
- 前端：清空后 fetchAll() 刷新地图 → 输出面板红字 "基线已清空：site -N / road -M / lessor -K"
- **V1 不做权限控制**（用户明确表态：调试用 / 试用 / 主基准误固化后兜底）
- 同时解决 "先入为主基准固化错误后无救" 的潜在风险

---

## 2026-05-29 (#14)

### #12 实施回写 · extras 去重 + 批量空间查询 unnest

**类型**：轻度变更（实施回写，含 1 个业务规则 + 1 个工程边界）

**来源**：Instance B（实施侧）#12 实施过程中两个真实问题的修复 commit `d30c3f4`

**变更内容**：

**1. `extras` 排除核心强类型列（业务规则）**

- 实施时 B 发现：如果解析器把所有字段（包括 `SITE ID` / `OPTION` 等核心列）都塞进 `extras` JSONB，属性面板会同时显示"强类型列段" + "extras 段"，导致 `SITE ID: V2152` 出现两次
- 修复：解析器（`api/parsers/kml.py` + `xlsx.py`）维护核心字段白名单 `_SITE_CORE / _ROAD_CORE / _LESSOR_CORE`，扔进 `extras` 前 filter 掉
- **Lessor 的核心字段集同时包含 `Lessor Category`（规范拼写）和 `Lessor Cagegory`（历史拼写错误）**，保持「字段名规范化」契约（CHANGELOG #3）的一致性

**2. 批量空间查询 `unnest` 数组传参（工程边界）**

- 实施时 B 发现：清洗判定 `classify_points()` 用 `VALUES ($1::text, $2::float8, $3::float8), ($4...), ...` 逐参数 placeholder，导入 ~11000 个点时触发 asyncpg 的 32767 参数上限报错
- 修复：改用 `unnest($1::text[], $2::float8[], $3::float8[])` 一次性传整个数组作为单个参数
- 这是 PostgreSQL 批量空间查询的标准最佳实践，**写入 Spec 防止未来在其他批量查询点重蹈覆辙**

**3. web Dockerfile 加 npmmirror 镜像加速**

- 国内构建加速，不影响 Spec

**Spec 改动位置**：

- 「补充说明 → 数据库设计 → 字段集策略（两层）」节
  - 补两条：`extras` 排除核心列；Lessor 排除同时含规范+拼写错误两个 key
- 新增「批量空间查询性能边界」小节
  - 强制使用 `unnest` 数组传参；解释 32767 参数上限

**理由**：

- B 的两个修复都是"真实数据里捞出来的坑"，不写进 Spec → 下次有人改解析器或加新查询大概率重踩
- "Lessor Cagegory 也要排除"是个易遗漏点，必须写明 —— 否则未来"修拼写错误"的 PR 可能漏改这里
- `unnest` 模式应当作为本项目空间查询的**默认范式**，写进 Spec 让 V2 维护者直接用

---

## 2026-05-29 (#15)

### V1.x 重度变更 · 主基准固化 + 野蛮粗暴策略 + 全局基线状态栏

**类型**：**重度变更**（修正实现 + 反转默认动作 + 新增 UI + 新增表）

**触发问题**：

实测大文件性能问题：13000 节点首次导入 40-50s（合理），**后续任何小文件仍 30-40s**（不合理）。
定位：`api/cleaning.py::_country_dist_in_db` 每次导入开始时都扫整张 `site` 表做 13000 次 ST_DWithin + KNN，性能瓶颈。

**Spec 原意 vs 实施偏差**：

Spec 写的是"先入为主"，B 实现成了"每次都重算" —— 是实现走偏了。

**用户提出的最终方案**（野蛮粗暴版）：

1. 主基准是 **一次性事件**：基线第一次确立后**永不重算**
2. "不在主基准"默认 **[丢弃]**（不是 [保留]）—— 强约束"先入为主"语义
3. 顶部加 **全局基线状态栏**，永远显示当前基线
4. 换基线的唯一通道：F14 清除（V1 不做基线漂移、不做 reset）
5. V2 候选：**工作空间**（一空间 = 一国家，可切换）

**Spec 改动清单**：

**1. 新表 `baseline_state`（单行）**

```sql
CREATE TABLE baseline_state (
    id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    iso_a2 TEXT NOT NULL,
    name_zh TEXT,
    coverage_pct INT,
    points_used INT,
    established_at TIMESTAMP DEFAULT NOW()
);
```

「数据库设计」节加入该表。

**2. 「主基准区域算法」节整段重写**

- 状态机：未确立 → 已确立 → F14 清除回未确立
- 触发固化时机：**第一次 commit 成功 + site 表新增 > 0**
- 三种使用场景的性能基线（导入开始 / 清洗判定 / 状态栏 = 都是 ~1ms 单行 SELECT）
- 极端情况兜底（首次入库全在海里 / 已确立后导入全异国 / 用户强制保留杂种点）

**3. 「数据清洗规则」表行修改**

`不在主基准区域` 默认动作 **[保留] → [丢弃]**，列出操作改为 [强制保留] / [丢弃]。

**4. 主流程 1 步骤 1 加红色警告 banner**

雷 29 选项 B：基线已确立 + 本文件 0 点在基线国家 → 顶部红色警告 banner，文案明确指引 F14。

**5. F14 描述强化**

- 标注为"换基线唯一通道"
- truncate 范围扩展到 4 张表（含 `baseline_state`）

**6. 新增 F15 + 全局基线状态栏**

- Toolbar 下方独立 28px 横条
- 浅灰底 + accent 边框
- 两态文案：已确立 / 未确立
- 数据来源：单行 SELECT，启动 + 每次 commit 后刷新
- 整体布局 ASCII 图同步更新

**7. 补充说明节加「主基准缓存原则」**

- 明令禁止重复触发全表扫描
- 引用 13000 行 ≈ 30s 性能数据

**8. V2 候选加「工作空间」**

- 一空间 = 一国家
- 顶部基线状态栏改为下拉切换空间
- schema 隔离或 tenant_id 字段方案待定

**用户拍板（追问轮次）**：

- 雷 26（固化时机）：第一次 commit + site > 0 ✓
- 雷 27（表 schema）：单行约束 + id=1 ✓
- 雷 28（状态栏位置）：**B = 独立 28px 状态栏** ✓
- 雷 29（极端保护）：**B = 红色警告 banner** ✓
- 雷 30（首次入库全在海里）：不写入 baseline_state ✓

**对实施侧的硬约束**：

1. 新建 migration：`baseline_state` 表 + `_country_dist_in_db` 重构
2. `compute_baseline_region` 函数行为完全重写：
   - 读 `baseline_state` → 有就返回（~1ms）
   - 无 + current_points → 算 70% 用于 banner 显示（不固化）
3. **第一次 commit 入库逻辑加固化**：commit 成功 + site 新增 > 0 + `baseline_state` 仍空 → 算 `_country_dist_in_db` → INSERT
4. **F14 端点改**：TRUNCATE 列表加 `baseline_state`
5. **前端新组件 `BaselineStatusBar.tsx`**：自动从 `/api/baseline-state` 拉取 + 每次 commit 后 refetch
6. **后端新端点 `GET /api/baseline-state`**：返回单行或 `null`
7. **清洗向导**：检测"基线已确立 + 本文件 0 点在基线国家"显示红色 banner（前端逻辑或后端 hint）
8. **批量空间查询统一用 unnest**（保持 #14 的修复）

**性能预期**：

| 场景 | 改前 | 改后 |
|------|------|------|
| 第一次大文件 13000 点 | ~40s | ~40s（差不多，固化在 commit 末端）|
| 后续任意文件导入开始 | **30-40s** ❌ | **<100ms** ✅ |
| 清洗判定 `not_in_baseline` | 触发全表扫 | 单行 SELECT |
| 全局状态栏渲染 | — | 单行 SELECT |

**关系网**（这条 #15 跟之前的关系）：

- **覆盖 #12**：「主基准区域算法」节、「数据清洗规则」表的"不在主基准"行
- **依赖 #14**：保持 `unnest` 范式 + `extras` 排除核心列
- **强化 F14**：增加 truncate 范围 + 唯一换基线通道角色

---

## 2026-05-29 (#13)

### #11 实施回写 + 面板默认值策略澄清

**类型**：轻度变更（实施细节回写 + Spec 表述澄清）

**变更内容**：

「V1.x #11 易用性」中关于面板缩放的「默认值策略」追加澄清段：

- **初次访问**（无 localStorage）→ CSS 默认百分比响应式（左 20% / 右 25%）
- **用户首次拖动后** → 切换为 px 并写入 localStorage
- **后续访问** → 永远按 px 值渲染
- **清空 localStorage** → 回到响应式百分比默认

**来源**：

Instance B（实施侧）#11 完成报告中主动提出"Spec 对不上的潜在点"：实施时做了"百分比 → 拖动后切 px"的渐进式策略，比纯 px 持久化更贴合多视口场景，征求是否回写 Spec 还是改回纯 px。

**理由**：

- B 的混合策略是 **GIS 类工具的标准做法**（QGIS / Figma / VS Code 侧边栏都是这套）
- 用户没调过的面板用百分比 → 不同显示器初次看体验一致
- 用户调过的面板用 px → 偏好持久化不漂移
- 改回纯 px 反而会引入"4K 上 400px 漂亮、1440p 上 400px 太大"的多视口问题

**B 的 #11 实施汇总**：

| 项 | 实现 |
|----|------|
| 100MB 上限 · nginx | `client_max_body_size 100M;` + `proxy_read_timeout 300s` |
| 100MB 上限 · 后端 | 方案 B 中间件 `MaxBodySizeMiddleware`，注册顺序在 CORS 之前（避免拦 OPTIONS）|
| 100MB 上限 · 前端 | `state.ts` 入口前置校验 + 413 友好提示 |
| 三面板缩放 | 通用 `ResizeHandle` 组件 + `axis="x"/"y"` + `edge="start"/"end"` |
| 地图同步重绘 | `MapView.tsx` 新增 `layoutEpoch` prop，拖拽期持续 `updateSize()` |
| localStorage key | `presurvey.panel.left/right/bottom`，按 `PANEL_LIMITS` clamp 防越界 |
| 属性面板再打开规则 | 零额外代码，`selectFeature(null)` 关闭 / `selectFeature(f)` 自动展开 |

**curl 验证（5/8 通过）**：

- 1MB / 99MB via nginx → 200
- 101MB via nginx → 413（nginx 早拦下）
- 101MB via api 直连 → 413 + 友好 JSON
- V1 链路回归 → 全通

**留给用户浏览器实测（3/8）**：

- 101MB 文件前端拦下 + 输出面板红字
- 三面板拖拽 + 地图同步重绘 + min/max clamp
- localStorage 持久化 + 清空回退默认

**对实施侧的硬约束**：

- 禁止硬编码色值
- 禁止改任何已有的交互文案、按钮位置、API shape
- 禁止改文件命名规则、事务边界、自反一致性契约
- 仅替换视觉层

---

## 2026-05-30 (#16)

### V1.x 性能与交互 · 左树虚拟化 + 拖拽条统一 + 拖动节流 + 地图↔树双向定位

**类型**：中度变更（性能重构 + UI 统一 + 新增交互，V1 功能范围不变）

**触发问题**（用户实测 + 纯定位）：

1. 导入 13000 点后**整个界面卡顿 ~0.5s**：面板拖拽掉帧、左树缩放绿条消失、点击树节点切换延迟。
2. A/B 定位结论：**元凶是左树的 13000 个 DOM 节点，与地图无关**——去勾选清空地图但树展开仍卡，折叠树立即丝滑。
3. 左树拖拽条只有上半截有绿色、太细、在滚动条左边难以点中；右属性/底部输出的拖拽条与左树宽度不一致。
4. 面板拖动时每像素触发一次地图 `updateSize`，大数据量下拖动卡顿。

**Spec 改动清单**：

1. **F7 图层树管理**：补"列表虚拟化（固定行高，DOM 只渲染可视区，支撑 13000+ 节点不卡顿）"
2. **F12 自动定位 → 双向焦点同步**：原"点击树节点飞到要素"扩展为双向——新增"地图选中要素 → 左树自动展开所在文件夹 + 滚动到该节点并高亮"
3. **「UI 布局 · 面板可拖拽缩放」**：
   - 拖拽条宽度 `4px → 6px`，三面板统一（常驻边框色、hover/拖动变 accent 绿）
   - 补"拖动重绘经 `requestAnimationFrame` 节流"
4. **「左侧树」节**：
   - 新增"地图→树 反向定位"交互描述（折叠时先展开再滚入视口）
   - 新增"性能 · 列表虚拟化（零依赖）"小节：动机 / 实现（撑高占位层 + translateY 绝对定位）/ 约束（选中只重渲可见行、不重建行数组）

**实现要点（实施侧已落地）**：

- `LayerTree.tsx` 完全重写为零依赖固定行高虚拟化：`ROW_H=24` / `OVERSCAN=8`；扁平化"文件夹头 + 展开节点"为一维行数组喂虚拟窗口
- 地图→树定位：`useEffect([selectedId, rows, ...])`，节点不在 rows 时先 `setExpanded` 展开其文件夹（rows 重建触发 effect 重跑），再按行号 `scrollTop` 居中滚入
- `state.ts`：`setPanelSize` 用 `requestAnimationFrame` 节流 `layoutEpoch`
- `App.tsx`：面板 resize 回调 `useCallback` 稳定化；`MapView` 包 `memo`
- `styles.css`：拖拽条统一 6px + 常驻色 + hover/active 变 accent；左树滚动区 `width:calc(100% - 6px)` 给右侧 6px 拖拽条让位

**零依赖原则**：用户明确要"最好方案、优先零依赖"，未引入 react-window / react-virtuoso 等库。

**性能结果**：

| 场景 | 改前 | 改后 |
|------|------|------|
| 13000 节点树渲染 | 全量 13000 DOM 节点 | 恒定 ~38 DOM 行（视口 + overscan）|
| 面板拖拽 / 节点点击切换 | 卡顿 ~0.5s | 丝滑 |
| 面板拖动重绘 | 每像素一次 updateSize | rAF 节流 |

**关系网**：

- **强化 #11**（面板缩放）：拖拽条统一宽度 + rAF 节流，归并到同一交互规范
- **扩展 F12**：单向定位 → 双向焦点同步
- **不影响** #14/#15 的后端空间查询与基线固化逻辑

**附带（未改 Spec，仅代码加固）**：导入路径 `imports.py` 地理清洗段加 try/except + 计时日志，`cleaning.py::classify_points` 两个相关子查询合并为单次 `LEFT JOIN LATERAL`（一次 KNN）——为偶发导入 502 留排查埋点，暂未复现。

---

## 2026-05-30 (#17)

### V1.x 新功能 · 全局搜索结果列表（F16）

**类型**：中度变更（新增功能 + 升级既有搜索行为，不改核心数据流 / 布局结构）

**需求来源**：用户提出"右上角搜索功能，结果放 Output 里，每行一条，顶部'搜索匹配 N 条，飞到第一条'可点，每条结果也能点击跳到地图 + 左树同步焦点"。

**升级既有项（冲突已消解）**：

原 Toolbar `🔍 搜索` 行为是"输入 SITE ID/名称 → 树节点高亮 + 地图飞到（单个）"。本次升级为"回车 → 三类全搜 → 结果列入 Output 搜索结果区 + 自动飞第一条"。旧的"直接飞"语义保留为汇总条默认动作。

**用户拍板（追问 4 项）**：

- 搜索范围：**三类全搜（Site/Road/Lessor）· 显示名匹配**，与左树过滤框同口径（复用 `nameOf`/`searchMatch`）
- 结果呈现：**Output 独立"搜索结果区"，封顶 200 条**，不挤占 50 条日志
- 触发：**回车触发 · 保留自动飞第一条**
- 边界文案：按推荐（0 条→红字"未匹配到任何要素"；空关键词→不搜索）
- 补充（默认拍板）：折叠态显示可点汇总行；新搜索覆盖旧结果；`[清空日志]` 不动搜索结果区
- **追加强调**：搜索到多条时，**每一条都独立可点跳转**（不是只有汇总条/第一条能跳）

**Spec 改动清单**：

1. **功能需求表新增 F16**：全局搜索结果列表
2. **Toolbar `🔍 搜索` 行重写**：回车触发 + 三类全搜 + 结果入 Output + 自动飞第一条
3. **「底部输出面板」节**：
   - 展开态新增"🔍 搜索结果区"（与操作日志并列的独立区块，不计入 50 条日志）
   - 折叠态补搜索汇总行 `🔍 搜索匹配 N 条，飞到第一条`（可点）
   - `[清空日志]` 标注"只清日志，不动搜索结果区"
   - 新增 **「搜索结果区（F16）」子节**：触发 / 匹配规则 / 结果呈现（汇总条 + 每条可点）/ 封顶 200 / 自动飞第一条 / 边界文案 / 覆盖策略

**关系网**：

- **复用 F12 双向焦点同步**（#16 刚做）：每条结果点击 → 地图飞到 + 左树展开折叠文件夹 + 滚动高亮
- **复用左树过滤口径**：匹配函数与 `LayerTree` 的 `searchMatch`/`nameOf` 一致，避免两套语义
- **不影响**：导入 / 清洗 / 基线 / 导出链路；不改布局栏数与面板结构

**对实施侧的硬约束**：

1. 搜索匹配口径必须复用左树 `nameOf`/`searchMatch`，不得另写一套
2. 搜索结果区是 Output 内独立 state，**不得**写进 50 条日志数组
3. 结果封顶 200 条，超出给提示，**不得**全量渲染（与 #16 虚拟化精神一致：防卡）
4. 每条结果 onClick 走与"左树点击节点"同一条 `onPick`/`selectFeature` 通路，确保地图飞到 + 左树焦点同步一次到位
5. 0 条 / 空关键词 / 超 200 条三种边界文案按本条落地
6. 折叠态汇总行可点（点击展开面板 + 飞第一条）

---

## 2026-05-30 (#18)

### F16 微优化 · 搜索结果可清空 + 结果行补核心属性

**类型**：轻度变更（F16 验收后的两点优化，不改触发/匹配/焦点同步主逻辑）

**需求来源**：用户 F16 浏览器验收通过后提出：① 搜索结果要有清理手段；② 结果行那么宽留白太多，除末尾类型角标外把核心属性也平铺出来。

**用户拍板（追问 2 项）**：

- 清理方式：**搜索结果区区头加 [✖ 清空结果] 按钮**，与 [清空日志] 并列、互不影响
- 核心属性集：**填满留白（信息全）**——按类型平铺核心强类型列

**Spec 改动清单**（均在「底部输出面板 → 搜索结果区（F16）」+ F16 表行）：

1. 结果行格式从"显示名 + 类型角标"扩展为 **显示名 · 核心属性 · 类型角标**：
   - Site：`状态: <SITE STATUS> · 项目: <PROJECT> · (lat, lng)`
   - Lessor：`类别: <Lessor Category> · 关系: <Relationship>`
   - Road：`起点: (lat, lng)`（LineString 几何首坐标，无则省略）
   - 字段缺失该项省略，不显示空占位
2. 区头加 **[✖ 清空结果]** 按钮：清空结果区回到无结果态；与 [清空日志] 互不影响

**对实施侧的硬约束**：

1. 核心属性字段名直接取强类型核心列（`SITE STATUS`/`PROJECT`/`LATI`/`LONGI`；`Lessor Category`/`Relationship`），**不要从 extras 里捞**。
2. 字段缺失即省略该段，禁止渲染 `状态: —` 这种空占位。
3. [✖ 清空结果] 只清搜索结果 state，**不得**触碰 50 条日志数组；[清空日志] 同理不得碰结果。
4. Road 起点坐标从几何首坐标取，取不到就整段省略，不报错。

**关系网**：纯 F16（#16/#17）的 UI 增量；不影响匹配口径（仍复用 nameOf）、焦点同步（仍 flyTo）与封顶 200 逻辑。

---

## 2026-05-30 (#19)

### V1.x 重度变更 · 双主题（默认 Dark Slate + 亮/暗切换）

**类型**：**重度变更**（反转 #8 的"仅 Light 单模式"决策 + 反转性请回 #7 被否的暗色 + 新增切换控件 + 新增一套调色板）

**需求来源**：领导反馈"界面太白，搞个深色的，还要够 Fashion"。用户顾虑"之前深色界面地图看不清"（即 #7 翻车点）。

**关键历史**：#7 曾做 Dark Pro，因"太黑、地图看不清"被否，#8 反转为 Light（Mint Tech）。本次回归暗色，**根因修复**：#7 错在把暗色刷到地图（底图换暗/滤镜压暗）；本方案地图区完全不参与主题，底图恒为亮色 CartoDB Positron，只暗化外壳。

**用户拍板（追问 + 联网核实业界实践后）**：

- 调性：**深石板 + 薄荷绿辉光**（冷静专业、对数据密集界面友好、无 blur 零性能负担；否决毛玻璃/双霓虹）
- 上线方式：**默认 Dark + 亮/暗切换开关**（先选"直接换暗"，经联网核实"业界主张暗色应可选、强制暗对散光用户有 halation"后，升级为默认暗+切换）
- 暗色底图：**不加**，地图保持亮底图（用户明确"地图不能黑不溜秋的"）

**联网核实的业界高级实践（已落入 Spec）**：

1. **暗壳 + 亮地图**是公认范式（地图 canvas 当内容区，亮底可读性更高，类比 Apple Books 暗色下正文仍亮底）
2. **表面分层**：每层提亮 5–8% 亮度，做 surface-base/raised/overlay 三级（`--bg #0f172a` → `--panel #1e293b` → `--overlay #273449`）
3. **不用纯黑**（投得出阴影，有层次；Material 用 #121212，我们用 #0f172a 深石板）
4. **文字不用纯白**（用 `#e2e8f0` 调白，防高分屏震动）
5. **语义令牌**而非散写 hex（本项目 CSS Variables 天生适配，只扩值不改键）
6. **对比度守 WCAG**（正文 ≥4.5:1，接缝与浮层尤其注意）

**Spec 改动清单**（均在「V1.x 视觉皮肤」节）：

1. 节首注解更新：从"#8 Light 单模式"改为"#19 双主题，默认 Dark"
2. 「模式切换」节整段重写：双主题定义 + 暗色主色板表（10 个语义令牌的 Dark/Light 双值）+ 暗色微交互（选中/激活态薄荷绿辉光 `0 0 8px`）+ **地图区护栏**
3. 「视觉一致性约束」补：双主题实现方式（`data-theme` 属性 + localStorage + 默认 dark）、Toolbar 加 ☀/☾ 切换按钮、地图区不参与主题

**对实施侧的硬约束**：

1. CSS Variables **只扩值不改键**：暗色为默认（`:root` 或 `[data-theme="dark"]`），亮色 `[data-theme="light"]`；切换改 `<html data-theme>` + localStorage，**默认 dark**
2. **地图区护栏（防重蹈 #7）**：MapView / 底图 URL / 要素样式（pin/面/线色）一律不动；**禁止**对地图容器用 `filter: invert/brightness/hue-rotate`；默认底图恒为 CartoDB Positron 亮色；不加暗色底图
3. Toolbar 仅新增 ☀/☾ 一个控件，其余文案/布局/数据规则/API/事务边界完全不动
4. 辉光（`box-shadow 0 0 8px rgba(16,185,129,.45)`）克制使用：仅选中节点 + 激活按钮，不得全局滥用
5. 逐组件排查硬编码色值，确保全走 CSS Variables（否则暗色下会有亮色漏网斑块）
6. 文字用调白 `#e2e8f0`、底色用 `#0f172a` 非纯黑，按主色板表逐令牌落地

**关系网**：

- **反转 #8**（Light 单模式）→ 双主题，默认 Dark
- **修复 #7**（Dark Pro 翻车）的根因：地图区护栏
- **不影响**任何功能（F1-F16）、布局、数据规则、API；纯皮肤层 + 一个切换控件

---

## 2026-05-30 (#20)

### F17 · 基线恢复点与回滚能力

**类型**：重度变更（新功能模块 + 新表 4 张/元表 1 张 + 新 API + 新 UI 对话框）

**动机**：`清除基线`（F14）不可逆、坏导入会污染累积数据，菲律宾现场出错没退路。需要一张安全网。

**业界做法调研（已落入 Spec 决策依据）**：

- 四层谱系（轻→重）：① 操作级撤销（batch_id）② 命名恢复点/快照（Figma/Docs 版本历史）③ 版本化时态表（Esri ArcGIS 地理库版本控制：named version + reconcile/post + undo/conflict）④ PITR 时间点恢复（Postgres WAL）
- 本工具定位：数据小（万级点）、内部单点用、导入累积式 → **取①+②叠加**，不上③④（重型协同/运维级，杀鸡用牛刀）

**变更内容**：

- **新增** F17 功能行（功能需求表）
- **新增** Toolbar [🕘 恢复点] 入口；[🗑️ 清除基线] 补注"执行前自动建恢复点（pre_clear）"
- **新增** 数据库设计 5 张表：`restore_point` 元表 + `site_snapshot`/`road_snapshot`/`lessor_snapshot`/`baseline_state_snapshot`（镜像源表列 + `restore_point_id` 外键 CASCADE）
- **新增** 「基线恢复点与回滚机制（F17）」专节：基线完整定义、三处自动建点触发、手动建点、覆盖式回滚语义、保留策略、API、与冷备分工
- **新增** 主流程 3 注解：F17 / KMZ 导出 / pg_dump 三者分工

**关键设计决策**：

- **基线 = site + road + lessor + baseline_state**，四者一起才是可回滚的完整快照
- **三处自动建点**（都在写操作前、同事务内）：导入 commit 前（pre_import）、清除基线前（pre_clear）、回滚前（pre_rollback）
- **回滚可逆**：回滚本身先建 pre_rollback 点，防手滑
- **撤销上一次导入** = 回滚到最近 pre_import 点（语义糖，非独立机制）
- **覆盖式回滚**：事务内 truncate 三表 + 清 baseline_state → 从快照重灌；二次确认（destructive）
- **保留 N=10 环形淘汰**，CASCADE 连带清快照；不做锁定/置顶/配额（V1.x 保持简单）
- **与冷备分工**：恢复点是 DB 内快照（卷丢即失），容灾仍靠 DEPLOY.md 的 pg_dump；两者互补不替代

**V1.x 不做（划归 V2 或运维层）**：

- 逐要素/字段级回滚（时态表，V2）
- 多人/版本分支/reconcile-post（Esri versioning，V2）
- 自动定时快照（只在导入前/清除前/手动）
- 恢复点导出为文件（用 pg_dump 冷备）

**影响**：

- 纯新增，不改 F1-F16 任何行为；导入/清除事务末尾各多一步建点（数据小，耗时可忽略）
- 存储：最多 10 份三表副本（万级行 × 10，可接受；单库膨胀后可降 N 或转 diff-only，V2）

**状态**：Spec only，待实施侧实现。

---

## 2026-05-31 (#21)

### F6 底图补全 + F18 双语界面（中/英）

**类型**：中度变更（F6 描述纠偏 + 新增功能 F18，不改数据规则 / 布局结构 / API）

**变更内容**：

**1. F6 底图描述纠偏 + 新增 Google 卫星**

- F6 功能行：默认底图从"OSM"改为"CartoDB Positron"（与实际实现对齐）；删除"高德地图"（从未实现）；新增"Google 卫星（测试用）"
- 「中间地图」节底图列表同步：移除"高德地图"，改为 OSM / Esri 卫星 / Google 卫星（测试用）
- **Google 卫星技术现状**：开发调试 + 内部服务器 beta 部署均走未授权 tile 接口（`mt{0-3}.google.com/vt/lyrs=s`）临时方案，**ToS 风险自知**；仅公有云商用部署时替换为 Google Maps API Key
- 来源：实施侧加了 Google 底图（用户事后确认为测试需求），同步纳入 Spec

**2. 新增 F18 双语界面（英文默认）**

- 目标：菲律宾工程师使用英文界面，中国工程师可切回中文
- 默认语言：**英文**
- 切换控件：Toolbar 右上 **[EN/中]** 按钮（与 [☀/☾] 主题切换并排）
- 翻译范围（UI 文案，软件自身）：
  - ✅ Toolbar 按钮 / 标签
  - ✅ 对话框标题 / 按钮 / 提示文案
  - ✅ 基线状态栏文案
  - ✅ 底部输出面板日志 / 错误提示
  - ✅ 左树文件夹名（Site / Road / Lessor 本已是英文，状态类文案需翻）
  - ✅ 清洗向导 / 冲突列表 UI 文案
  - ✅ 搜索结果区核心属性标签（`状态:` → `Status:`，`项目:` → `Project:` 等）
- 翻译范围（不动）：
  - ❌ 导入文件内容（KML/Excel 里的字段名和字段值）
  - ❌ 数据库里的字段值（site_status 的 positive/negative 本就是英文）
  - ❌ 属性面板展示的数据字段名（PROJECT / LATI / LONGI 本就是英文）
- 偏好持久化：`localStorage`（key: `presurvey.lang`，值 `en`/`zh`，默认 `en`）

**关键决策**：

- 英文为默认（主要用户是菲律宾工程师）；中国维护工程师切换到中文
- 实现建议：`i18n Context` + `useTranslation` hook，或轻量 key-value JSON 对（`en.json` / `zh.json`）；无需引入 react-i18next 等重型库，项目文案量小
- FOUC 防止：语言切换与主题切换类似，页面加载前从 localStorage 读取 lang 并设置，避免闪烁

**对实施侧的硬约束**：

1. **只换 UI 自身文案**，数据内容一律不动
2. `localStorage` key `presurvey.lang`，**默认 `en`**（不设值时表现为英文）
3. 字符串资源集中管理（不散写在各组件里），方便后续新增语言
4. 不引入重型 i18n 库，轻量 Context + JSON 文件即可
5. [EN/中] 按钮与 [☀/☾] 并排在 Toolbar 右上角，宽度固定（参照主题切换按钮规格）

**影响**：

- 不改任何功能逻辑、数据规则、API、布局结构
- 现有中文字符串需全部收归翻译 key，是一次较大的前端重构（覆盖所有组件的 UI 文案）
- 主题切换（#19）已用 localStorage + 初始化脚本模式，本功能可复用同一模式


---

## 2026-05-31 (#23)

### V1.x 重度变更 · F19 审计日志（带 Excel 导出 + 隐藏入口）

**类型**：**重度变更**（新增主要功能模块 + 新增表 + 新增隐藏入口 + 新增 API 端点）

**触发**：用户提出 — "暂时不做登录，但要审计关键操作"。"99% Windows 机器，能不能记域账号机器名，估计难，最多记 IP"。"查看审计日志要输密码，定死 mangosv5"。"用快捷键，不要按钮占地方"。后续追加 "审计日志我要可以导出 Excel"。

**变更内容**：

**1. 新增 F19 审计日志（12 类操作）**

操作枚举：
- `open` — session 首次打开
- `import` — 导入入库完成（含清洗/冲突决策计数 + 关联自动恢复点）
- `export_full` / `export_region` / `export_conflicts` — 三类导出（记 file_name + counts）
- `restore_point_create_auto` / `_manual` / `_delete` / `_rollback` / `_undo_last_import` — 5 类恢复点操作
- `clear_baseline` — F14 清基线
- `audit_log_export` — **元审计**，导出日志本身也记一条

**明确不记的（噪音）**：切换底图 / 切换语言 / 框选 / 缩放 / 点击树节点 / 属性面板查看。

**2. 身份识别 = 方案 E（IP + UA + Session ID）**

- 浏览器安全限制：拿不到 Windows 域账号、机器名、MAC
- V1 接受 "只识别浏览器，不识别真人" 的底线
- session_id 通过后端 cookie `presurvey_sid` 在首访问时 UUID 写入
- 用户拒绝 E+（首次填名字方案），"不让大家太麻烦"

**3. 隐藏入口：连续按 3 次 `Esc`**

- 全局键盘监听，间隔 < 1 秒触发
- 弹密码框，硬编码 `mangosv5`
- 密码错误不限次数（V1 简化）
- 一般用户偶发触发概率极低

**4. Modal UI（只读 + 可导出）**

- 全屏遮罩 + 居中 Modal（70vw × 80vh），跟 RestorePointDialog 风格一致
- 倒序时间（新的在上）+ 操作类型筛选 + 时间范围筛选 + 分页 50/页
- 行点击展开完整 `details` JSON
- **无删除/编辑**，但**右上角 [💾 导出 Excel]** 按钮
- 导出范围 = 当前筛选结果，文件名 `audit_log_YYYYMMDD_HHMMSS.xlsx`

**5. 新表 `audit_log`**

字段：`id BIGSERIAL` / `ts` / `session_id` / `ip` / `user_agent` / `action` (枚举) / `details JSONB` / `result` / `error_msg`
索引：`(ts DESC)` + `(action)`

**6. 后端 API 端点**

- `GET /api/audit-log` — 分页查询
- `GET /api/audit-log/export` — 导出 Excel（按筛选条件）
- **不开** `POST` / `DELETE` / `PATCH`（业务自己在成功路径里 insert）

**7. 容错原则**

审计写入失败 **不应该让业务回滚**（如导入入库成功但审计写失败，业务事务仍 commit）。审计用独立连接 / try-catch 兜底，失败只 WARNING 不抛出。

**用户拍板（追问轮次）**：

- 雷 31 "打开页面" 频率：**每 session 一条**（cookie 缺失时记） ✓
- 雷 32 展示形态：**Modal 弹窗** ✓
- 雷 33 导出字段：**类型 + 文件名 + 数据计数**（不记选区 WKT 几何） ✓
- 雷 34 保留策略：**永久保留** ✓
- 雷 35 UI 只读：**锁死** + 后端不开删改端点 ✓
- 雷 36 默认排序：**倒序**（新的在上） ✓
- 雷 37 密码错误次数：**不限** ✓
- **追加**：审计日志要可以**导出 Excel** ✓

**Spec 改动位置**：

- 功能需求表新增 F19 行
- 「数据库设计」节新增 `audit_log` 表行
- 「补充说明」节新增独立小节「审计日志（F19 · V1.x #23）」（含身份方案 / 操作枚举 / 隐藏入口 / Modal UI / 后端约束 / 容错原则）

**对实施侧的硬约束**：

1. 后端新建 migration：`audit_log` 表 + 索引
2. 后端 cookie 中间件：首访问写 `presurvey_sid` UUID
3. 业务路径（commit / export / clear / restore_point CRUD）每个成功/失败分支都要 insert audit_log
4. 审计写入用独立兜底，不影响业务事务
5. 前端全局键盘监听 `Esc` 三连 → 密码 modal → audit modal
6. 前端 audit modal：表格 + 筛选 + 分页 + Excel 导出
7. **导出 Excel 端点完成后必须再写一条 `audit_log_export` 记录**

**已知潜在风险**：

- 硬编码密码 `mangosv5` 在前端代码里可见（不混淆）—— V1 接受（用户明确）
- 审计日志写入用同步还是异步？推荐**同步同事务**（业务成功 → 审计也成功），失败兜底独立连接补写
- nginx 转发要传 `X-Forwarded-For` 透到后端

---

### V1.x #23 实施补丁（2026-05-31 落地后补充）

实施完成后用户拍板的 3 项补充决策，已写入 Spec「审计日志（F19）→ 实施补充决策」小节，CHANGELOG 同步记录：

**雷 38 落地 · nginx 加 XFF 头**

`web/nginx.conf` `location ~ ^/(api|health)` 块新增两行：
```nginx
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
```

`$proxy_add_x_forwarded_for` 会追加 `$remote_addr` 到已有 XFF 链，前置 LB 链路不会被截断。后端 `audit._ip_of()` 仍是三级 fallback（XFF[0] → X-Real-IP → request.client.host），所以即便 nginx 没传 XFF 也能拿到 IP，加这一行只是让链路更标准。

**雷 39 · `open` 仅 GET 触发**

`audit_middleware.py` 的实现选了 GET-only：
```python
if request.method == "GET":
    await write_audit(action="open", details={"path": ...}, request=request)
```

POST / DELETE / PATCH 第一次访问时只写 cookie，不补 open（避免与业务 audit 重复）。极端场景：脚本直传 POST 上传 → 第一条 audit 是 `import` 而不是 `open` + `import` 两条。

**雷 40 · 自动恢复点的双条审计**

`commit_import` / `clear_baseline` / `rollback` 三个路径每次会写**两条** audit：

| 路径 | 业务 audit | 关联 audit |
|------|-----------|-----------|
| commit | `import` | `restore_point_create_auto` (pre_import) |
| clear_baseline | `clear_baseline` | `restore_point_create_auto` (pre_clear) |
| rollback | `restore_point_rollback` 或 `restore_point_undo_last_import` | `restore_point_create_auto` (pre_rollback) |

两条用 `details.restore_point_id` 关联，不靠行序串。

**实施踩到的坑（补 DEPLOY.md）**：

- macOS Docker Desktop bind mount 缓存：`init.sql` 在 host 上更新后，容器内 `/docker-entrypoint-initdb.d/01-init.sql` 仍是旧版本（gRPC FUSE 缓存）。需 `docker compose restart db` 强制重读
- 旧 volume 升级到 V1.x #23 必走步骤：
  ```bash
  docker compose restart db
  docker compose exec -T db psql -U postgres -d presurvey \
    -f /docker-entrypoint-initdb.d/01-init.sql
  ```
  init.sql 全部 `CREATE TABLE IF NOT EXISTS`，幂等
- 容错验证（实战）：api 重启时 `audit_log` 尚未建表，第一次 `open` 写入抛 `UndefinedTableError`，logger.warning 一行吞掉，业务 `GET /health` 仍返回 200 OK


