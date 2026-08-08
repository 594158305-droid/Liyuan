# AGENTS.md — 梨园项目助手须知

本文件是任何 AI 助手（Claude Code / opencode / 其他）进入本仓库的**第一读**。

## 铁律

1. **禁止直接动手改代码**，除非用户明确说「开始/动手」。
   用户会说「先同步情况」「你来告诉我」「只读」——那期间只能读、不能改。
2. **读思考记录必须先读** `docs/READING-THINKING.md`——按文件 mtime 找最新会话
   会读错位置（旧会话被 model_change 碰过 mtime 会排到前面）。必须用行级
   timestamp 核对北京时间。
3. **流程与提示词的最终形态**定义在 `docs/PLAN-ROUND-FLOW.md`——任何提示词/
   引擎改动都要回答「离这个流程近了多少」。
4. 预设拆层规则见 `docs/PRESET-SPLIT-TAXONOMY.md`；RP agent 执行计划见
   `docs/PLAN-RP-AGENT-EXEC.md`。

## 快速索引

- `docs/PLAN-ROUND-FLOW.md` — 分轮演出流程（最终形态 + 落地记录）
- `docs/READING-THINKING.md` — 读思考记录的**正确方法**（先读这个再碰会话文件）
- `docs/DRAFT-prompt-rp-agent.md` — 「怎么演这一拍」演出指导草稿（B 版）
- `src/stage/` — 台上引擎（assemble 提示词 / engine 回合循环 / workspace 稿纸 /
  tools 工具 schema）
- 测试：`npx tsx --test test/*.test.ts`（当前 563 绿）
