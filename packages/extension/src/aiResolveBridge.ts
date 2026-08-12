import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import type { AiBatchMeta } from "./aiResolveBatch.js";
import type { AiResolveRequestPayload } from "./aiResolveTypes.js";
import {
  buildAiSystemPrompt,
  buildAiUserPrompt,
  extractAiJson,
  normalizeAiResults,
} from "./aiResolvePrompt.js";
import type { AiResolveResponsePayload } from "./aiResolveTypes.js";

export interface AiBridgeSession {
  port: number;
  callbackUrl: string;
  prompt: string;
  promptFile: string;
  /** 冲突数据 JSON（提示词内仅引用路径，避免粘贴超长） */
  conflictsFile: string;
  /** Agent 可直接写这个文件回传，不必跑终端 */
  resultFile: string;
  waitResult: Promise<string>;
  cancel: (reason?: string) => void;
  close: () => void;
}

/** 用户主动取消：分批循环遇到它要中断整轮，而不是降级继续 */
export class AiBridgeCancelledError extends Error {
  constructor(message = "已取消 AI 选边等待") {
    super(message);
    this.name = "AiBridgeCancelledError";
  }
}

async function safeRmDir(dir: string | undefined): Promise<void> {
  if (!dir) {
    return;
  }
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    // ignore missing / busy
  }
}

/**
 * 回传口只认带 secret 的路径：本机其它进程、以及浏览器里的网页（会扫本地端口）
 * 都不该能投喂选边结果。
 */
function isLocalHost(header: string | undefined): boolean {
  if (!header) {
    return false;
  }
  const host = header.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

const RESULT_FILE_RE = /^result.*\.json$/i;
const RESULT_POLL_MS = 800;

/**
 * 文件回传通道：Agent 写文件比跑终端可靠得多（不受 shell 语法、引号、中文编码影响）。
 * fs.watch 在 Windows 上对「写临时文件再 rename」这类原子写会漏事件，故并上一层轮询；
 * 读到半截时 extractAiJson 会抛，直接等下一次轮询重读即可。
 */
function watchResultFile(dir: string, onText: (text: string) => void): () => void {
  let stopped = false;
  let busy = false;

  const tryConsume = async (): Promise<void> => {
    if (stopped || busy) {
      return;
    }
    busy = true;
    try {
      const hit = (await readdir(dir)).find((name) => RESULT_FILE_RE.test(name));
      if (!hit) {
        return;
      }
      const text = await readFile(join(dir, hit), "utf8");
      extractAiJson(text);
      stopped = true;
      onText(text);
    } catch {
      // 目录已清理 / 文件写了一半 / JSON 不完整：等下一轮
    } finally {
      busy = false;
    }
  };

  const timer = setInterval(() => void tryConsume(), RESULT_POLL_MS);
  let watcher: FSWatcher | null = null;
  try {
    watcher = watch(dir, () => void tryConsume());
    // 目录被清掉时 Windows 会发 error；没人接管的 error 事件会直接抛穿扩展宿主
    watcher.on("error", () => undefined);
  } catch {
    // 平台不支持目录监听时只靠轮询
  }

  return () => {
    stopped = true;
    clearInterval(timer);
    watcher?.close();
  };
}

let active: {
  server: Server;
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  settled: boolean;
} | null = null;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  const raw = JSON.stringify(body);
  // 不发 CORS 头：调用方是 curl / Agent，浏览器页面不该能读写这个口
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(raw);
}

function settleOk(text: string): void {
  if (!active || active.settled) {
    return;
  }
  active.settled = true;
  active.resolve(text);
}

function settleErr(err: Error): void {
  if (!active || active.settled) {
    return;
  }
  active.settled = true;
  active.reject(err);
}

export function cancelAiBridge(reason = "已取消 AI 选边等待"): void {
  settleErr(new AiBridgeCancelledError(reason));
  closeAiBridgeServer();
}

function closeAiBridgeServer(): void {
  if (!active) {
    return;
  }
  try {
    active.server.close();
  } catch {
    // ignore
  }
  active = null;
}

export type AiBridgeEndpoints = {
  callbackUrl: string;
  healthUrl: string;
  resultFile: string;
};

const RESULT_JSON_SHAPE =
  '{"hunks":[{"id":"path::h-N","path":"…","choice":"ours|theirs|merge|pending","mergedContent":"可选","reason":"简短中文"}]}';

/**
 * Windows 上 Agent 跑的是 PowerShell：curl 是 Invoke-WebRequest 的别名，
 * heredoc 也不存在，给 bash 语法等于让它先撞一次墙再自己摸索。
 */
function httpFallbackLines(callbackUrl: string): string[] {
  if (process.platform === "win32") {
    return [
      "```powershell",
      `# PowerShell 里 curl 是 Invoke-WebRequest 的别名，不要直接用 curl；非要用请写 curl.exe`,
      `$json = @'`,
      RESULT_JSON_SHAPE,
      `'@`,
      `Invoke-RestMethod -Uri "${callbackUrl}" -Method Post -ContentType "application/json; charset=utf-8" -Body ([System.Text.Encoding]::UTF8.GetBytes($json))`,
      "```",
    ];
  }
  return [
    "```bash",
    `curl -s -X POST "${callbackUrl}" -H "Content-Type: application/json" -d @- <<'EOF'`,
    RESULT_JSON_SHAPE,
    `EOF`,
    "```",
  ];
}

export function buildCursorChatPrompt(
  req: AiResolveRequestPayload,
  endpoints: AiBridgeEndpoints,
  conflictsFile: string,
  batch?: AiBatchMeta,
): string {
  const allowMerge = req.rules.includes("mergeWhenPossible");
  const system = buildAiSystemPrompt(req.rules, allowMerge);
  const hunkCount = req.hunks.length;
  const batchLine =
    batch && batch.batchTotal > 1
      ? `本请求为自动分批第 ${batch.batchIndex}/${batch.batchTotal} 批（只裁决本文件内 hunk，不要臆造其它批）。`
      : "";
  return [
    `# Git Insight · 合并冲突 AI 选边`,
    ``,
    `请根据规章制度与冲突数据文件，给出每个冲突块的裁决。`,
    batchLine,
    ``,
    `## 规章与角色`,
    system,
    ``,
    `## 冲突数据文件（必须先读取）`,
    `请用 Read 工具读取下列 JSON 文件（本批共 ${hunkCount} 个 hunk；不要凭猜测或摘要臆造）：`,
    `\`${conflictsFile}\``,
    ``,
    `文件字段：into_online / from_mine / rules / extraNotes / hunks[]`,
    `（每项含 id, path, left_online, right_mine, base, oursCommits, theirsCommits）。`,
    `必须覆盖本文件中每一个 hunk；id 与 path 原样返回（id 形如 path::h-N，跨文件唯一）。`,
    ``,
    `## 完成后如何回传（两条通道，走通一条即可）`,
    ``,
    `没有走通任何一条就等于没有交付。若环境配置了 MCP feedback 等旁路确认工具，`,
    `确认完之后仍必须回来走方式 A，停在 feedback 扩展是收不到结果的。`,
    ``,
    `### 方式 A（首选，不需要终端）`,
    `用 Write 工具把最终 JSON 原样写入这个文件：`,
    ``,
    `\`${endpoints.resultFile}\``,
    ``,
    `扩展正在监听该文件，写完即视为交付，之后不要再执行方式 B。`,
    `内容形如（必须覆盖每一个输入 hunk）：`,
    ``,
    "```json",
    RESULT_JSON_SHAPE,
    "```",
    ``,
    `### 方式 B（确实无法写文件时才用）`,
    `先探活，拿到 {"ok":true} 再继续，探不通就说明端口已关，别反复重试：`,
    `\`${endpoints.healthUrl}\``,
    ``,
    ...httpFallbackLines(endpoints.callbackUrl),
    ``,
    `两条都走不通就直接在回复里说明原因并把 JSON 贴在回复里，不要空转。`,
  ].join("\n");
}

export type OpenChatResult = {
  tried: string[];
  opened: boolean;
  pasted: boolean;
  submitted: boolean;
};

/**
 * Cursor 无官方「带 prompt 打开 Chat」API。
 * 社区可用方案：clipboard → composer.newAgentChat → paste（可选再 submit）。
 */
export async function tryOpenCursorChat(
  promptAlreadyInClipboard: boolean,
): Promise<OpenChatResult> {
  const tried: string[] = [];
  let opened = false;
  let pasted = false;
  let submitted = false;

  // Cursor 优先；再尝试通用 Chat
  const openCandidates = [
    "composer.newAgentChat",
    "composer.focusComposer",
    "cursor.startComposerPrompt",
    "workbench.action.chat.open",
    "aichat.newchataction",
  ];

  for (const id of openCandidates) {
    tried.push(id);
    try {
      await vscode.commands.executeCommand(id);
      opened = true;
      break;
    } catch {
      // try next
    }
  }

  if (!opened || !promptAlreadyInClipboard) {
    return { tried, opened, pasted, submitted };
  }

  // 等 Chat 输入框就绪
  await new Promise<void>((r) => setTimeout(r, 280));

  try {
    await vscode.commands.executeCommand("editor.action.clipboardPasteAction");
    pasted = true;
    tried.push("editor.action.clipboardPasteAction");
  } catch {
    // paste failed — UI 仍可手动 Ctrl+V
  }

  if (pasted) {
    await new Promise<void>((r) => setTimeout(r, 120));
    for (const id of ["composer.startGeneration", "workbench.action.chat.submit"]) {
      tried.push(id);
      try {
        await vscode.commands.executeCommand(id);
        submitted = true;
        break;
      } catch {
        // optional
      }
    }
  }

  return { tried, opened, pasted, submitted };
}

export async function startAiResolveBridge(
  req: AiResolveRequestPayload,
  timeoutMs = 20 * 60 * 1000,
  batch?: AiBatchMeta,
): Promise<AiBridgeSession> {
  if (active) {
    cancelAiBridge("上一次 AI 选边等待已中断");
  }

  let resolveFn!: (text: string) => void;
  let rejectFn!: (err: Error) => void;
  const waitResult = new Promise<string>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });

  const secret = randomBytes(24).toString("hex");
  const resultPath = `/result/${secret}`;

  const server = createServer(async (reqIn, res) => {
    if (!isLocalHost(reqIn.headers.host)) {
      sendJson(res, 403, { ok: false, error: "forbidden" });
      return;
    }
    const url = reqIn.url ?? "/";
    if (reqIn.method === "GET" && url === `/health/${secret}`) {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (reqIn.method === "POST" && url === resultPath) {
      try {
        const body = await readBody(reqIn);
        if (!body.trim()) {
          sendJson(res, 400, { ok: false, error: "empty body" });
          return;
        }
        // 校验能解析
        extractAiJson(body);
        sendJson(res, 200, { ok: true, message: "received" });
        settleOk(body);
        // 稍后再关，让 curl 收完响应
        setTimeout(() => closeAiBridgeServer(), 200);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        sendJson(res, 400, { ok: false, error: message });
      }
      return;
    }
    sendJson(res, 404, { ok: false, error: "not found" });
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        resolve(addr.port);
      } else {
        reject(new Error("无法绑定本地端口"));
      }
    });
  });

  const session = {
    server,
    resolve: resolveFn,
    reject: rejectFn,
    settled: false,
  };
  active = session;

  const timer = setTimeout(() => {
    settleErr(new Error(`等待 Chat 回传超时（${Math.round(timeoutMs / 60_000)} 分钟）`));
    closeAiBridgeServer();
  }, timeoutMs);

  const callbackUrl = `http://127.0.0.1:${port}${resultPath}`;
  const healthUrl = `http://127.0.0.1:${port}/health/${secret}`;
  const batchTag =
    batch && batch.batchTotal > 1 ? `-b${batch.batchIndex}of${batch.batchTotal}` : "";
  // 冲突正文是用户源码，用私有临时目录而不是可预测的文件名
  const tempDir = await mkdtemp(join(tmpdir(), "git-insight-ai-"));
  const conflictsFile = join(tempDir, `conflicts${batchTag}.json`);
  const promptFile = join(tempDir, `prompt${batchTag}.md`);
  const resultFile = join(tempDir, `result${batchTag}.json`);
  await writeFile(conflictsFile, buildAiUserPrompt(req), "utf8");
  const prompt = buildCursorChatPrompt(
    req,
    { callbackUrl, healthUrl, resultFile },
    conflictsFile,
    batch,
  );
  await writeFile(promptFile, prompt, "utf8");

  // 结算到捕获的 session 而不是全局 active，避免上一批的迟到文件喂给下一批
  const stopResultWatch = watchResultFile(tempDir, (text) => {
    if (session.settled) {
      return;
    }
    session.settled = true;
    session.resolve(text);
  });

  // 用 then 双分支而非 finally：finally 会派生一个没人接管的 rejected promise
  const dispose = (): void => {
    clearTimeout(timer);
    stopResultWatch();
    void safeRmDir(tempDir);
  };
  void waitResult.then(dispose, dispose);

  return {
    port,
    callbackUrl,
    prompt,
    promptFile,
    conflictsFile,
    resultFile,
    waitResult,
    cancel: (reason) => {
      settleErr(new AiBridgeCancelledError(reason ?? "已取消 AI 选边等待"));
      closeAiBridgeServer();
    },
    close: () => {
      dispose();
      closeAiBridgeServer();
    },
  };
}

export function parseBridgeResult(
  text: string,
  req: AiResolveRequestPayload,
): AiResolveResponsePayload {
  const allowMerge = req.rules.includes("mergeWhenPossible");
  const parsed = extractAiJson(text);
  const hunks = normalizeAiResults(parsed, req.hunks, allowMerge);
  return {
    hunks,
    model: "cursor-chat-bridge",
    messages: ["经 Cursor Chat 回传（结果文件 / 本地端口）"],
  };
}
