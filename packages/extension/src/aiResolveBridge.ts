import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { unlink, writeFile } from "node:fs/promises";
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
  waitResult: Promise<string>;
  cancel: (reason?: string) => void;
  submitText: (text: string) => void;
  close: () => void;
}

async function safeUnlink(path: string | undefined): Promise<void> {
  if (!path) {
    return;
  }
  try {
    await unlink(path);
  } catch {
    // ignore missing / busy
  }
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
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
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

export function submitAiBridgeText(text: string): boolean {
  if (!active || active.settled) {
    return false;
  }
  settleOk(text);
  return true;
}

export function cancelAiBridge(reason = "已取消 AI 选边等待"): void {
  settleErr(new Error(reason));
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

export function buildCursorChatPrompt(
  req: AiResolveRequestPayload,
  callbackUrl: string,
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
    `## 完成后如何回传（二选一）`,
    ``,
    `重要：必须以方式 A 的 HTTP POST 或方式 B 的粘贴把 JSON 交给 Git Insight。`,
    `若环境配置了 MCP feedback / 其它旁路确认工具，不要只停在 feedback；仍须 curl POST 或让用户粘贴，否则扩展收不到结果。`,
    ``,
    `### 方式 A（推荐，Agent / 可跑终端时）`,
    `把最终 JSON 保存后执行（端口勿改）：`,
    ``,
    "```bash",
    `curl -s -X POST "${callbackUrl}" -H "Content-Type: application/json" -d @- <<'EOF'`,
    `{"hunks":[{"id":"path::h-N","path":"…","choice":"ours|theirs|merge|pending","mergedContent":"可选","reason":"简短中文"}]}`,
    `必须覆盖每一个输入 hunk；id/path 原样返回（id 已含 path 前缀，跨文件唯一）。`,
    `EOF`,
    "```",
    ``,
    `也可先把完整 JSON 写入临时文件再：`,
    `curl -s -X POST "${callbackUrl}" -H "Content-Type: application/json" --data-binary @result.json`,
    ``,
    `### 方式 B（普通 Chat / MCP feedback 兜底）`,
    `只输出一个 JSON 对象（不要其它废话）。然后回到 Git Insight 弹层，点「粘贴结果并应用」贴进去。`,
    ``,
    `回传地址：\`${callbackUrl}\``,
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
  timeoutMs = 5 * 60 * 1000,
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

  const server = createServer(async (reqIn, res) => {
    if (reqIn.method === "OPTIONS") {
      sendJson(res, 204, {});
      return;
    }
    const url = reqIn.url ?? "/";
    if (reqIn.method === "GET" && (url === "/" || url === "/health")) {
      sendJson(res, 200, { ok: true, service: "git-insight-ai-bridge" });
      return;
    }
    if (reqIn.method === "POST" && (url === "/result" || url === "/")) {
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

  active = {
    server,
    resolve: resolveFn,
    reject: rejectFn,
    settled: false,
  };

  const timer = setTimeout(() => {
    settleErr(new Error(`等待 Chat 回传超时（${Math.round(timeoutMs / 1000)}s）`));
    closeAiBridgeServer();
  }, timeoutMs);

  void waitResult.finally(() => clearTimeout(timer));

  const callbackUrl = `http://127.0.0.1:${port}/result`;
  const batchTag =
    batch && batch.batchTotal > 1 ? `-b${batch.batchIndex}of${batch.batchTotal}` : "";
  const conflictsFile = join(
    tmpdir(),
    `git-insight-ai-conflicts-${port}${batchTag}.json`,
  );
  const promptFile = join(tmpdir(), `git-insight-ai-prompt-${port}${batchTag}.md`);
  await writeFile(conflictsFile, buildAiUserPrompt(req), "utf8");
  const prompt = buildCursorChatPrompt(req, callbackUrl, conflictsFile, batch);
  await writeFile(promptFile, prompt, "utf8");

  const cleanupTempFiles = (): void => {
    void safeUnlink(conflictsFile);
    void safeUnlink(promptFile);
  };
  void waitResult.finally(cleanupTempFiles);

  return {
    port,
    callbackUrl,
    prompt,
    promptFile,
    conflictsFile,
    waitResult,
    cancel: (reason) => {
      settleErr(new Error(reason ?? "已取消"));
      cleanupTempFiles();
      closeAiBridgeServer();
    },
    submitText: (text) => {
      settleOk(text);
      setTimeout(() => closeAiBridgeServer(), 50);
    },
    close: () => {
      cleanupTempFiles();
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
    messages: ["经 Cursor Chat / 本地端口回传"],
  };
}
