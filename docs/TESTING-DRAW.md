# TESTING: 生图分层一期验收手测清单

> 状态：2026-08-08 一期实施完成，二期启动前的人工验收。
> 配套：`docs/DESIGN-draw.md`（设计 + §8 实施对账）；配置已启用（`liyuan.config.json` plugins 段）。
> 自动化单测（640 项）已覆盖纯逻辑，本清单只列**需要真实服务 / 真实 API / 人眼确认**的项。

## 0. 准备

- [ ] `liyuan.config.json` 已启用四个插件（draw-role / draw-slot / draw-pipeline / draw-edit）
- [ ] 管线规划模型已显式配置：`plugins.draw-pipeline.settings.llm = { provider: "opencode-go", model: "deepseek-v4-flash" }`（该 provider 已有 key；若报 "No API key" 说明旁路通道未读到 key，属待报 bug）
- [ ] 重启服务（AGENTS.md Windows 正确姿势：WMI 启动 + 单独轮询），`healthz` 200
- [ ] 启动日志无 `[draw` 前缀报错
- [ ] 绘图面板 → 测试连接（NovelAI，最小请求基本不烧 Anlas）通过

## 1. 底座生图（需 Anlas）

- [ ] `POST /api/draw/generate {"prompt":"1girl, tavern interior, warm candlelight","aspect":"landscape"}` → 200，返回 `{src:"/cache/…", slotId:"slot-…"}`；`GET /cache/<src>` 能打开图片
- [ ] 面板新增全局风格预设（正/负前缀）→ 再生成 → 风格前缀生效
- [ ] `POST /api/draw/enhance {"source":"<上一步src>","op":"upscale"}` → 200 新 src，分辨率放大
- [ ] 把 provider 的 key 改错 → 测试连接 → 中文提示「API Key 无效」（不是堆栈）
- [ ] 助手对话：「用 draw_generate 生成一张图」→ 助手调工具成功、右栏显示图

## 2. 角色管理（管线质量依赖，★必测）

- [ ] 面板 → 服装管理：给当前卡角色加**外观 tag** + **两套服装**（一套设参考图上传）→ `.liyuan-wardrobe/<hash>.json` 正确
- [ ] 面板「设为当前穿着」→ `.liyuan-state/<sid>.json` 该角色 `outfit` 字段已写入（**新增账本能力，重点验证**）
- [ ] 面板 D 标签搜索「miku」→ 命中 yuki_miku 等 + tag 展开
- [ ] `GET /api/draw/characters/resolve?names=<角色名>` → tags 含外观 + **当前穿着** outfit tag（验证账本优先）

## 3. 占位符与渲染（管线前置，★先测）

- [ ] 生成一张图 → 发消息，正文手写 `[image:slot-xxx]`（用返回的 slotId）→ 渲染为图 + 「未保存」徽标
- [ ] `DELETE /api/draw/slots?slotId=<id>` → 刷新 → 灰底「图片已清理」失效态
- [ ] 对一条 AI 消息 `POST /api/draw/pipeline/run {"entryId":…}`（或用 4 的手动触发）→ 正文出现占位符且渲染正常

## 4. 管线 auto + reroll 联动（★核心必测，需剧情模型 + Anlas）

- [ ] 手动触发 `POST /api/draw/pipeline/run {"text":"伊利亚斯推开了酒馆的门，暖光洒进来。"}` → 200 `ran:true` + slots；失败时 warnings 给出中文原因
- [ ] 正常跑一轮剧情（描述性内容）→ 等 30–90 秒 → 该 AI 消息出现插图，位置贴近对应段落（**锚点对齐效果，人眼重点看**）
- [ ] 连续几轮不同场景 → 图与正文匹配（skill 规范生效：danbooru tag / 构图 / 分级）
- [ ] 对已配图的回复 reroll → 新正文 → 新图；旧 slot 在 `draw-slots.json` 中 `discarded:true`
- [ ] 三旋钮：`auto:false` → 回复无图；`characters` 白名单 → 无关消息不配图
- [ ] 剧情引用知识库设定 → 配图体现 lore 内容（检索注入验证）；长对话 `/compact` 后继续配图（摘要注入验证）

## 5. 编辑操作

- [ ] 悬停消息图片 → 操作条出现（保存/删除/重生成/增强/放大/局部重绘/编辑TAG）
- [ ] 保存 → 徽标消失、文件进 `.liyuan-media/`（内容寻址名）、`saved:true`
- [ ] 局部重绘：InpaintModal 涂抹某区域 → 出图后该区域变化（**新接线组件，重点验证**）
- [ ] 重生成/增强各一次 → 画廊版本缩略图网格显示多版本，discarded 弱化

## 6. 数据一致性（★回档必测）

- [ ] 生成几张不保存 → `POST /api/draw/slots/cleanup {"retentionDays":0}` → 未保存的 slot/文件被清，已保存不动
- [ ] 生成并保存图 → `/store` 存档 → 改剧情 → `/back` 回档 → 正文/占位符/图片/账本 `current_outfit` 一起回到存档点
- [ ] 长对话 `/compact` → 摘要后配图正常（占位符不污染摘要——输入侧剥离验证）

## 已知边界（遇到不算 bug）

- 2 个既有失败测试（stage-engine 断言过期、assistant-gateway）——与本功能无关
- 手动「为这条消息配图」前端按钮是二期项，本期用 REST `POST /api/draw/pipeline/run`
- 「重新生成」是 redraw 语义（DESIGN §8 对账裁决 #5）
- 占位符走 rp-draft-op 读取时补丁：**树上正文不可见占位符**（查 jsonl 导出看不到属正常），显示/送模/压缩经 applyDraftOps 自动生效
- 插件开关改动需**重启服务**生效（工具注册/回合钩子在启动时完成）

## 验收判定

- 第 4 节「auto 配图 + reroll 联动」与第 6 节「回档一致性」两项通过 → 一期验收通过，可启动二期
- 测试中发现的任何异常：记下复现步骤，交回给开发侧（DESIGN 文档与开发过程互相佐证，差异需求证后更新，不得擅自偏离）
