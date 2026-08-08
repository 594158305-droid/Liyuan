/**
 * 已迁移到 src/draw/novelai.ts（生图领域层重组）。
 * 本文件保留为兼容垫片，防其他 import 断链；新代码请直接 import src/draw/novelai.ts。
 * resolveAspectSize 已迁往 src/draw/params.ts；错误模型迁往 src/draw/errors.ts，一并在此转发。
 */
export * from "./draw/novelai.ts";
export { resolveAspectSize } from "./draw/params.ts";
export { DrawError, classifyError, parseApiError } from "./draw/errors.ts";
export type { DrawErrorCode } from "./draw/errors.ts";
