import * as vscode from "vscode";

export type OpenPreviewArgs = {
  into?: string;
  from?: string;
  cwd?: string;
  /** 默认 true */
  autoPreview?: boolean;
};

function log(output: vscode.OutputChannel, line: string): void {
  output.appendLine(`[${new Date().toISOString()}] ${line}`);
}

function parseUriSeed(uri: vscode.Uri): OpenPreviewArgs {
  const q = new URLSearchParams(uri.query);
  const auto = q.get("autoPreview");
  return {
    into: q.get("into") ?? undefined,
    from: q.get("from") ?? undefined,
    cwd: q.get("cwd") ?? undefined,
    autoPreview: auto !== "0" && auto !== "false",
  };
}

async function openPreview(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  args?: OpenPreviewArgs,
): Promise<void> {
  const { GitInsightPanel } = await import("./GitInsightPanel.js");
  GitInsightPanel.createOrShow(context, "preview", {
    into: args?.into,
    from: args?.from,
    cwd: args?.cwd,
    autoPreview: args?.autoPreview !== false,
  });
}

async function openTab(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  tab: "config" | "preview" | "graph",
  seed?: OpenPreviewArgs,
): Promise<void> {
  const { GitInsightPanel } = await import("./GitInsightPanel.js");
  if (tab === "preview" && (seed?.into || seed?.from)) {
    GitInsightPanel.createOrShow(context, "preview", {
      into: seed.into,
      from: seed.from,
      cwd: seed.cwd,
      autoPreview: seed.autoPreview !== false,
    });
    return;
  }
  GitInsightPanel.createOrShow(context, tab);
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Git Insight");
  context.subscriptions.push(output);
  log(output, "activate 开始");

  // 命令必须最先注册；后续 Skill 同步 / 预警初始化失败也不影响面板
  context.subscriptions.push(
    vscode.commands.registerCommand("gitInsight.openWeb", () => {
      void openTab(context, output, "config").catch((err) => {
        log(output, `openWeb 失败: ${err}`);
        void vscode.window.showErrorMessage(
          err instanceof Error ? err.message : String(err),
        );
      });
    }),
    vscode.commands.registerCommand("gitInsight.previewMerge", () => {
      void openTab(context, output, "preview").catch((err) => {
        log(output, `previewMerge 失败: ${err}`);
        void vscode.window.showErrorMessage(
          err instanceof Error ? err.message : String(err),
        );
      });
    }),
    vscode.commands.registerCommand(
      "gitInsight.openPreview",
      (args?: OpenPreviewArgs) => {
        void openPreview(context, output, args).catch((err) => {
          log(output, `openPreview 失败: ${err}`);
          void vscode.window.showErrorMessage(
            err instanceof Error ? err.message : String(err),
          );
        });
      },
    ),
    vscode.commands.registerCommand("gitInsight.syncSkill", () => {
      void import("./skillSync.js")
        .then(({ syncBundledSkill }) => syncBundledSkill(context))
        .then((r) => {
          if (r.ok) {
            void vscode.window.showInformationMessage(
              `Git Insight Skill 已同步到全局：${r.targets.join("；")}`,
            );
          } else {
            void vscode.window.showErrorMessage(
              `Git Insight Skill 同步失败：${r.error ?? "unknown"}`,
            );
          }
        })
        .catch((err) => {
          log(output, `syncSkill 失败: ${err}`);
          void vscode.window.showErrorMessage(
            err instanceof Error ? err.message : String(err),
          );
        });
    }),
    vscode.window.registerUriHandler({
      handleUri(uri: vscode.Uri): vscode.ProviderResult<void> {
        const path = uri.path.replace(/^\//, "");
        if (path === "preview" || path === "" || path === "open") {
          void openPreview(context, output, parseUriSeed(uri)).catch((err) => {
            log(output, `URI preview 失败: ${err}`);
          });
          return;
        }
        if (path === "config") {
          void openTab(context, output, "config").catch((err) => {
            log(output, `URI config 失败: ${err}`);
          });
          return;
        }
        if (path === "graph") {
          void openTab(context, output, "graph").catch((err) => {
            log(output, `URI graph 失败: ${err}`);
          });
        }
      },
    }),
  );

  log(output, "命令已注册");

  void import("./skillSync.js")
    .then(({ syncBundledSkill }) => syncBundledSkill(context))
    .then((r) => {
      if (!r.ok) {
        log(output, `Skill 同步失败: ${r.error ?? "unknown"}`);
      } else {
        log(output, `Skill 已同步: ${r.targets.join("; ")}`);
      }
    })
    .catch((err) => {
      log(output, `Skill 同步异常: ${err}`);
    });

  void import("./mergeWatcher.js")
    .then(({ registerMergeWatcher }) => {
      registerMergeWatcher(context);
      log(output, "冲突预警已初始化");
    })
    .catch((err) => {
      log(output, `冲突预警初始化失败: ${err}`);
    });

  log(output, "activate 完成");
}

export function deactivate(): void {
  // no-op
}
