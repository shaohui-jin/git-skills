/**
 * 本地浏览器 UI 服务：静态 Webview + WebSocket，供 MCP / `pnpm preview` 共用。
 *
 * 固定端口单例：同一进程内多次 open_ui 只 listen 一次。
 * 业务逻辑（git 操作）由调用方通过 onRequest 注入，core 不依赖扩展代码。
 */
import { createServer } from "node:http";
import { access, readFile, stat } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { GitError } from "../git/runner.js";
import { GIT_INSIGHT_UI_PORT } from "./constants.js";

export { GIT_INSIGHT_UI_PORT };

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

export interface UiServerOnRequestResult {
  messages: unknown[];
  cwd?: string | null;
}

export interface UiServerRequestHelpers {
  sendProgress: (update: { percent: number; label: string }) => void;
}

export type UiServerOnRequest = (
  req: unknown,
  cwd: string | null,
  helpers: UiServerRequestHelpers,
) => Promise<UiServerOnRequestResult>;

export interface StartUiServerOptions {
  /** Webview 构建产物目录（含 index.html） */
  webRoot: string;
  port?: number;
  host?: string;
  initialCwd?: string | null;
  onRequest: UiServerOnRequest;
  /** 可选：pickFolder / ping / ai 等在进 onRequest 前拦截 */
  onBeforeRequest?: (
    req: unknown,
    cwd: string | null,
  ) => Promise<UiServerOnRequestResult | null | undefined>;
  /** 状态条文案；返回 undefined 则不显示 busy */
  busyLabel?: (req: unknown) => string | undefined;
  onLog?: (line: string) => void;
}

export interface UiServerHandle {
  url: string;
  port: number;
  host: string;
}

let activeServer: Promise<UiServerHandle> | null = null;
let activeKey: string | null = null;
let activeHttpServer: ReturnType<typeof createServer> | null = null;
let activeWss: WebSocketServer | null = null;
let stopPromise: Promise<void> | null = null;

function logLine(onLog: StartUiServerOptions["onLog"], line: string): void {
  onLog?.(line);
}

function safeJoin(root: string, reqPath: string): string | null {
  const decoded = decodeURIComponent(reqPath.split("?")[0] || "/");
  const rel = decoded === "/" ? "index.html" : decoded.replace(/^\//, "");
  const full = normalize(join(root, rel));
  if (!full.startsWith(root + sep) && full !== root) {
    return null;
  }
  return full;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * 按优先级查找 Webview 静态资源目录。
 * 调用方应把最可信的路径放在 candidates 最前（如扩展 dist/webview、MCP dist/webview）。
 */
export async function resolveWebviewRoot(candidates: string[]): Promise<string> {
  for (const raw of candidates) {
    const root = resolve(raw);
    if (await pathExists(join(root, "index.html"))) {
      return root;
    }
  }
  throw new GitError(
    `找不到 Webview 静态资源（需要 index.html）。已尝试：${candidates.join(", ")}`,
    { code: "WEBVIEW_NOT_FOUND" },
  );
}

/** MCP 包内默认布局：dist/index.js 与 dist/webview/ 同级 */
export function defaultMcpWebviewRoot(fromModuleUrl: string): string {
  return join(dirname(fileURLToPath(fromModuleUrl)), "webview");
}

async function listenOnce(options: StartUiServerOptions): Promise<UiServerHandle> {
  const port = options.port ?? GIT_INSIGHT_UI_PORT;
  const host = options.host ?? "127.0.0.1";
  const webRoot = resolve(options.webRoot);

  if (!(await pathExists(join(webRoot, "index.html")))) {
    throw new GitError(`Webview 目录无效：${webRoot}`, { code: "WEBVIEW_NOT_FOUND" });
  }

  let repoCwd: string | null = options.initialCwd ?? null;

  const httpServer = createServer((req, res) => {
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
          res.end(JSON.stringify({ ok: true, git: true }));
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

  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  wss.on("connection", (socket) => {
    const send = (payload: unknown) => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(payload));
      }
    };

    socket.on("message", (raw) => {
      void (async () => {
        let req: unknown;
        try {
          req = JSON.parse(String(raw));
        } catch {
          send({ type: "error", message: "无效的请求 JSON", code: "BAD_REQUEST" });
          return;
        }

        if (!req || typeof req !== "object" || !("type" in req)) {
          send({ type: "error", message: "无效的请求", code: "BAD_REQUEST" });
          return;
        }

        const intercepted = await options.onBeforeRequest?.(req, repoCwd);
        if (intercepted) {
          if (intercepted.cwd !== undefined) {
            repoCwd = intercepted.cwd;
          }
          for (const msg of intercepted.messages) {
            send(msg);
          }
          return;
        }

        const label = options.busyLabel?.(req);
        const showBusy = !!label;

        if (showBusy) {
          send({ type: "busy", busy: true, label, percent: 0 });
        }

        try {
          const helpers: UiServerRequestHelpers = {
            sendProgress: (update) => {
              send({ type: "progress", percent: update.percent, label: update.label });
            },
          };
          const result = await options.onRequest(req, repoCwd, helpers);
          if (result.cwd !== undefined) {
            repoCwd = result.cwd;
            if (repoCwd) {
              logLine(options.onLog, `repo → ${repoCwd}`);
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
          if (showBusy) {
            send({ type: "busy", busy: false, percent: 100 });
          }
        }
      })();
    });
  });

  await new Promise<void>((resolveListen, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => {
      httpServer.off("error", reject);
      resolveListen();
    });
  });

  const url = `http://${host}:${port}/`;
  logLine(options.onLog, `${url} (webview: ${webRoot})`);
  activeHttpServer = httpServer;
  activeWss = wss;
  return { url, port, host };
}

/**
 * 启动或复用 UI 服务。同 host+port+webRoot 的重复调用直接返回已有实例。
 */
export async function startUiServer(options: StartUiServerOptions): Promise<UiServerHandle> {
  const port = options.port ?? GIT_INSIGHT_UI_PORT;
  const host = options.host ?? "127.0.0.1";
  const key = `${host}:${port}:${resolve(options.webRoot)}`;

  if (activeServer && activeKey === key) {
    return activeServer;
  }

  activeKey = key;
  activeServer = listenOnce(options).catch((err) => {
    activeServer = null;
    activeKey = null;
    throw err;
  });
  return activeServer;
}

/**
 * 关闭当前 UI 服务并释放端口。
 * 一般 MCP 进程常驻不必调；测试或需要换端口时调用。
 */
export async function stopUiServer(): Promise<void> {
  if (!activeHttpServer) {
    return;
  }
  // 避免并发 close 重入
  if (stopPromise) {
    return stopPromise;
  }
  const httpServer = activeHttpServer;
  const wss = activeWss;
  activeServer = null;
  activeKey = null;
  activeHttpServer = null;
  activeWss = null;

  stopPromise = (async () => {
    // 先断 WebSocket 连接，再关 HTTP
    await new Promise<void>((resolve) => {
      wss?.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
  })().finally(() => {
    stopPromise = null;
  });
  return stopPromise;
}
