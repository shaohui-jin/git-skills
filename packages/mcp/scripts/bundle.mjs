/**
 * 把 MCP server 与 @shaohui_jin/git-insight-core 打成可独立发布的包。
 */
import * as esbuild from "esbuild";
import { readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, "..");
const distDir = resolve(pkgRoot, "dist");

const pkg = JSON.parse(await readFile(resolve(pkgRoot, "package.json"), "utf8"));

await rm(distDir, { recursive: true, force: true });

const external = Object.keys(pkg.dependencies ?? {}).flatMap((dep) => [dep, `${dep}/*`]);

await esbuild.build({
  entryPoints: [resolve(pkgRoot, "src/index.ts")],
  outfile: resolve(distDir, "index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external,
  define: { __MCP_VERSION__: JSON.stringify(pkg.version) },
  sourcemap: true,
  logLevel: "info",
});

console.log(`[git-insight-mcp] bundled dist/index.js v${pkg.version}（core 已内联）`);
