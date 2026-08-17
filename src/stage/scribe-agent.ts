/**
 * 场记表格维护代理（DESIGN-tables-sql §5，2026-08-16）。
 *
 * 场记旁路模型获得 sql_read / sql_write 两个工具（SQL 直传 + 发送前校验），
 * 按各表【维护规则】自主查询与写入（像 coding 一样填表）——不再全表下发、不再输出
 * JSON 补丁。写操作由 TablesService 落库并产生日志（rp-table-log，分支回溯权威）。
 *
 * 本模块纯逻辑：工具 schema、执行器（转 TablesService）、系统提示词（表维护规则索引，
 * 不含任何行数据）。循环调度在 engine #sideAgent。
 */

import type { TableDef } from "../tables/service.ts";

/** 与 StageTool 兼容的最小结构 */
export interface StageToolLike {
	name: string;
	description: string;
	parameters: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}

export interface ExecResult {
	text: string;
	isError?: boolean;
	activity?: string;
}

/** SQL 执行注入（engine 提供 TablesService 封装） */
export interface SqlExecDeps {
	execRead: (sql: string) => Promise<{ ok: true; rows: unknown[] } | { ok: false; error: string }>;
	execWrite: (
		sql: string,
	) => Promise<{ ok: true; changes: number; lastInsertRowid?: number | bigint } | { ok: false; error: string }>;
}

export function scribeAgentToolSchemas(): StageToolLike[] {
	return [
		{
			name: "sql_read",
			description:
				"执行一条 SELECT 查询表格（只读）：SQL 自由表达——JOIN/聚合/子查询/CTE(WITH)/任意 WHERE/LIMIT/OFFSET。" +
				"按需精确取行，禁止整表拉取；语法/列名/表名写错会收到 SQLite 原样报错，按报错修正重试。",
			parameters: {
				type: "object",
				properties: {
					sql: { type: "string", description: '完整 SELECT 语句，如 SELECT COUNT(*) AS n FROM 纪要表' },
				},
				required: ["sql"],
			},
		},
		{
			name: "sql_write",
			description:
				"执行一条 INSERT/UPDATE/DELETE 修改表格：SQL 自由表达（多行、子查询、任意条件）。" +
				"UPDATE/DELETE 必须带 WHERE；主键冲突/外键冲突/列不存在等报错原样返回，按报错修正重试。",
			parameters: {
				type: "object",
				properties: {
					sql: { type: "string", description: '完整写语句，如 INSERT INTO 纪要表 (时间跨度, 概览) VALUES (\'…\', \'…\')' },
				},
				required: ["sql"],
			},
		},
	];
}

/**
 * SQL 执行器（转 SqlExecDeps；报错文本原样外露给模型）。
 * 写操作成功时 activity 返回摘要（供 applied 收集），并回调 onWrite 供上层落日志。
 */
export function makeSqlExec(
	deps: SqlExecDeps,
	onWrite?: (sql: string, changes: number) => void,
): (name: string, args: Record<string, unknown>) => Promise<ExecResult> {
	return async (name, args): Promise<ExecResult> => {
		const sql = typeof args.sql === "string" ? args.sql.trim() : "";
		if (!sql) return { text: "请提供 sql 参数。", isError: true };
		if (name === "sql_read") {
			const r = await deps.execRead(sql);
			if (!r.ok) return { text: `SQL 报错：${r.error}`, isError: true };
			const rows = r.rows;
			const shown = Array.isArray(rows) ? rows : [];
			const more = shown.length > 20 ? `\n（共 ${shown.length} 行，仅列前 20 行——用 LIMIT/OFFSET 分页取更多）` : "";
			return { text: `${shown.length} 行：\n${JSON.stringify(shown.slice(0, 20), null, 1)}${more}`, activity: "SQL 查询" };
		}
		if (name === "sql_write") {
			const r = await deps.execWrite(sql);
			if (!r.ok) return { text: `SQL 报错：${r.error}`, isError: true };
			onWrite?.(sql, r.changes);
			return { text: `已执行，${r.changes} 行受影响。`, activity: `表写入（${r.changes} 行）` };
		}
		return { text: `未知工具「${name}」。`, isError: true };
	};
}

/**
 * 场记代理系统提示词：表维护规则索引（各表 description 全文——含【维护规则】段，
 * 模型据此决定查什么、写什么），不含任何表的行数据（按需 sql_read 取）。
 */
export function buildScribeAgentSystemPrompt(todo: string[], metaOf: (name: string) => TableDef | null): string {
	const index = todo
		.map((name) => {
			const t = metaOf(name);
			if (!t) return `- ${name}（表不存在）`;
			const columns = t.columns.map((c) => (c.type ? `${c.name}（${c.type}）` : c.name)).join("、");
			return `### 表「${name}」\n列定义：${columns}\n维护规则（description）：\n${t.description ?? "（无）"}`;
		})
		.join("\n\n");
	return `你是梨园场记的【表格维护代理】。本轮剧情正文已完成，你的任务：依据各表的【维护规则】用 SQL 维护下述 auto 表。

## 规则
- 只维护下方清单中的表；逐表处理，不遗漏。
- **先读数据、再决定写什么**：每表必须先用 sql_read 按维护规则读取该表现有行（如"最近一条纪要""某角色的当前状态"），对照【本轮对话】判断要新增/更新/删除哪些行，然后用 sql_write 写入。**读不到现状就直接下结论"无变化不写"是错误的**——绝大多数表都需要基于现状做增量维护。
- **表结构与列名以下方【列定义】为准**：物理表已建好、列名就是下表列出的名字，**不要额外去 sqlite_master / PRAGMA table_info 探查整体 schema**（那会白耗多轮）；直接按清单列名读写即可。
- **SQL 中所有中文或含符号的列名/表名必须用双引号包裹**（如 INSERT INTO "在场角色表" ("姓名", "当前状态") VALUES ('…', '…')），否则会被解析成其他内容报错——不要裸写列名。
- 写前核对表说明的约束（唯一键/格式/删除条件）；拿不准先查再写。
- UPDATE/DELETE 必须带 WHERE；主键冲突（UNIQUE constraint failed）时改 UPDATE 而非重复 INSERT。
- 真无变化才不写；禁止编造、脑补表内已有事实。
- 全部处理完，输出一句话总结：各表改了什么（未改的表不用提）。不要输出 SQL 之外的 JSON 补丁——写操作已通过 sql_write 直接落表。

## 待维护表（含维护规则）
${index}`;
}

/** 用户消息：本轮对话 + 维护指令 */
export function buildScribeAgentUserText(dialogue: string): string {
	return `【本轮对话】\n${dialogue}\n\n请按上方的维护规则处理待维护表。`;
}

/** 从写语句粗略提取表名（applied 摘要用；提取不到返回 "?"） */
export function tableOfSql(sql: string): string {
	const m = /^(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+["'`\[]?([A-Za-z0-9_\u4e00-\u9fff]+)/i.exec(sql.trim());
	return m?.[1] ?? "?";
}
