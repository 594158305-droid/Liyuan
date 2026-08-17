/**
 * 自定义表格 SQL 化一次性迁移（DESIGN-tables-sql §8，2026-08-16）。
 *
 * 把旧 WorldState.tables（rp-state 快照/磁盘缓存）导入 SQLite：
 * - 先导出备份：<db路径>.backup-<YYYYMMDD>.json（旧表定义+数据，可随时全量迁移）；
 * - 建 SQLite 表 + 导入行 + 写 __meta（表定义：auto/说明/列）；
 * - 幂等：目标 db 已存在则跳过。
 *
 * 用法：node scripts/migrate-tables-to-sql.mjs <状态文件.json> <目标.db 路径>
 * 例：node scripts/migrate-tables-to-sql.mjs .liyuan-state/019fec6e-….json .liyuan-state/tables/019fec6e-….db
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const [,, stateFile, dbPath] = process.argv;
if (!stateFile || !dbPath) {
	console.error("用法：node scripts/migrate-tables-to-sql.mjs <状态文件.json> <目标.db 路径>");
	process.exit(1);
}
if (!existsSync(stateFile)) {
	console.error(`状态文件不存在：${stateFile}`);
	process.exit(1);
}
if (existsSync(dbPath)) {
	console.log("目标 db 已存在，跳过（幂等）。");
	process.exit(0);
}

const state = JSON.parse(readFileSync(stateFile, "utf8"));
const tables = state.tables ?? {};

// 1) 备份导出（全量迁移的原料；目录先建）
mkdirSync(dirname(dbPath), { recursive: true });
const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
const backup = `${dbPath}.backup-${date}.json`;
writeFileSync(backup, JSON.stringify(tables, null, "\t"), "utf8");
console.log(`已备份旧表数据 → ${backup}`);

// 2) 建 db + 内部表
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA foreign_keys = ON");
db.exec("CREATE TABLE IF NOT EXISTS __meta (name TEXT PRIMARY KEY, json TEXT NOT NULL)");
db.exec("CREATE TABLE IF NOT EXISTS __checkpoint (id INTEGER PRIMARY KEY CHECK (id = 1), through_entry_id TEXT, at INTEGER)");

const TYPE_SQL = { text: "TEXT", number: "INTEGER", integer: "INTEGER", real: "REAL", boolean: "INTEGER" };
// 与 src/tables/service.ts 的 NAME_RE 同步：含 /（「内衣/内裤」复合列名）
const NAME_RE = /^[A-Za-z0-9_\u4e00-\u9fff/]{1,32}$/;

let migrated = 0;
const skipped = [];
for (const [name, t] of Object.entries(tables)) {
	if (!t || typeof t !== "object" || !Array.isArray(t.columns) || t.columns.length === 0) {
		skipped.push(`${name}（无列定义）`);
		continue;
	}
	if (!NAME_RE.test(name)) {
		skipped.push(`${name}（表名不合法）`);
		continue;
	}
	const cols = t.columns
		.filter((c) => c && typeof c.name === "string" && NAME_RE.test(c.name))
		.map((c) => `"${c.name}" ${TYPE_SQL[c.type ?? "text"] ?? "TEXT"}`);
	if (cols.length === 0) {
		skipped.push(`${name}（无合法列）`);
		continue;
	}
	try {
		db.exec(`CREATE TABLE IF NOT EXISTS "${name}" (${cols.join(", ")})`);
		const meta = {
			name,
			auto: !!t.auto,
			group: null,
			description: typeof t.description === "string" ? t.description : "",
			columns: t.columns.map((c) => ({ name: c.name, type: c.type ?? "text", description: c.description ?? "" })),
		};
		db.prepare("INSERT INTO __meta (name, json) VALUES (?, ?)").run(name, JSON.stringify(meta));
		const colNames = t.columns.filter((c) => c && NAME_RE.test(c.name)).map((c) => `"${c.name}"`);
		const stmt = db.prepare(`INSERT INTO "${name}" (${colNames.join(", ")}) VALUES (${colNames.map(() => "?").join(", ")})`);
		let rows = 0;
		for (const row of t.rows ?? []) {
			try {
				stmt.run(...t.columns.filter((c) => c && NAME_RE.test(c.name)).map((c) => {
					const v = row?.[c.name];
					return typeof v === "boolean" ? (v ? 1 : 0) : v === undefined ? null : v;
				}));
				rows++;
			} catch {
				// 单行失败跳过（脏行不阻断迁移）
			}
		}
		migrated++;
		console.log(`  ✓ ${name}：${rows} 行`);
	} catch (e) {
		skipped.push(`${name}（${e instanceof Error ? e.message : String(e)}）`);
	}
}
db.close();
console.log(`迁移完成：${migrated} 张表。${skipped.length > 0 ? `跳过：${skipped.join("；")}` : ""}`);
