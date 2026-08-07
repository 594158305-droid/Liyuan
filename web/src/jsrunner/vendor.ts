/**
 * JS Runner 脚本 iframe 的第三方 vendor 源码（M3a）。
 *
 * 用 vite `?raw` 把 dist 文件内容内联成字符串，由 frame.ts 注入 srcdoc <script>，
 * 让脚本 iframe 拥有全局 `$`/`jQuery`（jquery）与 `jsyaml`（js-yaml，随后别名 `YAML`）。
 * 不装 @types：这里只取源码字符串，不按模块类型使用。
 *
 * 注：jquery.min.js 与 js-yaml.min.js 的 dist 均不含字面 `</script>`（装后已核对，
 * 见 npm install 后 grep）；即使未来上游引入，frame.ts 的 escapeInlineScript 也会做
 * `</script` 转义兜底。
 *
 * 导入路径用 vendor-files/ 相对副本而非包子路径：jquery@4 的 package exports
 * 未暴露 `./dist/jquery.min.js`，vite 解析会报 Missing specifier；副本由
 * node_modules 复制而来（npm install 后若版本升级需同步更新副本）。
 */
import jquerySrc from "./vendor-files/jquery.min.js?raw";
import yamlSrc from "./vendor-files/js-yaml.min.js?raw";

export const vendorScripts = { jquerySrc, yamlSrc };
