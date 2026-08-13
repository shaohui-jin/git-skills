/**
 * 把 MCP server 和 @git-insight/core 打成单文件，让这个包能独立发到 npm。
 *
 * core 是 workspace 包、没发过 npm，不内联的话装到的就是个解析不了依赖的壳。
 * 反过来 @modelcontextprotocol/server 和 zod 是公开包，保持外部依赖，
 * 让 npm 正常做去重和安全更新。
 *
 * 入口的 hashbang 由 esbuild 原样保留在输出最前面，bin 仍可直接执行。
 */
import * as esbuild from "esbuild";
import { readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, "..");
const distDir = resolve(pkgRoot, "dist");

const pkg = JSON.parse(await readFile(resolve(pkgRoot, "package.json"), "utf8"));

await rm(distDir, { recursive: true, force: true });

await esbuild.build({
  entryPoints: [resolve(pkgRoot, "src/index.ts")],
  outfile: resolve(distDir, "index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external: Object.keys(pkg.dependencies ?? {}),
  // 握手里报的版本号得跟包版本一致，别靠人手动同步
  define: { __MCP_VERSION__: JSON.stringify(pkg.version) },
  sourcemap: true,
  logLevel: "info",
});

console.log(`[git-insight-mcp] bundled dist/index.js v${pkg.version}（core 已内联）`);
