/**
 * 结构化世界状态：读写、补丁合并、注入格式化。
 * 这是对 ST「模型忘状态」痛点的架构级解法（PLAN.md §3）。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { readJsonFile } from "./jsonio.ts";
import type { CharacterState, CustomTable, CustomTableColumn, StateRoster, TableColumnType, WorldState } from "./types.ts";

const TOP_KEYS = ["time", "location", "characters", "inventory", "flags", "plot_threads", "tables"] as const;

export function defaultState(): WorldState {
	return {
		time: "",
		location: "",
		characters: {},
		inventory: [],
		flags: {},
		plot_threads: [],
		tables: {},
	};
}

export function loadState(file: string): WorldState {
	try {
		const raw = readJsonFile(file) as Partial<WorldState>;
		return { ...defaultState(), ...raw };
	} catch {
		return defaultState();
	}
}

export function saveState(file: string, state: WorldState): void {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify(state, null, 2), "utf8");
}

export interface PatchResult {
	state: WorldState;
	/** 人类可读的变更摘要（用于工具返回，让模型确认写入了什么） */
	applied: string[];
	warnings: string[];
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

const normName = (s: string) => s.trim().toLowerCase();

/**
 * 把补丁中的角色键归一到已知的规范名（大小写/首尾空白不敏感），
 * 防止同一角色被记成多份（实测 flash 会写出 "Alice"/"alice " 变体）。
 * 中文译名与原名的等同（爱丽丝=Alice）无法机械判定，交给 Phase 2 scribe。
 */
export function canonicalizeCharacterKeys(
	patch: Record<string, unknown>,
	knownNames: string[],
): Record<string, unknown> {
	const chars = patch.characters;
	if (!chars || typeof chars !== "object" || Array.isArray(chars)) return patch;

	const canon = new Map<string, string>();
	for (const n of knownNames) {
		const k = normName(n);
		if (k && !canon.has(k)) canon.set(k, n.trim());
	}
	const out: Record<string, unknown> = {};
	for (const [name, value] of Object.entries(chars as Record<string, unknown>)) {
		const key = canon.get(normName(name)) ?? name.trim();
		if (!canon.has(normName(name))) canon.set(normName(name), key);
		// 补丁内部撞到同一规范名：浅合并（后写的字段覆盖）
		if (out[key] && value && typeof value === "object" && typeof out[key] === "object") {
			out[key] = { ...(out[key] as object), ...(value as object) };
		} else {
			out[key] = value;
		}
	}
	return { ...patch, characters: out };
}

/**
 * 合并补丁。语义（工具描述中向模型说明）：
 * - time / location：字符串整体替换
 * - characters：按角色名合并字段；传 null 删除该角色
 * - flags：按键合并；传 null 删除该键
 * - inventory / plot_threads：数组整体替换（须传完整数组）
 * - 未知顶层键拒绝并告警（保持 schema 诚实）
 */
export function applyPatch(state: WorldState, patch: Record<string, unknown>): PatchResult {
	const next: WorldState = structuredClone(state);
	const applied: string[] = [];
	const warnings: string[] = [];

	for (const [key, value] of Object.entries(patch)) {
		switch (key) {
			case "time":
			case "location": {
				if (typeof value === "string") {
					next[key] = value;
					applied.push(`${key} → ${value}`);
				} else warnings.push(`${key} 需要字符串，已忽略`);
				break;
			}
			case "characters": {
				if (value && typeof value === "object" && !Array.isArray(value)) {
					for (const [name, cs] of Object.entries(value as Record<string, unknown>)) {
						if (cs === null) {
							delete next.characters[name];
							applied.push(`characters.${name} 已移除`);
							continue;
						}
						if (!cs || typeof cs !== "object") {
							warnings.push(`characters.${name} 需要对象或 null，已忽略`);
							continue;
						}
						const cur: CharacterState = next.characters[name] ?? { affinity: 0, status: "", notes: "" };
						const p = cs as Partial<Record<keyof CharacterState, unknown>>;
						if (typeof p.affinity === "number") cur.affinity = clamp(Math.round(p.affinity), -100, 100);
						if (typeof p.status === "string") cur.status = p.status;
						if (typeof p.notes === "string") cur.notes = p.notes;
						// 当前穿着（服装档案 outfit id，随世界线回档）：显式 null 清除
						if (typeof p.outfit === "string") cur.outfit = p.outfit;
						else if (p.outfit === null) delete cur.outfit;
						next.characters[name] = cur;
						applied.push(`characters.${name} 已更新`);
					}
				} else warnings.push("characters 需要对象，已忽略");
				break;
			}
			case "flags": {
				if (value && typeof value === "object" && !Array.isArray(value)) {
					for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
						if (v === null) {
							delete next.flags[k];
							applied.push(`flags.${k} 已移除`);
						} else if (typeof v === "string") {
							next.flags[k] = v;
							applied.push(`flags.${k} → ${v}`);
						} else {
							next.flags[k] = JSON.stringify(v);
							applied.push(`flags.${k} 已更新`);
						}
					}
				} else warnings.push("flags 需要对象，已忽略");
				break;
			}
			case "inventory":
			case "plot_threads": {
				if (Array.isArray(value)) {
					// 非字符串元素**不静默丢弃**：模型常传 [{name,数量}] 这类对象，
					// 旧实现 filter 掉后仍回报「成功」（applied 里是空数组），模型只能反复试错。
					const kept = value.filter((x): x is string => typeof x === "string");
					const dropped = value.filter((x) => typeof x !== "string");
					if (dropped.length > 0) {
						warnings.push(
							`${key} 有 ${dropped.length} 项不是字符串已丢弃（${dropped
								.slice(0, 2)
								.map((d) => JSON.stringify(d))
								.join("、")}${dropped.length > 2 ? "…" : ""}）——` +
								`本字段是字符串数组，请写成 ["补气丹（已服用）"] 这样的一句话条目。`,
						);
					}
					next[key] = kept;
					applied.push(`${key} → [${kept.join("、")}]`);
				} else warnings.push(`${key} 需要完整数组（整体替换语义），已忽略`);
				break;
			}
			case "roster": {
				// 登场名录编辑（用户主权，REST 侧用；模型工具 schema 不含此键）：
				// {characters/items/events: {名称: null(删除) | 字符串(改一句话)}}。
				// 注意：删除**活跃**条目会被本函数末尾的 registerRoster 立即重新登记——名录必须覆盖在场条目。
				if (value && typeof value === "object" && !Array.isArray(value)) {
					const roster: StateRoster = next.roster ?? { characters: {}, items: {}, events: {} };
					for (const table of ["characters", "items", "events"] as const) {
						const patchTable = (value as Record<string, unknown>)[table];
						if (patchTable === undefined) continue;
						if (!patchTable || typeof patchTable !== "object" || Array.isArray(patchTable)) {
							warnings.push(`roster.${table} 需要对象，已忽略`);
							continue;
						}
						for (const [name, v] of Object.entries(patchTable as Record<string, unknown>)) {
							if (v === null) {
								delete roster[table][name];
								applied.push(`roster.${table}.${name} 已移除`);
							} else if (typeof v === "string") {
								roster[table][name] = v.slice(0, 60);
								applied.push(`roster.${table}.${name} 已更新`);
							} else warnings.push(`roster.${table}.${name} 需要字符串或 null，已忽略`);
						}
					}
					next.roster = roster;
				} else warnings.push("roster 需要对象，已忽略");
				break;
			}
			case "tables": {
				// 自定义表格补丁（场记专用，DESIGN-custom-tables §2）：仅更新 auto 标记的表；
				// 表不存在或非 auto → warning + 跳过。复用 applyTableOperation 的 insert/update/delete。
				// 形状：{ "<表名>": { "insert": [行对象...], "update": [{"match":{...},"changes":{...}}...], "delete": [匹配对象...] } }
				if (value && typeof value === "object" && !Array.isArray(value)) {
					const tbl: Record<string, CustomTable> = next.tables ?? (next.tables = {});
					for (const [name, ops] of Object.entries(value as Record<string, unknown>)) {
						const table = tbl[name];
						if (!table) {
							warnings.push(`tables.${name} 不存在，已跳过`);
							continue;
						}
						if (!table.auto) {
							warnings.push(`tables.${name} 非 auto 表（场记不自动维护），已跳过`);
							continue;
						}
						if (!ops || typeof ops !== "object" || Array.isArray(ops)) {
							warnings.push(`tables.${name} 需要操作对象，已忽略`);
							continue;
						}
						for (const [opKind, list] of Object.entries(ops as Record<string, unknown>)) {
							if (opKind !== "insert" && opKind !== "update" && opKind !== "delete") {
								warnings.push(`tables.${name}.${opKind} 不支持的操作，已忽略`);
								continue;
							}
							if (!Array.isArray(list)) {
								warnings.push(`tables.${name}.${opKind} 需要数组，已忽略`);
								continue;
							}
							for (const item of list) {
								if (!item || typeof item !== "object" || Array.isArray(item)) {
									warnings.push(`tables.${name}.${opKind} 有非对象项，已忽略`);
									continue;
								}
								const op = tableOpFromPatch(opKind, name, item as Record<string, unknown>);
								if (!op) {
									warnings.push(`tables.${name}.${opKind} 项格式不对（update 需 match/changes），已忽略`);
									continue;
								}
								const r = applyTableOperation(next, op);
								if (!r.ok) warnings.push(r.error ?? `tables.${name}.${opKind} 失败`);
								else {
									applied.push(...(r.applied ?? []));
									warnings.push(...(r.warnings ?? []));
								}
							}
						}
					}
				} else warnings.push("tables 需要对象，已忽略");
				break;
			}
			default:
				warnings.push(`未知字段 ${key}，允许的顶层字段：${TOP_KEYS.join(", ")}`);
		}
	}
	registerRoster(next);
	return { state: next, applied, warnings };
}

/** 注入用的紧凑可读格式 */
export function formatState(state: WorldState): string {
	const lines: string[] = [];
	if (state.time) lines.push(`时间：${state.time}`);
	if (state.location) lines.push(`地点：${state.location}`);
	for (const [name, c] of Object.entries(state.characters)) {
		const parts = [`好感 ${c.affinity}`];
		if (c.status) parts.push(`状态：${c.status}`);
		if (c.notes) parts.push(`备注：${c.notes}`);
		lines.push(`${name}：${parts.join("；")}`);
	}
	if (state.inventory.length) lines.push(`物品：${state.inventory.join("、")}`);
	for (const [k, v] of Object.entries(state.flags)) lines.push(`${k}：${v}`);
	if (state.plot_threads.length) lines.push(`剧情线：${state.plot_threads.map((t) => `「${t}」`).join(" ")}`);
	return lines.length ? lines.join("\n") : "（尚无记录）";
}

// ---------- 登场名录（agent 索引表） ----------

/** 名录各表容量上限（超出丢最旧——Record 保持插入序）。防剧情线改写措辞导致的近重复无限累积。 */
const ROSTER_CAPS = { characters: 100, items: 100, events: 60 } as const;

/** 名录登记时给人物的一句话预算 */
const ROSTER_BLURB_MAX = 30;

function capRoster(reg: Record<string, string>, cap: number): Record<string, string> {
	const keys = Object.keys(reg);
	if (keys.length <= cap) return reg;
	const out: Record<string, string> = {};
	for (const k of keys.slice(keys.length - cap)) out[k] = reg[k]!;
	return out;
}

/**
 * 名录登记（applyPatch 咽喉点调用）：把当前活跃的人物/物品/剧情线并入名录。
 * 只增不改——已登记条目不追新鲜度（名录记「存在过」，细节靠 memory_search 召回）；
 * 活跃状态里删掉的条目名录保留。
 */
function registerRoster(next: WorldState): void {
	const r: StateRoster = next.roster ?? { characters: {}, items: {}, events: {} };
	for (const [name, c] of Object.entries(next.characters)) {
		if (!(name in r.characters)) r.characters[name] = (c.status || "").slice(0, ROSTER_BLURB_MAX);
	}
	for (const it of next.inventory) {
		if (it && !(it in r.items)) r.items[it] = "";
	}
	for (const t of next.plot_threads) {
		if (t && !(t in r.events)) r.events[t] = "";
	}
	next.roster = {
		characters: capRoster(r.characters, ROSTER_CAPS.characters),
		items: capRoster(r.items, ROSTER_CAPS.items),
		events: capRoster(r.events, ROSTER_CAPS.events),
	};
}

/** 名录索引单节的字符预算（超出按条目边界截断，补「等 N 项」） */
const ROSTER_SECTION_MAX_CHARS = 240;

function rosterSection(label: string, entries: Array<[string, string]>): string | undefined {
	if (entries.length === 0) return undefined;
	const titles = entries.map(([name, blurb]) => (blurb ? `${name}（${blurb}）` : name));
	const shown: string[] = [];
	let used = 0;
	for (const t of titles) {
		if (used + t.length + 1 > ROSTER_SECTION_MAX_CHARS) break;
		shown.push(t);
		used += t.length + 1;
	}
	const rest = titles.length - shown.length;
	return `${label}：${shown.join("、")}${rest > 0 ? `……等 ${titles.length} 项` : ""}`;
}

/**
 * 名录索引渲染：只列**已不在当前状态**的条目（离场人物/失去的物品/已了结或改写的剧情线）——
 * 活跃条目已在【世界状态】全量可见，索引只补「曾经存在」这一层。全空返回 undefined。
 */
export function formatRosterIndex(state: WorldState): string | undefined {
	const r = state.roster;
	if (!r) return undefined;
	const gone = (reg: Record<string, string>, active: Set<string>): Array<[string, string]> =>
		Object.entries(reg).filter(([k]) => !active.has(k));

	const sections = [
		rosterSection("已离场人物", gone(r.characters, new Set(Object.keys(state.characters)))),
		rosterSection("曾持有物品", gone(r.items, new Set(state.inventory))),
		rosterSection("旧剧情线", gone(r.events, new Set(state.plot_threads))),
	].filter((s): s is string => Boolean(s));
	return sections.length ? sections.join("；") : undefined;
}

// ---------- 自定义表格（DESIGN-custom-tables） ----------

export interface TableOpResult {
	ok: boolean;
	/** 操作失败原因（表不存在/重名/无列等） */
	error?: string;
	/** 操作后的状态（成功且状态被修改时给出；错误/纯查询时为 undefined 语义由调用方决定） */
	state?: WorldState;
	/** 人类可读变更摘要 */
	applied?: string[];
	warnings?: string[];
	/** create/query 时返回的表 */
	table?: CustomTable;
	/** table_list 形态：全表清单 */
	tables?: Array<{ name: string; columns: CustomTableColumn[]; rowCount: number; auto?: boolean; description?: string }>;
	/** query 返回的行 */
	rows?: Record<string, unknown>[];
}

export type TableOp =
	| { kind: "create"; name: string; columns: CustomTableColumn[]; description?: string; auto?: boolean }
	| { kind: "drop"; name: string }
	| { kind: "setAuto"; table: string; auto: boolean }
	| { kind: "insert"; table: string; row: Record<string, unknown> }
	| { kind: "update"; table: string; match: Record<string, unknown>; changes: Record<string, unknown> }
	| { kind: "delete"; table: string; match: Record<string, unknown> }
	| { kind: "query"; table: string; filter?: Record<string, unknown> };

/** 列类型 advisory 转换：integer/number 尝试 Number()（integer 再取整），boolean 只认 true/false/1/0 形态；失败保留原值 */
function coerceCell(type: TableColumnType | undefined, value: unknown): unknown {
	if (value === null || value === undefined) return value;
	switch (type) {
		case "integer": {
			const n = Number(value);
			return Number.isFinite(n) ? Math.trunc(n) : value;
		}
		case "number": {
			const n = Number(value);
			return Number.isFinite(n) ? n : value;
		}
		case "boolean": {
			if (typeof value === "boolean") return value;
			if (value === "true" || value === 1 || value === "1") return true;
			if (value === "false" || value === 0 || value === "0") return false;
			return value; // 无法可靠布尔化，保留原值
		}
		default:
			return value;
	}
}

/** 列名去重（空白列名一并丢弃；列 description 保留——模板列说明随物化落地） */
function dedupeColumns(columns: CustomTableColumn[]): CustomTableColumn[] {
	const seen = new Set<string>();
	const out: CustomTableColumn[] = [];
	for (const c of columns) {
		const n = c.name.trim();
		if (!n || seen.has(n)) continue;
		seen.add(n);
		const col: CustomTableColumn = c.description ? { name: n, description: c.description } : { name: n };
		if (c.type) col.type = c.type;
		out.push(col);
	}
	return out;
}

/** 行只保留已声明列（未知列丢弃 + warning），已声明列按类型 advisory 转换 */
function normalizeRow(table: CustomTable, row: Record<string, unknown>, warnings: string[]): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const col of table.columns) {
		if (row[col.name] !== undefined) out[col.name] = coerceCell(col.type, row[col.name]);
	}
	const unknown = Object.keys(row).filter((k) => !table.columns.some((c) => c.name === k));
	if (unknown.length) {
		warnings.push(
			`表 ${table.name} 行含未知列 ${unknown.slice(0, 3).join("、")}${unknown.length > 3 ? "…" : ""}（该表声明列：${table.columns
				.map((c) => c.name)
				.join("、")}），已丢弃`,
		);
	}
	return out;
}

/** 按 match 的所有键值（列类型按声明转换后再比）判断行是否命中 */
function matchRow(table: CustomTable, row: Record<string, unknown>, match: Record<string, unknown>): boolean {
	for (const [k, v] of Object.entries(match)) {
		const col = table.columns.find((c) => c.name === k);
		const want = col ? coerceCell(col.type, v) : v;
		if (row[k] !== want) return false;
	}
	return true;
}

/** 把 applyPatch 的 tables 补丁项翻译成 TableOp；格式不对（update 缺 match/changes）返回 null */
function tableOpFromPatch(kind: string, name: string, item: Record<string, unknown>): TableOp | null {
	switch (kind) {
		case "insert":
			return { kind: "insert", table: name, row: item };
		case "update": {
			const { match, changes } = item;
			if (!match || typeof match !== "object" || Array.isArray(match)) return null;
			if (!changes || typeof changes !== "object" || Array.isArray(changes)) return null;
			return { kind: "update", table: name, match: match as Record<string, unknown>, changes: changes as Record<string, unknown> };
		}
		case "delete":
			return { kind: "delete", table: name, match: item };
		default:
			return null;
	}
}

/**
 * 表格读写（纯函数，直接改传入 state——调用方如 applyPatch 已先 structuredClone）。
 * 语义：
 * - create：表名唯一（重复 → error）；columns 至少 1 列；列名去重；rows 初始 []。
 * - drop：不存在 → error；存在 → 删除。
 * - setAuto：表不存在 → error；存在 → 覆写 auto 标志（true=场记自动维护，false=手动维护），不碰行数据。
 * - insert：表不存在 → error；行只保留已声明列（未知列丢弃 + warning）；列类型 advisory。
 * - update：按 match（所有键值相等）匹配行，应用 changes（只改已声明列）；无匹配 → warning。
 * - delete：按 match 匹配删除；无匹配 → warning。
 * - query：filter 为空返回全部行；否则按 filter 键值相等过滤。
 */
export function applyTableOperation(state: WorldState, op: TableOp): TableOpResult {
	const tables = state.tables ?? (state.tables = {});
	switch (op.kind) {
		case "create": {
			const name = op.name.trim();
			if (!name) return { ok: false, error: "表名不能为空" };
			if (tables[name]) return { ok: false, error: `表 ${name} 已存在` };
			const warnings: string[] = [];
			const columns = dedupeColumns(op.columns);
			if (columns.length === 0) return { ok: false, error: `表 ${name} 至少需要 1 列` };
			if (columns.length < op.columns.length) {
				warnings.push(`表 ${name} 有 ${op.columns.length - columns.length} 个空/重复列名已去重`);
			}
			const table: CustomTable = {
				name,
				columns,
				rows: [],
				...(op.description !== undefined ? { description: op.description } : {}),
				...(op.auto !== undefined ? { auto: op.auto } : {}),
			};
			tables[name] = table;
			return { ok: true, state, applied: [`表 ${name} 已创建`], warnings, table };
		}
		case "drop": {
			const name = op.name.trim();
			if (!tables[name]) return { ok: false, error: `表 ${name} 不存在` };
			delete tables[name];
			return { ok: true, state, applied: [`表 ${name} 已删除`] };
		}
		case "setAuto": {
			const table = tables[op.table];
			if (!table) return { ok: false, error: `表 ${op.table} 不存在` };
			table.auto = op.auto;
			return {
				ok: true,
				state,
				applied: [`表 ${op.table} 已设为${op.auto ? "场记自动维护" : "手动维护"}`],
			};
		}
		case "insert": {
			const table = tables[op.table];
			if (!table) return { ok: false, error: `表 ${op.table} 不存在` };
			const warnings: string[] = [];
			const row = normalizeRow(table, op.row, warnings);
			table.rows.push(row);
			return { ok: true, state, applied: [`表 ${op.table} 插入 1 行`], warnings };
		}
		case "update": {
			const table = tables[op.table];
			if (!table) return { ok: false, error: `表 ${op.table} 不存在` };
			const warnings: string[] = [];
			const changes = normalizeRow(table, op.changes, warnings);
			let n = 0;
			for (const row of table.rows) {
				if (matchRow(table, row, op.match)) {
					Object.assign(row, changes);
					n++;
				}
			}
			if (n === 0) warnings.push(`表 ${op.table} 无行匹配，未更新`);
			return { ok: true, state, applied: n > 0 ? [`表 ${op.table} 更新 ${n} 行`] : [], warnings };
		}
		case "delete": {
			const table = tables[op.table];
			if (!table) return { ok: false, error: `表 ${op.table} 不存在` };
			const before = table.rows.length;
			table.rows = table.rows.filter((r) => !matchRow(table, r, op.match));
			const n = before - table.rows.length;
			if (n === 0) return { ok: true, state, warnings: [`表 ${op.table} 无行匹配，未删除`] };
			return { ok: true, state, applied: [`表 ${op.table} 删除 ${n} 行`] };
		}
		case "query": {
			const table = tables[op.table];
			if (!table) return { ok: false, error: `表 ${op.table} 不存在` };
			const rows =
				op.filter && Object.keys(op.filter).length > 0
					? table.rows.filter((r) => matchRow(table, r, op.filter!))
					: table.rows.slice();
			return { ok: true, state, rows, table };
		}
	}
}

/**
 * 自定义表索引：列全部表（表名（列名…，N 行），[auto] 前缀标出场记自动维护）。
 * 所有表内容都不注入上下文，需用 table_query 现查。全空返回 undefined。
 */
export function formatTableIndex(state: WorldState): string | undefined {
	const tables = state.tables;
	if (!tables) return undefined;
	const entries: string[] = [];
	for (const t of Object.values(tables)) {
		entries.push(`${t.auto ? "[auto] " : ""}${t.name}（${t.columns.map((c) => c.name).join("、")}，${t.rows.length} 行）`);
	}
	return entries.length ? entries.join("；") : undefined;
}
