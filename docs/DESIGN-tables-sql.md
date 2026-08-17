# DESIGN-tables-sql：自定义表格 SQL 化重设计（v2）

> 2026-08-16。v2 按用户 feedback 刷新：补主键/关联关系、场景走查、用户视图；
> 术语表前置；模型档位不再列为决策点（走旁路模型配置）；迁移改外置一次性工具。

---

## 0. 决策记录（已拍板，不再返工）

1. **存储**：node:sqlite（零依赖，Node ≥23.4 默认可用）。
2. **迁移**：只迁当前生效的一个会话，用**外置一次性脚本**（非自动、非通用）；迁移前导出一份备份。
3. **不兼容 ST 模板**；保留「从另一会话复制表定义」的轻量预设。
4. **UI 由实现方自主决策**，列结构变更走「重建表」。
5. **场记粒度**：逐表一次工具循环；表定义**预留 group 字段**，同组可批量循环（接口先留，实弹再启用）。
6. **主键/唯一键**：需要，db 层强制（PRIMARY KEY / UNIQUE 索引）。
7. **关联关系**：需要，列可声明引用其他表（FOREIGN KEY 约束 + 表间一致性）。
8. **模型**：场记一律走 `sideModel`（现有旁路模型配置），reasoning 档位是实现内部选择，不设决策点。
9. **SQL 直传（v3 修订）**：模型直接传 SQL 语句（最自由，支持 JOIN/聚合/复杂 WHERE/多行操作），
   工具发送前正则校验（语句类型白名单 + 危险语句黑名单 + DELETE/UPDATE 强制 WHERE）；
   不再做结构化参数编译。工具形态：`sql_read`（仅 SELECT）/ `sql_write`（仅 INSERT/UPDATE/DELETE）。
   本地单用户 + SQLite 无网络 + 操作可回滚（日志/检查点）→ 注入非真实威胁，防的是危险语句与误操作。

---

## 1. 术语表（先读这里）

| 术语 | 含义 | 为什么需要 |
|---|---|---|
| **物化** | 把「操作日志」执行成真实的 SQLite 表数据 | SQLite 不存分支概念，需要一个「当前分支的表格样子」供查询 |
| **操作日志（rp-table-log）** | 每次写表（建/删/插/改/删行）后在会话树上追加的一条记录 | 会话树的**分支**语义（swipe/rewind 各带各的历史）就靠它；它是表格的**权威** |
| **重放（replay）** | 切分支/回退时，清掉检查点后的表数据，把该分支的日志按顺序重新执行一遍 | 让表格数据「回到」这个分支应有的样子 |
| **检查点** | 在 db 里记一条「物化已经覆盖到会话树哪个条目了」 | 有了它，重放只用执行「检查点之后」的日志，而不是从头全部重放——**频率就是控制这个重放量**：检查点越勤，回退时重放的日志越少（越快），但检查点动作本身要花一点时间；每 10 拍打一次是「回退快」和「打点开销」的折中 |
| **auto 表** | 表定义里 `auto: true` 的表 | 场记每拍收尾自动维护它（否则是用户手动维护的静态表） |
| **todo** | 场记每拍挑出的「这一拍需要维护的 auto 表清单」 | 只维护跟本拍剧情相关的表，避免无谓调用 |
| **维护规则（description）** | 存在表定义里的文字说明，含「这张表怎么填」的规则 | 场记代理读它决定「查什么、写什么」 |
| **叶守卫** | 旁路调用期间会话树被切走（swipe/rewind）就丢弃本次结果 | 防止把结果写到错误的分支上 |
| **主键（PRIMARY KEY）** | 表里唯一标识一行的列（或列组合） | 保证「同一实体不出现重复行」，冲突时报错让模型改 update |
| **外键（FOREIGN KEY）** | 某列的值必须存在于另一张表 | 保证表间引用不悬空（如「地点」必须在地图点表里存在） |

---

## 2. UI 设计规范（元素清单 + 元素关联）

> 框架：React 19 + Vite（现状）。组件按「卡片式 + 折叠」延续现有表编辑器语言。
> 实现方自主决策细则；本节的目的是把**元素**和**元素之间的关联**定清楚，避免做成孤立的表单。

### 2.1 信息架构（页面布局）

```
┌ 工具栏 ────────────────────────────────────────┐
│ [＋ 建表]  [复制自会话 ▾]   （当前会话：StarMini）│
├────────────┬──────────────────────────────────┤
│ 表列表      │ 详情（三 Tab）                    │
│ ┌────────┐ │ ┌──────────────────────────────┐ │
│ │纪要表   │ │ │ 数据 │ 结构 │ 说明与规则        │ │
│ │●auto     │ │ └──────────────────────────────┘ │
│ │ 112 行  │ │   （Tab 内容见下）                 │
│ ├────────┤ │                                   │
│ │角色状态 │ │                                   │
│ │●auto 主键│ │                                   │
│ │  96 行 │ │                                   │
│ └────────┘ │                                   │
└────────────┴──────────────────────────────────┘
```

### 2.2 元素清单（组件）

| 元素 | 用途 | 关键属性/状态 |
|---|---|---|
| **TableListItem**（表列表项） | 选中表、看行数/徽标 | 名称、`auto` 徽标、`group` 标签、主键标记、行数、hover 操作（复制/删除） |
| **CreateTableWizard**（建表向导） | 从零建表 | 表名 → 列定义器 → 说明与规则 → auto 开关 → 分组；校验（表名白名单/列名重复/主键非空可选） |
| **ColumnEditor**（列定义器） | 定义一列 | 名称/类型（text/number/boolean/real）/说明/**主键勾选**/**引用选择器**（选表 + 列） |
| **DataGrid**（行数据表格） | 读行、改行 | 虚拟滚动（行多时）、分页、列头、行 hover；单元格点击 → 编辑 |
| **CellEditor**（单元格编辑器） | 单格改值 | 输入框/布尔开关/数字框，失焦保存（UPDATE）；**主键列只读**（改主键 = 删旧行 + 插新行） |
| **SchemaEditor**（结构编辑器） | 增删改列 | 改类型/主键/引用 → 触发「重建表」确认（数据 COPY 保留） |
| **RuleEditor**（说明与规则编辑器） | 编辑 description/维护规则 | textarea + 保存 → 写 `__meta`，**下一拍场记生效**，不重建 |
| **GroupEditor**（分组设置） | 给表分维护组 | 分组名输入/下拉；同组表场记批量循环（预留接口） |
| **CopyTableWizard**（复制表） | 从另一会话复制 | 选来源会话 → 选表 → 预览结构 → 勾「带数据」→ 确认 |
| **ConfirmDialog** | 删表/重建表/删行 | 数据丢失警告 + 二次确认 |
| **InlineError / Toast**（报错） | SQLite 报错外露 | 行内红字定位到具体行/列 + 顶部可复制 toast |
| **Loading / Empty** | 重建中/无内容 | replay 时「表格加载中」遮罩；无表时「建表」引导 |

### 2.3 元素关联（交互流）

| 触发 | 关联动作 | 结果 |
|---|---|---|
| 点 TableListItem | → 详情切到该表「数据」Tab | DataGrid 分页读行 |
| 单元格编辑失焦 | → `table_update`（值参数绑定） | 成功刷新该行；失败 InlineError 红字（如 UNIQUE 冲突） |
| 「＋ 加行」 | → `table_insert` | 主键冲突 → InlineError + Toast，引导改 update |
| 结构 Tab 改列类型/主键/引用 | → ConfirmDialog「需重建表」 | 确认后 CREATE 新表 + COPY + DROP + 换 meta |
| 说明与规则 Tab 保存 | → 写 `__meta` | 下一拍场记代理读新规则（无重建） |
| auto 开关切换 | → 写 `__meta.auto` | 下一拍场记是否维护该表 |
| 分组名保存 | → 写 `__meta.group` | 场记调度器按组批量循环（预留） |
| 「复制自会话」 | → CopyTableWizard 选来源 | 本会话建同结构（可带数据） |
| 删表 | → ConfirmDialog | `DROP TABLE` + 删 meta + 落 `rp-table-log` |
| 场记每拍维护 auto 表 | → 后端 state 帧推送 | 开着的数据 Tab 自动刷新 |
| rewind/切分支 | → 后端 replay | 前端收「表格已重建」→ 刷新当前视图 |

### 2.4 状态与反馈

- **空态**：无表 → 引导建表；有表无行 → 「场记尚未写入」提示。
- **加载态**：replay 中 → DataGrid 遮罩「表格加载中」（禁用编辑）。
- **错误态**：SQLite message 原样（`no such column` / `UNIQUE constraint failed` / `FOREIGN KEY constraint failed`）→ 行内红字 + aria-live 播报 + 可复制 toast。
- **保存态**：写库中 → 按钮 loading/禁用，防重复提交。

### 2.5 可访问性（frontend-developer 基线）

- 全键盘可达（Tab 遍历、Enter 编辑、Esc 取消）；DataGrid 用 `role="table"` + aria-label；
- 报错 aria-live="polite"；对比度满足 WCAG AA。

### 2.6 典型用户场景

**场景 1：追踪 NPC 状态**
建表（列：姓名/状态/层数/失效时间，主键=姓名+状态，写维护规则「层数跨天+1；失效即删」）→ 勾 auto → 保存 → 场记每拍自动维护 → 用户随时在数据 Tab 看，错了手改行。

**场景 2：表被填错**
报错已外露（UNIQUE 冲突）→ 模型当场改 update 或用户在 CellEditor 手改；想改规则 → 说明与规则 Tab 改文字保存，下一拍生效，不重建。

**场景 3：跨会话复制表**
「复制自会话」→ 选来源会话和表 → 预览结构 → 确认（可带数据）。

---

## 3. 数据模型

### 3.1 表定义（存 `__meta`）

```jsonc
{
  "name": "角色状态效果表",
  "auto": true,
  "group": null,                      // 预留：同组表可批量循环（决策 5）
  "description": "表格说明/维护规则全文",
  "columns": [
    { "name": "角色名称", "type": "text", "description": "角色名", "primary": true, "ref": null },
    { "name": "状态名称", "type": "text", "description": "状态", "primary": true, "ref": null },
    { "name": "层数", "type": "number", "description": "层数" },
    { "name": "失效时间", "type": "number", "description": "Unix 秒，0=永久" }
  ]
}
```

### 3.2 主键（决策 6）

- 一列或多列的 `primary: true` → 建表 `PRIMARY KEY ("角色名称","状态名称")`；
- `table_insert` 主键冲突 → SQLite 抛 `UNIQUE constraint failed` → 报错外露，模型改 update；
- 无显式主键的表 → 使用隐藏自增 `__rowid`（流水表如纪要表）。

### 3.3 关联关系（决策 7）

- 列定义 `ref: { table: "世界地图点", column: "地点名称" }` → 建表
  `FOREIGN KEY ("地点") REFERENCES "世界地图点"("地点名称")`；
- 连接时 `PRAGMA foreign_keys = ON`，引用不存在的值 → 插入/更新报错外露
  （「FOREIGN KEY constraint failed」）；
- 表间一致性靠 FK 强制 + 维护规则里「与某表一致」的语义双保险。

---

## 4. 存储层

- **db 文件**：`.liyuan-state/tables/<sessionId>.db`（每会话独立，`DatabaseSync` 同步 API）。
- **用户表**：按 §3 建表（主键 + 外键 + 类型映射）。
- **`__meta`**：`(name TEXT PRIMARY KEY, json TEXT)` —— 表定义唯一归属，不随日志/快照复制。
- **`__checkpoint`**：`(id INTEGER PRIMARY KEY CHECK(id=1), through_entry_id TEXT, at INTEGER)`。
- 命名白名单：`^[A-Za-z0-9_\u4e00-\u9fff]{1,32}$`；`__` 前缀保留给内部表。

---

## 5. 场记与填表（场景走查：什么表、什么提示词、怎么触发、LLM 怎么回应）

### 5.1 触发

每拍收尾，场记调度：
1. 用本拍正文匹配出「这一拍相关的 auto 表」（todo）；时间/纪要类流水表强制入列；
2. 对 todo 里每张表（或同 group 一批）发起一次**工具循环**。

### 5.2 工具循环的系统提示词（逐表）

```
你是梨园场记的表格维护代理。本轮剧情正文已定稿，你只维护下面这一张表。

表「纪要表」
列：时间跨度(text) / 概览(text) / 纪要(text) / 重要对话(text)
维护规则（description）：
  …【维护规则】每轮新增一条：先查行数，再读末尾 2 条核对衔接，然后插入新纪要…

可用工具：
- sql_read(sql)：执行一条 SELECT（可 JOIN/聚合/子查询/任意 WHERE）
- sql_write(sql)：执行一条 INSERT / UPDATE / DELETE（必须带 WHERE）
```

- 输入里**不含**该表现有行数据（行数据靠 sql_read 按需取）。

### 5.3 LLM 预期回应（纪要表为例）

| 轮 | 模型调用 | 工具返回 | 模型下一步 |
|---|---|---|---|
| 1 | `sql_read("SELECT COUNT(*) AS n FROM 纪要表")` | 「n=112」 | 知道 N=112 |
| 2 | `sql_read("SELECT * FROM 纪要表 LIMIT 2 OFFSET 110")` | 最近 2 行 | 核对时间跨度衔接 |
| 3 | `sql_write("INSERT INTO 纪要表 (时间跨度,概览,纪要,重要对话) VALUES ('…','…','…','…')")` | 「1 行已插入」 | 完成 |
| 4 | 输出「纪要表已新增一条。」（无工具调用） | — | 循环结束 |

### 5.4 角色状态效果表（带主键 + 失效刷新）

| 轮 | 模型调用 | 说明 |
|---|---|---|
| 1 | `sql_read("SELECT * FROM 角色状态效果表 WHERE 失效时间 < 当前时间")` | 找失效状态 |
| 2 | `sql_write("DELETE FROM 角色状态效果表 WHERE 角色名称='…' AND 状态名称='…'")` × N | 清失效行 |
| 3 | `sql_write("UPDATE … SET 层数=2 WHERE …")` 或 `INSERT`（主键冲突报错则改 UPDATE） | 处理变化 |

### 5.5 失败行为

- 单表循环轮数上限 8；失败/超限只跳该表，不拖累其他表；
- 每次写后叶守卫（切分支则丢弃）；
- 报错（no such column / UNIQUE / FOREIGN KEY）原样回给模型，模型下一轮自纠。

---

## 6. SQL 校验（`src/tables/sql-guard.ts`，纯函数）

模型直接写 SQL；校验器发送前把关。**不是编译**——SQL 由模型自由表达（JOIN/聚合/子查询/
复杂 WHERE/多行操作），校验只做三件事：

1. **语句类型白名单**：剥离注释后，按开头关键字判定——
   `sql_read` 只放行 `SELECT`；`sql_write` 只放行 `INSERT`/`UPDATE`/`DELETE`；
2. **危险语句黑名单**（字符串字面量之外出现即拒绝）：
   `DROP / PRAGMA / ATTACH / DETACH / ALTER / VACUUM / REINDEX / CREATE / BEGIN / COMMIT /
   ROLLBACK / SAVEPOINT / RELEASE / EXPLAIN / WITH`；
   （建表/删表走 UI 的 `table_create`/`table_drop`，不给模型。）
3. **防误操作**：`DELETE`/`UPDATE` 必须含 `WHERE`（字符串外）；拒绝多语句（分号分隔超过
   一条）。

- 字符串字面量（`'…'`/`"…"`）内的关键字与分号**不算**（如 `WHERE 备注 = 'DROP TABLE'` 合法）；
- 报错矩阵（SQLite message 原样外露）：
  `no such table / no such column / UNIQUE constraint failed / FOREIGN KEY constraint failed /
  datatype mismatch / near "…": syntax error`——模型按报错重写 SQL 再试。

### 6.1 工具清单

| 工具 | 参数 | 校验 | 落日志 |
|---|---|---|---|
| `sql_read` | sql（SELECT） | 白名单 SELECT | 否 |
| `sql_write` | sql（INSERT/UPDATE/DELETE） | 白名单三语句 + WHERE 强制 + 黑名单 | 是 |
| `table_list` | () | — | 否 |
| `table_create` / `table_drop` | 结构化（UI/REST 专用，不给模型） | UI 二次确认 | 是 |

---

## 7. 回溯

1. 写操作成功 → 追加 `rp-table-log {table, op, params}` 到会话树（分支语义权威）。
2. 切分支/rewind/加载 → replay：
   - 读焦点分支日志 + 检查点；
   - 检查点命中 → 清检查点后物化 → 事务重放检查点后日志 → 更新检查点；
   - 未命中（早于迁移点）→ 回退到迁移基线并提示。
3. 检查点：每 10 拍或 `/compact` 时固化（控重放量，见术语表）。

---

## 8. 迁移（外置一次性工具，决策 2）

- `scripts/migrate-tables-to-sql.mjs <会话状态文件> <会话树 jsonl>`：
  1. 备份：导出当前生效表定义+数据 → `.liyuan-state/tables-backup-<date>.json`；
  2. 读当前生效 tables → 建 SQLite 表 + 导行 + 写 `__meta` + 落初始检查点；
  3. 幂等（db 已存在则跳过）。
- 旧会话树 jsonl **不动**（431 份 rp-state 快照天然是历史备份）。
- 迁移前历史不回溯（回退到迁移点前 = 迁移基线），需全历史时再跑全量迁移。

---

## 9. 执行效率

| 维度 | 结论 |
|---|---|
| 回滚 | 检查点后 ≤10 拍日志重放，事务内毫秒~秒级；存储从「每拍全量快照」降到「增量日志」 |
| LLM token | 表数据不再全量下发（旧 19 表 21.7 万字符/拍 → 按需查询结果）；净收益实弹用 usage 核对 |
| 时间 | 最大不确定项（多轮×思考）；靠逐表 + 轮数上限 + 前缀缓存，实弹调（模型走 sideModel，不设决策） |

---

## 10. 文件清单与实施顺序

| 步 | 文件 | 验收 |
|---|---|---|
| P1 | `src/tables/sql-guard.ts`（语句类型白名单/危险黑名单/WHERE 强制/字符串感知扫描） | 单测全绿 |
| P2 | `src/tables/service.ts`（db/meta/执行/日志） | 临时 db 单测全绿 |
| P3 | 工具执行器换 TablesService（主演 + 场记代理逐表循环，sql_read/sql_write） | 引擎测试全绿 |
| P4 | `src/tables/replay.ts` + 切分支 hook | 回退/重放测试全绿 |
| P5 | REST + UI（行编辑/建表/复制表定义） | 表编辑器可用 |
| P6 | `scripts/migrate-tables-to-sql.mjs` + StarMini 实弹迁移 | 迁移成功 + 场记 trace 核对 token/耗时 |

## 11. 落地记录（2026-08-16，用户下令一口气完工）

| 步 | 状态 | 落点 |
|---|---|---|
| P1 SQL 校验器 | ✅ | `src/tables/sql-guard.ts`：字符串/标识符感知扫描 + 括号深度跟踪（CTE/子查询不算主语句类型）、语句类型白名单、危险词黑名单（WITH 放行）、UPDATE/DELETE 顶层 WHERE 强制、多语句拒绝；`test/tables-sql-guard.test.ts` 14 例 |
| P2 服务层 | ✅ | `src/tables/service.ts`（TablesService：懒开 db、PRAGMA foreign_keys、__meta/__checkpoint、建表含主键+外键、execRead/execWrite/rawExec、clearUserTables 用 sqlite_master 清全部用户表、日志回调、检查点读写）；`test/tables-service.test.ts` 10 例 |
| P3 工具接入 | ✅ | 主演 `sql_read/sql_write`（stageTools + runStageTool，报错原样外露）；场记代理改 SQL 工具（scribe-agent 重写：makeSqlExec/系统提示词含维护规则索引）；engine：TablesService 生命周期（#tablesFor/closeTables/tablesService）、表索引源改 db（#sqlTableIndex）、落账清 tables 字段、**写日志拍末缓冲落树**（避免叶守卫误判）；删除废弃 table-ops；tool-staging Minimal 换 sql_read；测试全适配（stage-tools/stage-engine/scribe-agent/tool-staging 重写断言） |
| P4 回溯 | ✅ | `src/tables/replay.ts`（replayBranch 全量重放 + collectTableLogs）；engine replayTables（带日志状态键跳过，resyncAll 频繁触发不重复重放）；main.ts resyncAll 挂 replay hook |
| P5 REST | ✅ | `server/main.ts` `handleTablesApi`：GET /api/tables（清单+meta）、GET /api/tables/rows（分页）、POST /api/tables（create/drop/updateMeta）、POST /api/tables/rows（SQL 写入）；冒烟验证 19 表 + 行数据正确 |
| P6 迁移 | ✅ | `scripts/migrate-tables-to-sql.mjs`（备份导出 + 建表 + 导行 + meta，幂等）；**StarMini 实弹迁移完成**：19 张表（纪要 114 行 / 恋爱日记 63 行 / 角色状态效果 96 行 / 世界地图点 44 行…），备份 `…db.backup-20260815.json` |

**UI 前端（表编辑器行编辑/建表向导）**：REST 已就绪，前端改造留待后续（用户裁决 UI 小事后修）。

**待用户操作**：
1. 重启 7620 服务；
2. 演一拍 → trace 看场记代理（`purpose=scribe-agent`）用 sql_read/sql_write 填表（不再全表下发）；
3. rewind/切分支 → 表格物化随分支重建（resyncAll → replayTables）。

**场记/表格维护提效（2026-08-16 追加）**：斜杠列名规整、建表链路 `ensureMaterialized`、
表格代理 prompt 修正（先读再写）、旁路代理 `rounds`/`toolUsed` 观测增强——详见
`docs/DESIGN-scribe-efficiency.md`（含 6 个斜杠列 RENAME 迁移、textLen=0 反效果与修复、实测数据）。
