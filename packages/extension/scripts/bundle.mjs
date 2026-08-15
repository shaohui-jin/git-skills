import * as esbuild from "esbuild";
import { readFile, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const dist = resolve(root, "dist");
const coreSrc = resolve(root, "../core/src");

try {
  for (const name of await readdir(dist)) {
    if (name !== "webview") {
      await rm(join(dist, name), { recursive: true, force: true });
    }
  }
} catch {
  // dist 尚未创建
}

const uiServerStub = `
export const GIT_INSIGHT_UI_PORT = 17341;
export function startUiServer() { throw new Error("uiServer unavailable in extension"); }
export function stopUiServer() {}
export async function resolveWebviewRoot() { throw new Error("uiServer unavailable in extension"); }
export function defaultMcpWebviewRoot() { throw new Error("uiServer unavailable in extension"); }
`;

const stubPlugin = {
  name: "no-ui-server",
  setup(build) {
    build.onResolve({ filter: /[/\\]ui[/\\]uiServer\.js$/ }, (args) => ({
      path: args.path,
      namespace: "ui-server-stub",
    }));
    build.onResolve({ filter: /^@git-insight\/core\/ui\/server$/ }, () => ({
      path: "ui-server-stub",
      namespace: "ui-server-stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "ui-server-stub" }, () => ({
      contents: uiServerStub,
      loader: "js",
    }));
  },
};

await esbuild.build({
  entryPoints: [resolve(root, "src/extension.ts")],
  outfile: resolve(dist, "extension.js"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  external: ["vscode"],
  sourcemap: true,
  logLevel: "warning",
  plugins: [stubPlugin],
});

await esbuild.build({
  entryPoints: [resolve(coreSrc, "cli.ts")],
  outfile: resolve(dist, "cli.js"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  sourcemap: true,
  logLevel: "warning",
});

const ext = await readFile(resolve(dist, "extension.js"), "utf8");
if (/require\(["']ws["']\)|from ["']ws["']/.test(ext)) {
  console.error("extension.js 不能引用 ws（VSIX 无 node_modules）");
  process.exit(1);
}

console.log("bundled dist/extension.js + dist/cli.js");
