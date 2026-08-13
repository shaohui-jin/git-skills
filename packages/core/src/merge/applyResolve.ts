import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { reportProgress } from "../progress.js";
import type { ProgressReporter } from "../types.js";
import { GitError, ensureRev, resolveRepoRoot, runGit } from "../git/runner.js";
import { branchNameForMr } from "./branchName.js";
import { listRemotes } from "../git/remotes.js";
import {
  autoResolveConflicts,
  builtinResolvers,
  type ConflictResolver,
} from "./resolvers.js";

export interface StashFilePayload {
  path: string;
  resolvedContent: string;
}

export interface ApplyResolveOptions {
  cwd?: string;
  /** 线上 / 合入目标（预演 into / 左栏） */
  into: string;
  /** 我的分支 / 待提交（预演 from / 右栏） */
  from: string;
  /**
   * 暂存的已解决文件（需含 resolvedContent）。
   * 干净合并可传空数组：仅临时分支 + merge + push。
   */
  files: StashFilePayload[];
  /** 远程名，默认 origin */
  remote?: string;
  /** 是否 push，默认 true */
  push?: boolean;
  /** 自定义临时分支名；默认 merge/<from>-into-<into> */
  tempBranch?: string;
  /**
   * 机械冲突的自动解法（.gitignore 并集、lockfile 重算…）。默认只用内置的无副作用集合。
   *
   * 安全约束：**永远不要用仓库里的文件来组装这个数组**。regenerate 类 resolver 会执行命令，
   * 而预演别人的分支正是本工具的主要用法。详见 merge/resolvers.ts 文件头。
   */
  resolvers?: readonly ConflictResolver[];
  onProgress?: ProgressReporter;
}

export interface ApplyResolveResult {
  repoRoot: string;
  into: string;
  from: string;
  tempBranch: string;
  intoSha: string;
  fromSha: string;
  commitSha: string;
  pushed: boolean;
  remote: string;
  /** 浏览器打开即可创建 MR/PR（不做 API 提交） */
  createMrUrl: string | null;
  /** 主工作区当前分支（全程不切换） */
  previousBranch: string | null;
  /** 是否使用了独立 worktree（主工作区未 checkout） */
  usedWorktree: boolean;
  messages: string[];
}

function slugRef(ref: string, remotes: string[] = ["origin"]): string {
  return branchNameForMr(ref, remotes)
    .replace(/[^a-zA-Z0-9._/-]+/g, "-")
    .replace(/\/+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function defaultTempBranchName(
  into: string,
  from: string,
  remotes: string[] = ["origin"],
): string {
  return `merge/${slugRef(from, remotes)}-into-${slugRef(into, remotes)}`;
}

async function currentBranch(cwd: string): Promise<string | null> {
  const r = await runGit(cwd, ["branch", "--show-current"], { allowFail: true });
  const name = r.stdout.trim();
  return name || null;
}

async function removeWorktree(repoRoot: string, wtPath: string): Promise<void> {
  await runGit(repoRoot, ["worktree", "remove", "--force", wtPath], { allowFail: true });
  await rm(wtPath, { recursive: true, force: true });
  await runGit(repoRoot, ["worktree", "prune"], { allowFail: true });
}

/**
 * 将 git remote URL 转为可在浏览器打开的「新建 MR/PR」页。
 * 支持 https / ssh 形态的 GitLab、GitHub；无法识别时返回 null。
 */
export function buildCreateMrUrl(
  remoteUrl: string,
  sourceBranch: string,
  targetBranch: string,
): string | null {
  let url = remoteUrl.trim();
  if (!url) {
    return null;
  }
  if (url.startsWith("git@")) {
    // git@host:group/repo.git
    const m = url.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
    if (!m) {
      return null;
    }
    url = `https://${m[1]}/${m[2]}`;
  } else if (url.startsWith("ssh://git@")) {
    url = url.replace(/^ssh:\/\/git@/, "https://").replace(/\.git$/, "");
  } else {
    url = url.replace(/\.git$/, "");
  }

  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const path = u.pathname.replace(/^\/+|\/+$/g, "");
    const src = encodeURIComponent(sourceBranch);
    const tgt = encodeURIComponent(targetBranch);

    if (host.includes("github")) {
      return `${u.origin}/${path}/compare/${encodeURIComponent(targetBranch)}...${encodeURIComponent(sourceBranch)}?expand=1`;
    }
    // GitLab 及多数自建（含 gitlab. 子域）
    if (host.includes("gitlab") || host.includes("git.")) {
      return `${u.origin}/${path}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${src}&merge_request%5Btarget_branch%5D=${tgt}`;
    }
    // 默认按 GitLab 新建 MR 查询串尝试
    return `${u.origin}/${path}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${src}&merge_request%5Btarget_branch%5D=${tgt}`;
  } catch {
    return null;
  }
}

async function remoteHttpsOrSsh(cwd: string, remote: string): Promise<string> {
  const r = await runGit(cwd, ["remote", "get-url", remote], { allowFail: true });
  return r.stdout.trim();
}

async function listUnmerged(cwd: string): Promise<string[]> {
  const r = await runGit(cwd, ["diff", "--name-only", "--diff-filter=U"], {
    allowFail: true,
  });
  return r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * regenerate 类 resolver 的执行入口。刻意不走 shell：参数原样传给 execve，
 * 路径里的空格、引号、`&&` 都只是普通字符，构造不出注入。
 */
function runInWorktree(
  workDir: string,
  cmd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, {
      cwd: workDir,
      windowsHide: true,
      shell: false,
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (b: Buffer) => {
      stdout += b.toString("utf8");
    });
    child.stderr?.on("data", (b: Buffer) => {
      stderr += b.toString("utf8");
    });
    child.on("error", (err) => {
      resolvePromise({ code: 127, stdout: "", stderr: err.message });
    });
    child.on("close", (code) => {
      resolvePromise({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function writeStashFiles(
  workDir: string,
  files: StashFilePayload[],
): Promise<void> {
  for (const f of files) {
    const rel = f.path.replace(/\\/g, "/");
    const abs = join(workDir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, f.resolvedContent, "utf8");
    await runGit(workDir, ["add", "--", rel]);
  }
}

/**
 * 方案 A 一键解决冲突（独立 git worktree，不切换主工作区 HEAD）：
 * 1) 在临时目录 `worktree add -B` 基于 into 的临时分支
 * 2) 在该 worktree 内 merge from，按暂存 resolvedContent 写回并 commit
 * 3) 可选 push，然后移除 worktree
 * MR：只生成创建页 URL，不自动调 GitLab/GitHub API（后续可接 glab/gh）。
 */
export async function applyStashedResolve(
  options: ApplyResolveOptions,
): Promise<ApplyResolveResult> {
  const onProgress = options.onProgress;
  const remote = options.remote ?? "origin";
  const doPush = options.push !== false;
  const repoRoot = await resolveRepoRoot(options.cwd);
  const remotes = (await listRemotes(repoRoot)).map((r) => r.name);
  const into = options.into.trim();
  const from = options.from.trim();
  const tempBranch =
    options.tempBranch?.trim() || defaultTempBranchName(into, from, remotes);
  const resolvers = options.resolvers ?? builtinResolvers;

  if (!into || !from) {
    throw new GitError("into / from 不能为空", { code: "USAGE" });
  }
  const files = options.files ?? [];
  for (const f of files) {
    if (!f.path || f.resolvedContent == null) {
      throw new GitError(`暂存文件缺少 path 或 resolvedContent：${f.path}`, {
        code: "INVALID_STASH",
      });
    }
  }

  const messages: string[] = [];
  const previousBranch = await currentBranch(repoRoot);
  reportProgress(onProgress, 5, "解析分支…");
  const intoSha = await ensureRev(repoRoot, into);
  const fromSha = await ensureRev(repoRoot, from);

  // 临时分支若已在主工作区检出，worktree add 会失败
  if (previousBranch === tempBranch) {
    throw new GitError(
      `主工作区当前正在检出临时分支「${tempBranch}」，请先切回其他分支后再一键解决`,
      { code: "TEMP_BRANCH_CHECKED_OUT" },
    );
  }

  reportProgress(onProgress, 12, `创建独立 worktree（分支 ${tempBranch}）…`);
  const wtPath = await mkdtemp(join(tmpdir(), "git-insight-resolve-"));

  try {
    const addRun = await runGit(
      repoRoot,
      ["worktree", "add", "-B", tempBranch, wtPath, intoSha],
      { allowFail: true },
    );
    if (addRun.code !== 0) {
      throw new GitError(
        `无法创建 worktree（主工作区未改动）：${(addRun.stderr || addRun.stdout).trim()}` +
          `\n若「${tempBranch}」已在其他 worktree 中检出，请先移除该 worktree。`,
        { code: "WORKTREE_ADD_FAILED", stderr: addRun.stderr, stdout: addRun.stdout },
      );
    }
    messages.push(`已在独立 worktree 处理：${wtPath}`);
    messages.push(
      previousBranch
        ? `主工作区保持在「${previousBranch}」，未切换分支`
        : "主工作区 HEAD 未切换",
    );

    reportProgress(onProgress, 35, `合并 ${from}（与预演同向）…`);
    const mergeRun = await runGit(
      wtPath,
      ["merge", "--no-ff", "--no-commit", fromSha],
      { allowFail: true },
    );

    const unmerged = await listUnmerged(wtPath);
    const stashPaths = new Set(files.map((f) => f.path.replace(/\\/g, "/")));
    /** resolver 处理掉的文件，形如 `.gitignore (union)`；进 commit message 好留痕 */
    const autoNotes: string[] = [];

    if (mergeRun.code !== 0 || unmerged.length > 0) {
      // resolver 先过一遍：.gitignore、lockfile 这类机械冲突不该占用人的注意力。
      // 只处理没暂存裁决的文件——人已经选过边的，人说了算。
      const autoTargets = unmerged
        .map((p) => p.replace(/\\/g, "/"))
        .filter((p) => !stashPaths.has(p));
      const auto =
        resolvers.length > 0 && autoTargets.length > 0
          ? await autoResolveConflicts({
              workDir: wtPath,
              paths: autoTargets,
              resolvers,
              run: (cmd, args) => runInWorktree(wtPath, cmd, args),
            })
          : [];
      if (auto.length > 0) {
        await writeStashFiles(
          wtPath,
          auto.map((a) => ({ path: a.path, resolvedContent: a.content })),
        );
        for (const a of auto) {
          stashPaths.add(a.path);
          messages.push(`自动解决 ${a.path}（${a.resolverId}）`);
          autoNotes.push(`${a.path} (${a.resolverId})`);
        }
      }

      if (files.length === 0 && auto.length === 0) {
        await runGit(wtPath, ["merge", "--abort"], { allowFail: true });
        throw new GitError(
          "合并存在冲突，请先在预演中完成选边，再使用「一键解决并推送」",
          { code: "HAS_CONFLICTS" },
        );
      }
      if (files.length > 0) {
        reportProgress(onProgress, 50, `写入暂存解决结果（${files.length} 文件）…`);
        await writeStashFiles(wtPath, files);
      }

      const still = await listUnmerged(wtPath);
      const missing = still.filter((p) => !stashPaths.has(p.replace(/\\/g, "/")));
      if (missing.length > 0) {
        await runGit(wtPath, ["merge", "--abort"], { allowFail: true });
        throw new GitError(
          `以下冲突文件没有暂存解决结果，已中止合并（主工作区未改动）：\n${missing.join("\n")}`,
          { code: "UNRESOLVED_LEFT", args: missing },
        );
      }
      if (files.length > 0) {
        messages.push(`已按暂存覆盖 ${files.length} 个冲突文件`);
      }
    } else if (files.length > 0) {
      reportProgress(onProgress, 50, "合并无冲突，同步写入暂存文件…");
      await writeStashFiles(wtPath, files);
      messages.push("git merge 无冲突；已按暂存内容对齐文件");
    } else {
      reportProgress(onProgress, 50, "合并无冲突（干净合并）…");
      messages.push("git merge 无冲突；将提交合并结果到临时分支");
    }

    const resolvedAny = files.length > 0 || autoNotes.length > 0;
    reportProgress(onProgress, 70, resolvedAny ? "提交解决冲突…" : "提交合并…");
    const commitMsg = resolvedAny
      ? [
          `resolve: merge ${from} into ${into} via ${tempBranch}`,
          "",
          "Applied stash choices from Git Insight merge preview (scheme A, worktree).",
          autoNotes.length > 0
            ? `Auto-resolved by resolver: ${autoNotes.join(", ")}`
            : "",
        ]
          .filter(Boolean)
          .join("\n")
      : [
          `merge: ${from} into ${into} via ${tempBranch}`,
          "",
          "Clean merge via Git Insight temp branch (scheme A, worktree).",
        ].join("\n");

    const commitRun = await runGit(wtPath, ["commit", "-m", commitMsg], {
      allowFail: true,
    });
    if (commitRun.code !== 0) {
      await runGit(wtPath, ["merge", "--abort"], { allowFail: true });
      const detail = (commitRun.stderr || commitRun.stdout).trim();
      if (/nothing to commit|no changes added|did not stash/i.test(detail) ||
          /nothing to commit/i.test(mergeRun.stdout + mergeRun.stderr)) {
        throw new GitError(
          `没有可合并的新提交（${from} → ${into}），无需推送临时分支`,
          { code: "NOTHING_TO_MERGE" },
        );
      }
      // merge 已是 "Already up to date" 时往往没有 MERGE_HEAD，commit 也会失败
      if (/Already up to date/i.test(mergeRun.stdout + mergeRun.stderr)) {
        throw new GitError(
          `没有可合并的新提交（${from} → ${into}），无需推送临时分支`,
          { code: "NOTHING_TO_MERGE" },
        );
      }
      throw new GitError(
        `提交失败（主工作区未改动）：${detail}`,
        { code: "COMMIT_FAILED" },
      );
    }

    const head = await runGit(wtPath, ["rev-parse", "HEAD"]);
    const commitSha = head.stdout.trim();
    messages.push(`已提交 ${commitSha.slice(0, 7)} @ ${tempBranch}`);

    let pushed = false;
    if (doPush) {
      reportProgress(onProgress, 85, `推送 ${remote} ${tempBranch}…`);
      const pushRun = await runGit(
        wtPath,
        ["push", "-u", remote, `HEAD:refs/heads/${tempBranch}`],
        { allowFail: true },
      );
      if (pushRun.code !== 0) {
        throw new GitError(
          `本地临时分支已提交，但推送失败（主工作区仍在原分支）：${(pushRun.stderr || pushRun.stdout).trim()}`,
          { code: "PUSH_FAILED", stderr: pushRun.stderr, stdout: pushRun.stdout },
        );
      }
      pushed = true;
      messages.push(`已推送 ${remote}/${tempBranch}`);
    }

    reportProgress(onProgress, 95, "生成创建 MR 链接…");
    const remoteUrl = await remoteHttpsOrSsh(repoRoot, remote);
    const createMrUrl = buildCreateMrUrl(
      remoteUrl,
      tempBranch,
      branchNameForMr(into, remotes),
    );

    reportProgress(onProgress, 100, "完成");
    return {
      repoRoot,
      into,
      from,
      tempBranch,
      intoSha,
      fromSha,
      commitSha,
      pushed,
      remote,
      createMrUrl,
      previousBranch,
      usedWorktree: true,
      messages,
    };
  } finally {
    await removeWorktree(repoRoot, wtPath);
  }
}
