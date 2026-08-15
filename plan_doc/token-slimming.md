# 送模 token 瘦身（实测驱动，2026-08-15）

## 背景：实测送模构成

主聊天跟踪（trace）修复后拿到权威快照（`.liyuan-state/trace/<sessionId>.jsonl` 的 `prompt` 事件），一拍的完整送模（gemini，reasoning=xhigh）：

| 组成部分 | 字符数 | 占比 | 说明 |
|---|---|---|---|
| 历史 38 条 | 384,632 | 85% | 19 拍全量重发；定稿普遍 5k-12k 字（多条 2-7 万字符） |
| 世界状态注入 | 20,319 | 4.5% | characters 状态/备注越写越肥（每角色数百字） |
| 活跃面板 | 16,136 | 3.6% | 面板内容全量注入 |
| tools（43 个） | 17,236 | 3.8% | 正常 |
| systemPrompt | 10,866 | 2.4% | 正常 |
| 自定义表头索引 | 1,181 | 0.3% | 表内容未进主送模 ✓ |

另有**场记旁路**（deepseek，每拍一次）实测：`userText = 217,384 字符`，其中绝大部分是全量表 JSON（`scribe.ts` 的 `ledgerView.tables`），而这拍结果 `{"patch":{}}`（空 patch，场记无事可做却白烧 21.7 万字符）。

## 当前实施范围

### 方向 1：压缩挂错分支 bug 修复（已完成代码修复，待重启验证）

**症状**：rp-summary 落树后装配不生效（cacheRead 31.5 万依旧）；树里摘要挂在 reroll/切思考级别产生的过程条目链下，焦点分支装配时 `activeSummary`（assemble.ts:108-129）找不到。

**根因**：摘要的覆盖语义是「coversThroughId 之前的条目折叠」，但装配端只认「焦点分支上的摘要条目」。压缩落树挂「当时的叶」（`appendCustomEntry` → `storage.getLeafId()`，含 process 条目），而用户压缩后 reroll（branch 回 user 重新生成）会把焦点拉到新链——摘要条目不在新焦点链上，装配即失效。叶守卫只能防「压缩期间切分支」，防不了「压缩落树后 reroll」。

**修复（装配端兜底）**：
- `activeSummary(branch, allEntries?)`（`src/stage/assemble.ts`）：焦点分支上没有摘要时，扫全树找「coversThroughId 在焦点分支上」的最后一条摘要——锚点语义成立即生效
- `rebuildHistory(branch, allEntries?)` 透传；引擎装配处传 `sm.getEntries()`（`engine.ts:581`，pi 的 SessionManager 已有全量条目 API，无需改 fork）
- 测试：`test/stage-compact.test.ts` 新增 2 用例（摘要挂分支外 + 锚点在分支上 → 折叠）；37+38 全过

**真实数据验证**：现有会话树（rp-summary 挂 311d0b6f、锚点 87f8dac0）模拟装配——修复后送模历史 message 从 38 条 → 8 条。**待用户重启服务后最终确认**（trace 的 prompt 事件首条应为【前情提要】，cacheRead 骤降）。

### 方向 2：场记旁路瘦身（✅ 2026-08-15 逐表派发落地）

**症状**：场记每拍发送 21.7 万字符（全量表 JSON），结果常为 `{"patch":{}}` 或只改几行；
8/15 起输入过大导致旁路模型空输出（flash reasoning off 形态返回空完成，19 张表全量
注入超限），场记连挂数拍、表格停更。

**落地（8/15 用户定案：头提示词 + TODO 逐表派发）**：
- `src/table-todo.ts`（新增）：文本匹配本轮相关 auto 表——表名/列名/行实体命中 +
  时间·地点·纪要链强制入列（列名特征，如全局数据表/纪要表每拍维护时间线）；
- `src/stage/scribe-run.ts`：tables 域改为逐表独立旁路调用（`runPerTablePass`）——
  每表 = 提取器提示词（`src/table-backfill.ts` buildTableBackfillPrompt，表 description
  即头提示词）+ 该表现有行 + 关联表 + 本轮对话；单表调用失败/输出不可解析只跳过该表；
- full 顶层兜底保留（主演未调 world_state_update 时），其输出里 tables 剥掉（统一走逐表，
  避免双重写）；叶守卫（R9）逐表应用前核对。

**收益**：输入 21.7 万字符 → 每表约 0.3~1 万字符 × 相关表数（通常 2~5）；单表失败不再
拖累整拍；旁路空输出应大幅缓解（待实弹验证）。

**测试**：`test/stage-scribe.test.ts` 新增 6 用例（TODO 命中/强制入列/单表失败隔离/
full 合并/逐表注入）；`test/stage-engine.test.ts` 记账用例适配单表 ops 格式。全量
`npm test` 881 过 / 11 挂（基线一致，无新增失败）。

**待观察**：若逐表后仍出现旁路空输出，再考虑换 sideModel / 加大旁路 maxTokens（4096→8192）。

### 方向 3：世界状态 / 活跃面板注入裁剪（待办）

**症状**：世界状态注入 2 万字符（characters 状态/备注膨胀）+ 活跃面板 1.6 万字符全量注入。

**思路**：单角色状态/备注字符预算；面板内容截断/摘要；或按相关性裁剪。收益：3.6 万字符/拍（~8%）。

## 待办

- 方向 1 修复后验证：压缩落树 → 下一拍送模历史骤降（cacheRead 从 ~31 万掉到 <10 万）
- 方向 2 落地前确认场记 match 语义依赖（不可砍掉相关表现有行）
- 方向 3 需确认面板内容的使用场景（模型每拍读面板的收益 vs 1.6 万字符成本）
