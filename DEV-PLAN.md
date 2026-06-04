# Development Plan — Pre-Survey Map · F20 图层体系（V1.x #24/#25）

> 本文件记录 F20 图层体系（重度变更）的开发阶段划分。
> 新 session 启动时应首先阅读此文件 + Product-Spec.md「图层体系（F20）」节，了解状态后再继续开发。
>
> **背景**：F1–F19 已上线交付（见 Product-Spec.md「V1 交付快照」+ CHANGELOG #1~#23）。本 Plan 是 **F20 增量**，在现有 `api/` + `web/` + `deploy/` 代码基础上改造，不是从零搭建。
>
> **两个待定雷已在 #25 拍板**：① 站型形状映射接受默认；② 存量数据**清库重来**（不做库内迁移、不加「未分类」兜底层）。
>
> **核心契约（每个 Phase 都不许破坏）**：全局去重键不变（Site=SITE ID+OPTION / Road=Property / Lessor=fid）；KMZ 自反一致性；F17 回滚不丢列；事务边界（[确认导入] 才入库）。

---

## Phase 1: 数据层 — site 三列 + F17 快照链路三处同步 ✅

**交付内容**：
- `site` 表新增 3 个强类型核心列：`operator TEXT`（Globe/Smart/Dito）、`category TEXT`（存量/规划/勘测）、`type TEXT`（= SITE TYPE = 图层名），均可空（盖戳前为 NULL）
- `site_snapshot` 表**同步新增**同样 3 列（否则 F17 回滚静默丢列 → 回滚后分层全空）
- F17 建点 SQL 同步：`restore_point_helper.py` 的 `INSERT INTO site_snapshot (...) SELECT ...` 显式列清单加 operator/category/type
- F17 回滚 SQL 同步：`restore_points.py` 的 `INSERT INTO site (...) SELECT ... FROM site_snapshot` 显式列清单加 operator/category/type
- `extras` 解析白名单 `_SITE_CORE` 并入这 3 列（防属性面板「同字段重复显示」）
- `init.sql` 全部保持 `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` 幂等（兼容已有 volume 升级）

**关键文件**：
- `deploy/db/init.sql` — site 表（:8）+ site_snapshot 表（:100）加 3 列；用 `ADD COLUMN IF NOT EXISTS` 保证幂等
- `api/restore_point_helper.py` — 建点 `INSERT INTO site_snapshot` 列清单（:32-36）加 3 列
- `api/routers/restore_points.py` — 回滚 `INSERT INTO site` 列清单（:90-93）加 3 列
- `api/parsers/kml.py` / `api/parsers/xlsx.py` — `_SITE_CORE` 白名单并入 operator/category/type
- `api/db.py` — 如有 site 查询的显式列清单（SELECT/INSERT），同步加 3 列

**验收标准**：
- `docker compose restart db` + 执行 init.sql 后，`\d site` 与 `\d site_snapshot` 都含 operator/category/type 三列
- 端到端回滚测试：建一个含三列值的 site 行 → 手动建恢复点 → 改数据 → 回滚 → 三列值完整恢复（**不丢列**）
- 现有 F1–F19 链路回归通过（导入/导出/搜索/审计/恢复点不报错）

---

## Phase 2: 盖戳导入器 — 几何护栏 + 强制写三列 + 状态值规范化 ✅

**交付内容**：
- `POST /api/import` 入参新增 `operator` / `category` / `type` 三个盖戳值（由调用方=图层按钮传入；Road/Lessor 图层不传或传 null）
- **几何护栏（前置）**：目标图层强类型——Site 层只收点 / Road 层只收线 / Lessor 层只收面；几何类型不匹配的要素**跳过 + 底部输出窗口报告**「跳过 N 个非点要素」，不阻断其余导入
- **盖戳写入**：通过护栏的要素，`operator/category/type` **强制写为图层传入的值**，源文件这三个属性**一律忽略**（将错就错）；`site_status` 仍读源数据
- **状态值规范化（导入器层面）**：源文件 `site_status=Unknown` → 入库 `undermine`；Lessor `relationship=Friendly` → 入库 `Normal`（库内无旧数据需迁移，但源 KML 仍可能带旧值）
- **复用 F13→F4 两步向导**：清洗规则、主基准判定、冲突覆盖/忽略/取消导冲突 Excel 全部照旧；盖戳发生在解析后、写库前
- **全局去重不变**：冲突检测仍按全局键（Site=SITE ID+OPTION / Road=Property / Lessor=fid），不因分层局限本层
- **Road 改按 `Property` 去重**（原「不做去重」作废）；Lessor `extras` 白名单仍同时排除 `Lessor Category` + `Lessor Cagegory`

**关键文件**：
- `api/routers/imports.py` — `/api/import` 加 operator/category/type 入参 + 几何护栏跳过逻辑 + 盖戳写入；road 去重改 Property
- `api/parsers/kml.py` / `api/parsers/kmz.py` / `api/parsers/xlsx.py` — 解析输出保留几何类型标记供护栏判定；状态值规范化映射
- `api/cleaning.py` — 确认清洗判定对盖戳后的点正常工作（盖戳不影响坐标清洗）
- `api/routers/roads.py` — Road 去重键改 Property（去重逻辑落点）

**验收标准**：
- curl `POST /api/import` 传 `operator=Globe&category=存量&type=Macro` 导入一个 Site KML → 入库行的三列 = 盖戳值，**忽略源文件 operator 属性**
- 几何护栏测试：往 Site 图层导入含线要素的文件 → 线被跳过 + 输出报告「跳过 N 个非点要素」，点正常入库
- 状态规范化测试：源含 `Unknown`/`Friendly` 的 KML 导入 → 库内为 `undermine`/`Normal`
- KMZ 自反一致性回归：盖戳后导出 KMZ 重新导入 100% 命中冲突
- 现有 F13 清洗 + F4 冲突三路径（全忽略/部分覆盖/取消）回归通过

---

## Phase 3: 图层树重构 — F7 浅树 → 固定深层骨架（~100 节点）✅

**交付内容**：
- `LayerTree.tsx` **重写**为固定深层骨架（写死，不随数据生长）：Site → 运营商(Globe/Smart/Dito) → 类别(存量/规划/勘测) → 站型图层 → 状态样式；Road / Lessor 为与 Site 平级的图层根
- 类别→站型写死映射：存量={Macro,Micro,IBS} / 规划={Macro NP,Micro NP} / 勘测={Macro-ongoing,Micro-ongoing}
- **三种节点**：📁 文件夹（无按钮，三态复选框控后代）/ 🔺 图层（**[导入图层] [查看图层要素] 两按钮** + 复选框控全层 + 显示要素总数）/ 🎨 样式（按 site_status 分色图例，无按钮，复选框控该状态子集）
- **去虚拟化**（节点降到 ~100 个，原 13000 节点虚拟化逻辑移除）+ **去顶部树搜索框**
- **[导入图层] 按钮**：接通 Phase 2 后端，把该图层的 operator/category/type 传入 `/api/import`，复用现有 ImportStepper 两步向导
- 节点要素计数：按 operator/category/type 三列聚合查询（后端提供分层计数，或前端按已加载要素聚合）
- 单要素**不进树**：🎨 样式层是最深层；要素移到 Phase 4 列表框
- 地图→树反向定位（F12）：地图选中要素 → 树展开并高亮其所属 🔺 图层 / 🎨 样式节点（按 operator/category/type/status 定位）

**关键文件**：
- `web/src/components/LayerTree.tsx` — 完全重写为固定深层骨架 + 三种节点 + 两按钮
- `web/src/state.ts` — 树状态模型从「平铺三文件夹」改为「深层骨架」；图层显隐状态按 operator/category/type/status 维度
- `web/src/components/ImportStepper.tsx` — 导入入口参数化（接收图层盖戳值），复用现有两步向导 UI
- `web/src/i18n.ts` — 新树节点文案（运营商/类别/站型/状态）中英双语（F18 既有体系）
- `web/src/api.ts` — `/api/import` 调用加 operator/category/type 参数；分层计数接口（如需）
- `api/routers/sites.py` — 如需后端分层计数端点（按三列 GROUP BY）

**验收标准**：
- 树渲染出固定骨架（Globe/Smart/Dito × 3 类别 × 对应站型 + Road + Lessor），节点约 100 个
- 点某图层 [导入图层] → 走两步向导 → 入库后该图层计数 +N，要素出现在对应 🎨 样式分色下
- 复选框三级联动正常（📁 三态控后代 / 🔺 控全层 / 🎨 控状态子集）
- 地图选中一个要素 → 左树自动展开高亮其图层/样式节点
- 中英切换树节点文案正确

---

## Phase 4: 查看图层要素 — 浮动列表框（本层筛选 + 虚拟化）✅

**交付内容**：
- 新建浮动列表框组件，点 🔺 图层的 [查看图层要素] 弹出，列出该层全部要素
- **本版只读**（无编辑/删除按钮）
- **本层筛选框**（精确叫「筛选」，只筛本图层内要素；区别于 F16 右上「搜索」搜全库）
- **点击行 → 地图定位**：复用 F12 双向焦点同步（地图飞到 + 高亮 + 属性面板显示）
- **虚拟化**：承接原树的大数据量（单层可能数千行），固定行高虚拟化渲染，DOM 只渲可视区 + overscan（沿用 #16 LayerTree 已验证的零依赖虚拟化范式）

**关键文件**：
- `web/src/components/LayerFeatureList.tsx` — 新建浮动列表框（虚拟化 + 筛选 + 点击定位）
- `web/src/components/LayerTree.tsx` — [查看图层要素] 按钮接通，传入目标图层标识（operator/category/type 或 Road/Lessor）
- `web/src/state.ts` — 列表框开关状态 + 当前查看图层 + 该层要素子集筛选
- `web/src/api.ts` — 按图层（三列条件）拉取要素列表接口
- `api/routers/sites.py` — 按 operator/category/type 过滤返回该层要素（Road/Lessor 走各自 router）
- `web/src/i18n.ts` — 列表框标题/筛选 placeholder/空态文案双语

**验收标准**：
- 点 [查看图层要素] → 弹浮动列表框，列出该层要素，行数与树节点计数一致
- 筛选框输入 → 只在本层内收窄，不影响其他层 / 不影响 F16 全局搜索
- 点列表行 → 地图飞到该要素 + 高亮 + 属性面板显示
- 单层数千行时滚动流畅（DOM 行数恒定 ≈ 视口+overscan），不卡顿

---

## Phase 5: 渲染 — 形状×颜色 + 50m 辐射圈 + 去 Friendly + 移除全局导入按钮 ✅

**交付内容**：
- **要素样式 = 形状(type) × 颜色(site_status)**：用 OpenLayers `RegularShape` 按站型画形状（Macro ▲ / Micro ● / IBS ■ / Macro NP △ / Micro NP ○ / Macro-ongoing ◆ / Micro-ongoing ◇；points/radius/angle 控形状，fill/stroke 控实心/空心），颜色按状态（positive 绿 / negative 黄 / undermine 红 / 空值灰）
- **50m 辐射圈**：Macro NP / Micro NP 两个规划图层的点额外画 50m 半径透明圆（**仅渲染不入库**、50m 固定不可配）；其余图层不画
- **Lessor 去 Friendly**：样式收窄为 Unfriendly 红面 / Normal 黄面（去掉 Friendly 绿面）
- **移除顶部全局 [📁 导入] 按钮**：导入唯一入口已下沉到图层 [导入图层]（Phase 3 已接通），此时安全移除
- 渲染遵循 #19 地图区护栏：底图/要素样式不参与主题切换（要素颜色是数据语义，非主题色）

**关键文件**：
- `web/src/components/MapView.tsx` — 要素样式函数改为「形状×颜色」查表；规划类加 50m 圈渲染层；Lessor 面去 Friendly
- `web/src/utils.ts` — 形状/颜色映射表（type→shape、site_status→color）；50m → 地图投影半径换算
- `web/src/components/Toolbar.tsx` — 移除顶部全局 [📁 导入] 按钮
- `web/src/state.ts` — 如有全局导入触发状态，清理
- `web/src/i18n.ts` — 移除/调整全局导入按钮相关文案

**验收标准**：
- 地图上 Site 要素按「形状×颜色」正确渲染（如 Globe 存量 Macro 且 positive = 绿色实心三角）
- Macro NP / Micro NP 点周围出现 50m 透明圈，其余站型无圈；缩放时圈随比例尺正确缩放
- Lessor 只有红/黄两种面，无绿面
- 顶部 Toolbar 无全局导入按钮，导入只能从图层 [导入图层] 进入
- 主题亮/暗切换时地图要素颜色不变（数据语义色）；F1–F19 全链路回归通过

---

---

# V1.x #48 增量 — 图层要素列表（site）增删改 + 勾选导出 + 列宽可调

> 在 F20（Phase 1–5 ✅）基础上把「查看图层要素」列表框（`LayerFeatureList`）从**只读**升级为**可操作**。
> **本期仅 site**；road/lessor 仍只读（除列宽可调对三者通用）。详见 Product-Spec.md「要素增删改与勾选导出（site · V1.x #48）」节 + CHANGELOG #48。
>
> **依赖顺序**：Phase 6（后端接口）→ Phase 7（前端接通）；Phase 8（列宽）独立、可任意序，建议最后。
>
> **不许破坏的契约**：全局去重键不变；KMZ 自反一致性；**F17 回滚不丢列（含 site 三列 operator/category/type，Phase 1 教训）**；事务边界；盖戳模型（编辑锁死三列、新建仍走导入）。

## Phase 6: 后端 site 单条编辑 + 批量删除 + 勾选导出 + 恢复点/审计联动

**交付内容**：
- **`PATCH /api/sites/{site_id}/{option}`**（单条编辑）：更新业务属性（`project` / `site_status` 等）+ 坐标 `lati`/`longi`；坐标变更时**同步重算 geom** = `ST_SetSRID(ST_MakePoint(longi, lati), 4326)`；**拒绝修改** `operator`/`category`/`type`（盖戳三列）与 `site_id`/`option`（主键）——请求带这些字段变更则 400（或忽略且不写）；成功写审计 `edit_site`；返回更新后的 site feature。
- **`POST /api/sites/delete`**（批量删除）：入参 `{keys: [{site_id, option}, ...]}`；**事务内先 `create_restore_point(conn, reason="pre_feature_delete")` 建点**，再 `DELETE FROM site WHERE (site_id, "option") IN (...)`；写审计 `delete_site`（details 记删除条数 + `restore_point_id`）；返回 `{deleted: N, restore_point_id}`。
- **`POST /api/export/selection_ids`**（勾选导出）：入参 `{keys: [{site_id, option}, ...], np_radius_m?}`；按主键子集从 site 表取行 → 复用 `_build_kmz_meta(scope="region", ...)` + `_kmz_response` 打包 KMZ；NP 站型照 #46 随点带圈；写审计 `export_region`（`mode="list"`）。
- **枚举同步**：`restore_point_helper.create_restore_point` 的 reason 接受 `pre_feature_delete`（若有 reason 白名单/CHECK 则同步）；审计动作枚举/校验加 `edit_site`/`delete_site`（若 `audit.py` 有 ACTIONS 白名单）。

**关键文件**：
- `api/routers/sites.py` — 现仅 `GET ""`；新增 `PATCH /{site_id}/{option}`（update + geom 重算 + 拒改盖戳）+ `POST /delete`（批量 + 恢复点）两端点
- `api/routers/exports.py` — 新增 `POST /selection_ids`（按主键子集；复用 `_fetch_rows` 思路或直查 site + `_build_kmz_meta`/`_kmz_response`，:71/:85）
- `api/restore_point_helper.py` — `create_restore_point`（:11）支持 `reason="pre_feature_delete"`
- `api/audit.py` — `write_audit`（:55）动作枚举加 `edit_site`/`delete_site`
- `api/routers/restore_points.py` — 无需改；回归验证 `pre_feature_delete` 点经现有 `restore_from_snapshot`（:115）回滚正常

**验收标准**：
- curl `PATCH` 改一条 site 的 `site_status` + `lati`/`longi` → 库内值更新、`ST_AsGeoJSON(geom)` 坐标 = 新经纬度；带 `operator` 变更被拒（400 或库内盖戳不变）
- curl `POST /api/sites/delete` 删 3 条 → 返回 `deleted=3` + `restore_point_id`；site 表少 3 行；restore_point 表多 1 条 `reason=pre_feature_delete`
- **回滚验证（硬卡点）**：delete 后走现有恢复点回滚 → 3 行完整恢复，**operator/category/type 三列不丢**（Phase 1 教训）
- curl `POST /api/export/selection_ids` 传 2 个主键 → KMZ 仅含这 2 个 site（NP 站型带圈）
- 审计表出现 `edit_site` / `delete_site` / `export_region(mode=list)` 记录
- 现有 F1–F20 + #47 链路回归通过（导入/清洗/冲突/导出/搜索/恢复点/审计不报错）

## Phase 7: 前端列表框 site 增删改 + 勾选导出（接通 Phase 6）

**交付内容**：
- **行前多选列**：`LayerFeatureList` 每行最前加 checkbox；表头放全选/反选（仅作用当前 `filtered` 子集，与筛选口径一致）。
- **单行编辑**：site 行 [✏️ 编辑] → 弹编辑表单（小 modal 或 inline 面板）——业务属性 + `lati`/`longi` 可改；`site_id`/`option`/`operator`/`category`/`type` **只读置灰**；保存调 `PATCH`，成功后局部刷新该行 + 地图点位/颜色。
- **批量删除**：[🗑️ 删除选中]（勾选≥1 行启用）→ 确认 modal（显示将删条数）→ 调 `POST /api/sites/delete` → 成功后从列表/地图移除 + 提示「已删 N 条，可在恢复点回滚」。
- **勾选导出**：[💾 导出选中]（勾选≥1 行启用）→ 调 `POST /api/export/selection_ids` → 浏览器下载 KMZ。
- **仅 site 显示**：`target.kind === "site"` 才渲染操作列 + 三个按钮；road/lessor 列表不渲染（仍只读）。
- **数据同步**：编辑/删除后刷新 site `FeatureCollection`（复用现有拉取或局部更新），树计数 + 地图渲染随之更新。
- 双语文案（表单标题/字段标签/删除确认/导出/成功提示）。

**关键文件**：
- `web/src/components/LayerFeatureList.tsx` — 多选列 + 操作列 + 编辑表单 + 删除确认 + 导出按钮（均 `kind==="site"` 门控）
- `web/src/state.ts` — 选中行集合 state + 编辑/删除/导出动作 + site 数据刷新钩子
- `web/src/api.ts` — `patchSite` / `deleteSites` / `exportSelectionIds` 三个调用
- `web/src/i18n.ts` — #48 文案双语
- （可选）`web/src/components/EditSiteForm.tsx` — 编辑表单小组件（亦可内联在 LayerFeatureList）

**验收标准**：
- site 列表每行有复选框 + [编辑]；表头全选 → 当前 filtered 全勾
- 编辑一行 `site_status` + 坐标 → 保存 → 列表该行更新、地图点位/颜色随之变；主键/盖戳字段置灰不可改
- 勾选 3 行 → [删除选中] → 确认 → 列表少 3 行、地图少 3 点、提示可回滚；恢复点对话框出现 `pre_feature_delete` 点
- 勾选 2 行 → [导出选中] → 下载 KMZ 仅含这 2 站
- road/lessor 列表**无**多选/编辑/删除/导出（仍只读）
- 中英切换 #48 文案正确；F1–F20 + #47 前端链路回归通过

## Phase 8: 列表框列宽可拖调（类 Excel · 三 kind 通用）

**交付内容**：
- **列宽拖拽**：表头每列右边界加拖拽手柄，拖动手动调该列宽；最小列宽 48px 守卫；拖动走 `requestAnimationFrame` 节流（与 #30/#43 窗口拖缩一致）。
- **与 #31 等比拉伸混排**：列一旦手动拖过 → 转**手动固定宽**，不再参与 #31「随窗口等比拉伸」；**未拖过的列**仍按 #31 等比填充剩余内容区；总宽超内容区 → 横向滚动（沿用 #31 下限）。
- **双击自适应**：双击列分隔手柄 → 该列按内容最宽值自适应，并**清掉该列手动宽、还原自动**（Excel 双击惯例）。
- **持久化**：手动列宽存 `localStorage`（key 按 kind + 列 key，如 `presurvey.lfl.col.site.lati`），开窗恢复；未拖列不写。
- **三 kind 通用**：site/road/lessor 列表都享受；与 #48 增删改**正交**（多选列宽固定不可拖）。

**关键文件**：
- `web/src/components/LayerFeatureList.tsx` — 列宽 state（手动宽 `Record<colKey, number>`）+ 表头拖拽手柄 + 双击自适应 + 改造 #31 渲染（手动列固定宽、其余列等比）
- `web/src/index.css`（或对应样式文件）— 列分隔手柄样式（`cursor: col-resize` + hover 高亮）
- （可选）列宽 localStorage 读写 + 内容测宽工具函数（内联或 utils）

**验收标准**：
- 拖某列右边界 → 该列变宽/窄，其余未拖列仍等比填充；刷新后手动宽恢复
- 双击分隔线 → 该列按内容自适应，且回到「未手动」态（清该列 localStorage）
- 列宽不可拖到 < 48px；拖动不掉帧（rAF）
- site/road/lessor 三种列表都能调列宽
- 与 #48 编辑/删除/勾选共存不冲突；F1–F20 + #47 回归通过

---

# V1.x #49 增量 — 删除回滚改轻量「撤销删除」

> #48 删除复用 F17 全表快照，3W 节点删 1 个要复制整表（O(全表)）。#49 改为只存被删的几行（O(删除数)）。详见 CHANGELOG #49。
> **依赖**：在 #48 Phase 6/7 已入库基础上改。

## Phase 9: 删除轻量撤销 — site_delete_undo + undo 端点 + 前端撤销 + 测试改写

**交付内容**：
- **新表 `site_delete_undo`**（`deploy/db/init.sql` + 迁移 `deploy/migrations/V3__add_site_delete_undo.sql`，幂等 `CREATE TABLE IF NOT EXISTS`）：镜像 site 全列 + `undo_id BIGINT`（批次）+ `deleted_at TIMESTAMPTZ` + `undone BOOLEAN DEFAULT false`（已撤销标记）。
- **改 delete 实现**（`api/routers/sites.py`）：去掉 `create_restore_point` 调用；事务内**先** `INSERT INTO site_delete_undo SELECT <undo_id>,... FROM site WHERE keys`（捕获被删行）**再** `DELETE`；环形保留最近 **200** 个删除批次（按 undo_id 淘汰最旧）；返回 `{deleted, undo_id}`。审计 `delete_site` details 记 `undo_id`。
- **新端点 `GET /api/sites/delete-history`**（`api/routers/sites.py`）：列最近批次（undo_id/deleted_at/条数/图层摘要/站点名摘要/undone，按时间倒序，仅列 undone=false 或全列由前端区分）。
- **新端点 `POST /api/sites/undo-delete/{undo_id}`**（`api/routers/sites.py`）：`INSERT INTO site SELECT ... FROM site_delete_undo WHERE undo_id=$1 AND undone=false ON CONFLICT (site_id,"option") DO NOTHING`；该批次 `undone=true`；返回 `{restored, requested}`；审计 `undo_delete_site`。
- **前端 = 持久「删除历史」面板**（`web/src/`）：**工具栏新增 [🗑️ 删除历史] 按钮**（`Toolbar.tsx`，与 [🕘 恢复点] 并列）打开面板组件（新建 `DeleteHistoryPanel.tsx` 或复用恢复点对话框样式）；面板 `GET /api/sites/delete-history` 拉列表，每批显示「时间·删N条·图层·站点名摘要」+ [撤销]；点 [撤销] → `undoDelete(undo_id)` → 成功 refresh + rebindSelected + 该批移出列表 + 提示恢复数。删除成功 toast 改为「已删 N 条（可在 🗑️ 删除历史 撤销）」。`api.ts` 加 `fetchDeleteHistory`/`undoDelete`；`state.ts` 加 `doUndoDelete` + 面板开关 state。
- **测试改写**（`api/tests/test_site_crud_48.py` 或新 `test_site_undo_49.py`）：delete 测试的调用序列断言由 `[tx_enter→restore_point→delete→tx_exit]` 改为 `[tx_enter→capture_undo→delete→tx_exit]`（不再有 restore_point）；新增 undo 端点测试（再插回 + ON CONFLICT 跳过 + 审计 undo_delete_site）。
- `pre_feature_delete` reason 弃用（不动 CHECK，删除不再产生该 reason）。

**关键文件**：
- `deploy/db/init.sql` — 新增 `site_delete_undo` 表（幂等）
- `deploy/migrations/V3__add_site_delete_undo.sql` — 已部署库建表迁移
- `api/routers/sites.py` — delete 改捕获 undo（去 create_restore_point）+ 新增 undo-delete 端点 + 200 环形淘汰
- `api/tests/test_site_crud_48.py`（改）/ 新增 undo 测试
- `web/src/api.ts` — `fetchDeleteHistory()` + `undoDelete(undo_id)`
- `web/src/state.ts` — `doUndoDelete` + `doDeleteSites` 持 undo_id + 删除历史面板开关 state
- `web/src/components/Toolbar.tsx` — 新增 [🗑️ 删除历史] 按钮（与 [🕘 恢复点] 并列）
- `web/src/components/DeleteHistoryPanel.tsx`（新建，可参照恢复点对话框样式）— 列批次 + 每批 [撤销]
- `web/src/i18n.ts` — 删除历史/撤销文案 en/zh

**验收标准**：
- 删 N 条 → `site` 少 N 行、`site_delete_undo` 多 N 行（同一 undo_id）、**未产生 restore_point**；返回含 undo_id。
- POST undo-delete → N 行回到 site；主键被重新占用的跳过、返回实际恢复数。
- 3W 规模删 1 个：undo 表只写 1 行（O(删除数)），无全表快照（对比 #48）。
- 环形 200：超出淘汰最旧批次。
- 工具栏 [🗑️ 删除历史] → 面板列出最近批次（时间·删N条·图层·站点名摘要）；点某批 [撤销] → 列表/地图/树恢复 + 该批移出列表（undone）。
- `GET /api/sites/delete-history` 返回批次列表正确（倒序、含摘要、undone 标记）。
- 审计 `delete_site`(含 undo_id) / `undo_delete_site` 落库。
- pytest 改写后全绿；F17 恢复点（导入/清库/手动）链路不受影响回归通过。

---

## 技术栈（沿用现有，零新引入）

| 层级 | 技术 | 版本 | 说明 |
|------|------|------|------|
| 前端 | React + TypeScript | 现有 | 沿用 F1–F19 |
| 地图 | OpenLayers | 现有 | F20 用 `RegularShape` 画站型形状（标准 API，无新依赖）|
| 后端 | Python + FastAPI | 现有 | 导入器加盖戳 + 几何护栏 |
| 数据库 | PostgreSQL 16 + PostGIS | `postgis/postgis:16-3.4` | site 加 3 列 + snapshot 同步 |
| 解析 | fastkml/pykml + openpyxl | 现有 | 状态值规范化 |
| 国际化 | 自建轻量 i18n（en/zh） | 现有 | F18 体系，新增节点文案 |
| 部署 | Docker + 腾讯云 | 现有 | init.sql 幂等升级 |

## 数据库表（F20 改动）

| 表名 | 所属 Phase | 改动 |
|------|-----------|------|
| `site` | Phase 1 | 新增 `operator` / `category` / `type` 三列（可空，导入盖戳）|
| `site_snapshot` | Phase 1 | 同步新增三列（F17 回滚不丢列）|
| `road` | Phase 2 | 去重键改 `Property`（DDL 不变，逻辑变）|
| `lessor` | Phase 2 | relationship 仅 Unfriendly/Normal（DDL 不变，值变）|

> 无新建表。F17 的 restore_point / road_snapshot / lessor_snapshot / baseline_state_snapshot / audit_log 等表不动。

## 开发规则

- 每完成一个 Phase 执行四步走：Code Review → 测试完整性 → 编译验证 → 功能测试
- 四步走全部通过后才能 commit
- Commit message 格式：`phase-N: 简要描述`（F20 增量，建议带 `F20`/`#24` 标识）
- **依赖顺序硬约束**：Phase 1（数据层）必须先于 2/3/4/5；Phase 5「移除全局导入按钮」必须在 Phase 3「[导入图层] 接通」之后（否则无导入入口）
- **每个 Phase 必做回归**：F1–F19 已上线，任何 Phase 不得破坏现有链路（导入/清洗/冲突/导出/搜索/恢复点/审计/双语/双主题）
- 包管理器：npm（web/）；Python venv（api/）
- 数据库升级走 `docker compose restart db` + 执行幂等 init.sql（见 DEPLOY.md，macOS bind mount 缓存坑）
