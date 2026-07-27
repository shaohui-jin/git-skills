/**
 * Local browser preview — no VS Code/Cursor required.
 *
 * Usage:
 *   pnpm preview
 *   pnpm preview -- --cwd D:\path\to\repo
 *   GIT_INSIGHT_CWD=... pnpm preview
 *
 * 网页内也可「浏览…」选目录，或输入路径打开仓库。
 */
import { createServer } from "node:http";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createServer as createViteServer } from "vite";
import { WebSocketServer } from "ws";
import {
  handleWebviewRequest,
  resolveWorkspaceCwd,
} from "../src/coreBridge.js";
import type { ConfigMemento } from "../src/gitConfigStore.js";
import { pickFolderNative } from "../src/pickFolder.js";
import { looksLikeRemoteRepo } from "../src/remoteRepo.js";
import type { WebviewRequest } from "../src/protocol.js";

function memoryConfigMemento(): ConfigMemento {
  const store = new Map<string, unknown>();
  return {
    get: <T>(key: string) => store.get(key) as T | undefined,
    update: async (key, value) => {
      store.set(key, value);
    },
  };
}

const previewConfigMemento = memoryConfigMemento();

const __dirname = dirname(fileURLToPath(import.meta.url));
const extensionRoot = resolve(__dirname, "..");
const webviewRoot = resolve(extensionRoot, "webview");

const cliArgs = process.argv.slice(2).filter((arg) => arg !== "--");
const { values } = parseArgs({
  args: cliArgs,
  options: {
    cwd: { type: "string" },
    port: { type: "string", default: "5173" },
    host: { type: "string", default: "127.0.0.1" },
  },
  allowPositionals: true,
});

const port = Number(values.port ?? 5173);
const host = values.host ?? "127.0.0.1";
const initialRequested = values.cwd ?? process.env.GIT_INSIGHT_CWD ?? process.cwd();

async function main(): Promise<void> {
  let repoCwd = await resolveWorkspaceCwd(initialRequested);
  if (!repoCwd) {
    console.warn(
      `[git-insight preview] 初始路径不是 Git 仓库：${initialRequested}\n` +
        `  仍会启动页面；可在网页里「浏览…」或输入路径打开仓库。`,
    );
  } else {
    console.log(`[git-insight preview] 初始仓库：${repoCwd}`);
  }

  const vite = await createViteServer({
    root: webviewRoot,
    configFile: resolve(webviewRoot, "vite.config.ts"),
    server: { middlewareMode: true },
    appType: "spa",
    define: {
      __GIT_INSIGHT_PREVIEW__: JSON.stringify(true),
    },
  });

  const server = createServer((req, res) => {
    void vite.middlewares(req, res, () => {
      res.statusCode = 404;
      res.end("Not found");
    });
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
          send({ type: "busy", busy: true, label: "请在系统对话框中选择目录…" });
          try {
            const picked = await pickFolderNative();
            if (!picked) {
              send({ type: "error", message: "已取消选择目录", code: "CANCELLED" });
              return;
            }
            const result = await handleWebviewRequest(
              { type: "setCwd", path: picked },
              repoCwd,
              { previewMode: true, configMemento: previewConfigMemento },
            );
            if (result.cwd !== undefined) {
              repoCwd = result.cwd;
            }
            for (const msg of result.messages) {
              send(msg);
            }
            if (repoCwd) {
              console.log(`[git-insight preview] 切换仓库：${repoCwd}`);
            }
          } finally {
            send({ type: "busy", busy: false });
          }
          return;
        }

        if (req.type === "ping") {
          send({
            type: "pong",
            nonce: req.nonce,
            extensionVersion: "preview",
          });
          return;
        }

        if (req.type === "aiResolveConflicts") {
          send({
            type: "error",
            message: "浏览器预览不支持 AI 选边，请在 Cursor 扩展中使用",
            code: "PREVIEW_READONLY",
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
          send({ type: "busy", busy: true, label, percent: 0 });
        }
        try {
          const result = await handleWebviewRequest(req, repoCwd, {
            previewMode: true,
            configMemento: previewConfigMemento,
            onProgress:
              req.type === "graph" || req.type === "preview" || req.type === "blame"
                ? async (u) => {
                    send({
                      type: "progress",
                      percent: u.percent,
                      label: u.label,
                    });
                    await new Promise<void>((r) => setImmediate(r));
                  }
                : undefined,
          });
          if (result.cwd !== undefined) {
            repoCwd = result.cwd;
            if (repoCwd) {
              console.log(`[git-insight preview] 切换仓库：${repoCwd}`);
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
            send({ type: "busy", busy: false, percent: 100 });
          }
        }
      })();
    });
  });

  server.listen(port, host, () => {
    const url = `http://${host}:${port}/`;
    console.log(`[git-insight preview] 浏览器打开：${url}`);
    console.log(
      `[git-insight preview] 支持：本机路径 / GitHub 地址(owner/repo) / 浏览选目录`,
    );
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
