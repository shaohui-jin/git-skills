/**
 * 生产预览服务：静态 Webview + WebSocket，真实系统 git（clone/fetch/merge-tree）。
 *
 *   pnpm --filter git-insight preview:prod
 *   GIT_INSIGHT_MODE=remote HOST=0.0.0.0 PORT=8080 pnpm preview:prod
 *
 * 云端只开 GitHub 仓库时设置 GIT_INSIGHT_MODE=remote。
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { WebSocketServer } from "ws";
import {
  handleWebviewRequest,
  resolveWorkspaceCwd,
} from "../src/coreBridge.js";
import { isRemoteOnlyMode, looksLikeRemoteRepo } from "../src/remoteRepo.js";
import type { WebviewRequest } from "../src/protocol.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const extensionRoot = resolve(__dirname, "..");
const webRoot = resolve(extensionRoot, "dist/webview");

const cliArgs = process.argv.slice(2).filter((arg) => arg !== "--");
const { values } = parseArgs({
  args: cliArgs,
  options: {
    cwd: { type: "string" },
    port: { type: "string" },
    host: { type: "string" },
  },
  allowPositionals: true,
});

const port = Number(values.port ?? process.env.PORT ?? 8080);
const host = values.host ?? process.env.HOST ?? "0.0.0.0";
const initialRequested =
  values.cwd ?? process.env.GIT_INSIGHT_CWD ?? undefined;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".map": "application/json",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function safeJoin(root: string, reqPath: string): string | null {
  const decoded = decodeURIComponent(reqPath.split("?")[0] || "/");
  const rel = decoded === "/" ? "index.html" : decoded.replace(/^\//, "");
  const full = normalize(join(root, rel));
  if (!full.startsWith(root + sep) && full !== root) {
    return null;
  }
  return full;
}

async function main(): Promise<void> {
  let repoCwd: string | null = null;
  if (initialRequested && !isRemoteOnlyMode()) {
    repoCwd = await resolveWorkspaceCwd(initialRequested);
  } else if (initialRequested) {
    const result = await handleWebviewRequest(
      { type: "setCwd", path: initialRequested },
      null,
      { previewMode: true },
    );
    if (result.cwd) {
      repoCwd = result.cwd;
    }
  }

  const server = createServer((req, res) => {
    void (async () => {
      try {
        if (!req.url || req.method !== "GET") {
          res.statusCode = 405;
          res.end("Method Not Allowed");
          return;
        }
        if (req.url.startsWith("/ws")) {
          res.statusCode = 426;
          res.end("Upgrade Required");
          return;
        }
        if (req.url === "/healthz") {
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              ok: true,
              mode: isRemoteOnlyMode() ? "remote" : "local",
              git: true,
            }),
          );
          return;
        }

        let filePath = safeJoin(webRoot, req.url);
        if (!filePath) {
          res.statusCode = 400;
          res.end("Bad path");
          return;
        }
        try {
          const st = await stat(filePath);
          if (st.isDirectory()) {
            filePath = join(filePath, "index.html");
          }
        } catch {
          filePath = join(webRoot, "index.html");
        }
        const body = await readFile(filePath);
        res.statusCode = 200;
        res.setHeader("Content-Type", MIME[extname(filePath)] ?? "application/octet-stream");
        res.end(body);
      } catch (err) {
        res.statusCode = 500;
        res.end(err instanceof Error ? err.message : String(err));
      }
    })();
  });

  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (socket) => {
    const send = (payload: unknown) => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(payload));
      }
    };

    socket.on("message", (raw) => {
      void (async () => {
        let req: WebviewRequest;
        try {
          req = JSON.parse(String(raw)) as WebviewRequest;
        } catch {
          send({ type: "error", message: "无效的请求 JSON", code: "BAD_REQUEST" });
          return;
        }

        if (req.type === "pickFolder") {
          send({
            type: "error",
            message: isRemoteOnlyMode()
              ? "云端预览请输入 GitHub 仓库地址（owner/repo），不支持本机选目录"
              : "生产服务未启用本机目录对话框，请输入路径或 GitHub 地址",
            code: "UNSUPPORTED",
          });
          return;
        }

        const label =
          req.type === "setCwd" && looksLikeRemoteRepo(req.path)
            ? "正在 git clone / fetch…"
            : req.type === "fetch"
              ? "正在 Fetch…"
              : req.type === "graph"
                ? "正在加载全量分支图…"
                : req.type === "preview" || req.type === "blame"
                  ? "合并预演中…"
                  : req.type === "setCwd"
                    ? "正在打开仓库…"
                    : undefined;

        if (label) {
          send({ type: "busy", busy: true, label });
        }
        try {
          const result = await handleWebviewRequest(req, repoCwd, {
            previewMode: true,
          });
          if (result.cwd !== undefined) {
            repoCwd = result.cwd;
            if (repoCwd) {
              console.log(`[git-insight] repo → ${repoCwd}`);
            }
          }
          for (const msg of result.messages) {
            send(msg);
          }
        } catch (err) {
          send({
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        } finally {
          if (label) {
            send({ type: "busy", busy: false });
          }
        }
      })();
    });
  });

  server.listen(port, host, () => {
    console.log(`[git-insight] http://${host}:${port}/  (real git)`);
    console.log(
      `[git-insight] mode=${isRemoteOnlyMode() ? "remote (GitHub URL)" : "local+remote"}`,
    );
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
