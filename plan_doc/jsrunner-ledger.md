# JS Runner 世界状态账本 UI 定制——设计完成（D4 详细版），待实施

> 状态：**设计已完成。** 需求/协议/架构 = `docs/DESIGN-jsrunner-ledger.md`（D3，grilling
> 裁决 1–20 全整合）；**前端实现级详细设计 = `docs/DESIGN-jsrunner-ledger-ui.md`（D4，
> V1/V2 分段：PART 1 = V1 实施范围，PART 2 = V2 七项仅设计不实施）**。尚未实施。
> 本文档按 AGENTS.md plan_doc 约定维护「当前实施范围 / 待办」两节；待办条目仅追踪，
> 未经用户点名不得实现。

## 当前实施范围（设计已完成）

2026-08-09 用户点名进行设计，产出 `docs/DESIGN-jsrunner-ledger.md`（D2）。设计要点：

1. **三条通道**（核心）：
   - 读：`ContextSnapshot.worldState`（可选字段）+ `WORLD_STATE_CHANGED` 事件（前端投影 state 帧，不碰服务端）；
   - 渲染：`TavernHelper.registerLedgerPanel({title, icon?, maxHeight?})` → 脚本 iframe 可见化挂载进账本卡片（同一 contentWindow 不重载，脚本状态保留）；`resize`/`theme` 两个消息 kind 支撑尺寸同步与主题适配；
   - 写：`TavernHelper.applyStatePatch(patch)` 复用 `PUT /api/state`（applyPatch 语义，无服务端改动）。
2. **高度定制化六项能力对照**（§7.9 满足度矩阵，用户点名要求）：
   - ① 静态数据包：自由 extdata 键 API（`getExtData/setExtData`）+ 导入脚本附带 JSON 数据包 → `global:<scriptId>:data`；
   - ② 渲染图标：iframe 自由渲染 ✅ + 面板 spec `icon` 字段；
   - ③ 宿主按钮：复用 `ScriptMeta.buttons`（types.ts:21）→ 面板头渲染 + `LEDGER_BUTTON_CLICKED` 事件；
   - ④ 独立管理界面：`openManager()` + 宿主 `ModalPanel`（复用 mount/unmount，脚本状态不丢）；
   - ⑤ 配置独立存储：per-script 命名空间约定 `cfg:<scriptId>`；
   - ⑥ 动态数据存储：`setVar/getVar` + P4 自由 extdata 键（单值 ≤1MB 边界）。
3. **LLM 生成结论**（§5.10，exp-3 侦察）：补 `ext_generate` 服务端 handler 走 `streamSimple` 旁路（约 40 行，参照 `main.ts:2425-2464` registerPlannerCaller 样板）；**不走 agent 通道**（语义不匹配）。独立项，与 P1–P4 解耦。
4. **能力基准**（§1.2）：以瑟瑟灵感状态栏V2.67 为**支持程度基准**（自包含前端应用，
   UI 本体 ≈90% 可原样），**不迁移该脚本**——它只定义支持程度。
5. 需求满足度最大缺口 = `JsRunnerPanel`（脚本管理 UI）未挂载（P0 前置）。

## 待办（未点名实施，仅追踪）

- **P0 脚本管理面**：挂载 `JsRunnerPanel` 到 PowersPanel「扩展能力」tab（M4a 收尾）+ **拆文件存储**（`ScriptMeta.content` 落 `.liyuan-uploads/`，extdata `scripts` 键只存元数据+引用；多文件导入（主 `.js` 强制校验 + 可选附带数据文件）/ 导出单文件 / 统一外部编辑（只读查看+下载+重新导入）/ 删除级联清理文件）。
- **P1 数据面**：worldState 进快照 + `WORLD_STATE_CHANGED` + 前端投影 `MESSAGE_RECEIVED`/`GENERATION_ENDED`（types/context/runtime/bridge 各几行）。
- **P2 渲染面**：ledger registry（`web/src/jsrunner/ledger.ts`）+ `registerLedgerPanel`（spec 含 `area: "status"|"roster"`）+ `mount/unmount` + resize/theme 帧 + `LedgerScriptViews` 双区域（StatusStrip + RosterPanel）+ 面板头收起/展开 + 崩溃占位 + `setScriptMeta` 接线。
- **P3 写面**：`applyStatePatch` + `notify(level,text)`（toastr 桩改宿主 toast）。
- **P4 定制扩展面**：`getExtData/setExtData` + 面板头按钮渲染 + `ModalPanel`/`openManager` + 数据包文件（依赖 P2）。
- **（独立项）`ext_generate` handler**：服务端 switch 加 case + `streamSimple` 旁路 + `ext_abort`；与 P1–P4 解耦，可单独立项。
- **（验收物）常驻基准测试**：`test/jsrunner-baseline.test.ts`（自动化回归）+ 能力基准演示脚本（可导入、toast 汇报自检）——随 P1–P4 各阶段配套增量。

## 裁决记录（2026-08-09 用户）

1. **布局定位形态不追求复刻**：fixed-top/bottom/follow 悬浮定位不在需求内，overlay 全屏
   悬浮形态不做（设计 §3.2 已回退为 append 单形态）；状态栏脚本以容器内嵌呈现，UI 本体
   （视觉/组件/交互/数据）不受影响。
2. **静态数据不进 codex（裁决：嵌入脚本）**：玩法 489 / 成就 579 / 卡池 / 技能表 / 邂逅
   库等**存量静态数据嵌入脚本**（脚本自包含，UI 零通道，与 ST 原版内嵌形态一致）；
   **增量/新增数据走 codex**（codex_create/codex_write 工具族现成 + GATED_TOOLS 门禁，
   挂载后剧情侧可检索——codex 定位为「助手进行新增」的通道，不是存量静态数据仓库）。
   已导入 `.liyuan-codex/` 的 12 库保留（剧情侧「玩法检索与发卡/邂逅事件」仍经
   codex_mount 挂载检索，DB 路线用途不变）；新脚本的数据不再以库形式导入 codex。
3. **大内容承载 = 拆文件存储**（grilling R1，exp-5 事实：extdata 单键 1MB + 整 scope
   文件 1MB 双重上限，2.9MB/8.5MB 脚本必挂）：`ScriptMeta.content` 拆出 extdata，落
   `.liyuan-uploads/`（复用 POST /api/upload 64MB + /uploads/ 静态托管，服务端零改动），
   extdata `scripts` 键只存元数据 + 内容引用；静态数据包（①）走同一文件通道。**导入/
   导出/编辑功能随之修改**（形态细节见 grilling R2 澄清）。
4. **面板头交互**：单面板**独立收起/展开**（V1 做，iframe 常驻运行）；**面板顺序拖拽
   排序 V1 不做——TODO 记录，V2 必做（防遗忘）**。
5. **验收基准 = 常驻测试**：能力基准测试脚本（对标状态栏自包含程度：面板注册/图标/按钮/
   事件/存储/管理界面/大内容渲染）作为**常驻回归测试**，不是一次性冒烟——实现完成后
   每次改动跑它判定「支持程度达标」。
6. **实施点名不属于需求澄清阶段**（grilling R1 用户纠正）：待澄清结束后另行点名。
7. **导入/导出形态**（grilling R2）：多文件导入（主脚本 .js + 可选附带数据文件，统一落
   `.liyuan-uploads/` 并登记引用）；导出 = 主脚本单文件（数据包不并回，保持脚本自包含
   可移植）；zip 打包导入/导出是 V2（TODO 记录）。
8. **脚本编辑原则 = 统一外部编辑**（grilling R2，用户选 B）：所有脚本**不在线编辑**，
   只读查看 + 下载，编辑走「下载-改-重新导入」循环（统一原则，不为小脚本破例）。
9. **删除级联清理**（grilling R2）：删除脚本 → 一并删除其登记的文件（防孤儿堆积）；
   导入覆盖 → 旧文件删除、新文件登记；清理失败仅记日志不阻塞。脚本 = 文件所有权边界，
   脚本间文件默认隔离；文件共享是 V2（TODO 记录）。
10. **toastr 通知纳入**（grilling R2）：toastr 桩从 console 转发改为宿主 toast API
    + 新增 `notify(level, text)` 方法（G10 缺口补上，「脚本交互反馈可见」= 表现复刻
    收尾一环）。
11. **挂载范围 = 主卡 + 名录**（grilling R3，用户选 B）：脚本面板同时支持 StatusStrip
    主卡（输入框上方折叠卡）与 RosterPanel（左栏名录面板）两个账本 UI 区域；
    `LedgerPanelSpec` 增 `area: "status" | "roster"` 字段，宿主两处挂载面。
12. **面板默认展开**（grilling R3）：账本卡片展开时脚本面板默认全部展开（可独立收起）；
    紧凑性由折叠条收起兜底。
13. **面板数量不设上限**（grilling R3）：面板随注册自然堆叠，账本卡片展开区可滚动；
    若实测过重再收（TODO 记录实测指标）。
14. **导入脚本大小不额外限制**（grilling R3）：沿用 `.liyuan-uploads/` 64MB 通道上限，
    不设产品级限制（8.5MB 级脚本是真实生态）。
15. **脚本崩溃/未就绪 = 占位提示**（grilling R4）：面板头照常显示，内容区灰态占位
    「脚本未就绪/已停止」+ 查看日志提示；不自动重试（重载由用户在脚本管理面板操作）；
    崩溃只影响该脚本自己的面板。
16. **导入类型校验**（grilling R4）：主脚本文件扩展名强制 `.js`（导入正确性最低防线）；
    附带数据文件任意扩展名（.json/.png/.csv 等，脚本 fetch 引用）；大小统一 64MB。
17. **V2 TODO 清单确认**（grilling R4，8 项）：① zip 打包导入/导出 ② 面板顺序拖拽排序
    ③ 脚本间文件共享 ④ 挂载区域扩展（顶栏/侧栏）⑤ 面板 tab 接管视图 ⑥ iframe sandbox
    加固 ⑦ 面板数量上限实测 ⑧ 账本卡片展开区滚动性能实测。（独立项 ext_generate 非 V2。）
18. **事件面 = 账本 + 消息/回合事件**（grilling R5，用户选 B）：前端投影
    `MESSAGE_RECEIVED`（assistant 消息落定）与 `GENERATION_ENDED`（回合结束）——
    脚本面板可响应剧情推进，事件桥前端化，不依赖服务端 mapPiEventsToSt 修复。
19. **常驻基准测试 = 自动化 + 演示脚本双轨**（grilling R5，用户选 C）：
    `test/jsrunner-baseline.test.ts`（node 测试，协议面端到端断言，`npm test` 常驻回归）
    + 可导入的「能力基准」演示脚本（用户在 JsRunnerPanel 导入跑，面板注册/图标/按钮/
    事件/存储/管理界面/大内容渲染逐项自检并 toast 汇报，肉眼验证 UI 表现）。
20. **grilling 收尾**：2026-08-09 需求澄清完成（R1–R5），无未决需求分叉；设计文档已刷新
    为 D3 整合版（docs/DESIGN-jsrunner-ledger.md）。
21. **前端详细设计 D4 完成**（2026-08-09，基于 frontend-specialist 技能）：组件规格/状态
    机/样式/交互/可访问性/错误矩阵/验证清单（PART 1 = V1 实施范围）；**V2 七项完整设计
    但仅标记不实施**（zip 打包 / 拖拽排序 / 文件共享 / 区域扩展 / tab 接管 / sandbox 加固 /
    上限性能实测，PART 2 V2-1~V2-7），见 docs/DESIGN-jsrunner-ledger-ui.md。
