/**
 * 脚本运行时扩展（JS Runner）的通用 JSON 持久化：extdata。
 * 等价 ST 的 extdata 语义：按作用域存 key-value，供扩展脚本跨会话读写。
 * 落盘目录 `<cwd>/.liyuan-state/extdata/`，每个作用域一个 JSON 文件。
 * 领域层纪律（PLAN.md D3）：零 pi import，纯 JSON 读写。
 */

import { Buffer } from "node:buffer";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readJsonFile } from "./jsonio.ts";
import { DIRS } from "./paths.ts";

export const EXTDATA_SCOPES = ["global", "preset", "character", "chat"] as const;
export type ExtDataScope = (typeof EXTDATA_SCOPES)[number];

/** 单个 key 的 value 序列化后的字节上限（1MB） */
const MAX_EXTDATA_BYTES = 1024 * 1024;

/** key 长度上限 */
const MAX_EXTDATA_KEY_LENGTH = 128;

/** 拒绝原型链污染相关键 */
const BANNED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** scope 必须 ∈ EXTDATA_SCOPES（防拼路径越界） */
function assertScope(scope: string): asserts scope is ExtDataScope {
	if (!(EXTDATA_SCOPES as readonly string[]).includes(scope)) {
		throw new Error(`非法 extdata 作用域：${scope}（允许：${EXTDATA_SCOPES.join("、")}）`);
	}
}

/** key 校验：非空、≤128 字符、不含 "."（含 ".."，防路径穿越）、拒绝原型链危险键 */
function assertKey(key: string): void {
	if (typeof key !== "string" || key.length === 0) throw new Error("extdata 键不能为空");
	if (key.length > MAX_EXTDATA_KEY_LENGTH) {
		throw new Error(`extdata 键超长（${key.length} > ${MAX_EXTDATA_KEY_LENGTH}）：${key}`);
	}
	if (key.includes(".") || key.includes("/") || key.includes("\\")) {
		throw new Error(`extdata 键不能含点号/路径分隔符（防路径穿越）：${key}`);
	}
	if (BANNED_KEYS.has(key)) throw new Error(`extdata 拒绝危险原型键：${key}`);
}

/** JSON.stringify 带错误与大小校验（供 saveExtData 全量校验） */
function stringifyChecked(data: unknown, label: string): string {
	let json: string;
	try {
		json = JSON.stringify(data);
	} catch (err) {
		throw new Error(`extdata ${label}不可 JSON 序列化：${err instanceof Error ? err.message : String(err)}`);
	}
	if (json === undefined) {
		throw new Error(`extdata ${label}不可 JSON 序列化：undefined/函数/符号`);
	}
	if (Buffer.byteLength(json, "utf8") > MAX_EXTDATA_BYTES) {
		throw new Error(`extdata ${label}超过 1MB 上限`);
	}
	return json;
}

/** extdata 目录：<cwd>/.liyuan-state/extdata/ */
export function extdataDir(cwd: string): string {
	return join(cwd, DIRS.state, "extdata");
}

/** 单作用域数据文件：<extdataDir>/<scope>.json */
export function extdataFile(cwd: string, scope: ExtDataScope): string {
	assertScope(scope);
	return join(extdataDir(cwd), `${scope}.json`);
}

/** 读取某作用域全部数据；文件缺失或损坏返回空对象（不 throw） */
export function loadExtData(cwd: string, scope: ExtDataScope): Record<string, unknown> {
	assertScope(scope);
	const file = extdataFile(cwd, scope);
	try {
		const raw = readJsonFile(file);
		if (raw && typeof raw === "object" && !Array.isArray(raw)) {
			return raw as Record<string, unknown>;
		}
		return {};
	} catch {
		return {};
	}
}

/** 全量落盘：旧文件先备份为 <file>.bak，再写新文件 */
export function saveExtData(cwd: string, scope: ExtDataScope, data: Record<string, unknown>): void {
	assertScope(scope);
	if (!data || typeof data !== "object" || Array.isArray(data)) {
		throw new Error("extdata 数据须为对象");
	}
	for (const key of Object.keys(data)) assertKey(key);
	const json = stringifyChecked(data, "数据");
	const dir = extdataDir(cwd);
	mkdirSync(dir, { recursive: true });
	const file = extdataFile(cwd, scope);
	if (existsSync(file)) copyFileSync(file, `${file}.bak`);
	writeFileSync(file, `${json}\n`, "utf8");
}

/** 取单键；键不存在返回 undefined */
export function getExtData(cwd: string, scope: ExtDataScope, key: string): unknown {
	assertScope(scope);
	assertKey(key);
	return loadExtData(cwd, scope)[key];
}

/** 写单键（读-改-写整文件，同样过键/值校验） */
export function putExtData(cwd: string, scope: ExtDataScope, key: string, value: unknown): void {
	assertScope(scope);
	assertKey(key);
	stringifyChecked(value, `值（${key}）`);
	const data = loadExtData(cwd, scope);
	data[key] = value;
	saveExtData(cwd, scope, data);
}
