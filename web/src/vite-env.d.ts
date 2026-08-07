/// <reference types="vite/client" />

/**
 * Vite 客户端类型引用（jsrunner/vendor.ts 的 `*?raw` 导入声明由 vite/client 自带，
 * 见 node_modules/vite/client.d.ts：`declare module '*?raw' { const src: string; export default src }`）。
 * 本仓库原先没有独立 .d.ts；这里补引用即可，无需重复声明 `*?raw`。
 */
