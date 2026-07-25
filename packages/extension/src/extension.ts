import * as vscode from "vscode";
import { GitInsightPanel } from "./GitInsightPanel.js";

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("gitInsight.openWeb", () => {
      GitInsightPanel.createOrShow(context, "graph");
    }),
    vscode.commands.registerCommand("gitInsight.previewMerge", () => {
      GitInsightPanel.createOrShow(context, "preview");
    }),
    // 兼容旧命令名 → 合并预演
    vscode.commands.registerCommand("gitInsight.conflictBlame", () => {
      GitInsightPanel.createOrShow(context, "preview");
    }),
  );
}

export function deactivate(): void {
  // no-op
}
