/**
 * 把 MCP server、@shaohui_jin/git-insight-core 与 extension coreBridge 打成可独立发布的包；
 * 并复制 Webview 静态资源到 dist/webview。
 */
import * as esbuild from "esbuild";
import { cp, access } from "node:fs/promises";
import { readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, "..");
const distDir = resolve(pkgRoot, "dist");
const webviewSrc = resolve(pkgRoot, "../extension/dist/webview");
const webviewDest = resolve(distDir, "webview");

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

try {
  await access(join(webviewSrc, "index.html"));
  await cp(webviewSrc, webviewDest, { recursive: true });
  console.log(`[git-insight-mcp] copied webview → dist/webview`);
} catch {
  console.warn(
    "[git-insight-mcp] 警告：未找到 extension/dist/webview，请先运行 pnpm --filter git-insight build:webview",
  );
}

console.log(`[git-insight-mcp] bundled dist/index.js v${pkg.version}（core + coreBridge 已内联）`);
