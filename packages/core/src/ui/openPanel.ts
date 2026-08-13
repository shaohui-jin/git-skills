/**
 * 唤起扩展的合并预演面板，并把 into / from 种进去。
 *
 * 这是「Agent 查完之后我要动手」那一步的桥：分析结果留在对话里，选边、
 * 一键解决、申请 MR 这些要动手的事回到面板里做。CLI 的 `open-ui` 和 MCP 的
 * `open_ui` 都走这里，别再各写一份——拼 URI 的规则和逐个候选命令去试的顺序
 * 一旦分叉，两边就会在不同机器上表现不一致。
 *
 * 前提是本机装了扩展。装了才有人注册这个 URI scheme，否则只能把 uri 交回给
 * 调用方，让它提示用户手动打开。
 */
import { spawn } from "node:child_process";
import { GitError } from "../git/runner.js";

export const GIT_INSIGHT_EXTENSION_ID = "jinshaohui.git-insight";

export interface OpenPanelOptions {
  /** 仓库路径，默认取进程 cwd */
  cwd?: string;
  /** 线上目标分支 */
  into: string;
  /** 我的分支 */
  from: string;
  /** 默认 true：种入分支后立刻跑预演 */
  autoPreview?: boolean;
  /** 默认 true；false 只生成 URI，不尝试拉起窗口 */
  open?: boolean;
}

export interface OpenPanelResult {
  extensionId: string;
  uri: string;
  /** Cursor 对 vscode:// 的等价 scheme，Windows 上 start 兜底时用得上 */
  cursorUri: string;
  vscodeCommand: string;
  commandArgs: { into: string; from: string; cwd: string; autoPreview: boolean };
  opened: boolean;
  /** 实际是哪条命令拉起来的，排查「怎么没反应」时唯一有用的线索 */
  openedWith: string | null;
  howTo: string[];
  /** 每个候选命令的尝试结果，按顺序 */
  messages: string[];
}

function runCmdCapture(
  cmd: string,
  cmdArgs: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, cmdArgs, {
      windowsHide: true,
      shell: process.platform === "win32",
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
 * 逐个试，第一个成功就停。
 *
 * 顺序是有讲究的：先试 `cursor --open-url`（装了 Cursor CLI 时最准，能复用
 * 已开着的窗口），再退到系统默认打开器。Windows 的 `start` 需要那个空标题参数，
 * 否则第一个带引号的参数会被当成窗口标题。
 */
function openCandidates(uri: string, cursorUri: string): Array<{ bin: string; args: string[] }> {
  return process.platform === "win32"
    ? [
        { bin: "cursor", args: ["--open-url", uri] },
        { bin: "cursor", args: [uri] },
        { bin: "cmd", args: ["/c", "start", "", uri] },
        { bin: "cmd", args: ["/c", "start", "", cursorUri] },
      ]
    : [
        { bin: "cursor", args: ["--open-url", uri] },
        { bin: "cursor", args: [uri] },
        { bin: "code", args: ["--open-url", uri] },
        { bin: "open", args: [uri] },
      ];
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

  const q = new URLSearchParams({
    into,
    from,
    cwd,
    autoPreview: autoPreview ? "1" : "0",
  });
  const uri = `vscode://${GIT_INSIGHT_EXTENSION_ID}/preview?${q.toString()}`;
  const cursorUri = `cursor://${GIT_INSIGHT_EXTENSION_ID}/preview?${q.toString()}`;

  const messages: string[] = [];
  let opened = false;
  let openedWith: string | null = null;

  if (options.open === false) {
    messages.push("已跳过自动打开");
  } else {
    for (const a of openCandidates(uri, cursorUri)) {
      const r = await runCmdCapture(a.bin, a.args);
      if (r.code === 0) {
        opened = true;
        openedWith = `${a.bin} ${a.args.join(" ")}`;
        messages.push(`已尝试打开：${openedWith}`);
        break;
      }
      messages.push(`尝试失败：${a.bin}（${(r.stderr || r.stdout).trim() || r.code}）`);
    }
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
      "或在扩展宿主内 executeCommand('gitInsight.openPreview', { into, from })",
    ],
    messages,
  };
}
