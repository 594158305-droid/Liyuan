# DESIGN-scribe-efficiency：场记表格维护提效（v1）

> 2026-08-16。针对「旁路更新场记 + 自定义表格」的耗时，做完 trace 实测 + 代码修复 +
> 观测增强后的机制文档。承接 DESIGN-tables-sql（SQL 化表格）——本文件只记录**提效**相关的
> 决策、实测数据、缺陷与修复，不重复表格底层的存储/回溯设计。

---

## 0. 背景与问题

分轮演出中，「场记」与「自定义表格维护」是每拍收尾的旁路模型环节。trace 实测（`purpose` 维度）：

| 旁路用途 | 平均耗时 | 说明 |
|---|---|---|
| `scribe`（顶层场记） | ≈ 23s | 主演未交顶层时的全域兜底记账 |
| `scribe-agent`（表格维护代理） | ≈ 111s（43~160s） | **旁路里单块最大**，一次工具循环多轮 LLM |

表格维护代理（`scribe-agent`）单次可达 2 分钟，是旁路耗时大头。优化方向有三：列名规整、
建表链路自查、代理内部读/写轮次压缩。

---

## 1. 斜杠列名规整（2026-08-16）

### 1.1 问题

用户模板（如 `.liyuan-templates/TavernDB 导入.json`）里存在含斜杠的列名：

- `在场角色表.内衣/内裤`
- `NSFW信息表.身高/体重、三围/罩杯、敏感/XP倾向、泌乳/体液状态、羞耻点/心理防线`

模型写 SQL 时常不给中文/含符号列名加引号，`内衣/内裤` 被 SQLite 当**除法/标识符边界**解析报错，
代理被迫「读报错 → 查真实表结构 → 重试」，多轮往返直接推高耗时（trace 里两次实证：`需用双引号
包裹含斜杠的列名`、`列名含斜杠需反引号`）。

### 1.2 决策

- **代码层统一规整**，**不改用户模板/账本等数据文件**（真值源保留原样）。
- 规则：列名里的 `/` → `与`（`内衣/内裤` → `内衣与内裤`）。实现于 `src/tables/service.ts` 的
  `normalizeColumnName()`。
- 应用位置：
  - `createTable()`：**建库/迁移入口统一规整**——新建表直接用规整列名；物理表已含斜杠旧列时
    用 `ALTER TABLE RENAME COLUMN` 迁移到规整名（**保留数据**）；`__meta` 落规整列名。
  - `updateMeta()`：同口径规整，避免 UI/用户回写未规整列名造成与物理表脱节。
  - 存量表在 `ensureMaterialized()` 流经时自动迁移（见下）。

### 1.3 存量迁移

`ensureMaterialized()`（见 §2）对「物理表已存在但残留斜杠列名」的表也调 `createTable` 触发
RENAME（`内裤/内裤`→`内衣与内裤` 等 6 处），数据保留。

---

## 2. 建表链路自查（ensureMaterialized）

### 2.1 问题

若某会话 db 被重建/回退导致「`__meta` 有表定义、`sqlite_master` 无物理表」，表格代理 `sql_write`
一写就 `no such table`，被迫空转查 schema（trace 有 82s 空转实证）。

### 2.2 机制

`src/tables/service.ts` 新增 `ensureMaterialized()`：

- 遍历 `__meta` 定义；
- 物理表缺失 → `createTable` 建出（列名规整）；
- 物理表存在但含斜杠列名（存量未迁移）→ 也调 `createTable` 触发 RENAME；
- 幂等：已规整/已建的表零改动。

挂在 `listTables()` 开头（`listTables` 是表格代理派发、表格索引、UI 列表的统一入口），
并在 `listTables` 内 try/catch 兜底，ensure 失败不阻断列表读取。

---

## 3. 表格维护代理提示词（prompt）修正

### 3.1 第一版的问题（提效反效果）

初版为了省「查 schema」轮，在 `buildScribeAgentSystemPrompt` 里写死
「所有表均已物化，无需去 sqlite_master/PRAGMA 探查 schema；列名即提示词为准」。
**本意省探查，却让代理跳过了「先读各表现状再判断写什么」的必经步骤**，
出现「text=0（无总结）、rounds≈1、完全没写表」的反效果。

trace 实证：初版后两拍表格代理 `textLen=0`、待维护 15 张表一张没写（纪要表 115→115）；
修正前几拍 text 有内容（467~885 字）确实写了。

### 3.2 修正后（当前生效）

`src/stage/scribe-agent.ts` 的 `buildScribeAgentSystemPrompt` 改为：

- **先读数据再写**：每表必须先用 `sql_read` 读现有关键行（如「最近一条纪要」「某角色当前状态」），
  对照【本轮对话】判断增/改/删；「读不到现状就直接说不写」是错误的。
- **只禁探查整体 schema**：不要额外去 `sqlite_master` / `PRAGMA table_info` 扫全部表结构
  （那白耗多轮）；按清单列名直接读写即可。
- 列名引号约束仍保留：中文/含符号列名必须 `"…"` 包裹。

验证：修正后 `rounds`/`toolUsed` 恢复多轮多 SQL（见 §5），纪要表 115→123 行，真实写入。

---

## 4. 观测增强：旁路代理 trace 字段

### 4.1 动机

初版 trace 的 `side` 事件只记 `elapsedMs`，看不出旁路代理「发了几轮 LLM、调了几次 SQL」，
难以判断耗时是「真工作了」还是「空转/没写」。

### 4.2 改动

- `src/stage/engine.ts` `#sideAgent` 返回 `{ text, rounds, toolUsed }`；
- `#sideTrace` 支持额外 `meta`，把 `rounds`（LLM 轮数）与 `toolUsed`（SQL 调用次数）写入
  trace 的 `side` 事件；
- `#scribeAgentForTables` 的 console.log 同步打印 `LLM N 轮 / 工具 M 次`。

### 4.3 判读口径

| 信号 | 含义 |
|---|---|
| `rounds`≈1 且 `toolUsed`=0 | 代理第一轮就返回，未做任何读写 → 疑似「无变化」误判 / prompt 引导过头 |
| `rounds` 多 + `toolUsed` 多 + text 有内容 | 完整多轮多 SQL 增量维护，耗时匹配实际工作量 |
| `rounds` 多 + `toolUsed` 全是 read（写=0） | 只读不写 → 本期无持久变化或读溢出（见 §6） |

---

## 5. 实测数据（2026-08-16 最新）

| 拍 | 耗时 | rounds | toolUsed | 写了没 |
|---|---|---|---|---|
| 修正前：11:02 | 77s | ≈1 | ≈0 | ❌ textLen=0，没写（纪要表 115） |
| 修正前：11:20 | 87s | ≈1 | ≈0 | ❌ textLen=0，没写 |
| 修正后：16:17 | 98s | 5 | 25 | ✅ textLen=718 |
| 修正后：22:17 | 107s | 7 | 28 | ✅ textLen=800 |
| 修正后：23:07 | 144s | 8 | 29 | ✅ textLen=316，纪要表 115→123 |

- 列名迁移在重启后自动完成：`内衣/内裤`→`内衣与内裤`、`身高/体重`→`身高与体重` 共 6 处。
- **耗时定性**：144s 对应剧情量大（多体位交合/点数结算/多表联动）的一拍，29 次 SQL 覆盖 11 张表
  —— 实质工作量大故耗时长，不是空转。

---

## 6. 读/写拆分与优化方向

> `#sideAgent` 已加 reads/writes 计数（`sql_write` 计写、其余算读），随旁路代理 trace 落盘
> （`rounds`/`toolUsed`/`reads`/`writes` 四字段）。**需重启后新拍实测**才能得到精确读/写比例；
> 下表是代码逻辑 + text 摘要预判，供定优化方向。

| 优化方向 | 现状判断 | 待实测确认 |
|---|---|---|
| 1. 前置只读探查轮 | 每表维护前「先读现状」（读略多于写，估算读 ≈ 写+1~2）；流水表应只读末尾几行不该整表拉 | reads vs writes 比例；是否出现「读远多于写」的溢出拍 |
| 2. 写失败重试轮 | 列名规整 + 引号指令已治本（6 斜杠列已迁移）；若重试仍多 → 说明有别的 SQL 写法陷阱 | writes 里含失败重试的次数（trace 无法直接给，需 text/报错推断） |
| 3. round 上限 | `maxRounds=16`；若接近上限说明 todo 表多或模型低效 | rounds 分布；是否逼近 16 上限 |

**判读口径（重启后实测用）**：
- `reads≈writes`：健康——先读现状再增量写，无浪费；
- `reads >> writes`：读溢出（整表拉/重复探查）——优化点①；
- `writes` 高但 `applied` 少/空：写多为失败重试——优化点②；
- `rounds` 长期逼近 16：todo 表过多/模型低效——优化点③。

---

## 7. 相关文件

| 文件 | 改动 |
|---|---|
| `src/tables/service.ts` | `normalizeColumnName`、`createTable` 规整+RENAME、`updateMeta` 规整、`ensureMaterialized`+`listTables` 自查、`NAME_RE` |
| `src/stage/scribe-agent.ts` | `buildScribeAgentSystemPrompt` 先读再写/只禁探查整体 schema/引号约束 |
| `src/stage/engine.ts` | `#sideAgent` 返回 `toolUsed`、`#sideTrace` 加 `rounds`/`toolUsed`、`#scribeAgentForTables` log |
| `test/tables-service.test.ts` | 规整迁移 + RENAME 保留数据测试 |
