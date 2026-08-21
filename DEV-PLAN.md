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

# V1.x #50 增量 — 用户与角色权限（登录页 + RBAC）

> 推翻 V1「不做账号鉴权」Pinned 边界。新增登录体系 + 功能权限 × 数据权限（图层文件夹节点，子级继承，查看=编辑同权）+ [⚙管理] Modal（用户/角色/审计/备份收编）。详见 Product-Spec.md「用户与角色权限（F22 · V1.x #50）」节 + CHANGELOG #50。
>
> **依赖顺序**：Phase 10（数据层）→ 11（认证）→ 12（管理接口+权限门控）→ 13（前端登录管线）→ 14（管理 Modal）→ 15（前端权限渲染+收尾）。13 依赖 11；14 依赖 12+13；15 依赖 13、14。
>
> **不许破坏的契约**：全局去重键不变；KMZ 自反一致性；F17 回滚不丢列；事务边界；盖戳模型；F19 审计后端约束（无 DELETE/PATCH、永久保留、元审计）。**数据权限是读取/操作过滤层，不改写库逻辑**。
>
> **新依赖**：`bcrypt==5.0.0`（api/requirements.txt；≥3.8 兼容，有 cp312 abi3 wheel；5.x 起密码超 72 字节报错而非静默截断——密码校验须拒 >72 字节输入）。

## Phase 10: 数据层 — 4 张新表 + audit_log 加列 + admin 种子

**交付内容**：
- 新表 `app_user`：`id BIGSERIAL` 主键 / `username TEXT UNIQUE NOT NULL` / `password_hash TEXT NOT NULL` / `role_id BIGINT REFERENCES app_role(id)` / `disabled BOOLEAN DEFAULT false` / `must_change_password BOOLEAN DEFAULT true` / `created_at TIMESTAMPTZ DEFAULT now()`。
- 新表 `app_role`：`id BIGSERIAL` 主键 / `name TEXT UNIQUE NOT NULL` / `is_admin BOOLEAN DEFAULT false` / `perms JSONB NOT NULL DEFAULT '{}'`（4 开关：`import`/`export`/`edit_delete`/`danger`，布尔值，缺省 false）/ `created_at`。
- 新表 `app_role_scope`：`id BIGSERIAL` 主键 / `role_id BIGINT REFERENCES app_role(id) ON DELETE CASCADE` / `scope_node TEXT NOT NULL`（取值域：`site` / `site:Globe` / `site:Smart` / `site:Dito` / `site:Globe:EXISTING` … `site:<运营商>:<EXISTING|PLANNED|SURVEY>` / `road` / `lessor`），`UNIQUE(role_id, scope_node)`。
- 新表 `auth_session`：`token TEXT PRIMARY KEY`（URL-safe 随机 32 字节）/ `user_id BIGINT REFERENCES app_user(id) ON DELETE CASCADE` / `expires_at TIMESTAMPTZ NOT NULL` / `created_at TIMESTAMPTZ DEFAULT now()`；`expires_at` 建索引（清理用）。
- `audit_log` 表 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS username TEXT`（可空，未登录请求记空）。
- **admin 种子**（幂等）：无 admin 角色则插 `name='admin', is_admin=true`；无 admin 用户则插 `username='admin', password_hash=bcrypt('admin123'), must_change_password=true`（bcrypt 哈希在建表后由 api 启动种子逻辑完成，init.sql 只建结构、不写哈希——哈希生成放 `api/main.py` lifespan 启动钩子，判空再插）。
- `deploy/migrations/V4__add_rbac.sql`：上述 4 表 + audit_log 加列，全幂等（`CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`），已部署库升级用。
- `init.sql` 同步加 4 表结构 + audit_log 列（新部署首跑即有）。

**关键文件**：
- `deploy/db/init.sql` — 4 张新表 DDL + `audit_log` 加 `username` 列（幂等）
- `deploy/migrations/V4__add_rbac.sql` — 新建，已部署库迁移
- `api/requirements.txt` — 加 `bcrypt==5.0.0`
- `api/main.py` — lifespan 启动种子：admin 角色 + admin 用户（判空幂等；bcrypt 哈希在此生成）

**验收标准**：
- 空库启动后 `\d app_user / app_role / app_role_scope / auth_session` 结构齐全；`\d audit_log` 含 `username` 列
- 启动后 `SELECT username, must_change_password FROM app_user` 有 `admin/t` 一行；`app_role` 有 `admin/is_admin=t` 一行
- 重复重启容器种子不重复插入（幂等）；V4 迁移在已有库（v1.0.6 结构）上重复执行不报错

## Phase 11: 后端认证 — login/logout/me + 鉴权中间件 + 登录审计

**交付内容**：
- 新建 `api/auth.py`：`hash_password`（bcrypt，拒 >72 字节）/ `verify_password` / `create_session`（`secrets.token_urlsafe(32)`，expires=now+7d）/ `resolve_user(token)`（查 auth_session JOIN app_user，过期/禁用 → None；命中则**滑动续期** expires_at=now+7d）/ `revoke_sessions(user_id)`（禁用/重置密码时调）/ 定时清理过期 session（挂在现有 backup_scheduler 同款调度或启动任务，每日一次）。
- 新建 `api/routers/auth.py`：
  - `POST /api/auth/login` `{username, password}` → 校验用户存在/未禁用/密码 → 成功写审计 `login`（username）+ 返回 `{token, user: {username, is_admin, perms, scopes, must_change_password}}`（不含 role——Phase 13 前端 state 不消费，review 裁决划掉）；失败写 `login_failed`（记尝试账号）+ 401。**连续失败 5 次锁 10 分钟**（内存计数器按 username+IP，重启清零可接受；**已知接受项**：锁定键的 IP 半取自 XFF、客户端可轮换绕过——符合 Spec「防内网脚本爆破，够用即止」威胁模型，review 裁决接受不修复）。
  - `POST /api/auth/logout` → 删当前 token 行 + 审计 `logout`。
  - `GET /api/auth/me` → 返回当前用户 + 角色 perms + scopes（前端启动拉一次）。
  - `POST /api/auth/change-password` `{old_password, new_password}` → 校验旧密码 + 新密码 ≥8 位 ≤72 字节 → 改 hash + `must_change_password=false` + **吊销该用户其他全部 session**（保留当前）。
- 鉴权中间件（`api/main.py` 挂载，在现有 audit_middleware 之前）：除白名单（`POST /api/auth/login`、`GET /health`）外所有 `/api/*` 请求校验 `Authorization: Bearer` token → 无效/过期/禁用 → **401** `{detail:"unauthenticated"}`；有效则把 `user` 对象挂到 `request.state.user` 供下游权限门控和审计使用。
- 审计写入路径（`api/audit.py`）补 `username` 字段：从 `request.state.user` 取（未登录=login/health 路径记 NULL）。

**关键文件**：
- `api/auth.py` — 新建（hash/session/续期/吊销/清理）
- `api/routers/auth.py` — 新建（login/logout/me/change-password）
- `api/main.py` — 挂 auth router + 鉴权中间件（白名单 login/health）+ lifespan 挂 session 清理任务
- `api/audit.py` — `write_audit` 加 `username` 参数/取 `request.state.user`
- `api/audit_middleware.py` — session_id cookie 逻辑不动；确认与鉴权中间件顺序（鉴权先跑）
- `api/tests/test_auth_50.py` — 新建：login 成功/失败/锁定、me、logout 吊销、过期拒访、滑动续期、change-password 吊销其他 session（monkeypatch 范式同 test_site_crud_48.py）

**验收标准**：
- 无 token 调 `GET /api/sites` → 401；错 token → 401；有效 token → 200
- login 错密码 5 次 → 第 6 次 401/429 且提示锁定；`audit_log` 有 5 条 `login_failed`（username 记尝试账号）
- login 成功 → `audit_log` 有 `login` 行且 `username='admin'`；`GET /api/auth/me` 带 token 返回 is_admin=true
- 改密后旧 token（其他 session）401，当前 session 仍可用；pytest test_auth_50.py 全绿 + 既有 48 条测试无回归

## Phase 12: 后端管理接口 + 功能权限门控 + 数据权限过滤

**交付内容**：
- 新建 `api/routers/admin.py`（全部要求 `is_admin`，否则 403）：
  - `GET /api/admin/users` → 用户列表（id/username/role/disabled/created_at）
  - `POST /api/admin/users` `{username, role_id, password}` → 建号（`must_change_password=true`）；审计 `user_manage`（details: 目标用户+create）
  - `POST /api/admin/users/{id}/reset-password` `{password}` → 重设 + 吊销该用户全部 session；审计 `user_manage`（reset）
  - `POST /api/admin/users/{id}/toggle-disabled` → 禁用/启用；禁用即吊销全部 session；审计 `user_manage`（disable/enable）；**admin 用户（is_admin 角色的用户）拒禁用**（400）
  - `GET /api/admin/roles` → 角色列表（含 perms + scopes + 挂载用户数）
  - `POST /api/admin/roles` `{name, perms, scopes[]}` → 建角色；审计 `role_manage`（details: 角色名+权限快照）
  - `PATCH /api/admin/roles/{id}` → 改 perms/scopes/name；**is_admin 角色拒改**（400）；审计 `role_manage`
  - `DELETE /api/admin/roles/{id}` → **is_admin 拒删**；**有用户挂载拒删**（400 提示先迁用户）；审计 `role_manage`
- 功能权限门控（依赖注入 `require_perm("import"|"export"|"edit_delete"|"danger")`，非 admin 且无该 perm → 403）：
  - `import`：`/api/import*`（imports.py 全端点）
  - `export`：`/api/export/*`（exports.py 整库/选区/selection_ids）
  - `edit_delete`：`PATCH /api/sites/{...}` / `POST /api/sites/delete` / `POST /api/sites/undo-delete/{id}`
  - `danger`：`/api/restore-points*` 全部 + `POST /api/baseline/clear`（baseline.py 清除端点）
  - admin 角色恒过全部门控；审计日志端点（`/api/audit-log*`）与备份端点（`/api/backups*`）改 **admin-only**（收编进管理界面）。
- **数据权限过滤**（核心）：`auth.py` 加 `visible_scopes(user) → list[str]`（admin → 全量哨兵）；把 scope 集合换算成 site 过滤条件（`operator`/`category` 子集对，如 `site:Globe` → operator='Globe' 全部；`site:Globe:SURVEY` → operator='Globe' AND category='勘测'——注意 scope 英文节点名到库内中文类别值的映射表放 `auth.py` 单一真源）+ road/lessor 布尔可见性。落点：
  - `GET /api/sites` / `GET /api/roads` / `GET /api/lessors`：SQL WHERE 追加 scope 过滤（不可见类型直接返回空 FeatureCollection）
  - exports.py 三端点：同一过滤（选区/勾选导出也不可越权导出）
  - imports.py：盖戳目标图层必须在可见 scope 内（否则 403）
  - F16 全局搜索若走前端已加载数据则天然受限（后端已过滤），若有独立搜索端点同步加过滤
  - `DELETE /api/sites/delete` / `PATCH` / `undo-delete`：目标行必须在可见 scope 内（越权行跳过并报数，不静默成功）
- 审计 `user_manage` / `role_manage` 写入；登录态请求审计 `username` 全链路贯通。

**关键文件**：
- `api/routers/admin.py` — 新建（users/roles CRUD + 全部守卫）
- `api/auth.py` — `visible_scopes` / scope→SQL 条件换算（含英文节点名↔中文类别映射表）/ `require_perm` 依赖
- `api/routers/sites.py` / `roads.py` / `lessors.py` — GET 加 scope WHERE；PATCH/delete/undo 加行级 scope 校验
- `api/routers/exports.py` — 三端点加 scope 过滤 + `export` perm 门控
- `api/routers/imports.py` — `import` perm + 盖戳目标 scope 校验
- `api/routers/restore_points.py` / `baseline.py` — `danger` perm 门控
- `api/routers/audit.py` / `backups.py` — admin-only
- `api/tests/test_admin_50.py` / `test_scope_filter_50.py` — 新建（monkeypatch 范式：admin 守卫、角色删除守卫、scope 换算表、越权行跳过、导出过滤）

**验收标准**：
- 非 admin 无 `import` perm 调 `/api/import` → 403；有 perm 但目标图层不可见 → 403
- `Globe PM`（scope=site:Globe）`GET /api/sites` 只含 operator='Globe' 行；`GET /api/roads` 返回空（未勾 road）；选区导出 KMZ 只含 Globe 点
- `执行者`（scope=三家 SURVEY）只见 operator×category=勘测 的子集
- 非 admin 调 `/api/admin/*` / `/api/audit-log*` / `/api/backups*` → 403
- 删有用户挂载的角色 → 400；改 admin 角色 → 400；禁用 admin 用户 → 400
- 审计出现 `user_manage`/`role_manage` 且带 username；pytest 新测试全绿 + 既有测试无回归

## Phase 13: 前端登录页 + token 管线 + 首登强制改密

**交付内容**：
- 新建 `LoginPage.tsx`（全屏页）：账号/密码输入 + [登录]；错误提示（401=账号或密码错 / 锁定提示）；登录成功存 token 到 `localStorage`（key `presurvey.token`）→ 拉 `/api/auth/me` → 进主界面。
- `api.ts` 全局改造：所有请求自动带 `Authorization: Bearer <token>`；响应 401 → 清 token + 跳登录页（统一拦截点，不逐调用处处理）。
- `App.tsx` 启动闸门：无 token → 渲染 LoginPage；有 token → 先 `GET /api/auth/me` 验证（失败清 token 回登录页）→ 通过才渲染主界面（树/地图/面板全部在 me 成功后挂载，避免先闪一屏全量数据）。
- **首登强制改密**：`me.must_change_password=true` → 强制弹改密 Modal（不可关闭，旧密码+新密码≥8位+确认），改完才能进主界面。
- `Toolbar.tsx`：右端显示当前 `username` + [登出]（调 logout → 清 token → 回登录页）+ **[⚙ 管理] 按钮仅 `is_admin` 渲染**（Phase 14 接通 Modal）。
- `state.ts`：当前用户 state（username/is_admin/perms/scopes）+ login/logout action。
- i18n 双语（登录页/改密/登出/错误提示）。

**关键文件**：
- `web/src/components/LoginPage.tsx` — 新建
- `web/src/api.ts` — token 注入 + 401 拦截 + auth/login/logout/me/change-password 调用
- `web/src/App.tsx` — 启动闸门（LoginPage ↔ 主界面）+ 强制改密 Modal
- `web/src/state.ts` — auth state + login/logout/changePassword action
- `web/src/components/Toolbar.tsx` — username + [登出] + [⚙]（admin 门控渲染）
- `web/src/i18n.ts` — #50 文案双语

**验收标准**：
- 无 token 访问 → 只见登录页；错误密码提示明确；admin/admin123 首登 → 强制改密（关不掉）→ 改完进主界面
- 主界面仅在 me 验证通过后挂载（DevTools Network 确认业务数据请求都在 me 之后）
- Toolbar 显示用户名；[登出] → 回登录页且旧 token 调 API 401；非 admin 登录 → 无 [⚙] 按钮
- token 过期（可后端手动改 expires_at 模拟）→ 下一请求 401 → 自动回登录页
- F18 中英切换登录页文案正确；现有界面（登录后）无视觉回归

## Phase 14: 前端管理 Modal — 用户管理 + 角色管理 + 审计/备份收编

**交付内容**：
- 新建 `AdminModal.tsx`（全屏遮罩 Modal，风格同 AuditModal），四个 tab：**用户 / 角色 / 审计日志 / 备份恢复**。
- **用户 tab**：表格（用户名/角色/状态/创建时间）+ [新建用户]（用户名 + 角色下拉 + 初始密码）+ 行操作 [重置密码]（弹输入新密码）/ [禁用·启用]；admin 用户行禁用操作置灰（title 提示不可禁用）。
- **角色 tab**：角色列表 + [新建角色]/[编辑]/[删除]；编辑表单 = 名称 + 4 个功能权限 checkbox（导入/导出/编辑删除/高危操作）+ **文件夹权限勾选树**（复刻 LayerTree 骨架：SITE→运营商→类别 / Road / Lessor，三态 checkbox，勾父全选子，子级继承语义）；删除有用户挂载的角色 → 后端 400 错误透出提示；admin 角色行只读。
- **审计 tab**：现有 `AuditModal.tsx` 内容搬入为 tab（不改其内部逻辑）。
- **备份 tab**：现有 `BackupRestoreDialog.tsx` 内容搬入为 tab。
- `api.ts` 加 admin 系列调用（users/roles CRUD）。

**关键文件**：
- `web/src/components/AdminModal.tsx` — 新建（四 tab 框架 + 用户 tab + 角色 tab）
- `web/src/components/AuditModal.tsx` — 改为可作为 tab 嵌入（props 适配，逻辑不动）
- `web/src/components/BackupRestoreDialog.tsx` — 同上
- `web/src/components/Toolbar.tsx` — [⚙] 接通 AdminModal
- `web/src/api.ts` / `web/src/state.ts` — admin 调用 + Modal 开关 state
- `web/src/i18n.ts` — 管理界面文案双语

**验收标准**：
- admin 点 [⚙] → 四 tab 齐全；建 `Globe PM` 角色（勾 site:Globe + 三功能权限）→ 角色列表出现；建用户 `globe_pm1` 挂该角色 → 用户列表出现
- 用 globe_pm1 登录（强制改密后）→ 只见 Globe 目录（Phase 15 完整验证）
- 角色树三态勾选：勾 Globe → 其下类别全勾；取消子项 → 父转半选；保存后 scopes 与勾选一致
- 删除挂着 globe_pm1 的角色 → 提示不可删；重置密码后旧 session 401；审计/备份 tab 功能与原独立 Modal 一致
- 中英切换管理界面文案正确

## Phase 15: 前端权限渲染 + 隐藏入口拆除 + 回归收尾

**交付内容**：
- **数据权限隐藏**（按 `me.scopes` 前端收窄渲染，与后端过滤对齐）：`LayerTree.tsx` 不渲染无权限文件夹/图层/样式节点；`MapView.tsx` 不渲染无权限要素（后端已过滤，前端双保险）；`LayerFeatureList` 入口只对有权限图层可达；树节点计数与可见数据一致。
- **功能权限按钮门控**（按 `me.perms`）：无 `import` → 图层 [导入图层] 按钮不渲染；无 `export` → Toolbar [导出 KMZ]、列表框 [导出选中] 不渲染；无 `edit_delete` → 列表框多选列/[编辑]/[删除选中]/Toolbar [删除历史] 不渲染；无 `danger` → [清除基线]/[恢复点] 不渲染。
- **隐藏入口拆除**：删 `useEscTrigger`（3×ESC）与 3×B 键盘监听、`AuditPasswordPrompt.tsx` 组件及 i18n 相关文案；审计/备份唯一入口 = [⚙ 管理]。
- **回归测试补全**：`test_scope_filter_50.py` / `test_admin_50.py` / `test_auth_50.py`（Phase 11/12 已建）+ 既有 48 条全量重跑；前端构建零 TS 错误。
- **DEPLOY 注意**：V4 迁移进离线包部署脚本（参照 V2/V3 接线方式）；部署文档补 admin 初始密码说明。

**关键文件**：
- `web/src/components/LayerTree.tsx` / `MapView.tsx` / `LayerFeatureList.tsx` — scopes 过滤渲染
- `web/src/components/Toolbar.tsx` — perms 门控 + 去隐藏入口触发
- `web/src/hooks/`（useEscTrigger 所在）— 删除 3×ESC/3×B 监听
- `web/src/components/AuditPasswordPrompt.tsx` — 删除文件
- `web/src/App.tsx` / `web/src/state.ts` / `web/src/i18n.ts` — 清理隐藏入口残留
- `deploy/deploy.sh` 或 `deploy/prod/`（V2/V3 迁移接线处）— V4 迁移进部署链路
- `deploy/README.md` 或 `DEPLOY.md` — 补 admin 初始密码 + 首登改密说明

**验收标准**：
- globe_pm1 登录：树只见 SITE→GLOBE（Smart/Dito/Road/Lessor 无）；地图无别家点；搜索/导出结果只有 Globe
- 执行者角色登录：只见三家 SURVEY 目录；无 [导入]/[编辑]/[删除] 按角色 perms 门控正确
- 连按 3×ESC / 3×B 无任何反应；代码库 grep 无 `mangosv5` 残留
- 非 admin 浏览器直接敲 URL 无管理界面入口；admin 全流程可用
- pytest 全量绿（既有 48 + 新增）；`npm run build` 零错误；docker compose 重部署冒烟通过

---

# V1.x #51 增量 — AREA 运营商区域面图层（第四类实体）

> 每个运营商目录下新增 AREA 文件夹 + 面图层，承载区域划分 KMZ。全链路同 site 待遇。详见 Product-Spec.md「AREA 区域面图层（F23 · V1.x #51）」节 + CHANGELOG #51。
>
> **样例契约（data/NCR_BCA.kmz 实解）**：158 个 Placemark；几何 = MultiGeometry 包 Polygon；**无 Schema/SchemaData**，属性走 `<ExtendedData><Data name>`（Name / polygon_id / geozone_pr / new_polygo）；内嵌样式导入忽略。
>
> **依赖顺序**：Phase 16（数据层）→ 17（后端全链路）→ 18（前端）→ 19（回归收尾）。
>
> **不许破坏的契约**：全局去重键（area = operator+name）；KMZ 自反一致性（扩第四类 schema #area）；F17 回滚不丢列（含 area_snapshot）；事务边界；#50 权限过滤全链路。

## Phase 16: 数据层 — area 表 + area_snapshot + V5 迁移

**交付内容**：
- 新表 `area`：`id BIGSERIAL PRIMARY KEY` / `name TEXT NOT NULL` / `operator TEXT NOT NULL`（盖戳 Globe/Smart/Dito）/ `geom GEOMETRY(Polygon, 4326)`（MultiPolygon 源取最大面或展开，实现时定并注释）/ `extras JSONB DEFAULT '{}'` / `created_at TIMESTAMPTZ DEFAULT now()`；`UNIQUE(operator, name)`（去重键 DB 级兜底）
- 新表 `area_snapshot`：镜像 area 列 + `restore_point_id`（对照 site_snapshot 现有结构照抄模式）
- `deploy/migrations/V5__add_area.sql` + `deploy/db/init.sql` 同步（全幂等）
- F17 快照链路三处同步：`restore/helper.py` 建点 + `restore/router.py` 回滚 都纳入 area/area_snapshot（**回滚不丢列教训：照 site 模式逐列显式**）
- `_cloud_reset_db` TRUNCATE 清单加 area（**重复犯错模式警示：新表必进 reset 清单**）

**关键文件**：
- `deploy/db/init.sql`、`deploy/migrations/V5__add_area.sql`（新建）
- `api/restore/helper.py`、`api/restore/router.py`
- `deploy/deploy.sh`（reset 清单）

**验收标准**：
- 空库启动 `\d area` / `\d area_snapshot` 结构齐全；V5 重复执行零 ERROR
- 端到端回滚：area 有数据 → 建恢复点 → 改数据 → 回滚 → area 完整恢复
- reset 清单含 area（grep 验证）

## Phase 17: 后端全链路 — 解析/导入/清洗/冲突/导出/权限

**交付内容**：
- **解析器**（`api/parsers/kml.py` 或新 `area` 分支）：解 MultiGeometry 壳取 Polygon；`ExtendedData><Data name="Name"` → name；polygon_id/geozone_pr 等进 extras；无 SchemaData 不报错（AREA 按导入入口盖戳）
- **导入**（`api/imports/router.py`）：目标图层 kind=area 时收 operator 盖戳；**几何护栏只收面**（点/线跳过+输出报告）；走 F13 清洗（面以 `ST_Centroid` 质心做海里/基准国判定）+ F4 冲突（同 operator+name → 覆盖/忽略/取消导 Excel）
- **读取**（新建 `api/areas/{__init__.py, router.py}` 包）：`GET /api/areas` → FeatureCollection（scope 过滤：operator ∈ 可见运营商集合）；参照 roads/lessors 包结构
- **导出**（`api/exports/router.py`）：整库/选区导出含 area（schema `#area`，样式按运营商分色：Globe #3b82f6 / Smart #22c55e / Dito #ef4444 半透明）；自反契约——重导入 100% 命中冲突；选区导出 area 用 ST_Contains（质心或整面，与清洗判定口径一致并注释）
- **权限**（`api/auth/scopes.py`）：映射表加 `AREA`；`site:<op>:AREA` 值域合法化；area 表按可见 operator 集合过滤；imports 盖戳目标校验含 area
- **审计**：import/export 的 counts 加 area 维度

**关键文件**：
- `api/parsers/kml.py`（MultiGeometry + Data name 解析）
- `api/areas/__init__.py` / `api/areas/router.py`（新建）
- `api/imports/router.py`、`api/imports/cleaning.py`（面清洗）
- `api/exports/router.py`（area 导出 + #area schema + 分色样式）
- `api/auth/scopes.py`（AREA 映射 + 过滤）
- `api/main.py`（挂 areas router）

**验收标准**：
- curl 导入 NCR_BCA.kmz 到 Smart/AREA → 158 面入库、operator=Smart 盖戳、Name→name、polygon_id 在 extras
- 重复导入同文件 → 158 条全命中冲突（自反契约）
- 导出 KMZ 含 #area schema + 分色样式；重导入 100% 冲突
- Globe PM（scope=site:Globe）GET /api/areas 只含 Globe 行；无 site:Smart 权限导入 Smart/AREA → 403
- 面要素清洗：质心在海里的面被标 [丢弃]
- pytest 全量绿（151 基线 + 新增）

## Phase 18: 前端 — 树 AREA 节点 + 分色渲染 + 权限树

**交付内容**：
- **LayerTree.tsx**：每个运营商下加 📁 AREA → 🔺 AREA 面图层（[导入图层] [查看图层要素]），与 EXISTING/PLANNED/SURVEY 并列；无样式子层
- **MapView.tsx**：area 面渲染（按运营商分色半透明填充 + 同色描边）；**z-index 在点/线层之下**；复选框显隐接通
- **scopes.ts**：`areaVisible` 判定（operator 维度）；`site:<op>:AREA` 节点可见性
- **ScopeTree.tsx**：权限勾选树每个运营商下加 AREA 节点
- **LayerFeatureList.tsx**：area 只读列表（列：name / polygon_id / geozone_pr 等 extras 主要字段），本期不做增删改
- **api.ts**：fetchAreas 调用；state.ts：areas state + refresh 纳入
- **i18n**：AREA 相关文案双语
- 属性面板：点选 area 面显示属性（name/extras）

**关键文件**：
- `web/src/components/LayerTree.tsx`、`MapView.tsx`、`LayerFeatureList.tsx`、`admin/ScopeTree.tsx`
- `web/src/scopes.ts`、`api.ts`、`state.ts`、`i18n.ts`、`styles.css`

**验收标准**：
- 树出现 AREA 节点（三运营商各一）；导入 KMZ 后面渲染在地图上、分色正确、不遮挡站点
- Globe PM 登录只见 Globe 的 AREA；ScopeTree 能勾/回显 site:Globe:AREA
- AREA 列表框只读可用（筛选/点击定位）
- tsc 零错误 + build 通过；中英切换正确

## Phase 19: 回归测试 + 收尾

**交付内容**：
- `api/tests/test_area_51.py`：解析（MultiGeometry 解壳/Name 提取/extras）、盖戳、护栏拒点线、NAME 冲突、scope 过滤、导出自反（含 #area schema）、清洗质心判定
- 既有测试全量重跑绿
- 四步走验证 + 部署重打 + live 冒烟（真实导入 NCR_BCA.kmz）

**关键文件**：
- `api/tests/test_area_51.py`（新建）
- 部署：本机 docker 重打 + V5 迁移实测

**验收标准**：
- 151 + 新增全绿
- 本机部署后 live 导入 Smart/AREA 真实 KMZ 成功 + 树/地图/权限表现正确

---

## 技术栈（沿用现有，唯一新增 bcrypt）

| 层级 | 技术 | 版本 | 说明 |
|------|------|------|------|
| 前端 | React + TypeScript | 现有 | 沿用 F1–F19 |
| 地图 | OpenLayers | 现有 | F20 用 `RegularShape` 画站型形状（标准 API，无新依赖）|
| 后端 | Python + FastAPI | 现有 | 导入器加盖戳 + 几何护栏 |
| 密码哈希 | **bcrypt** | **5.0.0（#50 新增，PyPI 实查最新版）** | requirements.txt pin `bcrypt==5.0.0`；5.x 密码超 72 字节报错，校验须拒超长输入 |
| 会话 | 自建 DB token（auth_session） | — | 不引 JWT 库：admin 禁用/重置须立即吊销，DB token 天然可吊销 |
| 数据库 | PostgreSQL 16 + PostGIS | `postgis/postgis:16-3.4` | site 加 3 列 + snapshot 同步 |
| 解析 | fastkml/pykml + openpyxl | 现有 | 状态值规范化 |
| 国际化 | 自建轻量 i18n（en/zh） | 现有 | F18 体系，新增节点文案 |
| 部署 | Docker + 腾讯云 | 现有 | init.sql 幂等升级 |

## 数据库表（F20 + #50 改动）

| 表名 | 所属 Phase | 改动 |
|------|-----------|------|
| `site` | Phase 1 | 新增 `operator` / `category` / `type` 三列（可空，导入盖戳）|
| `site_snapshot` | Phase 1 | 同步新增三列（F17 回滚不丢列）|
| `road` | Phase 2 | 去重键改 `Property`（DDL 不变，逻辑变）|
| `lessor` | Phase 2 | relationship 仅 Unfriendly/Normal（DDL 不变，值变）|
| `app_user` | Phase 10（#50）| **新建**：username 唯一 / password_hash / role_id / disabled / must_change_password |
| `app_role` | Phase 10（#50）| **新建**：name 唯一 / is_admin / perms JSONB（import/export/edit_delete/danger）|
| `app_role_scope` | Phase 10（#50）| **新建**：role_id + scope_node（`site:Globe:SURVEY` 式节点串，子级继承）|
| `auth_session` | Phase 10（#50）| **新建**：token 主键 / user_id / expires_at（7 天滑动）|
| `audit_log` | Phase 10（#50）| 加 `username TEXT` 列（可空）|
| `site_delete_undo` | Phase 9（#49）| 已建（镜像 site + undo_id + undone，环形 200 批）|

> F20 无新建表。#50 新建 4 张（app_user / app_role / app_role_scope / auth_session）+ audit_log 加列，走 init.sql + V4 幂等迁移。F17 的 restore_point / *_snapshot / baseline_state_snapshot 等表不动。

## 开发规则

- 每完成一个 Phase 执行四步走：Code Review → 测试完整性 → 编译验证 → 功能测试
- 四步走全部通过后才能 commit
- Commit message 格式：`phase-N: 简要描述`（F20 增量，建议带 `F20`/`#24` 标识）
- **依赖顺序硬约束**：Phase 1（数据层）必须先于 2/3/4/5；Phase 5「移除全局导入按钮」必须在 Phase 3「[导入图层] 接通」之后（否则无导入入口）
- **每个 Phase 必做回归**：F1–F19 已上线，任何 Phase 不得破坏现有链路（导入/清洗/冲突/导出/搜索/恢复点/审计/双语/双主题）
- 包管理器：npm（web/）；Python venv（api/）
- 数据库升级走 `docker compose restart db` + 执行幂等 init.sql（见 DEPLOY.md，macOS bind mount 缓存坑）
