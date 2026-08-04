import assert from "node:assert/strict";
import { test } from "node:test";

import { detectProtocol, isProtocolContent, stripProtocolEntries } from "../src/protocol-detect.ts";

const entry = (over: Partial<Parameters<typeof stripProtocolEntries>[0][number]> = {}) => ({
	uid: 1,
	comment: "",
	keys: [] as string[],
	content: "",
	enabled: true,
	...over,
});

test("detectProtocol：强信号单条即判死（插件专属标签/命名）", () => {
	// 实测最短的真协议条目（模拟修仙2 uid83 / 道渊 uid230，159~160 字）
	const shortest = `变量输出格式强调:
  rule: The following must be inserted to the end of reply, and cannot be omitted
  format: |-
    <UpdateVariable>
    ...
    </UpdateVariable>`;
	const v = detectProtocol(shortest, "📋 MVU变量输出格式强调");
	assert.equal(v.family, "mvu");
	assert.ok(v.signals.includes("tag:UpdateVariable"), "命中信号要可回溯");

	// 标题里的插件命名约定也算强信号（道渊 uid227 正文无 UpdateVariable 标签）
	assert.equal(detectProtocol("变量更新规则:\n  世界:\n    当前时间:", "[mvu_update]").family, "mvu");
	// 酒馆前端消费的变量宏
	assert.equal(detectProtocol("<status_current_variables>\n{{format_message_variable::stat_data}}\n</status_current_variables>", "变量列表").family, "mvu");
});

test("detectProtocol：弱信号需 ≥2 共现——单个弱信号不判死（防误伤真设定）", () => {
	// 单弱信号：正常修真设定里也会出现「每次回复必须」之类的措辞
	assert.equal(detectProtocol("战斗时必须更新，不得遗漏敌方动向。").family, null, "单弱信号不判死");
	assert.equal(detectProtocol("此地遭遇冷却为 15 个回合。").family, null);

	// 两个弱信号共现 → 判死（道渊 uid227 形态：RFC6902 + op 动词）
	const two = `the update commands works like the **JSON Patch (RFC 6902)** standard
      - replace: replace the value of existing paths
      { "op": "delta", "path": "/主角/修为", "value": 5 }`;
	assert.equal(detectProtocol(two).family, "mvu");
});

test("detectProtocol：正常世界观设定零误伤（全库实测语料）", () => {
	// 道渊 #10「境界」——真设定，与 MVU 条目共享大量术语
	const realm = `# 核心规则：境界序列
  本世界的力量体系遵循一个明确的修炼序列，分为凡人九境与仙人五境。
  1. **炼气期**: 共十层，是修炼的起点。
  2. **筑基期**: 分为初期、中期、后期、圆满四个小境界。`;
	assert.equal(detectProtocol(realm, "境界").family, null);

	// 道渊 #17「具体数值」——含 0~100 数值表，最像变量 schema 的真设定
	const stats = `# 用户角色核心数值
  ## 总则
  用户角色拥有五大核心资源：生命、灵力、精血、修为、神识。上限均为100。
  ### 修为
  定义：境界积累进度。满100即当前小境界圆满。可倒退、可跌落。`;
	assert.equal(detectProtocol(stats, "具体数值").family, null, "数值表不是协议——判据看的是「要求输出格式」不是「有数字」");

	assert.equal(detectProtocol("").family, null);
	assert.equal(detectProtocol("   \n  ").family, null, "空白内容不判定");
});

test("detectProtocol：表格插件家族（SP·数据库）", () => {
	assert.equal(detectProtocol("回复末尾输出 <tableEdit> 块").family, "tabledb");
	assert.equal(detectProtocol("insertRow(0, {0:'张三'})").family, "tabledb");
	assert.equal(isProtocolContent("普通的桌子和椅子摆在房间里。"), false, "「table」词根不误伤");
});

test("stripProtocolEntries：协议条目置 enabled=false 并留痕；正常条目原样", () => {
	const { entries, dropped } = stripProtocolEntries([
		entry({ uid: 1, comment: "境界", content: "炼气期共十层，筑基期分四个小境界。" }),
		entry({ uid: 2, comment: "[mvu_update]变量输出格式", content: "<UpdateVariable>\n<JSONPatch>\n[]\n</JSONPatch>\n</UpdateVariable>" }),
	]);
	assert.equal(entries.length, 2, "条目不删除——只置死，面板仍可见");
	assert.equal(entries[0].enabled, true);
	assert.equal(entries[1].enabled, false, "协议条目退场（constant/激活/检索三通道都尊重 enabled）");

	assert.equal(dropped.length, 1);
	assert.equal(dropped[0].family, "mvu");
	assert.equal(dropped[0].title, "[mvu_update]变量输出格式");
	assert.ok(dropped[0].signals.length >= 2, "判据留痕，事后可核对为什么判死");
});

test("stripProtocolEntries：已停用条目不重复记账（用户已手关的不再报）", () => {
	const { dropped } = stripProtocolEntries([
		entry({ uid: 1, enabled: false, comment: "旧 MVU 块", content: "<UpdateVariable>x</UpdateVariable>" }),
	]);
	assert.deepEqual(dropped, [], "已 disabled 的不进报告——否则用户手关过的每拍都被播报一次");
});

test("stripProtocolEntries：标题缺失时回落关键词/uid，不产出空标题", () => {
	const { dropped } = stripProtocolEntries([
		entry({ uid: 7, comment: "", keys: ["变量"], content: "<UpdateVariable>x</UpdateVariable>" }),
		entry({ uid: 9, comment: "", keys: [], content: "<tableEdit>y</tableEdit>" }),
	]);
	assert.equal(dropped[0].title, "变量");
	assert.equal(dropped[1].title, "uid9");
});
