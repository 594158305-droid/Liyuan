/**
 * TablesService（DESIGN-tables-sql §4，2026-08-16）：自定义表格的 SQLite 服务层。
 *
 * 唯一入口：工具执行器（主演/场记代理）与 REST/UI 共用。职责：
 * - db 生命周期（每会话一个 .db 文件，懒打开；PRAGMA foreign_keys 开启）；
 * - 元数据（__meta：表定义唯一归属——auto/分组/说明/维护规则/列定义/主键/引用）；
 * - SQL 执行（sql_read / sql_write 经 sql-guard 校验；报错原样外露）；
 * - 写日志回调（供引擎落树 rp-table-log，分支回溯权威）；
 * - 检查点（__checkpoint：物化覆盖到哪个会话树条目）。
 *
 * 零外部依赖（node:sqlite 内置），同步 API（DatabaseSync）。
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { guardRead, guardWrite } from "./sql-guard.ts";

// ---------------- 类型 ----------------

export type ColumnType = "text" | "number" | "integer" | "real" | "boolean";

export interface TableColumnDef {
	name: string;
	type: ColumnType;
	description?: string;
	/** 主键列（一列或多列 → PRIMARY KEY） */
	primary?: boolean;
	/** 引用他表（FOREIGN KEY 约束） */
	ref?: { table: string; column: string };
}

export interface TableDef {
	name: string;
	auto: boolean;
	group?: string | null;
	description?: string;
	columns: TableColumnDef[];
}

export type TableExecResult =
	| { ok: true; rows?: unknown[]; changes: number; lastInsertRowid?: number | bigint }
	| { ok: false; error: string };

/** 写日志条目（引擎落树 rp-table-log；重放只需要 sql 本身） */
export interface TableLogEntry {
	op: "create" | "alter" | "drop" | "insert" | "update" | "delete";
	sql: string;
	changes: number;
	at: number;
	/** 落树后的条目 id（检查点增量重放用） */
	entryId?: string;
}

// ---------------- 常量 ----------------

const TYPE_SQL: Record<ColumnType, string> = {
	text: "TEXT",
	number: "INTEGER",
	integer: "INTEGER",
	real: "REAL",
	boolean: "INTEGER",
};

/** 表名/列名白名单：中文/字母/数字/下划线/斜杠，1-32 位（「内衣/内裤」这类复合列名合法，SQLite 带引号存储） */
const NAME_RE = /^[A-Za-z0-9_\u4e00-\u9fff/]{1,32}$/;

/** 非斜杠列名白名单（新建/物化同步时用规整名；存量斜杠列经 RENAME 迁移过来） */
const PLAIN_NAME_RE = /^[A-Za-z0-9_\u4e00-\u9fff]{1,32}$/;

/**
 * 斜杠列名 → 非斜杠（2026-08-16，场记表格提效）：模型写 SQL 时常不给中文/含符号
 * 列名加引号，`内衣/内裤` 这类被 SQLite 当除法/标识符边界解析报错，拖累表格维护代理
 * 多轮往返。统一把列名里的 `/` 替换为 `与`（如 `内衣/内裤 → 内衣与内裤`）。仅影响
 * 建表/物化/同步写入的 schema，不改用户模板/账本里的原始列名（真值源保留原样）。
 */
export function normalizeColumnName(name: string): string {
	if (name.includes("/")) return name.replaceAll("/", "与");
	return name;
}

const cleanSqlError = (e: unknown): string => {
	const msg = e instanceof Error ? e.message : String(e);
	// SQLite 报错带错误码前缀「ERR_SQLITE_ERROR: 」之类的噪音，剥掉
	return msg.replace(/^\[?\s*(ERR_SQLITE_ERROR|Error)\s*\]?\s*:?\s*/i, "").trim();
};

// ---------------- 服务 ----------------

export class TablesService {
	#db: DatabaseSync | null = null;
	#path: string;
	/** 写操作成功后的日志回调（引擎落树 rp-table-log） */
	onWrite?: (entry: TableLogEntry) => void;

	constructor(dbPath: string) {
		this.#path = dbPath;
	}

	#open(): DatabaseSync {
		if (this.#db) return this.#db;
		mkdirSync(dirname(this.#path), { recursive: true });
		const db = new DatabaseSync(this.#path);
		db.exec("PRAGMA foreign_keys = ON");
		db.exec(
			"CREATE TABLE IF NOT EXISTS __meta (name TEXT PRIMARY KEY, json TEXT NOT NULL)",
		);
		db.exec(
			"CREATE TABLE IF NOT EXISTS __checkpoint (id INTEGER PRIMARY KEY CHECK (id = 1), through_entry_id TEXT, at INTEGER)",
		);
		this.#db = db;
		return db;
	}

	close(): void {
		this.#db?.close();
		this.#db = null;
	}

	// ---------------- 元数据 ----------------

	/**
	 * 确保 __meta 里定义的表都有物理表（2026-08-16 场记建表链路修复）：
	 * 若 __meta 有定义、sqlite_master 无物理表 → createTable 建出（列名规整）；
	 * 物理表已存在但有**斜杠列名**（存量未迁移）→ 也调 createTable 触发 RENAME 迁移
	 * （2026-08-16 场记列名规整：存量表在每次被访问时自动把 内衣/内裤 → 内衣与内裤）。
	 * 解决「__meta 有表定义、物理表未建」→ 代理写表 no such table 空转，与
	 * 「存量斜杠列长期存在拖累 SQL 书写」两个问题。幂等：已规整/已建的表零改动。
	 * 返回本次新建或迁移改动的表名；内部异常单表跳过不中断（保证 listTables 兜底可读）。
	 */
	ensureMaterialized(): string[] {
		const db = this.#open();
		const touched: string[] = [];
		let metas: Array<{ name: string; json: string }>;
		try {
			metas = db.prepare("SELECT name, json FROM __meta").all() as Array<{ name: string; json: string }>;
		} catch {
			return touched;
		}
		for (const r of metas) {
			let def: TableDef;
			try {
				def = JSON.parse(r.json) as TableDef;
			} catch {
				continue;
			}
			const exists = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(r.name);
			if (exists) {
				// 物理表已在：仅当还残留斜杠列名（存量未迁移）时才调 createTable 触发 RENAME，否则跳过（零开销）
				const hasSlash = (db.prepare(`PRAGMA table_info("${r.name}")`).all() as Array<{ name: string }>).some((c) => c.name.includes("/"));
				if (!hasSlash) continue;
				const r2 = this.createTable(def);
				if (r2.ok && r2.changes > 0) touched.push(r.name);
				continue;
			}
			const r3 = this.createTable(def);
			if (r3.ok) touched.push(r.name);
		}
		return touched;
	}

	listTables(): Array<{ name: string; auto: boolean; group: string | null; rowCount: number }> {
		const db = this.#open();
		// 先确保 __meta 定义的表都有物理表（缺失会令下方 COUNT 炸，且表格代理一写就报 no such table）
		try {
			this.ensureMaterialized();
		} catch {
			// ensure 失败不阻断列表读取
		}
		const rows = db.prepare("SELECT name, json FROM __meta").all() as Array<{ name: string; json: string }>;
		return rows.map((r) => {
			let def: TableDef;
			try {
				def = JSON.parse(r.json) as TableDef;
			} catch {
				def = { name: r.name, auto: false, columns: [] };
			}
			const c = db.prepare(`SELECT COUNT(*) AS n FROM "${r.name}"`).get() as { n: number };
			return { name: r.name, auto: def.auto, group: def.group ?? null, rowCount: c.n };
		});
	}

	getMeta(name: string): TableDef | null {
		const db = this.#open();
		const row = db.prepare("SELECT json FROM __meta WHERE name = ?").get(name) as { json: string } | undefined;
		if (!row) return null;
		try {
			return JSON.parse(row.json) as TableDef;
		} catch {
			return null;
		}
	}

	updateMeta(def: TableDef): TableExecResult {
		if (!NAME_RE.test(def.name)) return { ok: false, error: `表名不合法：「${def.name}」（允许中文/字母/数字/下划线，1-32 位）。` };
		const db = this.#open();
		try {
			// 列名与 createTable 同口径规整（斜杠 → 与），避免 UI/user 用 updateMeta 时把未规整列名写回 __meta 造成脱节
			const normalized: TableDef = { ...def, columns: (def.columns ?? []).map((c) => ({ ...c, name: normalizeColumnName(c.name) })) };
			db.prepare("INSERT INTO __meta (name, json) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET json = excluded.json").run(def.name, JSON.stringify(normalized));
			return { ok: true, changes: 1 };
		} catch (e) {
			return { ok: false, error: cleanSqlError(e) };
		}
	}

	/** 建表：白名单校验 → CREATE TABLE（主键 + 外键）→ 写 meta → 落日志。
	 * 表已存在时：**增量加列**（meta 有、实际缺的列用 ALTER TABLE ADD COLUMN 补上，
	 * SQLite 支持；2026-08-16 修复「meta 与实际表脱节」——此前 IF NOT EXISTS 跳过建表
	 * 却无条件覆盖 meta，导致助手按新列写入报 no such column）。
	 * 2026-08-16 场记提效：列名统一经 normalizeColumnName 规整（斜杠 → 与），
	 * 存量斜杠旧列用 ALTER TABLE RENAME COLUMN 迁移（保留数据），杜绝模型写 SQL 因
	 * 未给中文/含符号列名加引号而反复报错。 */
	createTable(def: TableDef): TableExecResult {
		if (!NAME_RE.test(def.name)) return { ok: false, error: `表名不合法：「${def.name}」（允许中文/字母/数字/下划线，1-32 位）。` };
		if (def.name.startsWith("__")) return { ok: false, error: `表名不得以「__」开头（内部保留）。` };
		// 列名入口统一规整（斜杠 → 与）；def 只读，先算出规整后的列数组
		const cols = def.columns.map((c) => ({
			...c,
			name: normalizeColumnName(c.name),
			ref: c.ref ? { ...c.ref, column: normalizeColumnName(c.ref.column) } : c.ref,
		}));
		if (cols.some((c) => !NAME_RE.test(c.name))) return { ok: false, error: `列名不合法（含斜杠以外的标点）。` };
		const seen = new Set<string>();
		const colSql: string[] = [];
		const pk: string[] = [];
		const fks: string[] = [];
		for (const c of cols) {
			if (seen.has(c.name)) return { ok: false, error: `列名重复：「${c.name}」。` };
			seen.add(c.name);
			colSql.push(`"${c.name}" ${TYPE_SQL[c.type] ?? "TEXT"}`);
			if (c.primary) pk.push(`"${c.name}"`);
			if (c.ref) {
				if (!NAME_RE.test(c.ref.table) || (!NAME_RE.test(c.ref.column) && !c.ref.column.includes("/"))) {
					return { ok: false, error: `引用不合法：${c.ref.table}.${c.ref.column}。` };
				}
				fks.push(`FOREIGN KEY ("${c.name}") REFERENCES "${c.ref.table}"("${c.ref.column}")`);
			}
		}
		if (colSql.length === 0) return { ok: false, error: "至少需要一列。" };
		const db = this.#open();
		try {
			const exists = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(def.name);
			if (exists) {
				// 表已存在：① 斜杠旧列 → 规整列名 RENAME（保留数据）② 增量加列（只补缺的）
				const existingNames = (db.prepare(`PRAGMA table_info("${def.name}")`).all() as Array<{ name: string }>).map((c) => c.name);
				const existing = new Set(existingNames);
				const alterSqls: string[] = [];
				// ① 列名规整迁移：物理表里有含斜杠的旧列名、规整名不存在 → RENAME（已规整过则跳过）
				for (const c of cols) {
					const oldName = existingNames.find((n) => n.includes("/") && normalizeColumnName(n) === c.name);
					if (oldName && !existing.has(c.name)) {
						db.exec(`ALTER TABLE "${def.name}" RENAME COLUMN "${oldName}" TO "${c.name}"`);
						alterSqls.push(`ALTER TABLE "${def.name}" RENAME COLUMN "${oldName}" TO "${c.name}"`);
						existing.delete(oldName);
						existing.add(c.name);
					}
				}
				// ② 增量加列（只补缺的；已有列不动——删列/改类型需删表重建）
				for (const c of cols) {
					if (existing.has(c.name)) continue;
					const sql = `ALTER TABLE "${def.name}" ADD COLUMN "${c.name}" ${TYPE_SQL[c.type] ?? "TEXT"}`;
					db.exec(sql);
					alterSqls.push(sql);
				}
				// meta 存规整后的列定义（与物理表一致）
				db.prepare("INSERT INTO __meta (name, json) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET json = excluded.json").run(def.name, JSON.stringify({ ...def, columns: cols }));
				if (alterSqls.length > 0) {
					this.onWrite?.({
						op: "alter",
						sql: alterSqls.join("; "),
						changes: alterSqls.length,
						at: Date.now(),
					});
				}
				return { ok: true, changes: alterSqls.length };
			}
			const parts = [...colSql, ...(pk.length > 0 ? [`PRIMARY KEY (${pk.join(",")})`] : []), ...fks];
			// STRICT：强类型表——列类型不符（如往 number 列写字符串）直接报错外露（SQLite 默认动态类型不报，
			// 曾出现「skill_exp + 2」这类表达式字符串混进数值列的脏数据）
			const sql = `CREATE TABLE IF NOT EXISTS "${def.name}" (${parts.join(", ")}) STRICT`;
			db.exec(sql);
			db.prepare("INSERT INTO __meta (name, json) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET json = excluded.json").run(def.name, JSON.stringify({ ...def, columns: cols }));
		} catch (e) {
			return { ok: false, error: cleanSqlError(e) };
		}
		this.onWrite?.({ op: "create", sql: `CREATE TABLE "${def.name}"`, changes: 0, at: Date.now() });
		return { ok: true, changes: 0 };
	}

	dropTable(name: string): TableExecResult {
		if (!NAME_RE.test(name)) return { ok: false, error: `表名不合法：「${name}」。` };
		const db = this.#open();
		try {
			db.exec(`DROP TABLE IF EXISTS "${name}"`);
			db.prepare("DELETE FROM __meta WHERE name = ?").run(name);
		} catch (e) {
			return { ok: false, error: cleanSqlError(e) };
		}
		this.onWrite?.({ op: "drop", sql: `DROP TABLE "${name}"`, changes: 0, at: Date.now() });
		return { ok: true, changes: 0 };
	}

	// ---------------- SQL 执行 ----------------

	/** 读（sql_read）：guard → SELECT → rows；报错原样外露 */
	execRead(sql: string): TableExecResult {
		const g = guardRead(sql);
		if (!g.ok) return { ok: false, error: g.error };
		const db = this.#open();
		try {
			const rows = db.prepare(sql).all();
			return { ok: true, rows, changes: rows.length };
		} catch (e) {
			return { ok: false, error: cleanSqlError(e) };
		}
	}

	/** 写（sql_write）：guard → INSERT/UPDATE/DELETE → 日志回调；报错原样外露 */
	execWrite(sql: string): TableExecResult {
		const g = guardWrite(sql);
		if (!g.ok) return { ok: false, error: g.error };
		const db = this.#open();
		try {
			const r = db.prepare(sql).run();
			this.onWrite?.({ op: g.kind, sql, changes: Number(r.changes), at: Date.now() });
			return { ok: true, changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
		} catch (e) {
			return { ok: false, error: cleanSqlError(e) };
		}
	}

	/** 重放用：执行已校验过的日志 SQL（跳过 guard）；报错外露 */
	rawExec(sql: string): TableExecResult {
		const db = this.#open();
		try {
			const r = db.prepare(sql).run();
			return { ok: true, changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
		} catch (e) {
			return { ok: false, error: cleanSqlError(e) };
		}
	}

	/** 重放用：清空所有用户表（保留 __meta/__checkpoint 内部表） */
	clearUserTables(): void {
		const db = this.#open();
		// 用 sqlite_master 而非 __meta：重放路径 rawExec 不写 __meta，未登记表也要清
		const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_\\_%' ESCAPE '\\'").all() as Array<{ name: string }>;
		for (const r of rows) {
			db.exec(`DROP TABLE IF EXISTS "${r.name}"`);
		}
	}

	// ---------------- 检查点 ----------------

	getCheckpoint(): { throughEntryId: string | null; at: number | null } {
		const db = this.#open();
		const row = db.prepare("SELECT through_entry_id, at FROM __checkpoint WHERE id = 1").get() as
			| { through_entry_id: string | null; at: number | null }
			| undefined;
		return row ? { throughEntryId: row.through_entry_id, at: row.at } : { throughEntryId: null, at: null };
	}

	setCheckpoint(throughEntryId: string): void {
		const db = this.#open();
		db.prepare(
			"INSERT INTO __checkpoint (id, through_entry_id, at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET through_entry_id = excluded.through_entry_id, at = excluded.at",
		).run(throughEntryId, Date.now());
	}
}
