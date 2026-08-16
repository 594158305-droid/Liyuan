# DESIGN: 生图系统分层设计（底座 + 插件）

> 状态：**一期 + 二期实施完成**（2026-08-08；设计经 Act 1 grill 访谈锁定，实施与设计的差异裁决见 §8 实施对账）
> 定位：迁移**能力**而非代码——所有功能点按梨园的设计初衷重新审视设计，不搬运任何第三方实现。
> 关联文档：`docs/RELEASE-v1.1.2.md`、`docs/RELEASE-v1.2.0.md`、`docs/DEV-extend.md`

---

## 0. 目标与设计原则

### 0.1 总体目标

- **底座**（梨园原生）：提供**基础画图接口能力**——多后端生图管理（NovelAI 本期实现，SD WebUI / ComfyUI 预留）、参数与风格管理、原生生图工具。
- **插件层**（类 LittleWhiteBox）：在底座之上做到**插图（图文并茂）**——角色管理、生图旁路管线、图像存储映射、占位符图片编辑操作。
- 设计理念：旁路管线 + reroll 多次重来，让"文本 + 插图"**一次 roll 一起满足**，比"文本 + 人工多阶段修 tag + 出图"更省 token、更减焦虑；全套件（尤其角色管理）是生图体验的关键。

### 0.2 设计原则

1. **分层与依赖方向**：插件建立在底座**原生 tool / 领域层**之上；依赖方向始终是 插件 → 底座，禁止反向。剧情侧主模型不直接接触生图。
2. **能力迁移而非代码迁移**：每个能力点重新按梨园架构（领域层零依赖、接线层唯一、无构建、文件持久化）设计。
3. **资源保护**：一切持久化必须是**文件形式**，不做内存留驻（内存易丢）；沿用 LWB 节省模式——**仅"保存"后持久化**，未保存缓存可过期清理，避免图片文件无限膨胀且人类难以清理。
4. **默认关闭**：插件层默认不启用，用户面板显式开启（防无感消耗 token / 额度）。
5. **正文可修改**（2026-08-08 用户裁决移除「正文永不改写」红线——文章多次润色属常态）：管线可在模型输出后向正文附加 `[image:slotId]` 占位符锚点（锚点对齐插入），未来润色亦获授权；修改保留可追溯性（原文在会话树分支可回滚，沿用 rp-edited 分支机制）。输入侧仍剥离占位符——模型看到纯正文，避免对图片标记产生幻觉。

---

## 1. 分层架构总览

```
┌─────────────────────────────────────────────────────────┐
│ 插件层（src/draw-plugins/，默认关闭，能力包声明）          │
│  ┌───────────┐ ┌──────────────┐ ┌────────────┐ ┌───────┐ │
│  │ A 角色管理 │ │ B 生图旁路管线 │ │ C 存储映射  │ │D 编辑 │ │
│  │           │ │ (图文并茂)     │ │ (占位符)    │ │ 操作  │ │
│  └─────┬─────┘ └──────┬───────┘ └─────┬──────┘ └───┬───┘ │
│        │  调用        │  调用          │   调用       │     │
│        └──────────────┴──────┬────────┴─────────────┘     │
└──────────────────────────────┼───────────────────────────┘
                               ▼
┌─────────────────────────────────────────────────────────┐
│ 底座（梨园原生，src/draw/，常驻）                         │
│  领域层：config / novelai / (sd-webui|comfyui 预留)      │
│          params / 队列限流 / 错误分类 / 全局风格预设      │
│  原生 tool（助手侧）：draw_generate / draw_enhance       │
│  前端：DrawPanel（API 管理 / 风格预设 / 测试）            │
└─────────────────────────────────────────────────────────┘
```

**接线层**（`.liyuan/extensions/roleplay.ts` + `server/assistant.ts`）：唯一挂载点。底座 tool 注册助手侧；插件在接线层按 config 开关条件注册其 tools / panels / skills。

**依赖方向**：插件 A/B/C/D → 底座领域层（`src/draw/` 纯函数）与原生 tool；插件之间允许 A→B（管线用角色特征解析）、A→C、B→C（管线写 slot 映射）、C→D（编辑操作读写映射），均为插件内调用，不经过 tool 间代理。

---

## 2. 底座设计（梨园原生）

### 2.1 领域层模块（`src/draw/`，现有 `draw-config.ts`/`novelai.ts` 迁入并重组）

| 文件 | 职责 | 状态 |
|---|---|---|
| `src/draw/config.ts` | provider 注册表、参数预设、**全局风格预设**、队列参数（见 2.3） | 由 `draw-config.ts` 扩展迁入 |
| `src/draw/novelai.ts` | NAI 请求：V4.5/V3 双协议、坐标分区、角色参考图、增强/局部重绘、错误分类 | 由 `novelai.ts` 迁入，补队列限流 |
| `src/draw/sd-webui.ts` | **仅类型与配置 schema**（host/auth/transport/模型/采样器），请求函数未实现，调用抛"尚未实现" | 预留 |
| `src/draw/comfyui.ts` | **仅类型与配置 schema**（连接模式/工作流/节点 ID），请求函数未实现 | 预留 |
| `src/draw/params.ts` | aspect 分辨率映射（portrait/landscape/square）、effectiveParams 合并 | 新 |
| `src/draw/queue.ts` | 请求队列 + 限流（见 2.3） | 新 |
| `src/draw/errors.ts` | DrawErrorCode 枚举与分类 | 由 novelai.ts 拆出 |

### 2.2 provider 注册表与配置（`liyuan.draw.json` 扩展）

沿用现有 `DrawConfig`，扩展三处：

```jsonc
{
  "version": 1,
  "defaultProvider": "novelai-main",
  "autoConfirm": false,          // 全局防烧额度：生图前需确认
  "providers": [{
    "id": "novelai-main",
    "type": "novelai",            // "novelai" | "sd-webui" | "comfyui"（后两者预留）
    "name": "NovelAI 主号",
    "apiKey": "...",
    "baseUrl": "https://image.novelai.net",
    "model": "nai-diffusion-4-5-full",
    "defaultParams": { /* sampler/scheduler/steps/scale/width/height/negativePrompt/
                          ucPreset/qualityToggle/autoSmea/cfgRescale/varietyBoost */ },
    "presets": [],                // 参数预设，可各自指定 model
    "autoConfirm": false          // 单 provider 覆盖全局
  }],
  "styles": [{                    // ★ 新增：全局风格预设（与角色无关，截图中的"风格"）
    "id": "naiv4-quality",
    "name": "质量词风格",
    "positivePrefix": "1.3::best quality, amazing quality, very aesthetic, highres, incredibly absurdres::",
    "negativePrefix": "lowres, worst quality, jpeg artifacts, ..."
  }]
}
```

- `styles` 支持增删改查；生图时与角色特征（插件层）分属不同层级，仅作全局前缀合并。
- 校验沿用 `normalizeDrawProvider` 逐字段回退逻辑。

### 2.3 NAI 请求层（资源保护）

- **队列 + 限流**（新，底座常驻）：单后端 FIFO 队列（并发 1），NAI 默认随机冷却 15–30s 防封；可配并发上限；AbortSignal 支持（配合停止）。
- **autoConfirm**：provider 级/全局开关，开启时生图前弹确认（防烧 Anlas）。
- **超时**：单请求默认 120s（AbortController）。
- **错误分类**：`auth / quota / busy / network / timeout / parse / unknown`（401/402/429/5xx 映射，沿用现有）。
- **系统代理**：沿用现有（环境变量 + Windows 注册表读取）。
- 响应为 zip：沿用 `ziplite.ts` 内存解出首张图。

### 2.4 原生 tool（助手侧注册）

底座生图 tool **只收已组装好的 prompt 文本**，不做任何角色/场景理解（角色组装是插件 A 的职责——依赖方向不反向）。

**`draw_generate`**（助手侧，白名单可被自定义 agent 启用）：

```jsonc
// 参数 schema
{
  "prompt": "string, 必填, 已组装的 Danbooru tag / 画面描述（不含质量前缀）",
  "negativePrompt": "string, 选填, 整图负面",
  "aspect": "portrait | landscape | square, 默认 portrait",
  "provider": "string, 选填, 默认配置文件默认 provider",
  "preset": "string, 选填, 参数预设 id",
  "styleId": "string, 选填, 全局风格预设 id（缺省用默认）",
  "params": { "steps": 28, "cfg": 6, "seed": -1, "width": 0, "height": 0, "upscale": 1.0,
              "smea": false, "smDyn": false, "decrisper": true, "varietyBoost": true }
}
// 返回
{
  "image": "/media/{md5}.png",      // 已交付 .liyuan-media/ 的访问路径
  "slotId": "slot-{uuid}",          // ★ 见插件 C：占位符 id（底座生成，插件 C 负责映射持久化）
  "provider": "novelai",
  "params": { /* 实际生效参数快照 */ }
}
```

**`draw_enhance`**（助手侧）：

```jsonc
{
  "source": "/media/{md5}.png 或 slotId",
  "op": "redraw | enhance | upscale | inpaint",
  "strength": 0.15,        // redraw/enhance
  "scaleBy": 2,            // upscale
  "mask": "base64",        // inpaint：白底黑区 mask（黑区为重绘区）
  "params": { /* 同 draw_generate 可覆盖项 */ }
}
```

- `slotId` 是底座领域层生成的不透明标识（UUID），底座不知道 slot 的语义（占位符/映射由插件 C 管理）——保证依赖方向：插件 C 建立在底座输出之上。
- **剧情侧不注册生图 tool**：主剧情模型不直接生图；配图全部由插件 B 旁路管线在 harness 钩子里直接调用领域层完成。

### 2.5 SD WebUI / ComfyUI 预留深度

- **类型与配置结构完备**：provider 注册表含完整字段（SD：host/代理/模型/采样器；Comfy：连接模式 proxy|direct/工作流/节点 ID 注入），`DrawProvider.type` 合法值包含二者。
- **UI 可创建**：DrawPanel 可新增 SD/Comfy provider 并编辑配置。
- **请求未实现**：`draw_generate` 对 sd-webui/comfyui 返回 `尚未实现`；面板"测试连接"同样返回未实现。
- 未来实现只需补 `src/draw/sd-webui.ts` / `comfyui.ts` 的请求函数 + 面板测试逻辑，配置与 UI 已就绪。

### 2.6 前端：DrawPanel 改造（底座部分）

现有 `DrawPanel.tsx` 三段式保留并调整：

1. **API 管理**：provider CRUD / Key / baseUrl / model / 参数全字段编辑 / 测试连接 / 设默认（保留现有）
2. **★ 风格预设**（新）：全局正/负前缀 tag 串的增删改查、设为默认
3. 服装管理、画廊部分**移出**底座（归插件 A / D）——底座面板只留后端管理

### 2.7 底座明确不做

- ❌ Anlas 查看 / 避免花费 Anlas 守卫（用户决策移除——额度查询非底座职责，避免与 NovelAI 页面策略耦合）
- ❌ 剧情侧生图 tool（见 2.4）
- ❌ SD/Comfy 请求实现（仅预留，见 2.5）
- ❌ 任何角色/场景/故事理解（全部在插件层）
- ❌ 图片保存策略、占位符、画廊（插件 C / D）

---

## 3. 插件层设计

### 3.0 能力包机制（轻量模块化 + 能力包声明）

**声明文件**：每插件一个 `plugin.json`，放代码旁 `src/draw-plugins/<id>/`：

```jsonc
{
  "id": "draw-role",
  "name": "角色管理",
  "version": "0.1.0",
  "description": "服装档案、D 标签库、角色特征解析",
  "tools": ["wardrobe_list", "wardrobe_update", "tag_search"],   // 注册到接线层白名单
  "panels": ["DrawRolePanel"],                                     // 前端面板组件注册
  "skills": ["novelai-draw.md"],                                   // 发布时复制进 .liyuan-skills/
  "requires": []                                                    // 依赖的能力/插件（顺序加载 + 冲突检测）
}
```

**开关**：`liyuan.config.json` 新增 `plugins` 段：

```jsonc
"plugins": {
  "draw-role":     { "enabled": false, "settings": {} },
  "draw-pipeline": { "enabled": false, "settings": {} },
  "draw-slot":     { "enabled": false, "settings": {} },
  "draw-edit":     { "enabled": false, "settings": {} }
}
```

**注册流程**：启动时扫描 `src/draw-plugins/*/plugin.json` → 校验声明 → 接线层按开关条件注册 tools（助手侧白名单）与 hooks（onTurnEnd 回合钩子）/ skills 复制。**默认全关**。

> 实施注记（对账裁决，见 §8）：REST 路由（`/api/draw/*`、slots、tags、wardrobe 等）**常驻注册**不经插件开关（无副作用，插件关时返回空数据）；插件开关只控制 agent 工具注册、回合钩子与前端面板显示。

**运行时数据**：`.liyuan-plugins/<id>/`（插件私有状态）。

**红线**：插件代码属于领域层范畴（`src/draw-plugins/`），禁止触碰 `@liyuan/agent-runtime`（pi）API；只能经接线层标准接口注册/调用（与 D3 规则一致）。

**requires 一期只做**：顺序加载 + 依赖存在性/循环冲突检测（无动态解析）。

### 3.1 插件 A：角色管理（`draw-role`）

> 迁移 LWB 角色能力，含全部能力，**分两期**。

**一期：**

| 能力 | 设计 |
|---|---|
| 服装档案补强 | 现有 `wardrobe.ts`（appearanceTags + outfits + referenceImage + 账本 current_outfit 随世界线回档）保留；补强：服装 tag 支持 `n::tag::` 权重语法（novelai-draw skill 已约定）、多服装集 UI 完善 |
| D 标签离线库 | `danbooru-chars.dat` **服务端直接读**（LWB 是浏览器 IDB）：启动时解压建倒排 token 索引（若 .dat 为 zip 容器且 node 原生 zlib 不可解，则一期打包脚本转换为 gzip 后使用，不引入 fflate 依赖）→ `tagSearch(query)` 搜索 API |
| 角色特征解析 | `resolveCharacterTags(characterNames[]) → { tags, negative, referenceImage }`：已录入角色合并 danbooruTag + 外观 + **当前穿着**（账本 outfit 优先级：账本指定 → defaultOutfit → 第一套）+ 服装参考图；未知角色仅输出提示。**供插件 B 管线与插件 D 编辑复用**（依赖方向：B/D → A）。实施注记：RestHost 已补 `worldState()` 只读 getter，REST resolve 按账本当前穿着解析；插件工具 wardrobe_list 不碰 bridge，显示「当前穿着需经面板设置」（对账裁决接受） |
| 在场角色检出 | 迁移 LWB `detectPresentCharacters`：按姓名/别名在正文中检出在场角色（插件 B 管线输入用） |
| agent tools | `wardrobe_list`（读当前卡服装档案）、`wardrobe_update`（改服装/外观/设当前穿着，current_outfit 写账本）、`tag_search`（D 标签搜索，给自定义 agent 用）——助手侧注册 |

**二期：**（2026-08-08 已完成）

| 能力 | 设计 |
|---|---|
| 未知角色自动学习 | 管线识别的新角色 → 经用户确认后写入档案（`autoConfirm` 风格确认流） |
| 自定义标签组 | 用户自定义标签组（增删/导入导出 JSON），生图时可选追加 |
| 在线标签库 | HuggingFace CSV 下载缓存到 `.liyuan-plugins/draw-role/tags/`，与离线库合并搜索 |

**数据**：`.liyuan-wardrobe/`（现有，卡哈希分文件）+ `.liyuan-plugins/draw-role/tags/`（索引缓存）。

### 3.2 插件 B：生图旁路管线（`draw-pipeline`，图文并茂核心）

> 迁移 LWB scene-planner 全套能力，按梨园架构重设计。

**触发（Q4 决策：auto + reroll 联动 + 三旋钮）：**

- **auto**：AI 回复完成后（复用 after-ai 类钩子）自动触发管线，为该消息规划并生成插图
- **reroll 联动**：剧情 reroll 后，管线随**新正文重新规划**并替换该消息的旧占位符图片（新 slot，旧图标记废弃，保留期后清理）——这是"文本+插图一次 roll 一起满足"的关键
- **三旋钮**：总开关 / 按角色开关（角色白名单）/ 手动"为这条消息配图"（消息上按钮或斜杠命令）
- **限频**：同消息去重（已规划过则不重复跑）、连续 reroll 最小间隔

**管线模型**：独立配置（`plugins.draw-pipeline.settings.llm`，可复用助手模型或单独指定；默认跟随助手模型）——剧情模型不参与、不被污染。

**流程**（已完整实现）：

```
AI 回复完成 / reroll（onTurnEnd 回合钩子触发，后台执行不阻塞回合）
  → 读剧情输入：最近消息正文 + N 条前文（historyText，默认 3）+ 压缩摘要（rp-summary 条目）+ 知识库检索（.liyuan-lore/：loadMergedLore + searchEntries 经 host 注入）+ 角色档案（插件 A resolveCharacterTags）
  → 规划 LLM（提示词素材 = novelai-draw skill 规范 + 前情提要 + 世界设定 + 角色 + 正文 + <image_gen> 输出格式规范；独立模型 settings.llm 可覆盖，缺省跟随助手模型）
  → 图片计划解析（逐行模糊解析 + 多 <image_gen> 块合并 + 引号/缩进容错）
  → 轻量合规（Q11 决策）：硬上限截断（maxImages / maxCharactersPerImage，配置可调）+ 结构校验（scene 非空/长度/aspect 回退）
    （实施注记：场景分级校验一期不拦截——对账裁决接受现状，NAI API 拒绝由错误分类兜底）
  → 逐 task 调底座领域层（generateImage 领域函数，prompt = 全局风格前缀 + scene + 角色 tag；角色特征经插件 A 解析）
  → 锚点对齐插入占位符（anchor.ts 四层定位 + 段落对齐 → rp-draft-op 读取时补丁 {old,new}/{append}——树字节不改，显示/送模/压缩经 applyDraftOps 自动生效；映射落插件 C）
  → 失败自动带 CRITICAL OUTPUT RULE 重试一次（迁移 LWB 行为）
```

**图片计划 YAML**（Liyuan 版 `<image_gen>` 块）：

```yaml
image_gen:
  - index: 1
    anchor: "他推开酒馆的门"          # 正文锚点（可省略 → 默认消息末尾）
    aspect: landscape
    scene: "1girl, tavern interior, warm candlelight, ..."
    negative: ""                     # 整图补充负面（选填）
    characters:
      - name: "伊利亚斯"
        action: "pushing open the door, surprised"
    # 角色 tag 由插件 A 在组装阶段注入，计划里只写名字+动作/互动
```

**skill 双用途**（Q11 决策）：`novelai-draw.md` ① 作为管线 LLM 提示词素材（TAG 规范/构图/分级/配额）；② 供自定义 agent 加载自学后手动调 `draw_generate`。

**输出**：占位符经 **rp-draft-op 读取时补丁**注入正文（映射落插件 C），不直接输出媒体消息。输入侧剥离（assemble.ts stripDrawPlaceholders）——模型看到纯正文；显示侧 RichContent 渲染为图片（含未保存态/失效态）。手动触发：REST `POST /api/draw/pipeline/run`（对账裁决：前端「为这条消息配图」按钮二期补）。

### 3.3 插件 C：图像存储映射（`draw-slot`）

**占位符**：`[image:slotId]` 进消息正文纯文本（随压缩/回档/导入导出走）。

**文件布局**：

| 项 | 位置 | 说明 |
|---|---|---|
| 已保存图片 | `.liyuan-media/{md5}.png` | 沿用现有内容寻址交付链（deliverMedia） |
| 未保存缓存 | `.liyuan-cache/draw-{ts}.png` | 生成后默认落这里（未保存态） |
| **slot 映射表** | `.liyuan-state/draw-slots.json` | **文件形式持久化，不内存留驻**；防抖原子写 |

**slot 映射表 schema**：

```jsonc
{
  "version": 1,
  "slots": {
    "slot-xxx": {
      "chatId": "…", "messageId": "…",
      "saved": false,                      // 仅保存后置 true（节省模式）
      "createdAt": 1750000000000,
      "versions": [{                       // 编辑/增强/reroll 产生新版本
        "file": ".liyuan-media/a1b2…png",  // 已保存；未保存时指向 .liyuan-cache/
        "params": { /* 生成参数快照 */ },
        "savedAt": 0, "discarded": false   // reroll 替换的旧版标记 discarded
      }]
    }
  }
}
```

**保存模式**（Q6 决策：手动默认 + 自动开关）：

- 默认手动：消息图上的"保存"按钮 / 画廊"全部保存"批量按钮；**压缩/回档前提示未保存的图**
- 开关"自动保存模式"：生成即写盘
- 清理：未保存缓存默认保留 3 天自动清理（可配置）；已保存的永不自动删；discarded 版本保留期（默认 3 天）后随清理删除

**索引重建**（幂等）：从正文扫描 `[image:xxx]` 重建映射；从 `.liyuan-media/` 扫描已保存文件补全 saved 记录（迁移 LWB restoreIndexFromChat/FromDisk 思路，文件形式简化版）。

**渲染**：前端渲染消息时把占位符替换为图片（消息内嵌组件，指向 `/media/{name}` 或缓存路径）；未保存的缓存图同样可显示（缓存存在期内）。

### 3.4 插件 D：占位符图片编辑操作（`draw-edit`）

**UI 形态**：消息内图片**悬浮操作条**（悬停显示）+ 画廊版本缩略图网格升级 + Lightbox（现有画廊升级）。

**一期操作集**（Q8 决策）：

| 操作 | 实现 |
|---|---|
| 保存 / 删除 | 调插件 C 接口（保存=转正式库+映射置 saved；删除=标记删除+文件清理） |
| 重新生成 | 同参数换 seed 重新 roll → 新版本（映射 versions 追加） |
| 增强 / 放大 | 调底座 `draw_enhance`（enhance / upscale 2x） |
| 局部重绘 | **InpaintModal 接线**（已有组件）：canvas 涂抹重绘区 → mask（白底黑区）→ `draw_enhance` inpaint |
| 编辑 TAG 再生 | 弹窗编辑 prompt（自动挂 D 标签搜索补全——插件 A 能力）→ 重新生成 |

**二期操作集**：

| 操作 | 实现 |
|---|---|
| AI 微调 | 复用管线 LLM：对已生成图拆解 prompt → LLM 改写场景描述 → 重生成（迁移 LWB prompt-refine 思路） |
| 版本历史切换 | 映射 versions 多版本缩略图网格切换显示/恢复 |

**画廊升级**：DrawPanel 画廊区 → 版本缩略图网格（slot 维度）+ Lightbox（大图/元数据/操作按钮）。

---

## 4. 数据与文件布局总表

| 路径 | 归属 | 内容 |
|---|---|---|
| `liyuan.draw.json` | 底座 | provider 注册表 / 参数预设 / 全局风格预设 / autoConfirm |
| `src/draw/` | 底座 | 领域层（config/novelai/params/queue/errors + sd/comfy 预留） |
| `src/draw-plugins/<id>/` | 插件 | 代码 + plugin.json 声明 |
| `.liyuan-plugins/<id>/` | 插件 | 运行时私有数据（标签索引、管线状态） |
| `.liyuan-wardrobe/` + `refs/` | 插件 A | 服装档案（现有，卡哈希分文件）+ 参考图 |
| `.liyuan-media/` | 插件 C | 已保存图片（内容寻址 md5） |
| `.liyuan-cache/` | 插件 C | 未保存缓存 + 临时文件（3 天清理） |
| `.liyuan-state/draw-slots.json` | 插件 C | slot 映射表（文件持久化，防抖原子写） |
| `.liyuan-skills/novelai-draw.md` | 插件 B | 管线提示词素材 + 自定义 agent 文档（双用途） |
| `.liyuan-lore/` | 插件 B 输入 | 知识库（管线检索源） |

---

## 5. 分期计划

### 一期（本轮实施）

1. **底座**：`src/draw/` 重组（config 扩展 styles / novelai 迁入 + 队列限流 / params / queue / errors）；`draw_generate` / `draw_enhance` 原生 tool（助手侧）；DrawPanel 底座化改造（API 管理 + 风格预设；服装/画廊移出）；SD/Comfy 预留 schema 与"未实现"占位
2. **能力包机制**：plugin.json 扫描 / config plugins 开关 / 接线层注册流程 / `.liyuan-plugins/` 目录
3. **插件 A 一期**：服装档案补强 + D 标签离线库 + 角色特征解析接口 + 在场角色检出 + 3 个 agent tool
4. **插件 C**：占位符进正文 + 渲染 + slot 映射文件（保存模式/清理/重建）——**B、D 的地基，先做**
5. **插件 B**：管线（auto + reroll 联动 + 三旋钮 + 规划 LLM 独立配置 + YAML 解析容错 + 轻量合规 + 锚点对齐插入 + skill 双用途）
6. **插件 D 一期**：悬浮操作条（保存/删除/重生成/增强/放大/局部重绘/编辑 TAG）+ InpaintModal 接线 + 画廊升级

### 二期

1. 插件 A：未知角色自动学习 + 自定义标签组 + 在线标签库
2. 插件 D：AI 微调 + 版本历史切换
3. 视需：SD/Comfy 请求实现（配置与 UI 已预留）

---

## 6. 风险与开放问题

| 风险 | 缓解 |
|---|---|
| NAI 额度消耗 / 限流 | 底座队列 + 随机冷却（15–30s）；autoConfirm 确认流；插件默认关闭 |
| reroll 高频触发管线 → 费用与速度 | 同消息去重 + 连续 reroll 最小间隔 + 按角色开关 + 限频配置 |
| 锚点对齐在梨园纯文本正文的可靠性 | 迁移 LWB 多级定位策略（全文匹配→最长子串→尾部→去标点模糊）的**纯文本简化版**；失败回退消息末尾 |
| slot 映射文件写盘一致性 | 防抖 + 原子写（临时文件 rename）；映射可从正文/磁盘幂等重建（最坏情况丢失的是"未保存"缓存，符合节省模式预期） |
| danbooru-chars.dat 压缩格式与 node 兼容性 | 一期先验证：zip 容器则打包脚本转 gzip（node 原生 zlib 解压），不引入 fflate |
| 管线 LLM 输出 YAML 不稳 | 多级容错解析 + CRITICAL OUTPUT RULE 重试一次（迁移 LWB 行为） |
| 多图并发内存 | 逐任务串行 + 单图上限（maxImages 默认 2）；缓存图不预载 |
| 未保存图丢失（重启/清理） | 设计使然：占位符仍在正文（渲染为空态/重生成按钮），符合"仅保存后持久化"决策 |

**开放问题**（实现前需验证）：

1. `.liyuan-media/` 现有内容寻址命名（md5 前 16 位）与 slot versions 的多版本文件名冲突（同内容不同版本 = 同 md5？——内容寻址天然去重，版本切换靠映射记录，无需新文件名规则；确认）
2. 管线在**回档后**的行为：回档到旧世界线 → 正文占位符回到旧版 → 映射表是否随世界线快照回退（世界线机制是否覆盖 `.liyuan-state/draw-slots.json` 与 `.liyuan-media/` 需要实现时验证；原则：**映射随世界线回退，图片文件不删**——旧分支引用可重建）

---

## 7. 边界（Out of scope）

- ❌ zip 图库导入/导出归档（文件系统天然可迁移，复制即备份）
- ❌ 自定义图片保存目录（固定 `.liyuan-media/`）
- ❌ Anlas 查看 / 避免花费 Anlas 守卫
- ❌ SD WebUI / ComfyUI 请求实现（仅预留）
- ❌ 视频生成、表情生成
- ❌ 剧情侧生图 tool（主模型不直接生图）
- ❌ 正文改写：占位符是唯一介入点，且仅插件 B 写入

---

## 8. 实施对账（2026-08-08 一期落地）

一期全部落地后与本文档的差异及用户裁决（实施过程中逐项求证，DESIGN 文档与开发过程互相佐证）：

| # | 差异点 | 裁决 |
|---|---|---|
| 1 | 管线输入一期简化（无压缩摘要/lore 检索） | **现在补齐**（已完成：rp-summary 摘要 + loadMergedLore/searchEntries 注入 + historyText N 条前文） |
| 2 | 场景分级校验轻量化（不拦截，NAI 错误分类兜底） | 接受现状 |
| 3 | REST resolve 无账本 currentOutfit（RestHost 无 worldState getter） | **补 RestHost.worldState() 只读 getter**（已完成，resolve 按账本解析；wardrobe_list 工具不碰 bridge，显示「需经面板设置」） |
| 4 | REST 路由常驻注册（开关只控工具/钩子/前端显示） | 接受常驻 |
| 5 | 「重新生成」= redraw（参数快照无原始 prompt；prompt 已存入 versions[].params.prompt，后续可切回 generate+原 prompt） | 接受 redraw |
| 6 | 手动「为这条消息配图」前端按钮 | 二期补（REST `/api/draw/pipeline/run` 已可用） |
| 7 | Q14 正文红线移除（AGENTS.md 同步更新） | 已记录（§0.2 原则 5 + 附录 A） |
| 8 | Q15 助手生图嵌入正文（验收期扩展）：draw_generate 默认嵌入最近剧情消息（`embed:false` 例外），wire 媒体翻译白名单扩到 draw_generate/draw_enhance，draw_generate/draw_enhance 补 emitStoryMedia 委托同步 | 已记录（附录 A Q15） |

**B 类实现细节（仅记录）**：旧 `draw-config.ts`/`novelai.ts` 垫片转发；slot-store 防抖 300ms + 原子写 + effectiveStore 合并；rebuild 孤儿占位符登记；saveSlot 幂等；deleteSlot 删全部版本文件；画廊双分区（生图槽位 + 本地出图）；detect 长名优先；YAML 逐行解析（无 js-yaml 直接依赖，领域层不引入未声明依赖）；lore query = 正文前 100 字符 + 角色名、条目 200 字符截断；resolve REST worldState 可选链兜底；pipeline 限频/去重模块级状态（resetPipelineDedupe/resetPipelineTimer 供测试）；压缩摘要只认 rp-summary 新格式（旧 compaction 兼容未做，取不到时安全回退 ""）。

**路径注记**：占位符注入采用 **rp-draft-op 读取时补丁**（追加隐藏补丁条目，树字节不改）而非直接改正文——比 DESIGN 3.2 原文更优的实现路径（显示侧 wire、送模侧 assemble、压缩 serializeForSummary 均经 applyDraftOps 自动生效），输入侧剥离 + 显示侧渲染天然一致；原设计「锚点对齐写入正文」语义等价保留（anchor.ts 四层定位 + 段落对齐产出 replace/append 补丁）。

**验收期修复记录（2026-08-08）**：
1. `GET /api/draw/providers` 返回结构对齐前端既有契约 `{ ok, config: {version, defaultProvider, autoConfirm}, providers }`（原平铺结构导致 DrawPanel `providers.data.config` 为 undefined → 渲染崩溃黑屏；styles 由独立接口 `/api/draw/styles` 提供）。
2. 补 `/api/extdata` GET/PUT 路由（既有缺失——HEAD 起 rest.ts 即无此路由，jsrunner 前端一直 404；按 `src/extdata.ts` 的 scope/key 语义实现，含 scope 白名单校验）。
3. **rp-draft-op 补丁 content 必须 JSON 字符串**（draft.ts `parseDraftOp` 要求 string → JSON.parse；对象形态被静默跳过——`embedStoryImage` 与管线 `appendPatch` 两处写入原传对象导致补丁在树里但永不应用，正文/送模均无效果；已改 `JSON.stringify`）。
4. 补丁写入后补 `resyncAll()`（rp-draft-op 是读取时生效补丁，前端历史重放才应用 applyDraftOps——`embedStoryImage` 与管线 `appendPatch` 原来不刷新，已渲染正文不更新；与 storyEdit 行为对齐）。
5. **正文嵌入改用 storyEdit 通道（2026-08-08 用户定调简化）**：排查发现 rp-draft-op 补丁机制有深层问题——补丁只改消息 text，**timeline（引擎定稿快照）不含补丁效果**，而前端时间线优先渲染（消息带 timeline 时忽略 text）→ 占位符永不显示（此坑解释了从首轮起所有"正文没图"）。**弃用 rp-draft-op 写入**，`embedStoryImage` 与管线 `appendPatch` 改为：应用补丁得新全文 → `editEntryViaStoryChannel`（storyEdit 同款：场记网关 → 目标校验 → branchCommitToTarget → rp-edited-reply 注入 → 重记账 → resyncAll）。rp-edited-reply 消息无 timeline，渲染走 RichContent → 占位符替换直接生效；正文可修改（红线已移除），原文旁支可回滚。wire.ts timeline 构建保留占位符补丁兼容段（历史 rp-draft-op 数据仍可显示）。
6. **二期验收期修复（2026-08-08）**：① `srcToRel` 原以 switch case 间 const 声明触发 **TDZ**（跳转命中时声明被跳过 → 带 slotId 的 generate/enhance 成功路径抛 ReferenceError——操作条所有操作受影响），已内联到各 case；② **配图按钮嵌入**：`RestHost.manualPipelineRun(text)`（main.ts 实现：runPipeline + patches 应用到当前分支最新 assistant → editEntryViaStoryChannel），`POST /api/draw/pipeline/run` 有宿主能力时优先走它（返回 embedded），配图按钮不再是"只进画廊不嵌正文"。
7. **验证期修复（2026-08-08，用户黑盒验证反馈）**：① **foldTurnNarratives 合并坑**：rp-edited-reply 与原始回复合并后，消息带**旧版 timeline（引擎定稿快照，不含补丁占位符）**而 text 含占位符——前端 timeline 优先渲染再次漏图（"助手出图后没嵌入正文"的真因；嵌入本身成功）。修复：`toWireHistory` 末尾统一兜底——消息有 timeline 且 text 含占位符而 timeline 正文段不含时，把占位符补进 timeline 末尾正文段；② **配图按钮防重入**：`illustrateBusy` 是 React state（异步更新），快速连点绕过——改 `illustrateLockRef` 同步锁 + toast 反馈（"配图任务已提交，约需 30–90 秒"）；③ **enhance/generate 400「解析失败」**：`resolveSourcePath`（src/draw/service.ts）把 `/cache/xxx` 解析为 `cwd/cache/xxx`——**少了点前缀**（实际目录 `.liyuan-cache/`；`/media/` 同理 `.liyuan-media/`）→ 源图永远"不存在"→ DrawError(parse)。修复前缀映射 + 同步更新 draw-service 测试（旧断言按错误目录造文件）。
8. **UX 待办（用户验证反馈记录，随配图助手/UX 轮处理）**：增强/放大/局部重绘加蒙版+转圈（参考 LWB）；局部重绘确认后无反馈；编辑 TAG 再生时输入框未禁用；配图按钮 spinner 不明显（ref 锁已生效）。
9. **LWB 黑盒对齐批次 1（2026-08-08）**：目标 = **外在表现与 LWB 一致，内部按 Liyuan 方式实现**（用户定调）。①版本选中持久化（`selectedVersionIndex` 落盘 + `POST /api/draw/slots/select`）+ 结构化 tags 存储（`{scene, characterPrompts[], positive}`，管线/生成路径落库时自动存）；②编辑 TAG 分栏（🎬场景 + 👤每角色，`PUT /api/draw/slots/tags` 覆盖保存不重绘）；③保存当前显示版（saveSlot 带 versionIndex）；④画廊「当前」标记 + 「使用此图」；⑤**配图按钮修复**：根因 = `modelRegistry.getApiKeyAndHeaders` 返回空（models.json 有 key 但 registry 未带出）→ 旁路规划 LLM "No API key" → 管线空转。改为 `loadAgentConfig(cwd).config.providers` 直读 key（与剧情模型同源）——端到端验证 `ran=true slots=1 embedded=true`；⑥**draw_generate 结构化**（用户批评"分层架构薄弱"修正）：tool 加 `characters?: string[]` 参数，角色 tag 组装在领域层（draw-role resolver + 账本 currentOutfit），助手生图也产出分栏 tags；⑦图片比例修复（`.draw-slot-wrap img.zoomable` 去掉固定 max-height，版本切换按自然比例）；⑧编辑 TAG 弹窗加「＋ 添加角色」（手动补角色栏，助手路径无 characters 时的兜底）。
10. **验证期修复（2026-08-11，用户反馈「插入图片正文重复」）**：图片嵌入（配图按钮/管线/助手 embedStoryImage，全走 `editEntryViaStoryChannel`）与手改 storyEdit 的 `branchCommitToTarget` 定位不同——手改钉**目标前驱**（原文移出当前分支，分支只剩覆盖全文）；图片嵌入钉**目标自身**（原文留在分支 + rp-edited-reply 覆盖追加）→ `foldTurnNarratives` 把同轮内原文（ABC）与覆盖（AIBC）**拼接**成一泡 → 前端显示「ABC\n\nAIBC」= 正文重复。修复（server/wire.ts `foldTurnNarratives`）：合并遇 `edited` 段（rp-edited-reply）时用改后全文**替换**前一叙事段而非拼接（覆盖语义，原文仍在会话树可回滚）；测试：wire.test.ts 新增 3 用例（折叠覆盖/连续覆盖/集成 toWireHistory），全量 781 过 770 挂 11（基线不变）。

---

## 附录 A：决策记录（Act 1 grill 结论）

| # | 决策点 | 结论 |
|---|---|---|
| Q1 | 插件机制形态 | 轻量模块化 + 能力包声明（plugin.json），预留升级正式插件机制的接口，不引入独立运行时 |
| Q2 | 底座边界 | 按推荐清单；**Anlas 查看/守卫移除**；底座 **tool 化**（插件建立在原生 tool 上，依赖方向正确）；SD/Comfy 预留=配置完备 + UI 可建但测试返回未实现 |
| Q3 | 生图 tool 暴露范围 | 助手侧注册 + 领域层可被接线层直调；剧情侧不暴露；插件/管线不走 tool 间调用 |
| Q4 | 管线触发 | A：auto + reroll 联动 + 三旋钮（总开关/按角色/手动配图）；管线模型独立配置 |
| Q5 | 占位符机制 | 占位符进正文；持久化**必须文件形式**（不内存留驻）；沿用 LWB 节省模式（仅保存后持久化） |
| Q6 | 保存触发 | A：手动默认（图上保存/全部保存/压缩回档前提示）+ 自动保存模式开关；未保存缓存 3 天清理 |
| Q7 | 角色管理范围 | 五组全做分两期：一期=服装补强+D标签离线库+检出+3 tools；二期=自动学习+自定义标签组+在线标签库 |
| Q8 | 编辑操作范围 | 全能力分两期：一期=保存/删除/重生成/增强/放大/局部重绘/编辑TAG；二期=AI微调+版本历史；UI=悬浮操作条+画廊版本网格 |
| Q9 | 能力包声明 | 按表执行：plugin.json（tools/panels/skills/requires）+ config plugins 段 + 默认关闭 + `.liyuan-plugins/<id>/`；requires 只做顺序加载+冲突检测 |
| Q10 | 占位符插入位置 | **锚点对齐全套**（4 层定位+段落对齐，纯文本简化版）；总目标=底座画图接口 + 插件图文并茂 |
| Q14 | 正文红线 | 2026-08-08 用户裁决：**移除「剧情正文永不改写」红线**（文章多次润色属常态），管线可向正文附加 `[image:slotId]` 锚点、未来可润色；修改保留可追溯性（会话树分支可回滚）；输入侧仍剥离占位符 |
| Q15 | 助手生图嵌入正文 | 2026-08-08 用户裁决（超出一期扩展）：助手 `draw_generate` 生图**默认嵌入最近一条剧情消息正文**（锚点缺省 → 消息末尾 append），除非用户提示不嵌入（`embed:false`）；经 `embedStoryImage` 桥权限（FULL 开、自定义 agent 默认关）。**实现采用用户定调的三步简化方案**（2026-08-08 复盘：生图得 id → 改正文 tool 写入 → 渲染正则替换，不走 rp-draft-op 补丁）：占位符经 **storyEdit 通道（rp-edited-reply 分支注入）** 写入正文——正文可修改（红线已移除）、渲染走 RichContent 无 timeline 快照问题、原文旁支可回滚；管线 `appendPatch` 同通道 |
| Q11 | skill 定位与合规 | skill 双用途（管线提示词素材 + 自定义 agent 文档）；轻量合规（硬上限截断 + 场景分级校验） |
| Q12 | 画廊/归档 | 精简：画廊=版本网格+Lightbox；不做 zip 导入导出；不做自定义目录 |
| Q13 | 交付物 | `docs/DESIGN-draw.md` + 试跑 Act 2（Codex 对抗评审） |

---

## 9. 画师 agent 生图规范约定（2026-08-16 落地）

> 本节记录**画师 agent 生图规范**的约定变更（POV / 构图多样化 / 特殊构图 / NSFW 关键 tag）。规范本体在 `.liyuan-skills/*.md`（画师实读，每拍素材现读、下一拍生效），此处是变更索引 + 跨文件对应，不带系统架构改动（架构见 §0-8）。

### 触发背景
自定义 agent「画师」生图有此系列问题：不用 POV / 单人脸部特写（尤其多人）、倾向把所有人物全带上、view 只有 side view、构图单一乏味；NSFW 下不补 penis/pussy 关键部位 tag、不明确用性交/体位 tag。

### 规范载体与对应
| 文件 | 管什么 |
|---|---|
| `.liyuan-skills/moment-capture.md` | 何时出/几张/等级/体位/打不打特殊构图标记 + **构图多样化规划** |
| `.liyuan-skills/novelai-draw.md` | POV 三要素用法 + POV 挂点不进人物栏 + X-ray/横截面/分镜写法 + 特写强制表 + 区域限制豁免 + **NSFW 关键 tag 必写** |
| `liyuan.config.json` → `agents[].id=illustrator.prompt` | 画师执行纪律硬规则 |

### 约定要点
1. **POV 三要素**（novelai-draw「视角构图」）：挂点（`pov: [角色名]`）·出镜（焦点对准具体对象）·景深（DOF/前后景分离）。POV=机位归属，close-up=景别远近，可叠加。
2. **POV 挂点角色不进 characters（强制）**：镜头所在不出镜的角色（如凯尔 POV 的凯尔）不写进人物栏，scene 用 `pov: [角色名]` 记录归属。
3. **POV 与多人共存**：多人 POV 不要求全员入镜，可另出 wide/group 补全员信息；区域限制从「人数禁 close-up」改为「限景别上限、不禁 POV/特写」。
4. **构图多样化（多图强制）**：景别穿插 + 视角轮换 + pov，禁「全前侧全景侧视图」单一模板；附 2/3/4 张组合模板。
5. **多人 POV 配额**：在场 ≥3 且多图 → 至少 1 张 POV/单人特写；对话/对望/情绪凝视优先 POV。
6. **特殊构图（X-ray/横截面/分镜）**：moment-capture「出图策略标记」触发，每场性行为最多 1 次，优先级 分镜>横截面>X-ray；触发判据 = 内部吸收/交合剖面/连续过程。X-ray 例（吞精吸收·精液注入子宫）：`x-ray` + 保留三轴/体位 + `semen in uterus`/`cum inflation`/`gobbling up semen`；X-ray 角色照常进 characters、可豁免特写强制表。
7. **NSFW 关键 tag 必写（与视角无关）**：nsfw 时刻无论视角都写齐 `sex`(或 fellatio/vaginal) + 体位 tag + 双方性器官 `penis/pussy`。有档案角色不能省（appear 只管外貌、不豁免性器官 tag）。根因=旧规范把性器官 tag 放 apply「仅未知角色」栏致有档案角色缺失。
8. **Q5 挂钩（moment-capture）**：判 nsfw 即须带关键 tag，捕捉阶段标注。
