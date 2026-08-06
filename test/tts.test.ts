import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { loadTtsConfig, saveAudioBuffer, ttsConfigHint } from "../src/tts.ts";

test("loadTtsConfig：无 key 返回 null", () => {
	assert.equal(loadTtsConfig({}), null);
	assert.ok(ttsConfigHint().includes("LIYUAN_TTS"));
});

test("loadTtsConfig：OPENAI_API_KEY 可用", () => {
	const c = loadTtsConfig({ OPENAI_API_KEY: "sk-test" });
	assert.ok(c);
	assert.equal(c!.apiKey, "sk-test");
	assert.ok(c!.baseUrl.includes("openai.com") || c!.baseUrl.endsWith("/v1"));
});

test("saveAudioBuffer：写�?\.liyuan-audio 并返�?/audio/ 路径", () => {
	const dir = mkdtempSync(join(tmpdir(), "liyuan-tts-"));
	try {
		const r = saveAudioBuffer(dir, Buffer.from("fake-mp3-bytes"), ".mp3");
		assert.ok(r.src.startsWith("/audio/"));
		assert.ok(r.fileName.endsWith(".mp3"));
		assert.equal(r.bytes, "fake-mp3-bytes".length);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
