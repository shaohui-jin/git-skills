/**
 * 唤起 Git Insight UI：扩展面板和/或本地浏览器面板。
 *
 * CLI `open-ui` 与 MCP `open_ui` 共用；拼 URI / 浏览器 URL 的规则只维护一份。
 */
import { spawn } from "node:child_process";
import { GitError } from "../git/runner.js";
import { GIT_INSIGHT_UI_PORT } from "./constants.js";

export const GIT_INSIGHT_EXTENSION_ID = "jinshaohui.git-insight";

export type OpenUiMode = "auto" | "extension" | "browser";
export type OpenUiTab = "preview" | "config" | "graph";

export interface OpenPanelOptions {
  cwd?: string;
  into: string;
  from: string;
  autoPreview?: boolean;
  open?: boolean;
}

export interface OpenPanelResult {
  extensionId: string;
  uri: string;
  cursorUri: string;
  vscodeCommand: string;
  commandArgs: { into: string; from: string; cwd: string; autoPreview: boolean };
  opened: boolean;
  openedWith: string | null;
  howTo: string[];
  messages: string[];
}

export interface OpenInsightUiOptions extends OpenPanelOptions {
  mode?: OpenUiMode;
  tab?: OpenUiTab;
  /**
   * browser / auto-fallback 时启动本地 UI 服务。
   * MCP 注入 ensureBrowserServer；`pnpm preview` 直接调 startUiServer。
   */
  ensureBrowserServer?: () => Promise<{ baseUrl: string }>;
}

export interface OpenInsightUiResult {
  mode: "extension" | "browser";
  opened: boolean;
  openedWith: string | null;
  uri?: string;
  url?: string;
  extensionId?: string;
  cursorUri?: string;
  messages: string[];
  howTo: string[];
}

function runCmdCapture(
  cmd: string,
  cmdArgs: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, cmdArgs, {
      windowsHide: true,
      shell: false,
      detached: true,
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (b: Buffer) => {
      stdout += b.toString("utf8");
    });
    child.stderr?.on("data", (b: Buffer) => {
      stderr += b.toString("utf8");
    });
    child.on("error", (err) => {
      resolve({ code: 127, stdout: "", stderr: err.message });
    });
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

/**
 * Windows 下 PowerShell Start-Process 能稳定唤起浏览器。
 * cmd /c start 在无 GUI session 下会静默失败，所以换 Start-Process。
 *
 * pwsh（PowerShell 7+）优先，失败回退到 powershell（Windows PowerShell 5.1）。
 * 单引号包裹 URL，内部单引号用 '' 转义。
 */
function winStartArgs(target: string): Array<{ bin: string; args: string[] }> {
  const escaped = target.replace(/'/g, "''");
  const cmd = `Start-Process '${escaped}'`;
  return [
    { bin: "pwsh", args: ["-NoProfile", "-Command", cmd] },
    { bin: "powershell", args: ["-NoProfile", "-Command", cmd] },
  ];
}

/**
 * 返回值是二维数组：外层是"尝试顺序"，内层是这一尝试的并行候选。
 * 内层数组里任意一个成功就算这一尝试成功。
 */
function openCandidates(uri: string, cursorUri: string): Array<Array<{ bin: string; args: string[] }>> {
  if (process.platform === "win32") {
    return [
      [{ bin: "cursor", args: ["--open-url", uri] }],
      [{ bin: "cursor", args: [uri] }],
      [...winStartArgs(uri)],
      [...winStartArgs(cursorUri)],
    ];
  }
  return [
    [{ bin: "cursor", args: ["--open-url", uri] }],
    [{ bin: "cursor", args: [uri] }],
    [{ bin: "code", args: ["--open-url", uri] }],
    [{ bin: "open", args: [uri] }],
  ];
}

function browserOpenCandidates(url: string): Array<Array<{ bin: string; args: string[] }>> {
  if (process.platform === "win32") {
    return [[...winStartArgs(url)]];
  }
  if (process.platform === "darwin") {
    return [[{ bin: "open", args: [url] }]];
  }
  return [[{ bin: "xdg-open", args: [url] }]];
}

export function buildExtensionPreviewUri(options: {
  into: string;
  from: string;
  cwd: string;
  autoPreview: boolean;
}): { uri: string; cursorUri: string } {
  const q = new URLSearchParams({
    into: options.into,
    from: options.from,
    cwd: options.cwd,
    autoPreview: options.autoPreview ? "1" : "0",
  });
  const uri = `vscode://${GIT_INSIGHT_EXTENSION_ID}/preview?${q.toString()}`;
  const cursorUri = `cursor://${GIT_INSIGHT_EXTENSION_ID}/preview?${q.toString()}`;
  return { uri, cursorUri };
}

export function buildBrowserUiUrl(
  baseUrl: string,
  options: {
    into: string;
    from: string;
    cwd: string;
    autoPreview: boolean;
    tab?: OpenUiTab;
  },
): string {
  const root = baseUrl.replace(/\/+$/, "");
  const q = new URLSearchParams({
    into: options.into,
    from: options.from,
    cwd: options.cwd,
    tab: options.tab ?? "preview",
    autoPreview: options.autoPreview ? "1" : "0",
  });
  return `${root}/?${q.toString()}`;
}

/**
 * 尝试一组"打开方案"（外层顺序尝试），
 * 每个方案内部可能是多个并行候选（内层任一成功算通过）。
 */
async function tryOpenWithCandidates(
  candidates: Array<Array<{ bin: string; args: string[] }>>,
  messages: string[],
): Promise<{ opened: boolean; openedWith: string | null }> {
  for (const group of candidates) {
    for (const a of group) {
      const r = await runCmdCapture(a.bin, a.args);
      if (r.code === 0) {
        const openedWith = `${a.bin} ${a.args.join(" ")}`;
        messages.push(`已尝试打开：${openedWith}`);
        return { opened: true, openedWith };
      }
      messages.push(`尝试失败：${a.bin}（${(r.stderr || r.stdout).trim() || r.code}）`);
    }
  }
  return { opened: false, openedWith: null };
}

export async function openInsightPanel(
  options: OpenPanelOptions,
): Promise<OpenPanelResult> {
  const into = options.into.trim();
  const from = options.from.trim();
  if (!into || !from) {
    throw new GitError("into / from 不能为空", { code: "USAGE" });
  }
  const cwd = options.cwd?.trim() || process.cwd();
  const autoPreview = options.autoPreview !== false;

  const { uri, cursorUri } = buildExtensionPreviewUri({ into, from, cwd, autoPreview });

  const messages: string[] = [];
  let opened = false;
  let openedWith: string | null = null;

  if (options.open === false) {
    messages.push("已跳过自动打开");
  } else {
    const r = await tryOpenWithCandidates(openCandidates(uri, cursorUri), messages);
    opened = r.opened;
    openedWith = r.openedWith;
  }

  return {
    extensionId: GIT_INSIGHT_EXTENSION_ID,
    uri,
    cursorUri,
    vscodeCommand: "gitInsight.openPreview",
    commandArgs: { into, from, cwd, autoPreview },
    opened,
    openedWith,
    howTo: [
      "在装了扩展的机器上执行会直接拉起窗口",
      "或在 Cursor 命令面板运行「Git Insight: 打开预演（可带 into/from）」",
      `或手动打开 URI：${uri}`,
    ],
    messages,
  };
}

async function openBrowserUi(options: {
  into: string;
  from: string;
  cwd: string;
  autoPreview: boolean;
  tab?: OpenUiTab;
  open: boolean;
  ensureBrowserServer: () => Promise<{ baseUrl: string }>;
}): Promise<OpenInsightUiResult> {
  const { baseUrl } = await options.ensureBrowserServer();
  const url = buildBrowserUiUrl(baseUrl, {
    into: options.into,
    from: options.from,
    cwd: options.cwd,
    autoPreview: options.autoPreview,
    tab: options.tab,
  });

  const messages: string[] = [`浏览器面板：${url}`];
  let opened = false;
  let openedWith: string | null = null;

  if (options.open !== false) {
    const r = await tryOpenWithCandidates(browserOpenCandidates(url), messages);
    opened = r.opened;
    openedWith = r.openedWith;
  } else {
    messages.push("已跳过自动打开浏览器");
  }

  return {
    mode: "browser",
    opened,
    openedWith,
    url,
    messages,
    howTo: [
      `在浏览器打开：${url}`,
      `UI 服务默认监听 127.0.0.1:${GIT_INSIGHT_UI_PORT}`,
    ],
  };
}

function toPanelOptions(overrides: {
  into: string;
  from: string;
  cwd: string;
  autoPreview: boolean;
  open: boolean;
}): OpenPanelOptions {
  return overrides;
}

export async function openInsightUi(
  options: OpenInsightUiOptions,
): Promise<OpenInsightUiResult> {
  const into = options.into.trim();
  const from = options.from.trim();
  if (!into || !from) {
    throw new GitError("into / from 不能为空", { code: "USAGE" });
  }
  const cwd = options.cwd?.trim() || process.cwd();
  const autoPreview = options.autoPreview !== false;
  const mode = options.mode ?? "auto";
  const open = options.open !== false;

  if (mode === "extension") {
    const ext = await openInsightPanel(toPanelOptions({ into, from, cwd, autoPreview, open }));
    return {
      mode: "extension",
      opened: ext.opened,
      openedWith: ext.openedWith,
      uri: ext.uri,
      extensionId: ext.extensionId,
      cursorUri: ext.cursorUri,
      messages: ext.messages,
      howTo: ext.howTo,
    };
  }

  if (mode === "browser") {
    if (!options.ensureBrowserServer) {
      throw new GitError(
        "browser 模式需要 UI 服务（请通过 @git-insight/mcp-server 或 pnpm preview 提供）",
        { code: "BROWSER_UI_UNAVAILABLE" },
      );
    }
    return openBrowserUi({
      into,
      from,
      cwd,
      autoPreview,
      tab: options.tab,
      open,
      ensureBrowserServer: options.ensureBrowserServer,
    });
  }

  // auto: 扩展优先，失败则浏览器
  const ext = await openInsightPanel(toPanelOptions({ into, from, cwd, autoPreview, open }));
  if (ext.opened) {
    return {
      mode: "extension",
      opened: true,
      openedWith: ext.openedWith,
      uri: ext.uri,
      extensionId: ext.extensionId,
      cursorUri: ext.cursorUri,
      messages: ext.messages,
      howTo: ext.howTo,
    };
  }

  if (!options.ensureBrowserServer) {
    return {
      mode: "extension",
      opened: false,
      openedWith: null,
      uri: ext.uri,
      extensionId: ext.extensionId,
      cursorUri: ext.cursorUri,
      messages: [
        ...ext.messages,
        "未能打开扩展面板，且当前环境未配置浏览器 UI fallback。",
        "请安装 Git Insight 扩展，或使用 @git-insight/mcp-server 的 open_ui。",
      ],
      howTo: ext.howTo,
    };
  }

  const browser = await openBrowserUi({
    into,
    from,
    cwd,
    autoPreview,
    tab: options.tab,
    open,
    ensureBrowserServer: options.ensureBrowserServer,
  });
  return {
    ...browser,
    messages: [...ext.messages, "---", ...browser.messages],
    howTo: [...ext.howTo, ...browser.howTo],
  };
}
