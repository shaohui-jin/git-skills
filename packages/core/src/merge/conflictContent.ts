import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit } from "../git/runner.js";

const MAX_CHARS = 24_000;

async function showFile(
  cwd: string,
  rev: string,
  path: string,
): Promise<string | null> {
  const result = await runGit(cwd, ["show", `${rev}:${path}`], { allowFail: true });
  if (result.code !== 0) {
    return null;
  }
  return result.stdout;
}

function truncate(text: string): string {
  if (text.length <= MAX_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_CHARS)}\n\n…（内容过长已截断）\n`;
}

/**
 * Produce conflict-marker text (diff3) for a path without touching the worktree.
 */
export async function buildConflictContent(
  cwd: string,
  baseSha: string,
  intoSha: string,
  fromSha: string,
  path: string,
): Promise<{
  conflictContent: string | null;
  oursContent: string | null;
  theirsContent: string | null;
  baseContent: string | null;
}> {
  const [oursContent, theirsContent, baseContent] = await Promise.all([
    showFile(cwd, intoSha, path),
    showFile(cwd, fromSha, path),
    showFile(cwd, baseSha, path),
  ]);

  if (oursContent === null && theirsContent === null) {
    return {
      conflictContent: null,
      oursContent,
      theirsContent,
      baseContent,
    };
  }

  // modify/delete or add/add: still surface both sides when merge-file is awkward
  if (oursContent === null || theirsContent === null) {
    const parts = [
      `<<<<<<< ours (${intoSha.slice(0, 7)})`,
      oursContent ?? "（线上侧无此文件 / 已删除）",
      "||||||| base",
      baseContent ?? "（base 无此文件）",
      "=======",
      theirsContent ?? "（我的分支侧无此文件 / 已删除）",
      `>>>>>>> theirs (${fromSha.slice(0, 7)})`,
      "",
    ];
    return {
      conflictContent: truncate(parts.join("\n")),
      oursContent,
      theirsContent,
      baseContent,
    };
  }

  const dir = await mkdtemp(join(tmpdir(), "git-insight-merge-"));
  try {
    const oursPath = join(dir, "ours");
    const basePath = join(dir, "base");
    const theirsPath = join(dir, "theirs");
    await writeFile(oursPath, oursContent, "utf8");
    await writeFile(basePath, baseContent ?? "", "utf8");
    await writeFile(theirsPath, theirsContent, "utf8");

    const merged = await runGit(
      cwd,
      [
        "merge-file",
        "-p",
        "--diff3",
        "-L",
        `ours:${path}`,
        "-L",
        "base",
        "-L",
        `theirs:${path}`,
        oursPath,
        basePath,
        theirsPath,
      ],
      { allowFail: true },
    );

    const text = merged.stdout || null;
    return {
      conflictContent: text ? truncate(text) : null,
      oursContent,
      theirsContent,
      baseContent,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
