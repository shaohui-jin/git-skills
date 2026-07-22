import { spawn } from "node:child_process";
import {
  ensureRev,
  resolveRepoRoot,
  runGit,
  tryMergeBase,
} from "../git/runner.js";
import type {
  CommitRef,
  ConflictBlameResult,
  ConflictHunk,
  MergeOptions,
} from "../types.js";
import { mapProgress, reportProgress } from "../progress.js";
import { previewMerge } from "./preview.js";

async function fileExistsAt(repoRoot: string, rev: string, path: string): Promise<boolean> {
  const result = await runGit(repoRoot, ["cat-file", "-e", `${rev}:${path}`], {
    allowFail: true,
  });
  return result.code === 0;
}

/** Parse unified diff -U0 hunks into inclusive line ranges on the new side. */
function parseNewSideRanges(diff: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const re = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(diff)) !== null) {
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    if (count === 0) {
      continue;
    }
    ranges.push([start, start + count - 1]);
  }
  return ranges;
}

async function diffRanges(
  repoRoot: string,
  base: string,
  tip: string,
  path: string,
): Promise<Array<[number, number]>> {
  const { stdout } = await runGit(
    repoRoot,
    ["diff", "-U0", `${base}...${tip}`, "--", path],
    { allowFail: true },
  );
  return parseNewSideRanges(stdout);
}

async function blameRange(
  repoRoot: string,
  rev: string,
  path: string,
  range: [number, number],
): Promise<CommitRef[]> {
  const [start, end] = range;
  if (start <= 0 || end < start) {
    return [];
  }
  const { stdout } = await runGit(
    repoRoot,
    [
      "blame",
      "-l",
      "-w",
      `-L${start},${end}`,
      "--line-porcelain",
      rev,
      "--",
      path,
    ],
    { allowFail: true },
  );
  if (!stdout.trim()) {
    return [];
  }

  const bySha = new Map<string, CommitRef>();
  const lines = stdout.split("\n");
  let currentSha = "";
  let author = "";
  let summary = "";

  for (const line of lines) {
    if (/^[0-9a-f]{40}/.test(line)) {
      currentSha = line.slice(0, 40);
      continue;
    }
    if (line.startsWith("author ")) {
      author = line.slice("author ".length);
      continue;
    }
    if (line.startsWith("summary ")) {
      summary = line.slice("summary ".length);
      continue;
    }
    if (line.startsWith("\t") && currentSha && !bySha.has(currentSha)) {
      bySha.set(currentSha, {
        sha: currentSha,
        author,
        message: summary,
      });
    }
  }
  return [...bySha.values()];
}

async function lookupPrForCommit(cwd: string, shaShort: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn(
      "gh",
      ["pr", "list", "--search", shaShort, "--state", "all", "--json", "number", "--limit", "1"],
      { cwd, windowsHide: true, env: { ...process.env, GH_PROMPT_DISABLED: "1" } },
    );
    let stdout = "";
    child.stdout.on("data", (b: Buffer) => {
      stdout += b.toString("utf8");
    });
    child.on("error", () => resolve(undefined));
    child.on("close", (code) => {
      if (code !== 0) {
        resolve(undefined);
        return;
      }
      try {
        const arr = JSON.parse(stdout) as Array<{ number: number }>;
        resolve(arr[0] ? `#${arr[0].number}` : undefined);
      } catch {
        resolve(undefined);
      }
    });
  });
}

async function attachOptionalPr(repoRoot: string, commits: CommitRef[]): Promise<CommitRef[]> {
  const out: CommitRef[] = [];
  for (const c of commits) {
    const pr = await lookupPrForCommit(repoRoot, c.sha.slice(0, 7));
    out.push(pr ? { ...c, pr } : c);
  }
  return out;
}

async function blameFile(
  repoRoot: string,
  intoSha: string,
  fromSha: string,
  base: string,
  path: string,
): Promise<ConflictHunk[]> {
  const intoExists = await fileExistsAt(repoRoot, intoSha, path);
  const fromExists = await fileExistsAt(repoRoot, fromSha, path);
  if (!intoExists && !fromExists) {
    return [];
  }

  const oursRanges = intoExists ? await diffRanges(repoRoot, base, intoSha, path) : [];
  const theirsRanges = fromExists ? await diffRanges(repoRoot, base, fromSha, path) : [];

  const ours =
    oursRanges.length > 0 ? oursRanges : intoExists ? ([[1, 1]] as Array<[number, number]>) : [];
  const theirs =
    theirsRanges.length > 0
      ? theirsRanges
      : fromExists
        ? ([[1, 1]] as Array<[number, number]>)
        : [];

  const max = Math.max(ours.length, theirs.length, 1);
  const hunks: ConflictHunk[] = [];

  for (let i = 0; i < max; i++) {
    const oursRange = ours[i] ?? ours[0] ?? ([0, 0] as [number, number]);
    const theirsRange = theirs[i] ?? theirs[0] ?? ([0, 0] as [number, number]);

    let oursCommits: CommitRef[] = [];
    let theirsCommits: CommitRef[] = [];

    if (intoExists && oursRange[0] > 0) {
      oursCommits = await attachOptionalPr(
        repoRoot,
        await blameRange(repoRoot, intoSha, path, oursRange),
      );
    }
    if (fromExists && theirsRange[0] > 0) {
      theirsCommits = await attachOptionalPr(
        repoRoot,
        await blameRange(repoRoot, fromSha, path, theirsRange),
      );
    }

    hunks.push({
      path,
      oursRange,
      theirsRange,
      oursCommits,
      theirsCommits,
    });
  }

  return hunks;
}

/**
 * Preview merge then attach blame provenance for conflicting paths.
 */
export async function conflictBlame(options: MergeOptions): Promise<ConflictBlameResult> {
  const onProgress = options.onProgress;
  // previewMerge 占 0–45；内部会把进度报到 100，这里包一层映射
  const preview = await previewMerge({
    ...options,
    onProgress: onProgress
      ? (u) => mapProgress(onProgress, 0, 45, u.percent / 100, u.label)
      : undefined,
  });
  if (preview.clean || preview.conflictFiles.length === 0) {
    await reportProgress(onProgress, 100, "完成");
    return {
      ...preview,
      blamed: [],
    };
  }

  const repoRoot = await resolveRepoRoot(options.cwd);
  const intoSha = preview.intoSha || (await ensureRev(repoRoot, options.into));
  const fromSha = preview.fromSha || (await ensureRev(repoRoot, options.from));
  const base =
    preview.mergeBase ||
    (await tryMergeBase(repoRoot, intoSha, fromSha)) ||
    "4b825dc642cb6eb9a060e54bf8d0927f6fb5fb496";

  const maxFiles = options.maxBlameFiles ?? 20;
  const paths = preview.conflictFiles
    .map((f) => f.path)
    .filter((p) => p && p !== "(unknown)")
    .slice(0, maxFiles);

  await reportProgress(onProgress, 48, `溯源冲突文件（0/${paths.length}）…`);
  const blamed: ConflictHunk[] = [];
  for (let i = 0; i < paths.length; i++) {
    const path = paths[i]!;
    const hunks = await blameFile(repoRoot, intoSha, fromSha, base, path);
    blamed.push(...hunks);
    await mapProgress(
      onProgress,
      48,
      100,
      paths.length === 0 ? 1 : (i + 1) / paths.length,
      `溯源冲突文件（${i + 1}/${paths.length}）：${path}`,
    );
  }

  await reportProgress(onProgress, 100, "溯源完成");
  return {
    ...preview,
    blamed,
  };
}
