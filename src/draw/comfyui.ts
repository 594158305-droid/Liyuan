import { DrawError } from "./errors.ts";

/** ComfyUI 生图（预留：本期仅完成配置结构，请求未实现） */
export async function generateComfyImage(..._args: unknown[]): Promise<never> {
	throw new DrawError("unknown", "ComfyUI 尚未实现（预留）");
}
