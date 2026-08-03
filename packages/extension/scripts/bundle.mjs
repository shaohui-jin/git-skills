/**
 * 将扩展宿主 + @git-insight/core 打成单文件，便于 .vsix 分发（无需 workspace 依赖）。
 */
import * as esbuild from "esbuild";
import { readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const extensionRoot = resolve(__dirname, "..");
const distDir = resolve(extensionRoot, "dist");

/** 清掉宿主侧旧产物，保留 webview 构建结果 */
async function cleanHostArtifacts() {
  let entries = [];
  try {
    entries = await readdir(distDir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === "webview") {
      continue;
    }
    await rm(join(distDir, name), { recursive: true, force: true });
  }
}

await cleanHostArtifacts();

await esbuild.build({
  entryPoints: [resolve(extensionRoot, "src/extension.ts")],
  outfile: resolve(distDir, "extension.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external: ["vscode"],
  sourcemap: true,
  logLevel: "info",
});

/** Skill / Agent 在任意仓库可调用的 CLI（core 打进单文件） */
await esbuild.build({
  entryPoints: [resolve(extensionRoot, "../core/src/cli.ts")],
  outfile: resolve(distDir, "cli.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  banner: {
    js: "import { createRequire as __giCreateRequire } from 'module'; const require = __giCreateRequire(import.meta.url);",
  },
  sourcemap: true,
  logLevel: "info",
});

console.log("[git-insight] bundled dist/extension.js + dist/cli.js (core inlined)");
