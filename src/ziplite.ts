/**
 * 极简 zip 解压（仅在线更新用）：node 原生 zlib，零外部依赖。
 *
 * 只支持梨园自己 pack-release.ps1 产出的 zip 形态：
 * - 压缩方法 0（store）/ 8（deflate）
 * - 无加密、无分卷、无 zip64（包 ~12MB 远低于 4GB 界）
 * 以中央目录为准枚举条目（EOCD 定位），路径穿越防御（zip-slip）。
 * Unix 权限位从 external attr 高 16 位还原（start.sh 的 0755 不丢）。
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { inflateRawSync } from "node:zlib";

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

export interface ZipEntryInfo {
	name: string;
	size: number;
	isDir: boolean;
	/** unix mode（无则 0） */
	mode: number;
}

interface CenEntry extends ZipEntryInfo {
	method: number;
	compressedSize: number;
	localOffset: number;
}

function findEocd(buf: Buffer): number {
	// EOCD 注释最长 65535，从尾部回扫
	const min = Math.max(0, buf.length - 22 - 65535);
	for (let i = buf.length - 22; i >= min; i--) {
		if (buf.readUInt32LE(i) === EOCD_SIG) return i;
	}
	throw new Error("不是有效的 zip（找不到 EOCD）");
}

function readCentralDirectory(buf: Buffer): CenEntry[] {
	const eocd = findEocd(buf);
	const count = buf.readUInt16LE(eocd + 10);
	const cenOffset = buf.readUInt32LE(eocd + 16);
	const entries: CenEntry[] = [];
	let p = cenOffset;
	for (let i = 0; i < count; i++) {
		if (buf.readUInt32LE(p) !== CEN_SIG) throw new Error("中央目录损坏");
		const method = buf.readUInt16LE(p + 10);
		const compressedSize = buf.readUInt32LE(p + 20);
		const size = buf.readUInt32LE(p + 24);
		const nameLen = buf.readUInt16LE(p + 28);
		const extraLen = buf.readUInt16LE(p + 30);
		const commentLen = buf.readUInt16LE(p + 32);
		const externalAttr = buf.readUInt32LE(p + 38);
		const localOffset = buf.readUInt32LE(p + 42);
		const flags = buf.readUInt16LE(p + 8);
		// bit 11 = UTF-8 名；pack 脚本恒置位。非 UTF-8 也按 utf8 解（我们只吃自己的包）
		void flags;
		const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
		const mode = (externalAttr >>> 16) & 0o7777;
		entries.push({
			name,
			size,
			isDir: name.endsWith("/"),
			mode,
			method,
			compressedSize,
			localOffset,
		});
		p += 46 + nameLen + extraLen + commentLen;
	}
	return entries;
}

function entryData(buf: Buffer, e: CenEntry): Buffer {
	const p = e.localOffset;
	if (buf.readUInt32LE(p) !== LOC_SIG) throw new Error(`local header 损坏：${e.name}`);
	const nameLen = buf.readUInt16LE(p + 26);
	const extraLen = buf.readUInt16LE(p + 28);
	const start = p + 30 + nameLen + extraLen;
	const raw = buf.subarray(start, start + e.compressedSize);
	if (e.method === 0) return Buffer.from(raw);
	if (e.method === 8) return inflateRawSync(raw);
	throw new Error(`不支持的压缩方法 ${e.method}：${e.name}`);
}

/** 列出 zip 条目（调试/测试用） */
export function listZipEntries(zipPath: string): ZipEntryInfo[] {
	const buf = readFileSync(zipPath);
	return readCentralDirectory(buf).map(({ name, size, isDir, mode }) => ({ name, size, isDir, mode }));
}

/**
 * 解压整个 zip 到 destDir。zip-slip 防御：解出的绝对路径必须落在 destDir 内。
 */
export function extractZipFile(zipPath: string, destDir: string): void {
	const buf = readFileSync(zipPath);
	const entries = readCentralDirectory(buf);
	const root = resolve(destDir);
	for (const e of entries) {
		const target = resolve(join(root, e.name));
		if (target !== root && !target.startsWith(root + sep)) {
			throw new Error(`zip 条目路径越界：${e.name}`);
		}
		if (e.isDir) {
			mkdirSync(target, { recursive: true });
			continue;
		}
		mkdirSync(dirname(target), { recursive: true });
		const data = entryData(buf, e);
		if (data.length !== e.size) throw new Error(`解压尺寸不符：${e.name}（${data.length} != ${e.size}）`);
		writeFileSync(target, data);
		if (e.mode & 0o111) {
			try {
				chmodSync(target, e.mode);
			} catch {
				/* Windows 无权限位，忽略 */
			}
		}
	}
}
