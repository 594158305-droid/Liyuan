# 卡前端 P0+P1(v1.0.5)实现计划:呈现层底座 + 一档皮肤直渲

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 酒馆美化卡导入梨园后,卡作者的显示向正则皮肤(状态栏 HTML/CSS 模板)在对话流中无缝原样呈现,且送模历史裁剪一字不动。

**Architecture:** 服务端从盘上卡文件提取 `extensions.regex_scripts` 并筛出显示向规则(`src/cardfront.ts`,纯 TS);web 端在显示管线最前端应用规则(`web/src/cardSkin.ts`,纯 TS),产物经升级后的混排切分(`htmlEmbed.ts`)进无痕沙箱帧(`HtmlFrame.tsx` ghost 模式)。规格来源:`docs/superpowers/specs/2026-07-22-card-frontend-design.md`。

**Tech Stack:** Node ≥22 原生 TS 执行,`node --test`,React 19 + Vite(web/),无新依赖。

## Global Constraints

- 沙箱不退让:脚本帧(`scripts=true`)**永不**给 `allow-same-origin`;静态帧可给 `allow-same-origin` 但**永不**给 `allow-scripts`;CSP 不放宽(spec §3.5)。
- 裁剪不回升:皮肤只作用于显示文本;`cleanAssistantText`(送模历史)与 scribe/压缩路径零改动(spec §3.6)。
- 显示层纪律(D10):皮肤是卡作者的确定性显示变换,不是 AI 改写;应用点只在 web 显示管线,持久化消息原文不动。
- 不读酒馆/酒馆助手源码(D5);正则语义按卡内字段与公开卡规范实现。
- 解析失败的单条规则跳过并 `console.warn`,不炸整卡(spec §10)。
- 代码风格:tab 缩进、中文块注释讲「为什么」、领域层(src/)不 import pi(D3);测试文件放 `test/*.test.ts`,风格对照 `test/htmlEmbed.test.ts`(node:test + assert/strict)。
- 每个任务收尾跑 `node --test test/*.test.ts` 全绿再 commit。

**已知样本**(测试夹具直接用):`assets/cards/淫宫美人录.png` 有两条显示向皮肤规则:`/<StatusBlock>/gs` → `<div style="background-color: rgba(0, 0, 0, 0.5); …"><status>`、`/<\/StatusBlock>/gs` → `</status></div>`;`assets/cards/大乾风华录 Ver1.7.json` 有两条清理向规则(`删除描写分析` promptOnly,`角色登场2` 显示向删除)——用于验证筛选边界。

**v1 明确不支持**(遇到即整条跳过+warn,不硬猜):`trimStrings` 非空、`substituteRegex≠0`、`minDepth/maxDepth` 非 null 的深度限定语义(规则仍应用,深度字段忽略并 warn)。

---

### Task 1: `src/cardfront.ts` — 提取与筛选显示向规则

**Files:**
- Create: `src/cardfront.ts`
- Test: `test/cardfront.test.ts`

**Interfaces:**
- Consumes: `readCardRawJson(path)` 的返回值形态(`{ isPng, raw }`,raw 为卡原始 JSON 对象,字段可能在顶层或 `.data`)——本模块**不读盘**,吃 raw 对象,读盘由 rest 层做。
- Produces(后续任务依赖,签名精确):
  - `interface DisplayRule { name: string; source: string; flags: string; replace: string }`
  - `extractRegexScripts(raw: Record<string, unknown>): unknown[]` — 取 `data.extensions.regex_scripts ?? extensions.regex_scripts`,非数组返回 `[]`
  - `displayRules(scripts: unknown[]): DisplayRule[]` — 筛选+解析,坏条目跳过
  - `isSkinEnabled(config: { card: string; cardSkinOff?: string[] }, cardPath: string): boolean`
  - `setSkinEnabled(config: RpConfig, cardPath: string, enabled: boolean): RpConfig` — 返回新对象,维护 `cardSkinOff` 数组

- [ ] **Step 1: 写失败测试**

```ts
// test/cardfront.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { displayRules, extractRegexScripts, isSkinEnabled, setSkinEnabled } from "../src/cardfront.ts";

/** 淫宫美人录实卡形态(内联夹具,不读盘,测试自包含) */
const skinScript = {
	scriptName: "状态栏",
	findRegex: "/<StatusBlock>/gs",
	replaceString: '<div style="background-color: rgba(0, 0, 0, 0.5);"><status>',
	placement: [2],
	disabled: false,
	markdownOnly: true,
	promptOnly: false,
	trimStrings: [],
};
/** 大乾风华录:promptOnly 清理向,显示层必须排除 */
const promptOnlyScript = {
	scriptName: "删除描写分析",
	findRegex: "/<descriptive_analysis>[\\s\\S]*</descriptive_analysis>/gm",
	replaceString: "",
	placement: [2],
	disabled: false,
	markdownOnly: false,
	promptOnly: true,
	trimStrings: [],
};

test("extractRegexScripts: data.extensions 与顶层 extensions 都认,缺失返回空", () => {
	assert.equal(extractRegexScripts({ data: { extensions: { regex_scripts: [skinScript] } } }).length, 1);
	assert.equal(extractRegexScripts({ extensions: { regex_scripts: [skinScript] } }).length, 1);
	assert.deepEqual(extractRegexScripts({ name: "x" }), []);
	assert.deepEqual(extractRegexScripts({ data: { extensions: { regex_scripts: "bad" } } }), []);
});

test("displayRules: 显示向保留,promptOnly/disabled/非AI输出排除", () => {
	const rules = displayRules([
		skinScript,
		promptOnlyScript,
		{ ...skinScript, scriptName: "已停用", disabled: true },
		{ ...skinScript, scriptName: "只管用户输入", placement: [1] },
	]);
	assert.equal(rules.length, 1);
	assert.equal(rules[0].name, "状态栏");
	assert.equal(rules[0].source, "<StatusBlock>");
	assert.equal(rules[0].flags, "gs");
	assert.ok(rules[0].replace.startsWith("<div"));
});

test("displayRules: 裸模式串(无 /…/ 包裹)按字面正则源处理", () => {
	const rules = displayRules([{ ...skinScript, findRegex: "<StatusBlock>" }]);
	assert.equal(rules.length, 1);
	assert.equal(rules[0].source, "<StatusBlock>");
	assert.equal(rules[0].flags, "g"); // 无声明时默认 g,保证全文替换
});

test("displayRules: 非法正则跳过不抛", () => {
	const rules = displayRules([{ ...skinScript, findRegex: "/([unclosed/g" }, skinScript]);
	assert.equal(rules.length, 1);
});

test("displayRules: trimStrings 非空的规则整条跳过(v1 不支持,宁缺毋错)", () => {
	const rules = displayRules([{ ...skinScript, trimStrings: ["x"] }]);
	assert.equal(rules.length, 0);
});

test("skin 开关:默认开,cardSkinOff 关,setSkinEnabled 幂等往返", () => {
	const cfg = { card: "assets/cards/a.png" } as never;
	assert.equal(isSkinEnabled({ card: "assets/cards/a.png" }, "assets/cards/a.png"), true);
	const off = setSkinEnabled(cfg, "assets/cards/a.png", false);
	assert.equal(isSkinEnabled(off, "assets/cards/a.png"), false);
	const on = setSkinEnabled(off, "assets/cards/a.png", true);
	assert.equal(isSkinEnabled(on, "assets/cards/a.png"), true);
	assert.deepEqual(on.cardSkinOff, []);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/cardfront.test.ts`
Expected: FAIL,`Cannot find module '../src/cardfront.ts'`

- [ ] **Step 3: 最小实现**

```ts
// src/cardfront.ts
/**
 * 卡前端(一档皮肤):从卡原始 JSON 提取 ST regex_scripts,筛出「显示向美化规则」。
 *
 * 筛选逻辑(spec §7 P1):!disabled && placement 含 2(AI 输出) && !(promptOnly && !markdownOnly)。
 * 清理向(promptOnly)规则不进显示层——harness 策略引擎(postprocess)已原生替代。
 * v1 不支持 trimStrings/substituteRegex:遇到整条跳过,宁缺毋错(显示错样式比没样式糟)。
 */

import type { RpConfig } from "./types.ts";

export interface DisplayRule {
	name: string;
	/** 正则源文本(不含定界斜杠) */
	source: string;
	flags: string;
	replace: string;
}

/** ST 卡的 regex_scripts 数组(data.extensions 优先,顶层 extensions 兜底) */
export function extractRegexScripts(raw: Record<string, unknown>): unknown[] {
	const data = raw.data && typeof raw.data === "object" ? (raw.data as Record<string, unknown>) : raw;
	const ext = data.extensions && typeof data.extensions === "object" ? (data.extensions as Record<string, unknown>) : {};
	return Array.isArray(ext.regex_scripts) ? ext.regex_scripts : [];
}

/** "/pattern/flags" → {source, flags};裸串按字面源、默认 g */
function parseFindRegex(find: string): { source: string; flags: string } | null {
	const m = /^\/([\s\S]+)\/([a-z]*)$/.exec(find.trim());
	const source = m ? m[1] : find;
	const flags = m?.[2] || "g";
	try {
		new RegExp(source, flags);
	} catch {
		return null;
	}
	return { source, flags };
}

export function displayRules(scripts: unknown[]): DisplayRule[] {
	const out: DisplayRule[] = [];
	for (const s of scripts) {
		if (!s || typeof s !== "object") continue;
		const r = s as Record<string, unknown>;
		if (r.disabled === true) continue;
		const placement = Array.isArray(r.placement) ? r.placement : [];
		if (!placement.includes(2)) continue; // 2 = AI 输出
		if (r.promptOnly === true && r.markdownOnly !== true) continue; // 纯送模侧,显示层不管
		if (Array.isArray(r.trimStrings) && r.trimStrings.length > 0) {
			console.warn(`[cardfront] 规则「${String(r.scriptName ?? "?")}」用了 trimStrings,v1 不支持,跳过`);
			continue;
		}
		const find = typeof r.findRegex === "string" ? r.findRegex : "";
		if (!find.trim()) continue;
		const parsed = parseFindRegex(find);
		if (!parsed) {
			console.warn(`[cardfront] 规则「${String(r.scriptName ?? "?")}」正则无法解析,跳过`);
			continue;
		}
		out.push({
			name: typeof r.scriptName === "string" ? r.scriptName : "",
			source: parsed.source,
			flags: parsed.flags,
			replace: typeof r.replaceString === "string" ? r.replaceString : "",
		});
	}
	return out;
}

/** 皮肤开关:默认开;关过的卡记在 config.cardSkinOff(路径列表,同 disabledLore 模式) */
export function isSkinEnabled(config: { card: string; cardSkinOff?: string[] }, cardPath: string): boolean {
	return !(config.cardSkinOff ?? []).includes(cardPath);
}

export function setSkinEnabled(config: RpConfig, cardPath: string, enabled: boolean): RpConfig {
	const cur = config.cardSkinOff ?? [];
	const next = enabled ? cur.filter((p) => p !== cardPath) : cur.includes(cardPath) ? cur : [...cur, cardPath];
	return { ...config, cardSkinOff: next };
}
```

另在 `src/types.ts` 的 `RpConfig` 内(`assistantModel` 字段后)加:

```ts
	/** 一档卡皮肤:显示向美化正则被用户关闭的卡路径列表(默认开;spec 2026-07-22 §7 P1) */
	cardSkinOff?: string[];
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/cardfront.test.ts`
Expected: PASS(7 tests)

- [ ] **Step 5: 全量回归 + commit**

Run: `node --test test/*.test.ts` → 全绿(201+7)
```bash
git add src/cardfront.ts src/types.ts test/cardfront.test.ts
git commit -m "feat(cardfront): 提取与筛选卡显示向美化正则(一档皮肤域层)"
```

---

### Task 2: `web/src/cardSkin.ts` — 显示层应用规则

**Files:**
- Create: `web/src/cardSkin.ts`
- Test: `test/cardSkin.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `DisplayRule`(web 侧经 wire 拿到的是同构 JSON,类型从 `../../src/cardfront.ts` **type-only** 导入,与 `web/src/wire.ts` 对 server 的再导出同模式)。
- Produces:
  - `applyCardSkin(text: string, rules: DisplayRule[], macros: { charName: string; userName: string }): string`
  - 宏语义:find 源里的 `{{user}}/{{char}}`(大小写不敏感)先做**正则转义后**替换;replace 里的宏做字面替换;replace 里的 `{{match}}` 映射为 `$&`。

- [x] **Step 1: 写失败测试**

```ts
// test/cardSkin.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { applyCardSkin } from "../web/src/cardSkin.ts";

const M = { charName: "青梧", userName: "旅人" };
const wrapOpen = { name: "状态栏", source: "<StatusBlock>", flags: "gs", replace: '<div style="x"><status>' };
const wrapClose = { name: "状态栏2", source: "</StatusBlock>", flags: "gs", replace: "</status></div>" };

test("皮肤包装:开闭标签替换为卡作者 HTML(淫宫美人录模式)", () => {
	const out = applyCardSkin("正文\n<StatusBlock>\nHP: 80\n</StatusBlock>\n尾", [wrapOpen, wrapClose], M);
	assert.ok(out.includes('<div style="x"><status>'));
	assert.ok(out.includes("</status></div>"));
	assert.ok(!out.includes("<StatusBlock>"));
});

test("捕获组 $1 重排进模板", () => {
	const rule = { name: "血条", source: "HP[:：]\\s*(\\d+)", flags: "g", replace: '<b class="hp">$1</b>' };
	assert.equal(applyCardSkin("HP: 80", [rule], M), '<b class="hp">80</b>');
});

test("宏:find 与 replace 里的 {{user}}/{{char}} 生效;find 侧转义安全", () => {
	const rule = { name: "呼名", source: "{{char}}(说)", flags: "g", replace: "「{{char}}」$1" };
	assert.equal(applyCardSkin("青梧说", [rule], M), "「青梧」说");
});

test("{{match}} 映射整段命中", () => {
	const rule = { name: "高亮", source: "\\*\\*.+?\\*\\*", flags: "g", replace: "<mark>{{match}}</mark>" };
	assert.equal(applyCardSkin("**重要**", [rule], M), "<mark>**重要**</mark>");
});

test("单条规则运行期出错不影响其余规则", () => {
	// flags 合法但 source 在应用期构造失败的场景难造,退一步:构造期抛错由 try/catch 吞掉
	const bad = { name: "坏", source: "(?<", flags: "g", replace: "x" };
	assert.equal(applyCardSkin("<StatusBlock>a</StatusBlock>", [bad, wrapOpen, wrapClose], M).includes("<status>"), true);
});

test("空规则原文返回", () => {
	assert.equal(applyCardSkin("原文", [], M), "原文");
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `node --test test/cardSkin.test.ts`
Expected: FAIL,模块不存在

- [x] **Step 3: 最小实现**

```ts
// web/src/cardSkin.ts
/**
 * 一档卡皮肤:在显示文本上应用卡作者的美化正则(spec §7 P1)。
 * 只跑显示层——送模历史在 server 侧另有裁剪,此处产物绝不回流。
 * 单条规则失败静默跳过:显示层宁可少化妆,不能白屏。
 */

import type { DisplayRule } from "../../src/cardfront.ts";

const escapeReg = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function substMacros(text: string, macros: { charName: string; userName: string }, forRegex: boolean): string {
	const char = forRegex ? escapeReg(macros.charName) : macros.charName;
	const user = forRegex ? escapeReg(macros.userName) : macros.userName;
	return text.replace(/\{\{\s*char\s*\}\}/gi, char).replace(/\{\{\s*user\s*\}\}/gi, user);
}

export function applyCardSkin(
	text: string,
	rules: DisplayRule[],
	macros: { charName: string; userName: string },
): string {
	let out = text;
	for (const r of rules) {
		try {
			const re = new RegExp(substMacros(r.source, macros, true), r.flags);
			const replace = substMacros(r.replace, macros, false).replace(/\{\{\s*match\s*\}\}/gi, "$$&");
			out = out.replace(re, replace);
		} catch {
			// 单条坏规则不拖累整条管线
		}
	}
	return out;
}
```

- [x] **Step 4: 跑测试确认通过**

Run: `node --test test/cardSkin.test.ts`
Expected: PASS(6 tests)

- [x] **Step 5: 全量回归 + commit**

```bash
node --test test/*.test.ts
git add web/src/cardSkin.ts test/cardSkin.test.ts
git commit -m "feat(cardfront): web 显示层应用皮肤规则(宏/捕获组/容错)"
```

---

### Task 3: `htmlEmbed.ts` 混排切分升级 — 识别正文中的顶层 HTML 块

**Files:**
- Modify: `web/src/htmlEmbed.ts`
- Test: `test/htmlEmbed.test.ts`(追加用例,存量 4 例不许动)

**Interfaces:**
- Produces: `splitHtmlParts` 行为扩展——除现有 ```` ```html ```` 围栏与整段文档外,把行首出现的**标准容器元素块**(`div/section/article/table/figure/details/style` 开头,同名深度配平到闭合)切成 `{ kind: "html", scripts: false }` 段。自定义标签(如 `<StatusBlock>`、`<status>` 单独出现)**不**触发——那是 statusBlocks/postprocess 的地盘;但皮肤替换产物以 `<div` 等标准标签开头,天然命中。
- 新导出:`isFullInterface(text: string): boolean` — 整条消息就是一个界面(单段 html 且无正文文字),Task 5 的整楼判定用。

- [ ] **Step 1: 追加失败测试**

```ts
// test/htmlEmbed.test.ts 追加
import { isFullInterface } from "../web/src/htmlEmbed.ts"; // 并入顶部 import

test("splitHtmlParts: 正文中的顶层 <div> 块切为 html 段(皮肤产物形态)", () => {
	const text = '雨停了。\n<div style="x">\n<status>\nHP: 80\n</status>\n</div>\n她抬头。';
	const p = splitHtmlParts(text);
	assert.equal(p.length, 3);
	assert.equal(p[0].kind, "text");
	assert.equal(p[1].kind, "html");
	if (p[1].kind === "html") {
		assert.ok(p[1].html.startsWith("<div"));
		assert.ok(p[1].html.endsWith("</div>"));
		assert.equal(p[1].scripts, false);
	}
	assert.equal(p[2].kind, "text");
});

test("splitHtmlParts: 嵌套同名 div 深度配平", () => {
	const text = "<div><div>内</div></div>后文";
	const p = splitHtmlParts(text);
	assert.equal(p[0].kind, "html");
	if (p[0].kind === "html") assert.equal(p[0].html, "<div><div>内</div></div>");
	assert.equal(p[1].kind, "text");
});

test("splitHtmlParts: 自定义标签不触发块切分(留给 statusBlocks)", () => {
	const p = splitHtmlParts("<StatusBlock>\nHP: 80\n</StatusBlock>");
	assert.equal(p.length, 1);
	assert.equal(p[0].kind, "text");
});

test("splitHtmlParts: 行中 <div>(非行首)不切,避免误伤叙事里的尖括号", () => {
	const p = splitHtmlParts("他说 <div> 不是标签");
	assert.equal(p.length, 1);
	assert.equal(p[0].kind, "text");
});

test("splitHtmlParts: 未闭合 div 当普通文本", () => {
	const p = splitHtmlParts("<div>没有闭合");
	assert.equal(p.length, 1);
	assert.equal(p[0].kind, "text");
});

test("isFullInterface: 整条消息即界面", () => {
	assert.equal(isFullInterface('<div style="x">全屏界面</div>'), true);
	assert.equal(isFullInterface("<!DOCTYPE html><html><body>x</body></html>"), true);
	assert.equal(isFullInterface("正文\n<div>局部</div>"), false);
	assert.equal(isFullInterface("纯正文"), false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/htmlEmbed.test.ts`
Expected: 新 6 例 FAIL,存量 4 例 PASS

- [ ] **Step 3: 实现**

在 `web/src/htmlEmbed.ts` 追加(splitHtmlParts 围栏切分后,对每个 text 段再过一遍块扫描):

```ts
/** 标准容器标签白名单:皮肤/界面产物以它们开头;自定义标签(状态栏族)绝不在此列 */
const BLOCK_TAGS = /^(div|section|article|table|figure|details|style)$/i;

/** 在纯文本段中切出行首起始、深度配平的标准 HTML 块 */
function splitTopLevelBlocks(text: string): TextPart[] {
	const openRe = /^[ \t]*<(\w+)(\s[^>]*)?>/gm;
	const parts: TextPart[] = [];
	let last = 0;
	let m: RegExpExecArray | null;
	while ((m = openRe.exec(text)) !== null) {
		const tag = m[1];
		if (!BLOCK_TAGS.test(tag)) continue;
		// 从开标签起做同名深度配平
		const tagRe = new RegExp(`<(/?)${tag}(?:\\s[^>]*)?>`, "gi");
		tagRe.lastIndex = m.index;
		let depth = 0;
		let end = -1;
		let t: RegExpExecArray | null;
		while ((t = tagRe.exec(text)) !== null) {
			depth += t[1] ? -1 : 1;
			if (depth === 0) {
				end = t.index + t[0].length;
				break;
			}
		}
		if (end < 0) continue; // 未闭合:整段留作文本
		const before = text.slice(last, m.index);
		if (before.trim()) parts.push({ kind: "text", text: before });
		parts.push({ kind: "html", html: text.slice(m.index, end).trim(), scripts: false });
		last = end;
		openRe.lastIndex = end;
	}
	if (parts.length === 0) return [{ kind: "text", text }];
	const rest = text.slice(last);
	if (rest.trim()) parts.push({ kind: "text", text: rest });
	return parts;
}

/** 整条消息就是一个界面(单 html 段、无正文残留)——整楼模式判定(spec §4 落位 1) */
export function isFullInterface(text: string): boolean {
	const parts = splitHtmlParts(text);
	return parts.length === 1 && parts[0].kind === "html";
}
```

并把 `splitHtmlParts` 收尾改为(替换现有 `return parts.length > 0 ? parts : [{ kind: "text", text }];` 及其前的整文档判断段):

```ts
	// 整段就是 HTML 文档(无围栏)——常见于部分卡 first_mes
	if (parts.length === 1 && parts[0].kind === "text" && looksLikeHtmlDocument(parts[0].text)) {
		return [{ kind: "html", html: parts[0].text.trim(), scripts: false }];
	}
	const base = parts.length > 0 ? parts : [{ kind: "text", text } as TextPart];
	// 文本段二次扫描:行首标准容器块(皮肤产物)切成 html 段
	return base.flatMap((p) => (p.kind === "text" ? splitTopLevelBlocks(p.text) : [p]));
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/htmlEmbed.test.ts`
Expected: PASS(10 tests);再跑 `node --test test/statusBlocks.test.ts test/show-html.test.ts` 确认相邻模块无回归

- [ ] **Step 5: 全量回归 + commit**

```bash
node --test test/*.test.ts
git add web/src/htmlEmbed.ts test/htmlEmbed.test.ts
git commit -m "feat(cardfront): 混排切分识别顶层 HTML 块 + 整楼界面判定"
```

---

### Task 4: `HtmlFrame` 无痕化 — ghost 工具条、真实高度、样式主权

**Files:**
- Modify: `web/src/components/HtmlFrame.tsx`
- Modify: `web/src/app.css`(约 5425 行「对话流 HTML 底座」段落附近追加)
- Test: `test/show-html.test.ts`(追加对导出纯函数的用例)

**Interfaces:**
- Produces:
  - `HtmlFrame` 新增可选 props:`seamless?: boolean`(默认 false 保持 agent show_html 现状;true=无痕模式)
  - 导出 `buildSrcDoc(html: string, scripts: boolean, seamless: boolean): string`(现为私有,导出供测试)
  - 导出 `HEIGHT_REPORTER_SNIPPET: string`(脚本帧注入的高度上报脚本)
- 行为矩阵:
  - `seamless=false`:一切照旧(工具条、BASE_CSS、560 上限)——agent `show_html` 调试观感不变,本任务零回归;
  - `seamless=true` 静态帧:`sandbox="allow-same-origin"`(无 allow-scripts),`buildSrcDoc` 不注入 BASE_CSS 字体(只保 `html,body{margin:0;background:transparent}img,video{max-width:100%}`),量高上限放宽为 `Infinity`(跟随内容);
  - `seamless=true` 脚本帧:`sandbox="allow-scripts"`(不变,永无 same-origin),srcdoc 尾部注入 `HEIGHT_REPORTER_SNIPPET`(ResizeObserver → `postMessage({ liyuanFrameHeight, frameId })`),父组件 `useEffect` 监听 `message` 事件按 `frameId` 对号入座设高;
  - `seamless=true` 时工具条不渲染,改渲染 `<div className="msg-html-ghost">`(悬停浮现的「源码」链钮,复用现有 showSource state)。

- [ ] **Step 1: 追加失败测试**

```ts
// test/show-html.test.ts 追加(顶部 import 并入)
import { buildSrcDoc, HEIGHT_REPORTER_SNIPPET } from "../web/src/components/HtmlFrame.tsx";

test("buildSrcDoc seamless 静态:不强制字体,保留透明底", () => {
	const doc = buildSrcDoc("<div>x</div>", false, true);
	assert.ok(!doc.includes("PingFang"));
	assert.ok(doc.includes("background:transparent"));
	assert.ok(!doc.includes("liyuanFrameHeight"));
});

test("buildSrcDoc seamless 脚本帧:注入高度上报", () => {
	const doc = buildSrcDoc("<div>x</div>", true, true);
	assert.ok(doc.includes("liyuanFrameHeight"));
	assert.ok(doc.includes("ResizeObserver"));
});

test("buildSrcDoc 非 seamless:行为与旧版一致(仍带基础字体)", () => {
	const doc = buildSrcDoc("<div>x</div>", false, false);
	assert.ok(doc.includes("PingFang"));
});

test("HEIGHT_REPORTER_SNIPPET 是自包含 script", () => {
	assert.ok(HEIGHT_REPORTER_SNIPPET.startsWith("<script>"));
	assert.ok(HEIGHT_REPORTER_SNIPPET.endsWith("</script>"));
});
```

注意:该测试文件在 node 环境 import `.tsx`——若现有 `test/show-html.test.ts` 已 import HtmlFrame 相关(先看文件现状,它测的是 show_html 域逻辑),而 node 无法解析 JSX,则把 `buildSrcDoc`/`HEIGHT_REPORTER_SNIPPET` 移到**新文件 `web/src/frameDoc.ts`**(纯 TS 无 JSX),`HtmlFrame.tsx` 从那里 import;测试 import `../web/src/frameDoc.ts`。以实际能跑为准,优先纯 TS 拆分方案。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/show-html.test.ts`
Expected: 新 4 例 FAIL

- [ ] **Step 3: 实现**

`web/src/frameDoc.ts`(新,srcdoc 组装纯函数,自 HtmlFrame 迁出):

```ts
// web/src/frameDoc.ts
/** srcdoc 组装(纯函数,供 HtmlFrame 与测试):seamless 模式样式主权让位给卡(spec §4) */

const LEGACY_BASE_CSS =
	`html,body{margin:0;padding:0;background:transparent;color:#3f3f3f;` +
	`font:13.5px/1.55 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei","Noto Sans SC","Segoe UI",sans-serif}` +
	`img,video{max-width:100%;height:auto}` +
	`* {box-sizing:border-box}`;

/** 无痕模式兜底:只保透明底与媒体不溢出,字体配色全归卡作者 */
const SEAMLESS_BASE_CSS =
	`html,body{margin:0;padding:0;background:transparent}` + `img,video{max-width:100%;height:auto}`;

export const HEIGHT_REPORTER_SNIPPET =
	`<script>(function(){var last=0;function post(){var h=Math.max(` +
	`document.documentElement.scrollHeight,document.body?document.body.scrollHeight:0);` +
	`if(h!==last){last=h;parent.postMessage({liyuanFrameHeight:h,frameId:window.name},"*");}}` +
	`if(typeof ResizeObserver!=="undefined"){new ResizeObserver(post).observe(document.documentElement);}` +
	`window.addEventListener("load",post);setInterval(post,800);})();</script>`;

export function buildSrcDoc(html: string, scripts: boolean, seamless: boolean): string {
	const trimmed = html.trim();
	const isFull = /^\s*<(!doctype|html[\s>])/i.test(trimmed);
	const csp = scripts
		? `default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https: http: data: blob:; style-src 'unsafe-inline' https: http: data:; img-src data: blob: https: http:; font-src data: https: http:; media-src data: blob: https: http:; connect-src https: http: ws: wss:; frame-src 'none'`
		: `default-src 'none'; style-src 'unsafe-inline' https: http: data:; img-src data: blob: https: http:; font-src data: https: http:; media-src data: blob: https: http:`;
	const head =
		`<meta charset="utf-8">` +
		`<meta http-equiv="Content-Security-Policy" content="${csp}">` +
		`<style>${seamless ? SEAMLESS_BASE_CSS : LEGACY_BASE_CSS}</style>`;
	const tail = scripts && seamless ? HEIGHT_REPORTER_SNIPPET : "";
	if (isFull) {
		const withHead = /<head[\s>]/i.test(trimmed) ? trimmed.replace(/<head([^>]*)>/i, `<head$1>${head}`) : trimmed;
		return tail ? withHead.replace(/<\/body>/i, `${tail}</body>`) : withHead;
	}
	return `<!doctype html><html><head>${head}</head><body>${trimmed}${tail}</body></html>`;
}
```

`HtmlFrame.tsx` 改造要点(保留现有结构,增量修改):

```tsx
// 新 props:seamless(默认 false);frameId 用 useId() 生成注入 iframe name
import { useEffect, useId, useRef, useState } from "react";
import { buildSrcDoc } from "../frameDoc.ts";

export function HtmlFrame({ html, title, scripts = false, seamless = false, minHeight = 120, maxHeight = 560 }: {
	html: string; title?: string; scripts?: boolean; seamless?: boolean; minHeight?: number; maxHeight?: number;
}) {
	const frameId = useId();
	const ref = useRef<HTMLIFrameElement>(null);
	const [height, setHeight] = useState(minHeight);
	const [showSource, setShowSource] = useState(false);
	const srcDoc = buildSrcDoc(html, scripts, seamless);
	// 沙箱矩阵(Global Constraints):脚本帧永无 same-origin;seamless 静态帧给 same-origin 以便量高
	const sandbox = scripts ? "allow-scripts" : seamless ? "allow-same-origin" : "";
	const cap = seamless ? Number.POSITIVE_INFINITY : maxHeight;

	// 静态帧量高(seamless 下 same-origin 可读;旧模式维持原 try/catch 行为)
	useEffect(() => {
		if (scripts) {
			if (!seamless) setHeight(maxHeight);
			return;
		}
		const el = ref.current;
		if (!el) return;
		const fit = () => {
			try {
				const doc = el.contentDocument;
				const h = doc?.documentElement?.scrollHeight || doc?.body?.scrollHeight || minHeight;
				setHeight(Math.min(cap, Math.max(minHeight, h + 4)));
			} catch { /* opaque origin(非 seamless 静态帧) */ }
		};
		el.addEventListener("load", fit);
		const t = window.setTimeout(fit, 50);
		return () => { el.removeEventListener("load", fit); window.clearTimeout(t); };
	}, [srcDoc, scripts, seamless, minHeight, cap]);

	// 脚本帧高度上报(seamless):按 frameId 对号,来源不可信也只消费数字
	useEffect(() => {
		if (!scripts || !seamless) return;
		const onMsg = (e: MessageEvent) => {
			const d = e.data as { liyuanFrameHeight?: unknown; frameId?: unknown };
			if (d && d.frameId === frameId && typeof d.liyuanFrameHeight === "number" && d.liyuanFrameHeight > 0) {
				setHeight(Math.max(minHeight, Math.min(20000, d.liyuanFrameHeight + 4)));
			}
		};
		window.addEventListener("message", onMsg);
		return () => window.removeEventListener("message", onMsg);
	}, [scripts, seamless, frameId, minHeight]);

	return (
		<figure className={`msg-html ${scripts ? "msg-html-scripts" : ""} ${seamless ? "msg-html-seamless" : ""}`}>
			{!seamless && ( /* 旧工具条原样保留 */ )}
			{seamless && (
				<div className="msg-html-ghost">
					<button type="button" className="act" onClick={() => setShowSource((v) => !v)}>
						{showSource ? "收起源码" : "源码"}
					</button>
				</div>
			)}
			<iframe ref={ref} name={frameId} className="msg-html-frame" title={title || "界面"} sandbox={sandbox} srcDoc={srcDoc} style={{ height }} />
			{showSource && <pre className="msg-html-source">{html}</pre>}
			{!seamless && title?.trim() && !showSource && <figcaption className="msg-html-cap">{title}</figcaption>}
		</figure>
	);
}
```

(`{!seamless && (…)}` 处放现有工具条 JSX 原文,不改内容。)

`app.css` 追加(「对话流 HTML 底座」段落后):

```css
/* 卡前端无痕模式(spec §4):宿主零痕迹,幽灵操作悬停浮现 */
.msg-html-seamless { margin: 0; border: 0; background: transparent; position: relative; }
.msg-html-seamless .msg-html-frame { border: 0; border-radius: 0; background: transparent; display: block; width: 100%; }
.msg-html-ghost { position: absolute; top: 4px; right: 4px; opacity: 0; transition: opacity 0.15s; z-index: 2; }
.msg-html-seamless:hover .msg-html-ghost, .msg-html-seamless:focus-within .msg-html-ghost { opacity: 0.75; }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/show-html.test.ts` → PASS;`npm run web:build` → 编译零错误

- [ ] **Step 5: 全量回归 + commit**

```bash
node --test test/*.test.ts
git add web/src/frameDoc.ts web/src/components/HtmlFrame.tsx web/src/app.css test/show-html.test.ts
git commit -m "feat(cardfront): HtmlFrame 无痕模式——ghost 工具条/真实高度/样式主权"
```

---

### Task 5: `Messages.tsx` 管线接入 — 皮肤应用、整楼模式、无缝内嵌

**Files:**
- Modify: `web/src/components/Messages.tsx`
- Modify: `web/src/app.css`
- Test: 管线纯逻辑已由 Task 1-3 测试覆盖;本任务组件接线以 `npm run web:build` + Task 8 冒烟验收

**Interfaces:**
- Consumes: `applyCardSkin`(Task 2)、`isFullInterface`(Task 3)、`HtmlFrame seamless`(Task 4)。
- Produces: `RichContent` 与 `Bubble` 新增可选 prop `skin?: { rules: DisplayRule[]; charName: string; userName: string } | null`(Task 7 由 App 注入;缺省 null=行为与现在完全一致)。

- [ ] **Step 1: RichContent 应用皮肤(顺序:皮肤 → 状态标签 → 混排切分)**

```tsx
// Messages.tsx:import 区追加
import { applyCardSkin } from "../cardSkin.ts";
import type { DisplayRule } from "../../../src/cardfront.ts";

export interface SkinProp { rules: DisplayRule[]; charName: string; userName: string }

// RichContent 签名与首行改为:
export function RichContent({ text, skin }: { text: string; skin?: SkinProp | null }) {
	// 皮肤先行:卡作者的正则先认领它的标签,剩余状态标签才落梨园统一状态卡(spec §7 P1 优先级)
	const skinned = skin && skin.rules.length > 0 ? applyCardSkin(text, skin.rules, skin) : text;
	const statusParts = splitStatusParts(skinned);
	// …(其余逻辑不动,内部两处 text 引用换成 skinned)
```

`TextWithHtml` 内 HtmlFrame 调用改带 `seamless`:

```tsx
	if (p.kind === "html") return <HtmlFrame key={i} html={p.html} scripts={p.scripts} seamless />;
```

- [ ] **Step 2: Bubble 整楼模式**

`Bubble` 增 prop `skin?: SkinProp | null`,非用户分支正文渲染处(现 `{body && (isUser ? <Paragraphs text={body} /> : <RichContent text={body} />)}`)改为:

```tsx
	{body && (isUser ? <Paragraphs text={body} /> : <RichContent text={body} skin={skin} />)}
```

并在该分支外层 `<div className=…>` 的类名计算前加整楼判定(皮肤应用后判定,与 RichContent 同源):

```tsx
	const skinnedBody = !isUser && skin && skin.rules.length > 0 ? applyCardSkin(body, skin.rules, skin) : body;
	const stage = !isUser && !editing && isFullInterface(skinnedBody);
```

类名追加 `${stage ? "msg-stage" : ""}`;`stage` 时跳过 `msg-head` 渲染(开场白徽章/楼层号随 msg-actions 迁到尾部操作行,操作行保留)。`RichContent`/`ChoiceCard` 等其余分支不动;`msg.channel === "html"`(show_html,行 530-533)保持非 seamless——agent 调试通道观感不变。

- [ ] **Step 3: app.css 整楼样式**

```css
/* 整楼界面(spec §4 落位 1):界面即楼层,无气泡壳 */
.msg.msg-stage { background: none; border: 0; padding: 0; max-width: none; }
.msg.msg-stage .msg-html-seamless { margin: 0; }
```

(具体属性以现有 `.msg` / `.msg-char` 定义为准做「归零」——执行时先读 app.css 中 `.msg` 的背景/边框/内边距,逐项抵消。)

- [ ] **Step 4: 构建验证**

Run: `npm run web:build`
Expected: 编译零错误;`node --test test/*.test.ts` 全绿

- [ ] **Step 5: Commit**

```bash
git add web/src/components/Messages.tsx web/src/app.css
git commit -m "feat(cardfront): 消息管线接皮肤——整楼模式/无缝内嵌/优先级排序"
```

---

### Task 6: REST 端点 — `GET/PUT /api/cardfront`

**Files:**
- Modify: `server/rest.ts`(卡库段,`case "GET /api/cards"` 前后,行 1465 附近)
- Test: `test/cardfront.test.ts`(端点纯逻辑已covered;路由层以 Task 8 冒烟验收)

**Interfaces:**
- Consumes: `readCardRawJson`(src/card.ts)、`extractRegexScripts` / `displayRules` / `isSkinEnabled` / `setSkinEnabled`(Task 1)、rest.ts 现有 `loadConfig` / `saveConfig`(先在文件内确认既有写配置的工具函数名,DELETE /api/cards 分支内有改写 config 的现成模式,照抄它的读写对)。
- Produces(Task 7 依赖的 JSON 形态):
  - `GET /api/cardfront` → `{ enabled: boolean, hasSkin: boolean, rules: DisplayRule[], charName: string, userName: string }`(rules 在 enabled=false 时也返回,前端开关即时生效不用二次拉取)
  - `PUT /api/cardfront` body `{ enabled: boolean }` → `{ ok: true, enabled }`

- [ ] **Step 1: 实现两个 case**

```ts
			// ---- 卡前端(一档皮肤,spec 2026-07-22 §7 P1) ----
			case "GET /api/cardfront": {
				const config = loadConfig(host.cwd);
				const abs = assertLibraryCard(host.cwd, config, config.card);
				let rules: DisplayRule[] = [];
				try {
					rules = displayRules(extractRegexScripts(readCardRawJson(abs).raw));
				} catch {
					// 坏卡/无 extensions:无皮肤即可,不是错误
				}
				const card = loadCardFile(abs);
				sendJson(res, 200, {
					enabled: isSkinEnabled(config, config.card),
					hasSkin: rules.length > 0,
					rules,
					charName: card.name,
					userName: config.userName,
				});
				return true;
			}
			case "PUT /api/cardfront": {
				const body = (await readBodyJson(req)) as { enabled?: boolean };
				if (typeof body.enabled !== "boolean") throw new Error("enabled 必须是布尔值");
				const config = loadConfig(host.cwd);
				saveConfig(host.cwd, setSkinEnabled(config, config.card, body.enabled));
				sendJson(res, 200, { ok: true, enabled: body.enabled });
				return true;
			}
```

import 区追加 `extractRegexScripts, displayRules, isSkinEnabled, setSkinEnabled, type DisplayRule`(from `../src/cardfront.ts`)。`readBodyJson`/`saveConfig` 若名字不同,以 rest.ts 既有函数为准(全文 grep `saveConfig|writeConfig|readBody` 对齐,勿发明新读写函数)。

- [ ] **Step 2: 类型检查 + 全量测试**

Run: `node --test test/*.test.ts` 全绿(rest.ts 是 node 直跑 TS,测试进程会加载它,类型/语法错误在此暴露)

- [ ] **Step 3: 手动端点验证**

```bash
npm run web &   # 或已在跑的实例
curl -s http://127.0.0.1:7620/api/cardfront
```
Expected: 默认卡(default_Qingwu,无 regex_scripts)返回 `{"enabled":true,"hasSkin":false,"rules":[],…}`

- [ ] **Step 4: Commit**

```bash
git add server/rest.ts
git commit -m "feat(cardfront): GET/PUT /api/cardfront 端点(规则下发+每卡开关)"
```

---

### Task 7: App 接线 + 卡详情开关

**Files:**
- Modify: `web/src/App.tsx`(state + fetch + Bubble callsite 传 skin)
- Modify: `web/src/components/CardPanel.tsx`(卡详情加「原卡界面美化」开关行)
- Modify: `web/src/api.ts`(若无 `apiGet`/`apiPut` 泛型助手则已有,照现有用法)

**Interfaces:**
- Consumes: Task 5 的 `SkinProp`、Task 6 的两个端点。
- Produces: 用户可见功能闭环。

- [ ] **Step 1: App.tsx 拉取与注入**

state 区(App 组件内)追加:

```tsx
	const [cardSkin, setCardSkin] = useState<SkinProp | null>(null);
	const refreshCardFront = useCallback(async () => {
		try {
			const r = await apiGet<{ enabled: boolean; hasSkin: boolean; rules: DisplayRule[]; charName: string; userName: string }>("/api/cardfront");
			setCardSkin(r.enabled && r.hasSkin ? { rules: r.rules, charName: r.charName, userName: r.userName } : null);
		} catch {
			setCardSkin(null);
		}
	}, []);
```

调用时机:① 初始加载处(App 现有首次 fetch 序列末尾);② 换卡成功回调处(grep `POST /api/cards` 或卡切换后刷新 config 的位置,同点追加 `void refreshCardFront()`);③ CardPanel 开关翻转回调。渲染注入:grep `<Bubble`(App.tsx 内消息列表 map 处),每个 callsite 追加 `skin={cardSkin}`。

- [ ] **Step 2: CardPanel 开关行**

CardPanel 详情区(找「收藏」或删除按钮所在操作区,同层追加;仅当 `hasSkin` 时显示):

```tsx
	{front?.hasSkin && (
		<label className="cardfront-toggle">
			<input
				type="checkbox"
				checked={front.enabled}
				onChange={(e) => void toggleFront(e.target.checked)}
			/>
			原卡界面美化(卡作者的状态栏/界面样式)
		</label>
	)}
```

`front` 由 CardPanel 挂载时 `apiGet("/api/cardfront")` 获得,`toggleFront` = `apiPut("/api/cardfront", { enabled })` 后刷新本地 state 并调 App 传入的 `onFrontChange`(即 `refreshCardFront`)。prop 穿线与 CardPanel 现有 `onSaved` 类回调同模式。

- [ ] **Step 3: 构建 + 冒烟**

```bash
npm run web:build
node scripts/smoke-web.mjs
```
Expected: 双绿。

- [ ] **Step 4: Commit**

```bash
git add web/src/App.tsx web/src/components/CardPanel.tsx web/src/api.ts
git commit -m "feat(cardfront): App 接线与卡详情皮肤开关"
```

---

### Task 8: 端到端验收 + README 兼容声明更新

**Files:**
- Modify: `README.md`(「明确不兼容」段)
- Test: 全量 + 冒烟 + 真卡手工

- [ ] **Step 1: 真卡端到端**

```bash
npm run web
```
浏览器操作清单(逐项核对,spec §9 验收):
1. 卡库切到「淫宫美人录」,发一轮消息诱导状态栏输出(或 `/import` 一段含 `<StatusBlock>HP: 80</StatusBlock>` 的旧档);
2. 该楼层出现**卡作者的半透明黑底圆角 div**(不是梨园白底状态卡),无工具条无徽章,悬停右上浮现「源码」;
3. 卡详情关闭「原卡界面美化」→ 同楼层回落为梨园统一「状态」卡;再开 → 恢复;
4. 换回 default_Qingwu:无任何观感变化;agent `show_html` 消息(若有存档)仍带工具条(非 seamless 通道未动);
5. DevTools 确认:皮肤帧 iframe `sandbox="allow-same-origin"` 且 srcdoc 无 script;`/api/cardfront` 响应正常。

- [ ] **Step 2: 送模不回升自证**

`applyCardSkin` 只在 `RichContent`/`Bubble`(纯显示组件)被调用——grep 确认 `applyCardSkin` 无任何 server/、src/(除类型)引用:

```bash
grep -rn "applyCardSkin" src server .liyuan | grep -v cardfront.ts
```
Expected: 无输出(即送模路径零接触)。

- [ ] **Step 3: README 更新**

「❌ 明确不兼容」段中「正则脚本」改为如实分层表述:

```markdown
❌ 明确不兼容：STscript、前端插件、角色卡自带的 HTML 界面脚本（酒馆助手 JS 卡——规划中）。
⚠️ 正则脚本分两类：**显示美化类**（把状态标签替换成 HTML/CSS 皮肤）已兼容——导入即生效，卡详情可关；**清理修补类**（裁思维链、修格式）无需兼容——梨园在 harness 层原生完成了它们的工作。
```

- [ ] **Step 4: 全量回归 + commit**

```bash
node --test test/*.test.ts
npm run web:build && node scripts/smoke-web.mjs
git add README.md
git commit -m "feat(cardfront): P0+P1 收尾——真卡验收通过,README 兼容声明分层"
```

---

## Self-Review 记录

- **Spec 覆盖**:§4 三种落位——落位 1(Task 3/5 整楼)、落位 2(Task 3/5 内嵌)、落位 3(侧栏,spec 声明不动,无任务,正确);§4 幽灵操作/高度/样式主权(Task 4);§7 P1 全行(Task 1/2/6/7);§9 P0+P1 验收(Task 8);§3.6 裁剪不回升(Task 8 Step 2 自证)。P2/P3 不在本计划(v1.1.0 另拆)。
- **占位符**:Task 4 的「现有工具条 JSX 原文」与 Task 5/7 的「grep 定位 callsite」是对既有代码的保真引用而非缺省实现,执行者按指令定位后原样保留/追加;无 TBD。
- **类型一致**:`DisplayRule` 四字段(name/source/flags/replace)贯穿 Task 1/2/5/6/7;`SkinProp` 定义在 Task 5、Task 7 消费;`seamless` prop 定义在 Task 4、Task 5 消费;`isFullInterface` 定义在 Task 3、Task 5 消费。一致。
