/**
 * SQL 校验器（DESIGN-tables-sql §6，2026-08-16）。
 *
 * 模型直接写 SQL（最自由：JOIN/聚合/子查询/CTE/复杂 WHERE/多行操作），本模块在发送
 * 前把关——不是编译，只做三件事：
 *  1. 语句类型白名单：sql_read 只放行 SELECT；sql_write 只放行 INSERT/UPDATE/DELETE；
 *  2. 危险语句黑名单（字符串/标识符字面量之外出现即拒绝）；
 *  3. 防误操作：UPDATE/DELETE 必须含顶层 WHERE；拒绝分号分隔的多语句。
 *
 * 语句类型按「顶层（括号深度 0）的第一个类型关键字」判定——CTE（WITH … AS (SELECT …)）
 * 内部的 SELECT、INSERT…SELECT 的子查询都不算主语句类型；UPDATE/DELETE 的 WHERE 也
 * 只认顶层的（子查询里的 WHERE 不能顶替主语句的）。
 *
 * 字符串字面量（'…' / "…"）与标识符引用（`…` / […]）内部的关键字与分号不算——
 * 模型写 WHERE 备注 = 'DROP TABLE' 是合法的，不该误杀。
 *
 * 纯函数、零依赖、可单测。
 */

export type SqlKind = "select" | "insert" | "update" | "delete";

export type SqlGuardResult =
	| { ok: true; kind: SqlKind }
	| { ok: false; error: string };

/** 危险语句黑名单（单词级；WITH 放行——CTE 是合法查询能力） */
const DANGEROUS = new Set([
	"DROP",
	"PRAGMA",
	"ATTACH",
	"DETACH",
	"ALTER",
	"VACUUM",
	"REINDEX",
	"CREATE",
	"BEGIN",
	"COMMIT",
	"ROLLBACK",
	"SAVEPOINT",
	"RELEASE",
	"EXPLAIN",
]);

/** 语句类型关键字集合 */
const TYPE_WORDS = new Set(["SELECT", "INSERT", "UPDATE", "DELETE"]);

/** 字符串外扫描产物：带括号深度的单词序列 */
export interface ScannedSql {
	tokens: Array<{ word: string; depth: number }>;
	/** 字符串外的分号个数 */
	semicolons: number;
	/** 最后一个字符串外分号之后是否还有非空白内容（多语句判定用） */
	tailAfterLastSemicolon: boolean;
}

/**
 * 扫描：剥离字符串字面量（'…' / "…"）与标识符引用（`…` / […]），
 * 同时跳过注释（-- 行注释与 / * … * / 块注释），并跟踪括号深度。
 */
export function scanSql(sql: string): ScannedSql {
	const tokens: Array<{ word: string; depth: number }> = [];
	let semicolons = 0;
	let lastSemicolonAt = -1;
	let i = 0;
	let depth = 0;
	let word = "";
	const flushWord = () => {
		if (word) {
			tokens.push({ word: word.toUpperCase(), depth });
			word = "";
		}
	};
	const isWordChar = (ch: string): boolean => /[A-Za-z_]/.test(ch);

	while (i < sql.length) {
		const ch = sql[i]!;
		// 行注释
		if (ch === "-" && sql[i + 1] === "-") {
			flushWord();
			while (i < sql.length && sql[i] !== "\n") i++;
			continue;
		}
		// 块注释
		if (ch === "/" && sql[i + 1] === "*") {
			flushWord();
			i += 2;
			while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
			i = Math.min(sql.length, i + 2);
			continue;
		}
		// 字符串字面量（单引号/双引号）与标识符引用（反引号/方括号）
		if (ch === "'" || ch === '"' || ch === "`") {
			flushWord();
			const close = ch;
			i++;
			while (i < sql.length && sql[i] !== close) {
				// SQLite 字符串转义：两个相邻同引号 = 字面引号
				if (sql[i] === close && sql[i + 1] === close) i += 2;
				else i++;
			}
			i = Math.min(sql.length, i + 1);
			continue;
		}
		if (ch === "[") {
			flushWord();
			i++;
			while (i < sql.length && sql[i] !== "]") i++;
			i = Math.min(sql.length, i + 1);
			continue;
		}
		if (ch === ";") {
			flushWord();
			semicolons++;
			lastSemicolonAt = i;
			i++;
			continue;
		}
		if (ch === "(") {
			flushWord();
			depth++;
			i++;
			continue;
		}
		if (ch === ")") {
			flushWord();
			depth = Math.max(0, depth - 1);
			i++;
			continue;
		}
		if (isWordChar(ch)) {
			word += ch;
			i++;
			continue;
		}
		flushWord();
		i++;
	}
	flushWord();
	// 最后一个分号之后是否还有非空白内容
	let tail = "";
	if (lastSemicolonAt >= 0) tail = sql.slice(lastSemicolonAt + 1);
	const tailAfterLastSemicolon = tail.trim().length > 0;
	return { tokens, semicolons, tailAfterLastSemicolon };
}

/** 主语句类型：顶层（深度 0）的第一个类型关键字（WITH 与 CTE/子查询内的不算） */
const mainKindOf = (tokens: ScannedSql["tokens"]): SqlKind | null => {
	for (const t of tokens) {
		if (t.depth !== 0) continue;
		if (t.word === "SELECT") return "select";
		if (t.word === "INSERT") return "insert";
		if (t.word === "UPDATE") return "update";
		if (t.word === "DELETE") return "delete";
	}
	return null;
};

const allWords = (tokens: ScannedSql["tokens"]): string[] => tokens.map((t) => t.word);

/** 危险词检查（所有深度；字符串/标识符内已剥离） */
const dangerousHits = (tokens: ScannedSql["tokens"]): string[] =>
	[...new Set(allWords(tokens).filter((w) => DANGEROUS.has(w)))];

/** 顶层 WHERE（UPDATE/DELETE 的主语句必须带它；子查询里的 WHERE 不算） */
const hasTopWhere = (tokens: ScannedSql["tokens"]): boolean =>
	tokens.some((t) => t.depth === 0 && t.word === "WHERE");

/** 单语句判定：至多一个分号且其后无内容 */
const isSingleStatement = (s: ScannedSql): boolean =>
	!(s.semicolons > 1 || (s.semicolons === 1 && s.tailAfterLastSemicolon));

/**
 * 读侧校验：只放行 SELECT；无危险词；单语句。
 */
export function guardRead(sql: string): SqlGuardResult {
	const t = (sql ?? "").trim();
	if (!t) return { ok: false, error: "SQL 为空。" };
	const s = scanSql(t);
	const kind = mainKindOf(s.tokens);
	if (kind !== "select") {
		return { ok: false, error: `sql_read 只允许 SELECT 语句（收到 ${kind ? kind.toUpperCase() : "未知类型"}）。` };
	}
	if (!isSingleStatement(s)) {
		return { ok: false, error: "一次只允许一条 SQL 语句（禁止分号拼接多条）。" };
	}
	const hits = dangerousHits(s.tokens);
	if (hits.length > 0) return { ok: false, error: `包含危险语句 ${hits.join(" / ")}。` };
	return { ok: true, kind: "select" };
}

/**
 * 写侧校验：只放行 INSERT/UPDATE/DELETE；无危险词；单语句；UPDATE/DELETE 必须带顶层 WHERE。
 */
export function guardWrite(sql: string): SqlGuardResult {
	const t = (sql ?? "").trim();
	if (!t) return { ok: false, error: "SQL 为空。" };
	const s = scanSql(t);
	const kind = mainKindOf(s.tokens);
	if (kind !== "insert" && kind !== "update" && kind !== "delete") {
		return { ok: false, error: `sql_write 只允许 INSERT/UPDATE/DELETE 语句（收到 ${kind ? kind.toUpperCase() : "未知类型"}）。` };
	}
	if (!isSingleStatement(s)) {
		return { ok: false, error: "一次只允许一条 SQL 语句（禁止分号拼接多条）。" };
	}
	const hits = dangerousHits(s.tokens);
	if (hits.length > 0) return { ok: false, error: `包含危险语句 ${hits.join(" / ")}。` };
	if ((kind === "update" || kind === "delete") && !hasTopWhere(s.tokens)) {
		return { ok: false, error: `${kind.toUpperCase()} 必须带 WHERE 条件（防止误改/误删全表）。` };
	}
	return { ok: true, kind };
}

/** 供测试与后续模块复用的类型词集合导出 */
export { TYPE_WORDS };
