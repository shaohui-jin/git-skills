import * as vscode from "vscode";
import {
  parseBridgeResult,
  startAiResolveBridge,
  tryOpenCursorChat,
  type AiBridgeSession,
} from "./aiResolveBridge.js";
import type {
  AiResolveRequestPayload,
  AiResolveResponsePayload,
} from "./aiResolveTypes.js";
import {
  buildAiSystemPrompt,
  buildAiUserPrompt,
  extractAiJson,
  normalizeAiResults,
  runAiResolveWithOpenAiCompat,
  type OpenAiCompatOptions,
} from "./aiResolvePrompt.js";

export type AiBridgeReadyInfo = {
  port: number;
  callbackUrl: string;
  prompt: string;
  promptFile: string;
  openedChat: boolean;
  copied: boolean;
  pasted: boolean;
  submitted: boolean;
};

async function readResponse(
  response: vscode.LanguageModelChatResponse,
  onProgress?: (label: string, percent: number) => void | Promise<void>,
): Promise<string> {
  let text = "";
  let lastPct = 55;
  for await (const part of response.text) {
    text += part;
    const next = Math.min(84, lastPct + 1);
    if (next > lastPct) {
      lastPct = next;
      await onProgress?.(`模型输出中…（已收 ${text.length} 字）`, lastPct);
    }
  }
  return text;
}

async function runWithVscodeLm(
  req: AiResolveRequestPayload,
  onProgress?: (label: string, percent: number) => void | Promise<void>,
): Promise<AiResolveResponsePayload> {
  const lm = (vscode as typeof vscode & { lm?: typeof vscode.lm }).lm;
  if (!lm || typeof lm.selectChatModels !== "function") {
    throw new Error("NO_LM");
  }

  await onProgress?.("选择 vscode.lm 模型…", 8);
  let models: vscode.LanguageModelChat[] = [];
  try {
    models = await Promise.race([
      lm.selectChatModels(),
      new Promise<vscode.LanguageModelChat[]>((_, reject) => {
        setTimeout(() => reject(new Error("选择模型超时")), 8_000);
      }),
    ]);
  } catch {
    throw new Error("NO_LM");
  }
  if (!models.length) {
    throw new Error("NO_LM");
  }

  const model = models[0]!;
  const allowMerge = req.rules.includes("mergeWhenPossible");
  await onProgress?.(`调用 ${model.name}…`, 20);

  const LanguageModelChatMessage = vscode.LanguageModelChatMessage;
  if (!LanguageModelChatMessage?.User) {
    throw new Error("NO_LM");
  }
  const messages = [
    LanguageModelChatMessage.User(
      `${buildAiSystemPrompt(req.rules, allowMerge)}\n\n---\n输入数据：\n${buildAiUserPrompt(req)}`,
    ),
  ];

  const cts = new vscode.CancellationTokenSource();
  const sendTimer = setTimeout(() => cts.cancel(), 120_000);
  try {
    await onProgress?.("等待模型开始响应…", 35);
    const response = await model.sendRequest(messages, {}, cts.token);
    await onProgress?.("模型输出中…", 55);
    const text = await readResponse(response, onProgress);
    await onProgress?.("解析结果…", 85);
    const parsed = extractAiJson(text);
    const hunks = normalizeAiResults(parsed, req.hunks, allowMerge);
    return {
      hunks,
      model: model.name,
      messages: [`vscode.lm：${model.name}`],
    };
  } finally {
    clearTimeout(sendTimer);
    cts.dispose();
  }
}

export interface RunAiResolveOptions {
  openAi?: OpenAiCompatOptions | null;
  onProgress?: (label: string, percent: number) => void | Promise<void>;
  /** Chat 桥就绪时回调（供 UI 展示端口 / 复制提示词） */
  onBridgeReady?: (info: AiBridgeReadyInfo) => void | Promise<void>;
  /** 暴露当前 bridge session，便于宿主处理粘贴/取消 */
  onBridgeSession?: (session: AiBridgeSession | null) => void;
}

/**
 * 1) vscode.lm（若有）
 * 2) 可选 OpenAI 兼容 API（已配置时）
 * 3) Cursor Chat + 本地端口回传（零配置主路径）
 */
export async function runAiResolve(
  req: AiResolveRequestPayload,
  options: RunAiResolveOptions = {},
): Promise<AiResolveResponsePayload> {
  if (!req.hunks.length) {
    throw new Error("没有待解决的冲突块");
  }

  try {
    return await runWithVscodeLm(req, options.onProgress);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg !== "NO_LM") {
      // 有模型但失败：若已配 API 再试；否则走 Chat 桥
      const api = options.openAi;
      const hasApi =
        !!api?.baseUrl?.trim() &&
        !!api?.model?.trim() &&
        (!!api.apiKey?.trim() || /localhost|127\.0\.0\.1/i.test(api.baseUrl));
      if (hasApi) {
        await options.onProgress?.("vscode.lm 失败，改用已配置 API…", 15);
        return runAiResolveWithOpenAiCompat(req, api!, options.onProgress);
      }
    }
  }

  const api = options.openAi;
  const hasApi =
    !!api?.baseUrl?.trim() &&
    !!api?.model?.trim() &&
    (!!api.apiKey?.trim() || /localhost|127\.0\.0\.1/i.test(api.baseUrl ?? ""));
  if (hasApi && (await options.onProgress?.("尝试已配置的 OpenAI 兼容 API…", 12), true)) {
    try {
      return await runAiResolveWithOpenAiCompat(req, api!, options.onProgress);
    } catch {
      // 继续 Chat 桥
    }
  }

  await options.onProgress?.("启动本地回传端口 + Cursor Chat…", 18);
  const session = await startAiResolveBridge(req);
  options.onBridgeSession?.(session);

  let copied = false;
  try {
    await vscode.env.clipboard.writeText(session.prompt);
    copied = true;
  } catch {
    copied = false;
  }

  const chat = await tryOpenCursorChat(copied);
  await options.onBridgeReady?.({
    port: session.port,
    callbackUrl: session.callbackUrl,
    prompt: session.prompt,
    promptFile: session.promptFile,
    openedChat: chat.opened,
    copied,
    pasted: chat.pasted,
    submitted: chat.submitted,
  });

  const stage = chat.submitted
    ? "已打开 Chat 并尝试自动发送"
    : chat.pasted
      ? "已打开 Chat 并粘贴提示词，请确认发送"
      : chat.opened
        ? "已打开 Chat，请 Ctrl+V 粘贴后发送"
        : copied
          ? "请手动打开 Chat，Ctrl+V 粘贴后发送"
          : "请复制提示词后打开 Chat";

  await options.onProgress?.(`${stage}；监听 ${session.callbackUrl} …`, 30);

  try {
    const text = await session.waitResult;
    await options.onProgress?.("已收到回传，解析中…", 85);
    return parseBridgeResult(text, req);
  } finally {
    options.onBridgeSession?.(null);
    session.close();
  }
}

/** @deprecated 使用 runAiResolve */
export const runAiResolveWithLm = runAiResolve;
