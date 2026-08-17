# DESIGN-tables-vector：自定义表格向量检索注入（发现性方案）

> 2026-08-16。目标：主演不需要知道「有什么表」——每拍装配时，系统用本拍上下文
> 对表格行做向量检索（借鉴 SillyTavern shujuku_index 的「向量粗召回 + 精排」管线，
> 但跳过其世界书中间层，直接注入梨园每拍注入区），把最相关的表行喂给主演。
> 底稿：docs/DESIGN-tables-sql.md（表格 SQL 化，本方案是其检索/注入层）。

---

## 1. 借鉴对象机制（已读 shujuku_index.js 源码）

| 环节 | shujuku_index 做法 | 梨园对应 |
|---|---|---|
| 表格 ↔ 检索单元 | 表行导出为世界书条目（injectIntoWorldbook，Markdown 表格文本 + 关键字） | 表行 → 向量 chunk（id 稳定，文本 = 表名+列值序列化） |
| 命中 | 用户输入 → embedding → topK=200 向量粗召回 → **LLM rerank 精排**（指令：「按与当前输入及关键词的相关性降序」） | 每拍上下文 → embedding → topK=6 余弦截断（第一版不 rerank，误命中多再上 flash rerank） |
| 注入 | 命中条目经 ST 世界书扫描/关键词增强触发进入上下文 | 直接组装【相关表格】注入块（梨园每拍注入区原生能力） |

**结论**：机制可借鉴（两段式检索），中间层可省（梨园有注入区）。

## 2. 总体流程

```
写表（sql_write / create / drop）
  └→ 表级同步器：本拍「被写过的表」全量行重嵌入（不解析 SQL 行变化，单表百行 <100ms）

每拍装配（engine #turn）
  └→ 检索：本拍上下文（用户输入 + 最近 1 拍正文）→ topK 余弦命中
  └→ 组装【相关表格】注入块（【相关设定】之后、轮次卡之前）
  └→ 主演读到命中行 → 需要更多用 sql_read 深查 → 写回用 sql_write

rewind / 切分支（replayTables）
  └→ 全量重同步（异步）：清表格向量库 → 重新嵌入焦点分支全部表全部行
```

## 3. 存储

- **位置**：独立于 memory 域的表格向量库——`.liyuan-state/tables-vec/<scopeId>.jsonl`（与
  `.liyuan-memory` 分离，避免污染记忆管理 UI；格式同 chunks.jsonl 行式）。
- **chunk 结构**（`src/tables/vector-sync.ts` 自持类型）：
  ```
  id        = "tables:<表名>:<rowid>"     // 稳定 id，支持按行 upsert/删除
  text      = "表名｜列1=值1；列2=值2；…"  // 检索与展示共用
  embedding = number[]（256 维本地 hash 或云端）
  meta      = { table, rowid, embedMode }
  ```
- **嵌入通道**：复用 `src/memory/embed.ts` 的 `embedTextLocal` / `embedText`（与 memory 同
  嵌入模式，混用不同嵌入器会检索质量差——跟随 memory 的 embedMode 配置）。
- **容量**：不设 maxChunks 上限（行数据权威在 SQLite，向量只是索引；丢失可由全量重同步重建）。

## 4. 同步（写路径）

- **触发**：engine `#flushTableLogs`（拍末统一落树）之后，收集本拍写过的表名集合 →
  `syncTableRows(tables)`：逐表 `SELECT rowid, * FROM 表` → upsert 全部行 chunk → 删除该表
  旧 chunk 中已不存在的 rowid。
- **drop** → 删除该表全部 chunks；**create** → 空表不产生 chunks（首行写入时同步）。
- **幂等**：按 id upsert；重复同步无副作用。
- **失败容错**：嵌入失败（云端不可用）→ 跳过本次同步并告警（表格查询不受影响，检索注入降级）。

## 5. 检索（每拍装配）

- **触发点**：engine `#turn`，`buildStageInjection` 之前；开关 `tables.vector.enabled`（默认
  true，表行数 > 0 时生效）。
- **查询文本**：`lastUserText + "\n" + 最近 1 拍定稿正文前 200 字`（本拍上下文；只用用户
  输入会漏「承接上文」的场景）。
- **检索**：`searchTableRows(query, topK=6)`——余弦遍历（本地嵌入 256 维，千 chunk <5ms）。
- **阈值**：命中分 < `threshold`（默认 0.15，实弹调）→ 不注入（低相关不喂，避免噪音）。
- **去重**：同一表最多带 3 行；总注入 ≤ 6 行。
- **组装**：
  ```
  【相关表格】以下自定义表行与本拍剧情相关（内容按需查阅，写回用 sql_write）：
  - 纪要表：时间跨度=…；概览=…；纪要=…
  - 主角技能表：技能名称=…；技能经验值=…
  ```
- **注入位置**：注入块内【相关设定】之后、轮次卡之前（近场；注入区本就每拍动态，零前缀
  缓存代价）。

## 6. 一致性（rewind / 重放）

- **触发**：`replayTables`（切分支/重放）成功后 → 发起全量重同步。
- **策略**：**异步**（fire-and-forget + 进度日志）——不阻塞装配；期间检索用旧索引（短暂
  不一致可接受：最坏是下一拍注入的行略旧，行数据本身永远以 SQLite 为准）。
- **成本**：全量行数（当前 19 表 ≈ 500+ 行）× 本地嵌入 ≈ 1–2 秒，异步可接受；行数超
  阈值（5000 行）时日志提示。

## 7. 配置

```jsonc
// liyuan.config.json 新增段（与 router 并列）
"tablesVector": {
  "enabled": true,      // 默认开
  "topK": 6,            // 每拍注入命中行数上限
  "threshold": 0.15     // 余弦阈值（低于不注入；实弹调）
}
```

- 嵌入模式跟随 `.liyuan-memory/config.json` 的 `embedMode`（local/cloud 一致）。
- 关闭（enabled=false）→ 零行为变化（不嵌入不检索）。

## 8. 性能审计

| 项 | 估算 | 备注 |
|---|---|---|
| 每拍检索 | 查询嵌入 <5ms + 余弦遍历千 chunk <5ms | 可忽略 |
| 写后同步 | 本拍写过的表（1–3 张）× 每表 ≤200 行 × 嵌入 | <100ms，拍末批处理 |
| rewind 全量重同步 | 千行级 × 本地嵌入 | 1–2s，异步不阻塞 |
| 存储 | 千行 × 256 维浮点 | 数 MB 级 |
| token | 【相关表格】注入 ≤6 行 × 每行 ≤200 字 | 每拍 ≤1.5KB |

## 9. 失败矩阵

| 场景 | 行为 |
|---|---|
| 嵌入失败（cloud 挂） | 跳过同步 + 告警；检索注入降级，sql_read 仍可用 |
| 向量文件损坏 | 清库 + 全量重同步重建 |
| rewind 期间同步竞态 | 异步任务带「世代号」——若重同步期间又切分支，旧任务作废（以最后一次重同步为准） |
| 表行超长（>4000 字） | chunk 文本截断（检索用），行数据全量仍在 SQLite |

## 10. 文件清单与实施顺序

| 步 | 文件 | 验收 |
|---|---|---|
| P1 | `src/tables/vector-sync.ts`（chunk 读写/行 upsert/表级重同步/删除，复用 embed.ts）+ 单测 | 全绿 |
| P2 | 引擎接入：flushTableLogs 后写同步；#turn 检索 + 组装【相关表格】注入块；replayTables 后异步全量重同步 | 引擎测试 + trace 可见注入块 |
| P3 | 配置段（tablesVector）+ 初始全量嵌入（已有表行一次同步） | 配置开关生效 |
| P4 | 实弹验证：演一拍看【相关表格】注入命中质量（阈值/topK 调参） | 命中行相关、无噪音 |

## 11. 待拍板决策点（已拍板，2026-08-16）

1. **查询文本**：用户输入 + **最近 2 拍**正文 ✅
2. **阈值/topK**：初值 0.15 / 6，**支持界面配置**（liyuan.config.json `tablesVector` 段，
   设置面板暴露控件——前端后置）✅
3. **向量库位置**：**独立文件** `.liyuan-state/tables-vec/<scopeId>.jsonl` ✅
4. **rewind 重同步**：**异步**（世代号防竞态）✅
5. **只做检索**（不做【自定义表索引】升级）✅

**额外要求：降级健壮性**（无表/向量未启用/向量异常都不得影响主链路）——见 §12。

## 12. 降级场景（无表 / 未启用 / 向量异常）

| 场景 | 行为 |
|---|---|
| 会话没有自定义表（listTables 空） | 检索前短路——不嵌入、不检索、不注入，零开销 |
| `tablesVector.enabled=false` | 同上短路；sql_read/sql_write 主链路不受影响 |
| 嵌入异常（云端 embedMode 但未配 key/网络失败/响应非 JSON） | 检索返回空；**每会话只告警一次**（不每拍刷屏）；写同步跳过但表数据照常落 SQLite |
| 向量文件损坏（JSON 解析失败） | 该行跳过 + 告警一次；下次全量重同步自然重建 |
| 重同步竞态（异步中又切分支） | 世代号：旧任务完成后若世代已变则丢弃结果（以最后一次重同步为准） |
| 表被 drop / 行被删 | 对应 chunk 移除（removeTable / 同步时清理不存在的 rowid） |
