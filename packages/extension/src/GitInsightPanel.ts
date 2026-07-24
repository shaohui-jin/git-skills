import * as vscode from "vscode";
import { handleWebviewRequest, resolveWorkspaceCwd } from "./coreBridge.js";
import type { HostMessage, WebviewRequest } from "./protocol.js";

export class GitInsightPanel {
  public static current: GitInsightPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private disposables: vscode.Disposable[] = [];
  /** Override when user picks a folder; otherwise use workspace folder. */
  private overrideCwd: string | null = null;

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this.panel = panel;
    this.extensionUri = extensionUri;

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
    extensionUri: vscode.Uri,
    focusTab?: "graph" | "preview",
  ): void {
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

    GitInsightPanel.current = new GitInsightPanel(panel, extensionUri);
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
          { previewMode: false },
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
        `将按方案 A 写仓库并${push ? "推送" : "仅本地提交"}：\n` +
          `1) 从「${req.into}」创建临时分支\n` +
          `2) merge「${req.from}」并应用暂存解决结果后 commit\n` +
          (push ? `3) push 到 origin\n` : "") +
          `\n要求工作区干净。MR 不会自动创建（完成后可打开链接）。`,
        { modal: true },
        "继续",
      );
      if (pick !== "继续") {
        await this.post({ type: "error", message: "已取消一键解决冲突", code: "CANCELLED" });
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
              ? "一键解决冲突（建分支 / merge / 提交 / 推送）…"
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
        onProgress:
          req.type === "graph" ||
          req.type === "preview" ||
          req.type === "blame" ||
          req.type === "applyResolve"
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
        if (msg.type === "applyResolveResult" && msg.createMrUrl) {
          const open = await vscode.window.showInformationMessage(
            `已完成：${msg.tempBranch} @ ${msg.commitSha.slice(0, 7)}` +
              (msg.pushed ? "（已推送）" : "（未推送）") +
              "\n是否打开「创建 MR/PR」页面？",
            "打开 MR 页面",
            "稍后",
          );
          if (open === "打开 MR 页面") {
            await vscode.env.openExternal(vscode.Uri.parse(msg.createMrUrl));
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
