import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type * as vscode from "vscode";

const SKILL_NAME = "git-branch-insight";
const PLACEHOLDER = "__GIT_INSIGHT_CLI__";

/**
 * 将扩展内 Skill 同步到用户全局目录，使 Cursor `/git-branch-insight` 在任意仓库可用。
 * 同时写入 CLI 绝对路径（扩展 dist/cli.js）。
 */
export async function syncBundledSkill(
  context: vscode.ExtensionContext,
): Promise<{ ok: boolean; targets: string[]; error?: string }> {
  const targets: string[] = [];
  try {
    const src = join(
      context.extensionPath,
      "skills",
      SKILL_NAME,
      "SKILL.md",
    );
    const cliPath = join(context.extensionPath, "dist", "cli.js");
    let body = await readFile(src, "utf8");
    // JSON.stringify 保证 Windows 反斜杠在 markdown 代码块里可粘贴
    const cliLiteral = JSON.stringify(cliPath).slice(1, -1);
    body = body.split(PLACEHOLDER).join(cliLiteral);

    const home = homedir();
    const dirs = [
      join(home, ".cursor", "skills", SKILL_NAME),
      join(home, ".agents", "skills", SKILL_NAME),
    ];

    for (const dir of dirs) {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "SKILL.md"), body, "utf8");
      await writeFile(
        join(dir, ".git-insight-managed"),
        `${context.extension.id}\n${context.extension.packageJSON.version ?? ""}\n${cliPath}\n`,
        "utf8",
      );
      targets.push(dir);
    }

    return { ok: true, targets };
  } catch (err) {
    return {
      ok: false,
      targets,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
