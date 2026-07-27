import * as vscode from "vscode";
import { bundledCliPath, shellExecCommand } from "./cliBundle.js";
import { handleWebviewRequest, resolveWorkspaceCwd } from "./coreBridge.js";
import type { HostMessage, WebviewRequest } from "./protocol.js";

export class GitInsightPanel {
  public static current: GitInsightPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly cliStorageDir: string;
  private readonly configMemento: vscode.Memento;
  private disposables: vscode.Disposable[] = [];
  /** Override when user picks a folder; otherwise use workspace folder. */
  private overrideCwd: string | null = null;

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    cliStorageDir: string,
    configMemento: vscode.Memento,
  ) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.cliStorageDir = cliStorageDir;
    this.configMemento = configMemento;

    this.panel.webview.html = this.getHtml(this.panel.webview);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      async (raw: WebviewRequest) => {
        await this.onMessage(raw);
      },
      null,
      this.disposables,
    );
  }

  public static createOrShow(
    context: vscode.ExtensionContext,
    focusTab?: "config" | "graph" | "preview",
  ): void {
    const extensionUri = context.extensionUri;
    const cliStorageDir = context.globalStorageUri.fsPath;
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (GitInsightPanel.current) {
      GitInsightPanel.current.panel.reveal(column);
      if (focusTab) {
        void GitInsightPanel.current.panel.webview.postMessage({
          type: "focusTab",
          tab: focusTab,
        });
      }
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "gitInsight",
      "Git Insight",
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "dist", "webview")],
      },
    );

    GitInsightPanel.current = new GitInsightPanel(
      panel,
      extensionUri,
      cliStorageDir,
      context.globalState,
    );
    if (focusTab) {
      setTimeout(() => {
        void GitInsightPanel.current?.panel.webview.postMessage({
          type: "focusTab",
          tab: focusTab,
        });
      }, 300);
    }
  }

  private async getCwd(): Promise<string | null> {
    if (this.overrideCwd) {
      return this.overrideCwd;
    }
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return resolveWorkspaceCwd(folder);
  }

  private async post(msg: HostMessage | { type: "focusTab"; tab: string }): Promise<void> {
    await this.panel.webview.postMessage(msg);
  }

  private async onMessage(req: WebviewRequest): Promise<void> {
    if (req.type === "openExternal") {
      try {
        await vscode.env.openExternal(vscode.Uri.parse(req.url));
      } catch (err) {
        await this.post({
          type: "error",
          message: err instanceof Error ? err.message : String(err),
          code: "OPEN_EXTERNAL",
        });
      }
      return;
    }

    if (req.type === "cliAuthLogin") {
      const cwd = (await this.getCwd()) ?? undefined;
      const kind = req.kind;
      // PowerShell 下 `"path\to\gh.exe" auth login` 会把路径当字符串，必须用 &
      const cmd =
        req.scope === "bundled"
          ? shellExecCommand(bundledCliPath(this.cliStorageDir, kind), ["auth", "login"], vscode.env.shell)
          : `${kind} auth login`;
      const term = vscode.window.createTerminal({
        name: `Git Insight · ${kind} login`,
        cwd,
      });
      term.show();
      term.sendText(cmd);
      await vscode.window.showInformationMessage(
        `已在终端启动「${kind} auth login」。完成后请回到面板点击「重新检测 CLI」。`,
      );
      return;
    }

    if (req.type === "pickFolder") {
      await this.post({ type: "busy", busy: true, label: "请选择目录…" });
      try {
        const uris = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          openLabel: "打开 Git 仓库",
        });
        const picked = uris?.[0]?.fsPath;
        if (!picked) {
          await this.post({ type: "error", message: "已取消选择目录", code: "CANCELLED" });
          return;
        }
        const result = await handleWebviewRequest(
          { type: "setCwd", path: picked },
          this.overrideCwd,
          {
            previewMode: false,
            cliStorageDir: this.cliStorageDir,
            configMemento: this.configMemento,
          },
        );
        if (result.cwd !== undefined) {
          this.overrideCwd = result.cwd;
        }
        for (const msg of result.messages) {
          await this.post(msg);
        }
      } finally {
        await this.post({ type: "busy", busy: false });
      }
      return;
    }

    if (req.type === "applyResolve") {
      const push = req.push !== false;
      const pick = await vscode.window.showWarningMessage(
        `将在独立 git worktree 中${push ? "解决并推送" : "解决并提交"}（不切换你当前分支）：\n` +
          `1) 基于「${req.into}」创建临时分支\n` +
          `2) merge「${req.from}」并应用暂存后 commit\n` +
          (push ? `3) push 到 origin\n` : "") +
          `\n主工作区文件与 HEAD 保持不变。创建 MR 请用面板「一键申请 MR」。`,
        { modal: true },
        "继续",
      );
      if (pick !== "继续") {
        await this.post({ type: "error", message: "已取消一键解决冲突", code: "CANCELLED" });
        return;
      }
    }

    if (req.type === "createMr") {
      const reviewers =
        req.reviewers?.length ? `\n评审人：${req.reviewers.join(", ")}` : "\n评审人：（未指定）";
      const pick = await vscode.window.showWarningMessage(
        `将按「Git 配置」中的方式创建 ${req.sourceBranch} → ${req.targetBranch} 的 MR/PR。` +
          reviewers,
        { modal: true },
        "创建",
      );
      if (pick !== "创建") {
        await this.post({ type: "error", message: "已取消创建 MR", code: "CANCELLED" });
        return;
      }
    }

    const label =
      req.type === "fetch"
        ? "正在 Fetch…"
        : req.type === "graph"
          ? "正在加载全量分支图…"
          : req.type === "preview" || req.type === "blame"
            ? "合并预演中…"
            : req.type === "applyResolve"
              ? "一键解决冲突（独立 worktree，不改当前分支）…"
              : req.type === "prepareCreateMr"
                ? "准备申请 MR（识别平台 / 拉取成员）…"
                : req.type === "createMr"
                  ? "正在创建 MR…"
                  : req.type === "downloadCli"
                    ? "正在下载 CLI 到扩展目录…"
                    : req.type === "validateToken"
                      ? "正在校验 Token…"
                      : req.type === "saveGitConfig" && req.config.mrMethod === "token"
                        ? "保存配置并校验 Token…"
                        : req.type === "setCwd"
                          ? "正在打开仓库…"
                          : undefined;

    if (label) {
      await this.post({ type: "busy", busy: true, label, percent: 0 });
    }

    try {
      const cwd = await this.getCwd();
      const result = await handleWebviewRequest(req, cwd, {
        previewMode: false,
        cliStorageDir: this.cliStorageDir,
        configMemento: this.configMemento,
        onProgress:
          req.type === "graph" ||
          req.type === "preview" ||
          req.type === "blame" ||
          req.type === "applyResolve" ||
          req.type === "downloadCli" ||
          req.type === "validateToken" ||
          (req.type === "saveGitConfig" && req.config.mrMethod === "token")
            ? async (u) => {
                await this.post({
                  type: "progress",
                  percent: u.percent,
                  label: u.label,
                });
                // 让出事件循环，确保 webview 能刷新百分比（否则易一直停在 0）
                await new Promise<void>((r) => setImmediate(r));
              }
            : undefined,
      });
      if (result.cwd !== undefined) {
        this.overrideCwd = result.cwd;
      }
      for (const msg of result.messages) {
        await this.post(msg);
        if (msg.type === "applyResolveResult") {
          const stay =
            msg.previousBranch != null
              ? `\n当前工作区仍在「${msg.previousBranch}」（独立 worktree 已清理）`
              : "\n主工作区未切换分支（独立 worktree 已清理）";
          await vscode.window.showInformationMessage(
            `已完成：${msg.tempBranch} @ ${msg.commitSha.slice(0, 7)}` +
              (msg.pushed ? "（已推送）" : "（未推送）") +
              stay +
              "\n可在面板点击「一键申请 MR」用 gh/glab 创建合并请求。",
          );
        }
        if (msg.type === "createMrResult" && msg.url) {
          const open = await vscode.window.showInformationMessage(
            `MR/PR 已创建：${msg.sourceBranch} → ${msg.targetBranch}`,
            "打开链接",
            "关闭",
          );
          if (open === "打开链接") {
            await vscode.env.openExternal(vscode.Uri.parse(msg.url));
          }
        }
      }
    } finally {
      if (label) {
        await this.post({ type: "busy", busy: false, percent: 100 });
      }
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "assets", "index.js"),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "assets", "index.css"),
    );
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>Git Insight</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  public dispose(): void {
    GitInsightPanel.current = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }
}

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 32; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return id;
}
