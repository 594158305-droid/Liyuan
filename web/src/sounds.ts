/**
 * 完成音效与提醒：主聊天完成 / 助手完成 / 出现 ask / LLM 主动播放（play_sound 工具）。
 * 设置存 localStorage（liyuan.sound.settings，本机偏好），播放时惰性读取 → 改动即时生效。
 * 用 Web Audio API 程序化合成短提示音（无需素材文件）；浏览器 autoplay 策略下
 * 无用户手势时可能被拒，一律静默容错，不抛错。
 */

export type SoundKind = "main" | "assistant" | "ask";

export type SoundSettings = {
	/** 总开关 */
	enabled: boolean;
	/** 主聊天回答完成 */
	mainChat: boolean;
	/** 助手回答完成 */
	assistant: boolean;
	/** 出现 ask（需要你定夺） */
	ask: boolean;
	/** LLM 主动播放（play_sound 工具） */
	agent: boolean;
	/** 仅窗口不可见时提醒 */
	backgroundOnly: boolean;
};

const KEY = "liyuan.sound.settings";

export const SOUND_DEFAULTS: SoundSettings = {
	enabled: true,
	mainChat: true,
	assistant: true,
	ask: true,
	agent: true,
	backgroundOnly: false,
};

const bool = (v: unknown, dflt: boolean) => (typeof v === "boolean" ? v : dflt);

export function readSoundSettings(): SoundSettings {
	try {
		const raw = JSON.parse(localStorage.getItem(KEY) ?? "") as Record<string, unknown>;
		if (raw && typeof raw === "object") {
			return {
				enabled: bool(raw.enabled, SOUND_DEFAULTS.enabled),
				mainChat: bool(raw.mainChat, SOUND_DEFAULTS.mainChat),
				assistant: bool(raw.assistant, SOUND_DEFAULTS.assistant),
				ask: bool(raw.ask, SOUND_DEFAULTS.ask),
				agent: bool(raw.agent, SOUND_DEFAULTS.agent),
				backgroundOnly: bool(raw.backgroundOnly, SOUND_DEFAULTS.backgroundOnly),
			};
		}
	} catch {
		/* localStorage 不可用或未设置 */
	}
	return { ...SOUND_DEFAULTS };
}

export function saveSoundSettings(s: SoundSettings): void {
	try {
		localStorage.setItem(KEY, JSON.stringify(s));
	} catch {
		/* 忽略写入失败 */
	}
}

let audioCtx: AudioContext | null = null;

/** 懒创建 AudioContext（首次播放才建）；被浏览器挂起时尝试 resume，失败返回 null */
function getCtx(): AudioContext | null {
	try {
		if (!audioCtx) audioCtx = new AudioContext();
		if (audioCtx.state === "suspended") void audioCtx.resume();
		return audioCtx;
	} catch {
		return null;
	}
}

/** 门控：场景开关通过 + 后台规则满足时返回可用 AudioContext，否则 null */
function gatedCtx(sceneOn: boolean): AudioContext | null {
	const s = readSoundSettings();
	if (!s.enabled || !sceneOn) return null;
	if (s.backgroundOnly && !document.hidden) return null;
	return getCtx();
}

/** 播一个短音：快速起音 + 指数衰减的包络，避免爆音 */
function tone(ctx: AudioContext, freq: number, start: number, dur: number, vol = 0.22): void {
	const osc = ctx.createOscillator();
	const gain = ctx.createGain();
	osc.type = "sine";
	osc.frequency.value = freq;
	const t0 = ctx.currentTime + start;
	gain.gain.setValueAtTime(0.0001, t0);
	gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.02);
	gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
	osc.connect(gain);
	gain.connect(ctx.destination);
	osc.start(t0);
	osc.stop(t0 + dur + 0.05);
}

/**
 * 播放场景提示音。按设置过滤：总开关 / 场景开关 / 「仅后台」时页面可见。
 * 三种音互相区分：主聊天=上行双音，助手=下行双音，ask=急促三连音。
 */
export function playChime(kind: SoundKind): void {
	const s = readSoundSettings();
	const sceneOn = kind === "main" ? s.mainChat : kind === "assistant" ? s.assistant : s.ask;
	const ctx = gatedCtx(sceneOn);
	if (!ctx) return;
	try {
		if (kind === "main") {
			// 上行双音（C5 → G5）：主聊天回答完成
			tone(ctx, 523.25, 0, 0.14);
			tone(ctx, 783.99, 0.12, 0.18);
		} else if (kind === "assistant") {
			// 下行双音（G5 → C5）：助手回答完成
			tone(ctx, 783.99, 0, 0.14);
			tone(ctx, 523.25, 0.12, 0.18);
		} else {
			// 急促三连音（A5）：需要你定夺
			tone(ctx, 880, 0, 0.1);
			tone(ctx, 880, 0.12, 0.1);
			tone(ctx, 880, 0.24, 0.16);
		}
	} catch {
		/* 静默容错 */
	}
}

/** 预定义音效库（play_sound 工具）：名字 → 旋律片段 [频率, 起始偏移秒, 时长秒] */
const FX_MELODIES: Record<string, Array<[number, number, number]>> = {
	notice: [[659.25, 0, 0.18]], // E5 单音——一般提醒
	complete: [
		[523.25, 0, 0.14],
		[783.99, 0.12, 0.18], // C5→G5 上行——完成
	],
	alert: [
		[880, 0, 0.1],
		[880, 0.12, 0.1],
		[880, 0.24, 0.16], // A5 急促三连——警报
	],
	positive: [
		[523.25, 0, 0.12],
		[659.25, 0.1, 0.12],
		[783.99, 0.2, 0.2], // C5→E5→G5 上行三音——好消息
	],
	negative: [
		[783.99, 0, 0.14],
		[523.25, 0.12, 0.18], // G5→C5 下行——坏消息
	],
};

/**
 * 播放 LLM 主动请求的音效（play_sound 工具）。未知音效名忽略（服务端白名单外不会到）；
 * 音量 0~1 线性作用于增益，缺省 0.6。设置过滤同 playChime（总开关 + agent 场景 + 仅后台）。
 */
export function playFx(name: string, volume?: number): void {
	const melody = FX_MELODIES[name];
	if (!melody) return;
	const ctx = gatedCtx(readSoundSettings().agent);
	if (!ctx) return;
	const vol = Math.min(1, Math.max(0, typeof volume === "number" && Number.isFinite(volume) ? volume : 0.6));
	try {
		for (const [freq, start, dur] of melody) tone(ctx, freq, start, dur, 0.3 * vol);
	} catch {
		/* 静默容错 */
	}
}
