import * as vscode from "vscode";
import { GitInsightPanel } from "./GitInsightPanel.js";
import { registerMergeWatcher } from "./mergeWatcher.js";
import { syncBundledSkill } from "./skillSync.js";

export type OpenPreviewArgs = {
  into?: string;
  from?: string;
  cwd?: string;
  /** 默认 true */
  autoPreview?: boolean;
};

function openPreview(
  context: vscode.ExtensionContext,
  args?: OpenPreviewArgs,
): void {
  GitInsightPanel.createOrShow(context, "preview", {
    into: args?.into,
    from: args?.from,
    cwd: args?.cwd,
    autoPreview: args?.autoPreview !== false,
  });
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

export function activate(context: vscode.ExtensionContext): void {
  // 安装/启动即把 Skill 注册到用户全局（~/.cursor/skills、~/.agents/skills）
  void syncBundledSkill(context).then((r) => {
    if (!r.ok) {
      console.warn("[git-insight] skill sync failed:", r.error);
    }
  });

  // 默认关闭；开了才起定时器与状态栏（见 gitInsight.conflictWatcher.enabled）
  registerMergeWatcher(context);

  context.subscriptions.push(
    vscode.commands.registerCommand("gitInsight.openWeb", () => {
      GitInsightPanel.createOrShow(context, "config");
    }),
    vscode.commands.registerCommand("gitInsight.previewMerge", () => {
      GitInsightPanel.createOrShow(context, "preview");
    }),
    vscode.commands.registerCommand(
      "gitInsight.openPreview",
      (args?: OpenPreviewArgs) => {
        openPreview(context, args);
      },
    ),
    vscode.commands.registerCommand("gitInsight.syncSkill", async () => {
      const r = await syncBundledSkill(context);
      if (r.ok) {
        void vscode.window.showInformationMessage(
          `Git Insight Skill 已同步到全局：${r.targets.join("；")}`,
        );
      } else {
        void vscode.window.showErrorMessage(
          `Git Insight Skill 同步失败：${r.error ?? "unknown"}`,
        );
      }
    }),
    vscode.window.registerUriHandler({
      handleUri(uri: vscode.Uri): vscode.ProviderResult<void> {
        // vscode://jinshaohui.git-insight/preview?into=...&from=...
        const path = uri.path.replace(/^\//, "");
        if (path === "preview" || path === "" || path === "open") {
          openPreview(context, parseUriSeed(uri));
          return;
        }
        if (path === "config") {
          GitInsightPanel.createOrShow(context, "config");
          return;
        }
        if (path === "graph") {
          GitInsightPanel.createOrShow(context, "graph");
        }
      },
    }),
  );
}

export function deactivate(): void {
  // no-op
}
