/**
 * MCP 浏览器 UI：bundled 时内联 extension coreBridge，npx 装完即可开面板。
 */
import { homedir } from "node:os";
import { join } from "node:path";
import {
  defaultMcpWebviewRoot,
  startUiServer,
} from "@git-insight/core/ui/server";
import { GIT_INSIGHT_UI_PORT } from "@git-insight/core";
import {
  busyLabelForRequest,
  handleWebviewRequest,
  requestStreamsProgress,
  resolveWorkspaceCwd,
} from "../../extension/src/coreBridge.js";
import type { ConfigMemento } from "../../extension/src/gitConfigStore.js";
import { isRemoteOnlyMode, looksLikeRemoteRepo } from "../../extension/src/remoteRepo.js";
import type { WebviewRequest } from "../../extension/src/protocol.js";

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

const MCP_CLI_STORAGE = join(homedir(), ".git-insight", "mcp-cli");

async function beforePreviewRequest(
  req: unknown,
  _cwd: string | null,
): Promise<{ messages: unknown[]; cwd?: string | null } | null> {
  if (!req || typeof req !== "object" || !("type" in req)) {
    return null;
  }
  const typed = req as WebviewRequest;

  if (typed.type === "pickFolder") {
    return {
      messages: [
        {
          type: "error",
          message: isRemoteOnlyMode()
            ? "云端预览请输入 GitHub 仓库地址（owner/repo），不支持本机选目录"
            : "浏览器面板请输入路径或 GitHub 地址，不支持系统目录对话框",
          code: "UNSUPPORTED",
        },
      ],
    };
  }

  if (typed.type === "ping") {
    return {
      messages: [
        {
          type: "pong",
          nonce: typed.nonce,
          extensionVersion: "mcp-browser",
        },
      ],
    };
  }

  if (typed.type === "aiResolveConflicts") {
    return {
      messages: [
        {
          type: "error",
          message: "浏览器面板不支持 AI 选边，请在 Cursor 扩展中使用",
          code: "PREVIEW_READONLY",
        },
      ],
    };
  }

  return null;
}

function busyLabel(req: unknown): string | undefined {
  if (!req || typeof req !== "object" || !("type" in req)) {
    return undefined;
  }
  const typed = req as WebviewRequest;
  if (typed.type === "setCwd" && looksLikeRemoteRepo(typed.path)) {
    return "正在 git clone / fetch…";
  }
  return busyLabelForRequest(typed);
}

export async function ensureMcpBrowserServer(): Promise<{ baseUrl: string }> {
  const webRoot = defaultMcpWebviewRoot(import.meta.url);
  const initialRaw =
    process.env.GIT_INSIGHT_MCP_CWD?.trim() || process.cwd();
  let initialCwd: string | null = null;
  if (!isRemoteOnlyMode()) {
    initialCwd = await resolveWorkspaceCwd(initialRaw);
  }

  const handle = await startUiServer({
    webRoot,
    port: GIT_INSIGHT_UI_PORT,
    host: "127.0.0.1",
    initialCwd,
    busyLabel,
    onBeforeRequest: beforePreviewRequest,
    onRequest: async (req, cwd, helpers) => {
      const typed = req as WebviewRequest;
      const onProgress = requestStreamsProgress(typed)
        ? async (update: { percent: number; label: string }) => {
            helpers.sendProgress(update);
            await new Promise<void>((r) => setImmediate(r));
          }
        : undefined;

      return handleWebviewRequest(typed, cwd, {
        previewMode: false,
        configMemento: previewConfigMemento,
        cliStorageDir: MCP_CLI_STORAGE,
        onProgress,
      });
    },
    onLog: (line) => {
      console.error(`[git-insight-ui] ${line}`);
    },
  });

  return { baseUrl: handle.url };
}
