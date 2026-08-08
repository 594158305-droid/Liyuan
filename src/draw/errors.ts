/**
 * 生图错误模型：错误码枚举 + DrawError + API 状态码映射 + 异常分类。
 * 从 src/novelai.ts 迁入（原样），供生图领域层统一抛错/归类。
 */

export type DrawErrorCode = "auth" | "quota" | "busy" | "network" | "timeout" | "parse" | "unknown";

export class DrawError extends Error {
	code: DrawErrorCode;
	constructor(code: DrawErrorCode, message: string) {
		super(message);
		this.code = code;
	}
}

/** 状态码 → 错误（移植 parseApiError） */
export function parseApiError(status: number, text: string): DrawError {
	switch (status) {
		case 401:
			return new DrawError("auth", "API Key 无效");
		case 402:
			return new DrawError("quota", "Anlas 不足");
		case 429:
			return new DrawError("busy", "当前并发繁忙，请稍后重试");
		case 500:
		case 502:
		case 503:
			return new DrawError("network", "服务不可用");
		default:
			return new DrawError("unknown", `失败: ${text || status}`);
	}
}

/** 分类异常（移植 classifyError + handleFetchError） */
export function classifyError(e: unknown): DrawError {
	if (e instanceof DrawError) return e;
	if (e instanceof Error) {
		const msg = e.message.toLowerCase();
		if (e.name === "AbortError" || msg.includes("timeout") || msg.includes("abort")) return new DrawError("timeout", "请求超时");
		if (
			msg.includes("failed to fetch") ||
			msg.includes("network") ||
			msg.includes("fetch failed") ||
			msg.includes("econnrefused") ||
			msg.includes("econnreset") ||
			msg.includes("etimedout") ||
			msg.includes("eai_again") ||
			msg.includes("getaddrinfo") ||
			msg.includes("proxy")
		) {
			return new DrawError("network", e.message.includes("proxy") ? `代理连接失败：${e.message}` : `网络错误：${e.message}`);
		}
		if (msg.includes("401") || msg.includes("key") || msg.includes("auth")) return new DrawError("auth", "认证失败");
		if (msg.includes("429") || msg.includes("rate limit") || msg.includes("busy")) return new DrawError("busy", "并发繁忙");
		if (msg.includes("402") || msg.includes("anlas") || msg.includes("quota")) return new DrawError("quota", "额度不足");
		return new DrawError("unknown", e.message);
	}
	return new DrawError("unknown", String(e));
}
