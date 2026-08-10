/**
 * 自定义表格模板（DESIGN-template-system §2/§3）：
 * 模板的存储 / CRUD / TavernDB 导入解析 / 物化建表。
 *
 * 纯函数零 pi 依赖：
 * - 存储 `.liyuan-templates/`（一个模板一个 `<name>.json`，格式 `{ format, version, ...TableTemplateDef }`）；
 * - 物化复用 src/state.ts 的 applyTableOperation（每个表不存在则 create、已存在跳过，幂等只建结构）。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { applyTableOperation } from "./state.ts";
import type { CustomTableColumn, TableColumnType, TableTemplate, TableTemplateDef, WorldState } from "./types.ts";
import { TABLE_DISCIPLINE } from "./table-discipline.ts";

/** 模板存储目录（相对项目根；与其它 .liyuan-* 数据目录同级） */
export const TEMPLATES_DIR = ".liyuan-templates";

/** 模板文件格式标记（版本化，便于将来迁移/校验） */
const TEMPLATE_FORMAT = "liyuan-template";
const TEMPLATE_VERSION = 1;

/** 模板名上限（规格 §1：≤40 字，作文件标识） */
const TEMPLATE_NAME_MAX = 40;

function templatesDir(cwd: string): string {
	return join(cwd, TEMPLATES_DIR);
}

function templatePath(cwd: string, name: string): string {
	return join(templatesDir(cwd), `${name}.json`);
}

/**
 * 校验并归一化模板定义。
 * 返回错误信息（null = 合法）；合法时模板名已 trim。防御：name 不能带路径分隔符（文件标识防穿越）。
 */
function validateTemplateDef(def: TableTemplateDef): string | null {
	const name = (def.name ?? "").trim();
	if (!name) return "模板名不能为空";
	if (name.length > TEMPLATE_NAME_MAX) return `模板名不能超过 ${TEMPLATE_NAME_MAX} 字`;
	if (name === "." || name === ".." || /[/\\]/.test(name)) return "模板名不能包含路径分隔符";
	if (!Array.isArray(def.tables)) return "tables 必须是数组";
	if (def.tables.length === 0) return "模板至少要有一张表";
	for (const t of def.tables) {
		if (!t || typeof t !== "object" || Array.isArray(t)) return "tables 含非法项";
		if (typeof t.name !== "string" || !t.name.trim()) return "表必须有 name";
		if (!Array.isArray(t.columns) || t.columns.length === 0) return `表「${t.name}」至少需要 1 列`;
	}
	return null;
}

/**
 * 归一化单张表定义（读盘用）：只挑合法字段，缺啥补啥。
 * 向后兼容：旧模板文件的 instructions（updateNode+initNode+deleteNode 合并版）在无 updateNode 时映射到 updateNode。
 */
function normalizeTableTemplate(t: unknown): TableTemplate | null {
	if (!t || typeof t !== "object" || Array.isArray(t)) return null;
	const tt = t as Record<string, unknown>;
	if (typeof tt.name !== "string" || !tt.name.trim() || !Array.isArray(tt.columns)) return null;
	const out: TableTemplate = {
		name: tt.name.trim(),
		...(typeof tt.description === "string" && tt.description ? { description: tt.description } : {}),
		columns: tt.columns as CustomTableColumn[],
		...(tt.auto === true ? { auto: true } : {}),
		...(typeof tt.note === "string" && tt.note ? { note: tt.note } : {}),
		...(typeof tt.initNode === "string" && tt.initNode ? { initNode: tt.initNode } : {}),
		...(typeof tt.insertNode === "string" && tt.insertNode ? { insertNode: tt.insertNode } : {}),
		...(typeof tt.updateNode === "string" && tt.updateNode ? { updateNode: tt.updateNode } : {}),
		...(typeof tt.deleteNode === "string" && tt.deleteNode ? { deleteNode: tt.deleteNode } : {}),
		...(Array.isArray(tt.rows) ? { rows: tt.rows as Record<string, unknown>[] } : {}),
	};
	// 旧模板 instructions → updateNode（新语义触发器独立存；两字段都留，materialize 已兼容）
	const instructions = typeof tt.instructions === "string" && tt.instructions ? tt.instructions : undefined;
	if (instructions) {
		out.instructions = instructions;
		if (!out.updateNode) out.updateNode = instructions;
	}
	return out;
}

/** 读模板文件（校验格式标记与必填字段；损坏/缺失返回 null） */
function readTemplateFile(file: string): TableTemplateDef | null {
	try {
		const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
		if (raw.format !== TEMPLATE_FORMAT) return null;
		if (typeof raw.name !== "string" || !Array.isArray(raw.tables)) return null;
		return {
			name: raw.name,
			...(typeof raw.description === "string" && raw.description ? { description: raw.description } : {}),
			tables: raw.tables.map(normalizeTableTemplate).filter((x): x is TableTemplate => x !== null),
		};
	} catch {
		return null;
	}
}

/**
 * 列出全部模板摘要（模板名 → 描述/表数）；目录不存在返回 []。按模板名排序。
 */
export function listTemplates(cwd: string): Array<{ name: string; description?: string; tableCount: number }> {
	let files: string[];
	try {
		files = readdirSync(templatesDir(cwd)).filter((f) => f.endsWith(".json"));
	} catch {
		return [];
	}
	const out: Array<{ name: string; description?: string; tableCount: number }> = [];
	for (const f of files) {
		const def = readTemplateFile(join(templatesDir(cwd), f));
		if (!def) continue;
		out.push({
			name: def.name,
			...(def.description ? { description: def.description } : {}),
			tableCount: def.tables.length,
		});
	}
	return out.sort((a, b) => a.name.localeCompare(b.name, "zh"));
}

/** 按模板名加载；不存在/损坏返回 null */
export function loadTemplate(cwd: string, name: string): TableTemplateDef | null {
	const n = name.trim();
	if (!n) return null;
	return readTemplateFile(templatePath(cwd, n));
}

/** 保存模板（重名覆盖）。返回 { ok:true } 或 { ok:false, error } */
export function saveTemplate(cwd: string, def: TableTemplateDef): { ok: true } | { ok: false; error: string } {
	const err = validateTemplateDef(def);
	if (err) return { ok: false, error: err };
	mkdirSync(templatesDir(cwd), { recursive: true });
	writeFileSync(
		templatePath(cwd, def.name.trim()),
		JSON.stringify({ format: TEMPLATE_FORMAT, version: TEMPLATE_VERSION, ...def }, null, 2),
		"utf8",
	);
	return { ok: true };
}

/** 删除模板；不存在返回 { ok:false, error } */
export function deleteTemplate(cwd: string, name: string): { ok: true } | { ok: false; error: string } {
	const n = name.trim();
	if (!n) return { ok: false, error: "模板名不能为空" };
	const file = templatePath(cwd, n);
	if (!existsSync(file)) return { ok: false, error: `模板 ${n} 不存在` };
	try {
		unlinkSync(file);
		return { ok: true };
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) };
	}
}

// ---------- TavernDB chatSheets 导入解析（DESIGN-template-system §3） ----------

interface DdlColumn {
	name: string;
	type?: TableColumnType;
	/** SQL 行尾 `-- 注释`（中文列名，用于与 content 表头对齐） */
	comment?: string;
}

/** SQL 类型关键字 → TableColumnType；识别不出返回 undefined（按 text 处理） */
function sqlTypeToColumnType(sql: string): TableColumnType | undefined {
	const t = sql.toUpperCase();
	if (/\b(INTEGER|INT|BIGINT|SMALLINT)\b/.test(t)) return "integer";
	if (/\b(REAL|FLOAT|DOUBLE|NUMERIC|DECIMAL)\b/.test(t)) return "number";
	if (/\b(BOOLEAN|BOOL)\b/.test(t)) return "boolean";
	return undefined; // TEXT / VARCHAR 等一律 text
}

/**
 * 解析 CREATE TABLE DDL，提取 `列名 类型 ... -- 注释` 序列。
 * 只解析首尾括号之间的列定义体（跳过 `CREATE TABLE x (` 首行与结尾 `);`）；
 * 逐行匹配：行首列名 + 紧随的类型关键字（跳过 PRIMARY KEY 等修饰）+ 行尾注释。
 * 解析不出列的行跳过；非 SQL / 无括号返回 []。
 */
function parseDdlColumns(ddl: string | undefined): DdlColumn[] {
	if (typeof ddl !== "string" || !ddl.trim()) return [];
	const open = ddl.indexOf("(");
	const close = ddl.lastIndexOf(")");
	if (open < 0 || close <= open) return [];
	const out: DdlColumn[] = [];
	for (const line of ddl.slice(open + 1, close).split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const nameM = /^([A-Za-z_][A-Za-z0-9_]*)\s+/.exec(trimmed);
		if (!nameM) continue;
		const typeM = /^([A-Za-z]+)/.exec(trimmed.slice(nameM[0].length));
		if (!typeM) continue;
		const commentM = /--\s*(.+?)\s*$/.exec(trimmed);
		const comment = commentM ? commentM[1].trim() : undefined;
		out.push({
			name: nameM[1],
			type: sqlTypeToColumnType(typeM[1]),
			...(comment ? { comment } : {}),
		});
	}
	return out;
}

/**
 * 表头列名 → 列类型：优先按 DDL 注释（`-- 姓名` 与中文表头一致）、再按 DDL 列名（英文）、
 * 最后按位置对齐（TavernDB 导出 DDL 与 content 列序一致）；识别不出返回 undefined（text）。
 */
function headerColumnType(header: string, ddlCols: DdlColumn[], index: number): TableColumnType | undefined {
	const byComment = ddlCols.find((c) => c.comment === header);
	if (byComment?.type) return byComment.type;
	const byName = ddlCols.find((c) => c.name.toLowerCase() === header.toLowerCase());
	if (byName?.type) return byName.type;
	return ddlCols[index]?.type;
}

/**
 * 表头列名 → 列说明（description）：取 DDL 注释（与类型同源的查找链——注释优先、列名其次、位置兜底）。
 * DDL 注释常含「列名 + 用途」，如 `name TEXT, -- 姓名：角色昵称`；说明保留原样供模型/场记参考。
 */
function headerColumnDescription(header: string, ddlCols: DdlColumn[], index: number): string | undefined {
	const byComment = ddlCols.find((c) => c.comment === header);
	if (byComment?.comment) return byComment.comment;
	const byName = ddlCols.find((c) => c.name.toLowerCase() === header.toLowerCase());
	if (byName?.comment) return byName.comment;
	return ddlCols[index]?.comment;
}

/**
 * 解析 TavernDB chatSheets 导出文件（`{"mate": {...}, "sheet_x": {...}}`，参考
 * TavernDB_template_色色灵感数据库模板V2.56.json）。解析规则（DESIGN-template-system §3）：
 * - 遍历顶层键，取 `sheet_` 开头的对象（须含 name / sourceData / content）。
 * - 模板名：fallbackName（调用方文件名）> mate.name > 「TavernDB 导入」。
 * - 每张表：name = sheet.name；columns = content[0]（表头行，过滤空串列名，row_id 等内部列保留）；
 *   note = sourceData.note（表格说明，独立存）；initNode/insertNode/updateNode/deleteNode 各自独立存
 *   （不再合并 instructions）；auto = 有 updateNode（有维护规则 → 启发式默认场记自动维护）。
 * - 列类型从 sourceData.ddl 的 SQL 推断（见 headerColumnType）；列 description 取 DDL 注释
 *   （见 headerColumnDescription，与中文表头对齐）；推断不出类型按 text。
 * - rows = content[1..]（数据区）按表头列名映射成对象：跳过空行/空单元格，值保留原样
 *   （列类型在物化 insert 时做 advisory 转换）。不保留 ddl（列结构已提取）。
 * 解析失败（无 sheet_ 表 / 表头缺失）返回 null。
 */
export function parseTavernDB(raw: unknown, fallbackName?: string): TableTemplateDef | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const root = raw as Record<string, unknown>;
	const tables: TableTemplate[] = [];
	for (const [key, value] of Object.entries(root)) {
		if (!key.startsWith("sheet_")) continue;
		if (!value || typeof value !== "object" || Array.isArray(value)) continue;
		const sheet = value as Record<string, unknown>;
		const name = typeof sheet.name === "string" && sheet.name.trim() ? sheet.name.trim() : key;
		const source =
			sheet.sourceData && typeof sheet.sourceData === "object" && !Array.isArray(sheet.sourceData)
				? (sheet.sourceData as Record<string, unknown>)
				: {};
		const content = Array.isArray(sheet.content) ? sheet.content : [];
		const headerRow = content[0];
		if (!Array.isArray(headerRow)) continue;
		const ddlCols = parseDdlColumns(typeof source.ddl === "string" ? source.ddl : undefined);
		// 列：列名 + 类型（DDL 推断）+ description（DDL 注释）；空表头列跳过
		const columns: CustomTableColumn[] = [];
		const colNameAt: Array<string | undefined> = []; // content 列索引 → 列名（空表头为 undefined）
		for (let i = 0; i < headerRow.length; i++) {
			const cell = headerRow[i];
			if (typeof cell !== "string" || !cell.trim()) {
				colNameAt.push(undefined);
				continue;
			}
			const cname = cell.trim();
			const type = headerColumnType(cname, ddlCols, i);
			const desc = headerColumnDescription(cname, ddlCols, i);
			colNameAt.push(cname);
			columns.push(
				desc
					? type
						? { name: cname, type, description: desc }
						: { name: cname, description: desc }
					: type
						? { name: cname, type }
						: { name: cname },
			);
		}
		if (columns.length === 0) continue; // 表头全空：不是有效表
		// 触发器独立存（TavernDB 4 节点；新模板不再合并 instructions）
		const note = typeof source.note === "string" && source.note.trim() ? source.note.trim() : undefined;
		const initNode = typeof source.initNode === "string" && source.initNode.trim() ? source.initNode.trim() : undefined;
		const insertNode =
			typeof source.insertNode === "string" && source.insertNode.trim() ? source.insertNode.trim() : undefined;
		const updateNode =
			typeof source.updateNode === "string" && source.updateNode.trim() ? source.updateNode.trim() : undefined;
		const deleteNode =
			typeof source.deleteNode === "string" && source.deleteNode.trim() ? source.deleteNode.trim() : undefined;
		// 初始数据行：content[1..] 按表头列名映射（跳过空行与空单元格；row_id 等内部列保留）
		const rows: Record<string, unknown>[] = [];
		for (let ri = 1; ri < content.length; ri++) {
			const cells = content[ri];
			if (!Array.isArray(cells)) continue;
			const row: Record<string, unknown> = {};
			let filled = false;
			for (let ci = 0; ci < cells.length && ci < colNameAt.length; ci++) {
				const cname = colNameAt[ci];
				if (!cname) continue;
				const cell = cells[ci];
				if (cell === null || cell === undefined) continue;
				const s = String(cell);
				if (!s.trim()) continue; // 空单元格跳过
				row[cname] = cell; // 保留原值（字符串），列类型在物化 insert 时做 advisory 转换
				filled = true;
			}
			if (filled) rows.push(row);
		}
		tables.push({
			name,
			columns,
			...(note ? { note } : {}),
			...(initNode ? { initNode } : {}),
			...(insertNode ? { insertNode } : {}),
			...(updateNode ? { updateNode } : {}),
			...(deleteNode ? { deleteNode } : {}),
			...(rows.length ? { rows } : {}),
			...(updateNode ? { auto: true } : {}),
		});
	}
	if (tables.length === 0) return null;
	// 模板名：fallbackName（调用方传文件名）> mate.name > 「TavernDB 导入」
	const mate =
		root.mate && typeof root.mate === "object" && !Array.isArray(root.mate) ? (root.mate as Record<string, unknown>) : {};
	const mateName = typeof mate.name === "string" && mate.name.trim() ? mate.name.trim() : "";
	const name = (fallbackName?.trim() || mateName || "TavernDB 导入").slice(0, TEMPLATE_NAME_MAX);
	return { name, tables };
}

// ---------- 物化（DESIGN-template-system §2/§4） ----------

/**
 * 表 description 合并串（物化写入 / 覆写共用）：
 * [全局填表纪律, description, note, initNode, insertNode, updateNode, deleteNode] 拼接
 * （纪律前置：场记/回填/UI 第一眼看到执行层红线；旧模板 instructions 兜底）。
 */
function buildTableDescription(t: TableTemplate): string {
	const parts = [
		TABLE_DISCIPLINE,
		t.description,
		t.note,
		t.initNode,
		t.insertNode,
		t.updateNode,
		t.deleteNode,
	];
	if (t.instructions) parts.push(t.instructions);
	return parts.filter((x): x is string => Boolean(x?.trim())).join("\n");
}

/** 列结构一致性（只看 name+type 序列，忽略 description——列说明允许模板侧覆写） */
function sameColumnStructure(a: CustomTableColumn[], b: CustomTableColumn[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i].name !== b[i].name) return false;
		if ((a[i].type ?? undefined) !== (b[i].type ?? undefined)) return false;
	}
	return true;
}

/**
 * 把模板物化进世界状态：对每个表——不存在则 create（columns / auto / description 写入；
 * description = [description, note, initNode, insertNode, updateNode, deleteNode] 合并，避免改
 * CustomTable 类型），已有 rows 则建表后逐个 insert 填初始数据；
 * **表已存在且列结构（name+type 序列）一致 → 覆写表 description 与逐列 description**（模板为
 * 真值源：说明可随模板迭代更新，不碰 rows/列结构）；列结构不一致 → 跳过 + warning 注明差异。
 * 返回 applied（建表/覆写/填数据摘要）与 warnings（已存在/失败/未知列丢弃）。
 * 注意：applyTableOperation 直接改传入 state——调用方须自行 clone（loadState 已返回新对象）。
 */
export function materializeTemplate(
	state: WorldState,
	def: TableTemplateDef,
): { applied: string[]; warnings: string[] } {
	const applied: string[] = [];
	const warnings: string[] = [];
	for (const t of def.tables) {
		const existing = state.tables?.[t.name];
		if (existing) {
			if (sameColumnStructure(existing.columns, t.columns)) {
				const description = buildTableDescription(t);
				if (description) existing.description = description;
				// 逐列覆写列说明（模板列有说明才写；name 对齐）
				let colsWritten = 0;
				for (const tc of t.columns) {
					const ec = existing.columns.find((c) => c.name === tc.name);
					if (ec && tc.description) {
						ec.description = tc.description;
						colsWritten++;
					}
				}
				warnings.push(
					`表「${t.name}」已存在，说明已按模板覆写${colsWritten ? `（列说明 ${colsWritten} 个）` : ""}`,
				);
				applied.push(`表「${t.name}」说明已按模板更新`);
			} else {
				warnings.push(`表「${t.name}」已存在但列结构与模板不一致（模板 ${t.columns.map((c) => c.name).join("、")} vs 现有 ${existing.columns.map((c) => c.name).join("、")}），跳过——需删表后重新物化`);
			}
			continue;
		}
		const description = buildTableDescription(t);
		const r = applyTableOperation(state, {
			kind: "create",
			name: t.name,
			columns: t.columns,
			...(description ? { description } : {}),
			...(t.auto ? { auto: true } : {}),
		});
		if (!r.ok) {
			warnings.push(r.error ?? `表「${t.name}」创建失败`);
			continue;
		}
		applied.push(...(r.applied ?? []));
		warnings.push(...(r.warnings ?? [])); // create 侧去重等警告一并透出
		// 初始数据行：建表后逐个 insert（只保留已声明列，类型按列声明做 advisory 转换）。
		// 幂等：表已存在会提前跳过，初始行不会重复插入。
		if (t.rows?.length) {
			let inserted = 0;
			for (const row of t.rows) {
				const ir = applyTableOperation(state, { kind: "insert", table: t.name, row });
				if (!ir.ok) {
					warnings.push(ir.error ?? `表「${t.name}」初始行插入失败`);
					continue;
				}
				inserted++;
				warnings.push(...(ir.warnings ?? [])); // 未知列丢弃等警告一并透出
			}
			if (inserted) applied.push(`表「${t.name}」填充初始数据 ${inserted} 行`);
		}
	}
	return { applied, warnings };
}
