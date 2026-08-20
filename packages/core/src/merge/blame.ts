import { spawn } from "node:child_process";
import { EMPTY_TREE_SHA } from "../git/constants.js";
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
import { mapLimit } from "../util/concurrency.js";
import { previewMerge } from "./preview.js";

/** 每个文件要跑 cat-file / diff / blame，几路并行足够压掉串行等待又不至于压垮机器 */
const FILE_CONCURRENCY = 4;
const HUNK_CONCURRENCY = 4;

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
  let authorEmail = "";
  let authorTime: number | undefined;
  let summary = "";

  for (const line of lines) {
    if (/^[0-9a-f]{40}/.test(line)) {
      currentSha = line.slice(0, 40);
      author = "";
      authorEmail = "";
      authorTime = undefined;
      summary = "";
      continue;
    }
    if (line.startsWith("author ")) {
      author = line.slice("author ".length);
      continue;
    }
    if (line.startsWith("author-mail ")) {
      authorEmail = line.slice("author-mail ".length).replace(/^<|>$/g, "");
      continue;
    }
    if (line.startsWith("author-time ")) {
      const n = Number(line.slice("author-time ".length));
      authorTime = Number.isFinite(n) ? n : undefined;
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
        time: authorTime,
        authorEmail: authorEmail || undefined,
      });
    }
  }
  return [...bySha.values()];
}

const PR_LOOKUP_TIMEOUT_MS = 4_000;

interface PrLookup {
  /** false = gh 不可用 / 未登录 / 非 GitHub 仓库，调用方应停止后续尝试 */
  ok: boolean;
  pr?: string;
}

async function lookupPrForCommit(cwd: string, shaShort: string): Promise<PrLookup> {
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    const finish = (result: PrLookup): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      resolve(result);
    };

    const child = spawn(
      "gh",
      ["pr", "list", "--search", shaShort, "--state", "all", "--json", "number", "--limit", "1"],
      { cwd, windowsHide: true, env: { ...process.env, GH_PROMPT_DISABLED: "1" } },
    );
    timer = setTimeout(() => {
      child.kill();
      finish({ ok: false });
    }, PR_LOOKUP_TIMEOUT_MS);

    let stdout = "";
    child.stdout.on("data", (b: Buffer) => {
      stdout += b.toString("utf8");
    });
    child.on("error", () => finish({ ok: false }));
    child.on("close", (code) => {
      if (code !== 0) {
        finish({ ok: false });
        return;
      }
      try {
        const arr = JSON.parse(stdout) as Array<{ number: number }>;
        finish({ ok: true, pr: arr[0] ? `#${arr[0].number}` : undefined });
      } catch {
        finish({ ok: false });
      }
    });
  });
}

type AttachPr = (commits: CommitRef[]) => Promise<CommitRef[]>;

/**
 * 关联 PR 要为每个 commit 跑一次 `gh`（网络调用），冲突文件多时是预演里最慢的一环。
 * 因此默认关闭；开启后单次预演内按 sha 去重，并在首次失败后熔断
 * （GitLab 仓库、没装 gh、未登录都会立刻停手，而不是每个 commit 白等一遍）。
 */
function createPrResolver(cwd: string, enabled: boolean): AttachPr {
  const cache = new Map<string, Promise<PrLookup>>();
  let broken = false;

  return async function attachPr(commits: CommitRef[]): Promise<CommitRef[]> {
    if (!enabled || broken || commits.length === 0) {
      return commits;
    }
    return Promise.all(
      commits.map(async (c) => {
        if (broken) {
          return c;
        }
        const key = c.sha.slice(0, 7);
        let pending = cache.get(key);
        if (!pending) {
          pending = lookupPrForCommit(cwd, key);
          cache.set(key, pending);
        }
        const result = await pending;
        if (!result.ok) {
          broken = true;
          return c;
        }
        return result.pr ? { ...c, pr: result.pr } : c;
      }),
    );
  };
}

async function blameFile(
  repoRoot: string,
  intoSha: string,
  fromSha: string,
  base: string,
  path: string,
  attachPr: AttachPr,
): Promise<ConflictHunk[]> {
  const [intoExists, fromExists] = await Promise.all([
    fileExistsAt(repoRoot, intoSha, path),
    fileExistsAt(repoRoot, fromSha, path),
  ]);
  if (!intoExists && !fromExists) {
    return [];
  }

  const noRanges = async (): Promise<Array<[number, number]>> => [];
  const [oursRanges, theirsRanges] = await Promise.all([
    intoExists ? diffRanges(repoRoot, base, intoSha, path) : noRanges(),
    fromExists ? diffRanges(repoRoot, base, fromSha, path) : noRanges(),
  ]);

  const ours =
    oursRanges.length > 0 ? oursRanges : intoExists ? ([[1, 1]] as Array<[number, number]>) : [];
  const theirs =
    theirsRanges.length > 0
      ? theirsRanges
      : fromExists
        ? ([[1, 1]] as Array<[number, number]>)
        : [];

  const max = Math.max(ours.length, theirs.length, 1);

  const sideCommits = async (
    exists: boolean,
    range: [number, number],
    rev: string,
  ): Promise<CommitRef[]> => {
    if (!exists || range[0] <= 0) {
      return [];
    }
    return attachPr(await blameRange(repoRoot, rev, path, range));
  };

  const indexes = Array.from({ length: max }, (_, i) => i);
  return mapLimit(indexes, HUNK_CONCURRENCY, async (i) => {
    const oursRange = ours[i] ?? ours[0] ?? ([0, 0] as [number, number]);
    const theirsRange = theirs[i] ?? theirs[0] ?? ([0, 0] as [number, number]);
    const [oursCommits, theirsCommits] = await Promise.all([
      sideCommits(intoExists, oursRange, intoSha),
      sideCommits(fromExists, theirsRange, fromSha),
    ]);
    return {
      path,
      oursRange,
      theirsRange,
      oursCommits,
      theirsCommits,
    };
  });
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
    EMPTY_TREE_SHA;

  const maxFiles = options.maxBlameFiles ?? 20;
  const paths = preview.conflictFiles
    .map((f) => f.path)
    .filter((p) => p && p !== "(unknown)")
    .slice(0, maxFiles);

  await reportProgress(onProgress, 48, `溯源冲突文件（0/${paths.length}）…`);
  const attachPr = createPrResolver(repoRoot, options.lookupPr === true);
  let finished = 0;
  const perFile = await mapLimit(paths, FILE_CONCURRENCY, async (path) => {
    const hunks = await blameFile(repoRoot, intoSha, fromSha, base, path, attachPr);
    finished += 1;
    await mapProgress(
      onProgress,
      48,
      100,
      finished / paths.length,
      `溯源冲突文件（${finished}/${paths.length}）：${path}`,
    );
    return hunks;
  });
  const blamed: ConflictHunk[] = perFile.flat();

  await reportProgress(onProgress, 100, "溯源完成");
  return {
    ...preview,
    blamed,
  };
}
