import * as vscode from "vscode";
import type { AiBridgeSession } from "./aiResolveBridge.js";
import { runAiResolve } from "./aiResolveLm.js";
import { bundledCliPath, shellExecCommand } from "./cliBundle.js";
import { handleWebviewRequest, resolveWorkspaceCwd } from "./coreBridge.js";
import { loadUserConfig } from "./gitConfigStore.js";
import type { HostMessage, WebviewRequest } from "./protocol.js";

export class GitInsightPanel {
  public static current: GitInsightPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly cliStorageDir: string;
  private readonly configMemento: vscode.Memento;
  private readonly output: vscode.OutputChannel;
  private disposables: vscode.Disposable[] = [];
  /** Override when user picks a folder; otherwise use workspace folder. */
  overrideCwd: string | null = null;
  /** 当前 Chat 回传桥会话（粘贴 / 取消） */
  private aiBridgeSession: AiBridgeSession | null = null;
  private lastAiPrompt = "";

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
    this.output = vscode.window.createOutputChannel("Git Insight");
    this.disposables.push(this.output);

    this.panel.webview.html = this.getHtml(this.panel.webview);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      (raw: unknown) => {
        void this.onMessageSafe(raw);
      },
      null,
      this.disposables,
    );
  }

  private log(line: string): void {
    this.output.appendLine(`[${new Date().toISOString()}] ${line}`);
  }

  private extensionVersion(): string {
    try {
      const found = vscode.extensions.all.find(
        (e) =>
          e.id.endsWith("git-insight") ||
          e.packageJSON?.name === "git-insight",
      );
      return String(found?.packageJSON?.version ?? "unknown");
    } catch {
      return "unknown";
    }
  }

  private async onMessageSafe(raw: unknown): Promise<void> {
    let req: WebviewRequest | null = null;
    try {
      if (typeof raw === "string") {
        req = JSON.parse(raw) as WebviewRequest;
      } else if (raw && typeof raw === "object") {
        req = raw as WebviewRequest;
      }
      if (!req || !("type" in req)) {
        this.log(`忽略无效消息: ${typeof raw}`);
        return;
      }
      this.log(`← webview ${req.type}`);
      await this.onMessage(req);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`onMessage 异常: ${message}`);
      console.error("[git-insight] onMessage", err);
      try {
        await this.post({ type: "error", message, code: "HOST_EXCEPTION" });
      } catch {
        // ignore
      }
      void vscode.window.showErrorMessage(`Git Insight 宿主异常：${message}`);
      this.output.show(true);
    }
  }

  public static createOrShow(
    context: vscode.ExtensionContext,
    focusTab?: "config" | "graph" | "preview",
    seed?: { into?: string; from?: string; autoPreview?: boolean; cwd?: string },
  ): void {
    const extensionUri = context.extensionUri;
    const cliStorageDir = context.globalStorageUri.fsPath;
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    const postSeed = (panel: GitInsightPanel): void => {
      if (seed?.cwd?.trim()) {
        panel.overrideCwd = seed.cwd.trim();
      }
      const tab = focusTab ?? (seed?.into || seed?.from ? "preview" : undefined);
      if (tab) {
        void panel.panel.webview.postMessage({ type: "focusTab", tab });
      }
      if (seed?.into || seed?.from) {
        void panel.panel.webview.postMessage({
          type: "seedPreview",
          into: seed.into,
          from: seed.from,
          autoPreview: seed.autoPreview !== false,
        });
      }
    };

    if (GitInsightPanel.current) {
      GitInsightPanel.current.panel.reveal(column);
      postSeed(GitInsightPanel.current);
      if (seed?.cwd?.trim()) {
        void GitInsightPanel.current.refreshWorkspaceAfterSeed();
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
    setTimeout(() => {
      if (GitInsightPanel.current) {
        postSeed(GitInsightPanel.current);
        if (seed?.cwd?.trim()) {
          void GitInsightPanel.current.refreshWorkspaceAfterSeed();
        }
      }
    }, 350);
  }

  /** seed 指定 cwd 后刷新工作区分支列表 */
  async refreshWorkspaceAfterSeed(): Promise<void> {
    try {
      const cwd = await this.getCwd();
      const result = await handleWebviewRequest(
        { type: "refreshWorkspace" },
        cwd,
        {
          previewMode: false,
          cliStorageDir: this.cliStorageDir,
          configMemento: this.configMemento,
        },
      );
      for (const msg of result.messages) {
        await this.post(msg);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`seed refresh 失败: ${message}`);
    }
  }

  private async getCwd(): Promise<string | null> {
    if (this.overrideCwd) {
      return this.overrideCwd;
    }
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return resolveWorkspaceCwd(folder);
  }

  private async post(
    msg:
      | HostMessage
      | { type: "focusTab"; tab: string }
      | {
          type: "seedPreview";
          into?: string;
          from?: string;
          autoPreview?: boolean;
        },
  ): Promise<void> {
    await this.panel.webview.postMessage(msg);
  }

  private async onMessage(req: WebviewRequest): Promise<void> {
    if (req.type === "ping") {
      await this.post({
        type: "pong",
        nonce: req.nonce,
        extensionVersion: this.extensionVersion(),
      });
      this.log(`→ pong v${this.extensionVersion()}`);
      return;
    }

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

    if (req.type === "aiResolveCancelBridge") {
      this.aiBridgeSession?.cancel("用户取消了 AI 选边等待");
      this.aiBridgeSession = null;
      await this.post({ type: "busy", busy: false });
      return;
    }

    if (req.type === "aiResolveSubmitPaste") {
      if (!this.aiBridgeSession) {
        await this.post({
          type: "error",
          message: "当前没有等待中的 AI 回传会话，请重新点「开始 AI 选边」",
          code: "AI_NO_BRIDGE",
        });
        return;
      }
      this.aiBridgeSession.submitText(req.text ?? "");
      return;
    }

    if (req.type === "aiResolveCopyPrompt") {
      const text = this.lastAiPrompt;
      if (!text) {
        await this.post({
          type: "error",
          message: "暂无提示词可复制，请先开始 AI 选边",
          code: "AI_NO_PROMPT",
        });
        return;
      }
      await vscode.env.clipboard.writeText(text);
      void vscode.window.showInformationMessage("已复制 AI 选边提示词到剪贴板");
      return;
    }

    if (req.type === "aiResolveConflicts") {
      const hunkCount = req.hunks?.length ?? 0;
      this.log(`AI 选边开始：into=${req.into} from=${req.from} hunks=${hunkCount}`);
      void this.post({
        type: "progress",
        percent: 3,
        label: `宿主已收到（${hunkCount} 个冲突块）…`,
      });
      void this.post({ type: "busy", busy: true, label: "AI 选边中…", percent: 3 });
      try {
        if (!req.hunks?.length) {
          throw new Error("没有待解决的冲突块");
        }
        const cfg = await loadUserConfig(
          this.configMemento,
          await this.getCwd(),
          this.cliStorageDir,
        );
        const result = await runAiResolve(
          {
            into: req.into,
            from: req.from,
            rules: req.rules,
            extraNotes: req.extraNotes ?? "",
            hunks: req.hunks,
          },
          {
            openAi: {
              baseUrl: cfg.aiApiBaseUrl ?? "",
              apiKey: cfg.aiApiKey ?? "",
              model: cfg.aiModel ?? "",
            },
            onProgress: async (label, percent) => {
              await this.post({ type: "progress", percent, label });
              await new Promise<void>((r) => setImmediate(r));
            },
            onBridgeSession: (session) => {
              this.aiBridgeSession = session;
            },
            onBridgeReady: async (info) => {
              this.lastAiPrompt = info.prompt;
              this.log(
                `Chat 桥就绪 port=${info.port} batch=${info.batchIndex ?? 1}/${info.batchTotal ?? 1} conflicts=${info.conflictsFile} copied=${info.copied} opened=${info.openedChat} pasted=${info.pasted} submitted=${info.submitted}`,
              );
              await this.post({
                type: "aiResolveBridgeReady",
                port: info.port,
                callbackUrl: info.callbackUrl,
                prompt: info.prompt,
                promptFile: info.promptFile,
                conflictsFile: info.conflictsFile,
                openedChat: info.openedChat,
                copied: info.copied,
                pasted: info.pasted,
                submitted: info.submitted,
                batchIndex: info.batchIndex,
                batchTotal: info.batchTotal,
              });
              // 自动粘贴成功时不再抢焦点打开旁路文档；失败时旁开便于复制
              if (!info.pasted) {
                try {
                  const doc = await vscode.workspace.openTextDocument({
                    content: info.prompt,
                    language: "markdown",
                  });
                  await vscode.window.showTextDocument(doc, {
                    preview: true,
                    viewColumn: vscode.ViewColumn.Beside,
                  });
                } catch {
                  // ignore
                }
              }
            },
          },
        );
        await this.post({
          type: "aiResolveConflictsResult",
          into: req.into,
          from: req.from,
          hunks: result.hunks,
          model: result.model,
          messages: result.messages,
        });
        this.log(`AI 选边完成：model=${result.model ?? "?"} results=${result.hunks.length}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log(`AI 选边失败：${message}`);
        console.error("[git-insight] AI 选边失败:", err);
        await this.post({
          type: "error",
          message,
          code: "AI_RESOLVE",
        });
        if (!/取消|cancel/i.test(message)) {
          void vscode.window.showErrorMessage(`Git Insight · AI 选边失败：${message}`);
          this.output.show(true);
        }
      } finally {
        this.aiBridgeSession = null;
        await this.post({ type: "busy", busy: false });
      }
      return;
    }

    if (req.type === "applyResolve") {
      const push = req.push !== false;
      const cleanTemp = !req.files?.length;
      const pick = await vscode.window.showWarningMessage(
        cleanTemp
          ? `将推送临时分支（独立 worktree，不切换当前分支）：\n` +
              `1) 基于「${req.into}」新建临时分支\n` +
              `2) 合并「${req.from}」并提交\n` +
              (push ? `3) 推送到 origin\n` : "") +
              `\n完成后可在面板「一键申请 MR」。`
          : `将解决冲突并${push ? "推送" : "提交"}（独立 worktree，不切换当前分支）：\n` +
              `1) 基于「${req.into}」新建临时分支\n` +
              `2) 合并「${req.from}」并写入选边结果\n` +
              (push ? `3) 推送到 origin\n` : "") +
              `\n完成后可在面板「一键申请 MR」。`,
        { modal: true },
        "继续",
      );
      if (pick !== "继续") {
        await this.post({
          type: "error",
          message: cleanTemp ? "已取消推送临时分支" : "已取消一键解决",
          code: "CANCELLED",
        });
        return;
      }
    }

    if (req.type === "createMr") {
      const people =
        req.reviewers?.length
          ? `\n指派人 / 审核人：${req.reviewers.join(", ")}`
          : "\n指派人 / 审核人：（未指定）";
      const pick = await vscode.window.showWarningMessage(
        `将按「Git 配置」中的方式创建 ${req.sourceBranch} → ${req.targetBranch} 的 MR/PR。` +
          people,
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
              ? !req.files?.length
                ? "正在推送临时分支…"
                : "一键解决并推送…"
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
            `临时分支已就绪：${msg.tempBranch} @ ${msg.commitSha.slice(0, 7)}` +
              (msg.pushed ? "（已推送）" : "（未推送）") +
              stay +
              "\n可在面板点击「一键申请 MR」。",
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
