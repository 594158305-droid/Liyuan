import { DrawError } from "./errors.ts";

/** SD WebUI 生图（预留：本期仅完成配置结构，请求未实现） */
export async function generateSdImage(..._args: unknown[]): Promise<never> {
	throw new DrawError("unknown", "SD WebUI 尚未实现（预留）");
}
