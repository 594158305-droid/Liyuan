import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

import {
	compareVersions,
	downloadAndStage,
	expectedHashFromSums,
	platformAssetName,
	readPendingUpdate,
	withMirror,
	type UpdateCheckResult,
} from "../src/update.ts";
import { extractZipFile, listZipEntries } from "../src/ziplite.ts";
import { createHash } from "node:crypto";

test("compareVersions：语义比较与前缀 v 容忍", () => {
	assert.equal(compareVersions("1.1.0", "1.1.1"), -1);
	assert.equal(compareVersions("1.1.1", "1.1.1"), 0);
	assert.equal(compareVersions("v1.2.0", "1.1.9"), 1);
	assert.equal(compareVersions("1.9.0", "1.10.0"), -1, "两位段不能按字符串比");
	assert.equal(compareVersions("1.1", "1.1.0"), 0);
});

test("platformAssetName / withMirror", () => {
	assert.equal(platformAssetName("1.1.2", "win32"), "Liyuan-1.1.2-windows.zip");
	assert.equal(platformAssetName("v1.1.2", "linux"), "Liyuan-1.1.2-linux.zip");
	assert.equal(platformAssetName("1.1.2", "darwin"), "Liyuan-1.1.2-macos.zip");
	assert.equal(withMirror("https://github.com/a/b.zip", ""), "https://github.com/a/b.zip");
	assert.equal(withMirror("https://github.com/a/b.zip", "https://ghproxy.net/"), "https://ghproxy.net/https://github.com/a/b.zip");
	assert.equal(withMirror("https://github.com/a/b.zip", "https://ghproxy.net"), "https://ghproxy.net/https://github.com/a/b.zip");
});

test("expectedHashFromSums：GNU 格式解析（含 * 前缀与多行）", () => {
	const sums = "aaaa  other.zip\n" + `${"b".repeat(64)}  Liyuan-1.1.2-windows.zip\n` + `${"c".repeat(64)} *starred.zip\n`;
	assert.equal(expectedHashFromSums(sums, "Liyuan-1.1.2-windows.zip"), "b".repeat(64));
	assert.equal(expectedHashFromSums(sums, "starred.zip"), "c".repeat(64));
	assert.equal(expectedHashFromSums(sums, "missing.zip"), null);
});

// ---- 构造一个最小合法 zip（store + deflate 混合）供 ziplite 与下载链路用 ----

function crc32(buf: Buffer): number {
	let c: number;
	const table: number[] = [];
	for (let n = 0; n < 256; n++) {
		c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	let crc = 0 ^ -1;
	for (const b of buf) crc = (crc >>> 8) ^ table[(crc ^ b) & 0xff];
	return (crc ^ -1) >>> 0;
}

interface ZipSrcEntry {
	name: string;
	data?: Buffer;
	dir?: boolean;
	mode?: number;
	deflate?: boolean;
}

function buildZip(entries: ZipSrcEntry[]): Buffer {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;
	for (const e of entries) {
		const nameBuf = Buffer.from(e.name, "utf8");
		const data = e.dir ? Buffer.alloc(0) : (e.data ?? Buffer.alloc(0));
		const method = e.deflate ? 8 : 0;
		const comp = e.deflate ? deflateRawSync(data) : data;
		const crc = crc32(data);
		const loc = Buffer.alloc(30);
		loc.writeUInt32LE(0x04034b50, 0);
		loc.writeUInt16LE(20, 4);
		loc.writeUInt16LE(0x800, 6); // UTF-8 flag
		loc.writeUInt16LE(method, 8);
		loc.writeUInt32LE(crc, 14);
		loc.writeUInt32LE(comp.length, 18);
		loc.writeUInt32LE(data.length, 22);
		loc.writeUInt16LE(nameBuf.length, 26);
		const localRec = Buffer.concat([loc, nameBuf, comp]);
		locals.push(localRec);

		const cen = Buffer.alloc(46);
		cen.writeUInt32LE(0x02014b50, 0);
		cen.writeUInt16LE(20, 4);
		cen.writeUInt16LE(20, 6);
		cen.writeUInt16LE(0x800, 8);
		cen.writeUInt16LE(method, 10);
		cen.writeUInt32LE(crc, 16);
		cen.writeUInt32LE(comp.length, 20);
		cen.writeUInt32LE(data.length, 24);
		cen.writeUInt16LE(nameBuf.length, 28);
		const mode = e.mode ?? (e.dir ? 0o755 : 0o644);
		cen.writeUInt32LE(((mode | (e.dir ? 0o040000 : 0o100000)) << 16) >>> 0, 38);
		cen.writeUInt32LE(offset, 42);
		centrals.push(Buffer.concat([cen, nameBuf]));
		offset += localRec.length;
	}
	const cenAll = Buffer.concat(centrals);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(entries.length, 8);
	eocd.writeUInt16LE(entries.length, 10);
	eocd.writeUInt32LE(cenAll.length, 12);
	eocd.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, cenAll, eocd]);
}

test("ziplite：store/deflate 解压、UTF-8 名、权限位、zip-slip 拒绝", () => {
	const dir = mkdtempSync(join(tmpdir(), "liyuan-ziplite-"));
	try {
		const zip = buildZip([
			{ name: "Liyuan/", dir: true },
			{ name: "Liyuan/a.txt", data: Buffer.from("hello"), deflate: false },
			{ name: "Liyuan/中文/b.txt", data: Buffer.from("深压缩内容".repeat(50)), deflate: true },
			{ name: "Liyuan/start.sh", data: Buffer.from("#!/bin/sh\n"), mode: 0o755, deflate: true },
		]);
		const zp = join(dir, "t.zip");
		writeFileSync(zp, zip);
		const names = listZipEntries(zp).map((e) => e.name);
		assert.ok(names.includes("Liyuan/中文/b.txt"));
		extractZipFile(zp, join(dir, "out"));
		assert.equal(readFileSync(join(dir, "out", "Liyuan", "a.txt"), "utf8"), "hello");
		assert.equal(readFileSync(join(dir, "out", "Liyuan", "中文", "b.txt"), "utf8"), "深压缩内容".repeat(50));

		const evil = buildZip([{ name: "../evil.txt", data: Buffer.from("x") }]);
		const ep = join(dir, "evil.zip");
		writeFileSync(ep, evil);
		assert.throws(() => extractZipFile(ep, join(dir, "out2")), /越界/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("downloadAndStage：本地 HTTP 全链路——下载→SHA256→解压→pending；坏哈希拒绝", async () => {
	const dir = mkdtempSync(join(tmpdir(), "liyuan-dl-"));
	// 假 release zip：合法梨园结构（package.json + server/main.ts + 扩展）
	const goodZip = buildZip([
		{ name: "Liyuan/", dir: true },
		{ name: "Liyuan/package.json", data: Buffer.from(JSON.stringify({ name: "liyuan", version: "9.9.9" })), deflate: true },
		{ name: "Liyuan/server/main.ts", data: Buffer.from("// server"), deflate: true },
		{ name: "Liyuan/.liyuan/extensions/roleplay.ts", data: Buffer.from("// ext"), deflate: true },
	]);
	const zipName = platformAssetName("9.9.9");
	const goodHash = createHash("sha256").update(goodZip).digest("hex");

	let sumsBody = `${goodHash}  ${zipName}\n`;
	const server = createServer((req, res) => {
		if (req.url === `/dl/${zipName}`) {
			res.writeHead(200, { "content-type": "application/zip", "content-length": String(goodZip.length) });
			res.end(goodZip);
		} else if (req.url === "/dl/SHA256SUMS.txt") {
			res.writeHead(200, { "content-type": "text/plain" });
			res.end(sumsBody);
		} else {
			res.writeHead(404);
			res.end();
		}
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const port = (server.address() as { port: number }).port;
	const base = `http://127.0.0.1:${port}/dl`;

	const check: UpdateCheckResult = {
		currentVersion: "1.1.1",
		latestVersion: "9.9.9",
		hasUpdate: true,
		asset: { name: zipName, url: `${base}/${zipName}`, size: goodZip.length },
		checksumsUrl: `${base}/SHA256SUMS.txt`,
	};

	try {
		const progress: number[] = [];
		const pending = await downloadAndStage({
			cwd: dir,
			check,
			onProgress: (p) => progress.push(p.received),
		});
		assert.equal(pending.version, "9.9.9");
		assert.equal(pending.verified, "sha256sums");
		assert.equal(pending.zipSha256, goodHash);
		assert.ok(progress.length >= 1, "应有进度回调");
		assert.ok(existsSync(join(pending.stagedDir, "package.json")));
		assert.ok(existsSync(join(pending.stagedDir, ".liyuan", "extensions", "roleplay.ts")));
		const re = readPendingUpdate(dir);
		assert.ok(re && re.version === "9.9.9", "pending.json 可读回");

		// 坏哈希：整个暂存目录必须回到干净态
		sumsBody = `${"0".repeat(64)}  ${zipName}\n`;
		await assert.rejects(
			downloadAndStage({ cwd: dir, check }),
			/SHA256 校验不符/,
		);
		assert.equal(readPendingUpdate(dir), null, "失败后不得残留 pending");
	} finally {
		server.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("apply-update.mjs：白名单覆盖 + 数据保留 + 备份", () => {
	const dir = mkdtempSync(join(tmpdir(), "liyuan-apply-"));
	try {
		// 旧树：代码 + 用户数据
		mkdirSync(join(dir, "src"), { recursive: true });
		mkdirSync(join(dir, "assets", "cards"), { recursive: true });
		mkdirSync(join(dir, ".liyuan-state"), { recursive: true });
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "liyuan", version: "1.1.1", dependencies: { ws: "1" } }));
		writeFileSync(join(dir, "src", "old.ts"), "old code");
		writeFileSync(join(dir, "src", "gone.ts"), "will be removed by update");
		writeFileSync(join(dir, "liyuan.config.json"), '{"userName":"怀瑾"}');
		writeFileSync(join(dir, "assets", "cards", "我的私人卡.png"), "PRIVATE");
		writeFileSync(join(dir, "assets", "cards", "default_Qingwu.json"), '{"v":"old"}');
		writeFileSync(join(dir, ".liyuan-state", "state.json"), '{"hp":1}');

		// 暂存新树
		const staged = join(dir, ".liyuan-cache", "update", "staged", "Liyuan");
		mkdirSync(join(staged, "src"), { recursive: true });
		mkdirSync(join(staged, "assets", "cards"), { recursive: true });
		writeFileSync(join(staged, "package.json"), JSON.stringify({ name: "liyuan", version: "1.1.2", dependencies: { ws: "2" } }));
		writeFileSync(join(staged, "src", "old.ts"), "new code");
		writeFileSync(join(staged, "src", "added.ts"), "brand new module");
		writeFileSync(join(staged, "assets", "cards", "default_Qingwu.json"), '{"v":"new"}');
		writeFileSync(
			join(dir, ".liyuan-cache", "update", "pending.json"),
			JSON.stringify({ version: "1.1.2", stagedDir: staged, zipSha256: "x", verified: "sha256sums", downloadedAt: "t" }),
		);

		const script = fileURLToPath(new URL("../scripts/apply-update.mjs", import.meta.url));
		const out = execFileSync(process.execPath, [script], { cwd: dir, encoding: "utf8" });
		assert.match(out, /更新完成/);

		// 代码被覆盖 / 新增 / 删除
		assert.equal(readFileSync(join(dir, "src", "old.ts"), "utf8"), "new code");
		assert.equal(readFileSync(join(dir, "src", "added.ts"), "utf8"), "brand new module");
		assert.ok(!existsSync(join(dir, "src", "gone.ts")), "更新里已删除的模块不得残留");
		assert.equal(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version, "1.1.2");
		// 用户数据分毫不动
		assert.equal(readFileSync(join(dir, "liyuan.config.json"), "utf8"), '{"userName":"怀瑾"}');
		assert.equal(readFileSync(join(dir, "assets", "cards", "我的私人卡.png"), "utf8"), "PRIVATE");
		assert.equal(readFileSync(join(dir, ".liyuan-state", "state.json"), "utf8"), '{"hp":1}');
		// 官方示例卡同步
		assert.equal(JSON.parse(readFileSync(join(dir, "assets", "cards", "default_Qingwu.json"), "utf8")).v, "new");
		// 备份在
		assert.equal(readFileSync(join(dir, ".liyuan-cache", "backup-1.1.1", "src", "old.ts"), "utf8"), "old code");
		// 依赖变了 → 重装标记
		assert.ok(existsSync(join(dir, ".liyuan-cache", "needs-npm-install")));
		// pending 已清
		assert.ok(!existsSync(join(dir, ".liyuan-cache", "update")));

		// 幂等：再跑一次（无 pending）应静默通过
		const out2 = execFileSync(process.execPath, [script], { cwd: dir, encoding: "utf8" });
		assert.equal(out2.trim(), "");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
