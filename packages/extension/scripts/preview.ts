/**
 * 浏览器预览（不依赖 VS Code/Cursor）
 *
 *   pnpm preview                    # 静态 Webview + uiServer，默认 :8080
 *   pnpm preview -- --dev           # Vite 热更新，默认 :5173
 *   pnpm preview -- --cwd D:\repo
 *   GIT_INSIGHT_MODE=remote pnpm preview
 */
import { createServer } from "node:http";
import { parseArgs } from "node:util";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";
import { WebSocketServer } from "ws";
import { resolveWebviewRoot, startUiServer } from "@shaohui_jin/git-insight-core";
import {
  busyLabelForRequest,
  handleWebviewRequest,
  requestStreamsProgress,
  resolveWorkspaceCwd,
} from "../src/coreBridge.js";
import type { ConfigMemento } from "../src/gitConfigStore.js";
import { pickFolderNative } from "../src/pickFolder.js";
import { isRemoteOnlyMode, looksLikeRemoteRepo } from "../src/remoteRepo.js";
import type { WebviewRequest } from "../src/protocol.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const extensionRoot = resolve(__dirname, "..");
const webviewRoot = resolve(extensionRoot, "webview");

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

const cliArgs = process.argv.slice(2).filter((arg) => arg !== "--");
const { values } = parseArgs({
  args: cliArgs,
  options: {
    dev: { type: "boolean", default: false },
    cwd: { type: "string" },
    port: { type: "string" },
    host: { type: "string" },
  },
  allowPositionals: true,
});

function parseReq(raw: unknown): WebviewRequest | null {
  if (!raw || typeof raw !== "object" || !("type" in raw)) {
    return null;
  }
  return raw as WebviewRequest;
}

function busyLabel(req: unknown): string | undefined {
  const typed = parseReq(req);
  if (!typed) {
    return undefined;
  }
  if (typed.type === "setCwd" && looksLikeRemoteRepo(typed.path)) {
    return "正在 git clone / fetch…";
  }
  return busyLabelForRequest(typed);
}

async function beforeProdRequest(
  req: unknown,
  _cwd: string | null,
): Promise<{ messages: unknown[]; cwd?: string | null } | null> {
  const typed = parseReq(req);
  if (!typed) {
    return null;
  }

  if (typed.type === "pickFolder") {
    return {
      messages: [
        {
          type: "error",
          message: isRemoteOnlyMode()
            ? "云端预览请输入 GitHub 仓库地址（owner/repo），不支持本机选目录"
            : "生产服务未启用本机目录对话框，请输入路径或 GitHub 地址",
          code: "UNSUPPORTED",
        },
      ],
    };
  }

  if (typed.type === "ping") {
    return {
      messages: [{ type: "pong", nonce: typed.nonce, extensionVersion: "preview" }],
    };
  }

  if (typed.type === "aiResolveConflicts") {
    return {
      messages: [
        {
          type: "error",
          message: "浏览器预览不支持 AI 选边，请在 Cursor 扩展中使用",
          code: "PREVIEW_READONLY",
        },
      ],
    };
  }

  return null;
}

async function handlePreviewRequest(
  req: WebviewRequest,
  cwd: string | null,
  previewMode: boolean,
  send: (payload: unknown) => void,
): Promise<string | null> {
  if (req.type === "pickFolder") {
    if (!previewMode) {
      return cwd;
    }
    send({ type: "busy", busy: true, label: "请在系统对话框中选择目录…" });
    try {
      const picked = await pickFolderNative();
      if (!picked) {
        send({ type: "error", message: "已取消选择目录", code: "CANCELLED" });
        return cwd;
      }
      const result = await handleWebviewRequest(
        { type: "setCwd", path: picked },
        cwd,
        { previewMode, configMemento: previewConfigMemento },
      );
      for (const msg of result.messages) {
        send(msg);
      }
      return result.cwd ?? cwd;
    } finally {
      send({ type: "busy", busy: false });
    }
  }

  if (req.type === "ping") {
    send({ type: "pong", nonce: req.nonce, extensionVersion: "preview" });
    return cwd;
  }

  if (req.type === "aiResolveConflicts") {
    send({
      type: "error",
      message: "浏览器预览不支持 AI 选边，请在 Cursor 扩展中使用",
      code: "PREVIEW_READONLY",
    });
    return cwd;
  }

  const label = busyLabel(req);
  if (label) {
    send({ type: "busy", busy: true, label, percent: 0 });
  }
  try {
    const result = await handleWebviewRequest(req, cwd, {
      previewMode,
      configMemento: previewConfigMemento,
      onProgress: requestStreamsProgress(req)
        ? async (u) => {
            send({ type: "progress", percent: u.percent, label: u.label });
            await new Promise<void>((r) => setImmediate(r));
          }
        : undefined,
    });
    for (const msg of result.messages) {
      send(msg);
    }
    return result.cwd ?? cwd;
  } catch (err) {
    send({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
    return cwd;
  } finally {
    if (label) {
      send({ type: "busy", busy: false, percent: 100 });
    }
  }
}

async function runDevPreview(): Promise<void> {
  const port = Number(values.port ?? 5173);
  const host = values.host ?? "127.0.0.1";
  const initialRequested = values.cwd ?? process.env.GIT_INSIGHT_CWD ?? process.cwd();

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
    define: { __GIT_INSIGHT_PREVIEW__: JSON.stringify(true) },
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

        repoCwd = await handlePreviewRequest(req, repoCwd, true, send);
        if (repoCwd) {
          console.log(`[git-insight preview] 当前仓库：${repoCwd}`);
        }
      })();
    });
  });

  server.listen(port, host, () => {
    console.log(`[git-insight preview:dev] ${`http://${host}:${port}/`}`);
  });
}

async function runProdPreview(): Promise<void> {
  const port = Number(values.port ?? process.env.PORT ?? 8080);
  const host = values.host ?? process.env.HOST ?? "0.0.0.0";
  const initialRequested = values.cwd ?? process.env.GIT_INSIGHT_CWD ?? undefined;

  const webRoot = await resolveWebviewRoot([join(extensionRoot, "dist/webview")]);

  let initialCwd: string | null = null;
  if (initialRequested && !isRemoteOnlyMode()) {
    initialCwd = await resolveWorkspaceCwd(initialRequested);
  } else if (initialRequested) {
    const result = await handleWebviewRequest(
      { type: "setCwd", path: initialRequested },
      null,
      { previewMode: false, configMemento: previewConfigMemento },
    );
    initialCwd = result.cwd ?? null;
  }

  await startUiServer({
    webRoot,
    port,
    host,
    initialCwd,
    busyLabel,
    onBeforeRequest: beforeProdRequest,
    onRequest: async (req, cwd, helpers) => {
      const typed = parseReq(req);
      if (!typed) {
        return { messages: [{ type: "error", message: "无效请求", code: "BAD_REQUEST" }] };
      }
      const onProgress = requestStreamsProgress(typed)
        ? async (update: { percent: number; label: string }) => {
            helpers.sendProgress(update);
            await new Promise<void>((r) => setImmediate(r));
          }
        : undefined;

      return handleWebviewRequest(typed, cwd, {
        previewMode: false,
        configMemento: previewConfigMemento,
        onProgress,
      });
    },
    onLog: (line) => console.log(`[git-insight] ${line}`),
  });

  console.log(
    `[git-insight preview] mode=${isRemoteOnlyMode() ? "remote (GitHub URL)" : "local+remote"}`,
  );
}

async function main(): Promise<void> {
  if (values.dev) {
    await runDevPreview();
    return;
  }
  await runProdPreview();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
