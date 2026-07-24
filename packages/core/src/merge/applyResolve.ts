import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { reportProgress } from "../progress.js";
import type { ProgressReporter } from "../types.js";
import { GitError, ensureRev, resolveRepoRoot, runGit } from "../git/runner.js";

export interface StashFilePayload {
  path: string;
  resolvedContent: string;
}

export interface ApplyResolveOptions {
  cwd?: string;
  /** 目标分支（预演 into / 左） */
  into: string;
  /** 待合并分支（预演 from / 右） */
  from: string;
  /** 暂存的已解决文件（需含 resolvedContent） */
  files: StashFilePayload[];
  /** 远程名，默认 origin */
  remote?: string;
  /** 是否 push，默认 true */
  push?: boolean;
  /** 自定义临时分支名；默认 merge/<from>-into-<into> */
  tempBranch?: string;
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
  previousBranch: string | null;
  messages: string[];
}

function slugRef(ref: string): string {
  return ref
    .replace(/^refs\/heads\//, "")
    .replace(/^refs\/remotes\/[^/]+\//, "")
    .replace(/[^a-zA-Z0-9._/-]+/g, "-")
    .replace(/\/+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function defaultTempBranchName(into: string, from: string): string {
  return `merge/${slugRef(from)}-into-${slugRef(into)}`;
}

async function currentBranch(cwd: string): Promise<string | null> {
  const r = await runGit(cwd, ["branch", "--show-current"], { allowFail: true });
  const name = r.stdout.trim();
  return name || null;
}

async function assertCleanWorktree(cwd: string): Promise<void> {
  const { stdout } = await runGit(cwd, ["status", "--porcelain"]);
  if (stdout.trim()) {
    throw new GitError(
      "工作区或暂存区不干净，请先 commit / stash / 丢弃本地修改后再一键解决冲突",
      { code: "DIRTY_WORKTREE", args: ["status", "--porcelain"] },
    );
  }
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
 * 方案 A 一键解决冲突：
 * 1) 从 into 创建临时分支
 * 2) merge from，按暂存 resolvedContent 写回并 commit
 * 3) 可选 push
 * MR：只生成创建页 URL，不自动调 GitLab/GitHub API（后续可接 glab/gh）。
 */
export async function applyStashedResolve(
  options: ApplyResolveOptions,
): Promise<ApplyResolveResult> {
  const onProgress = options.onProgress;
  const remote = options.remote ?? "origin";
  const doPush = options.push !== false;
  const repoRoot = await resolveRepoRoot(options.cwd);
  const into = options.into.trim();
  const from = options.from.trim();
  const tempBranch =
    options.tempBranch?.trim() || defaultTempBranchName(into, from);

  if (!into || !from) {
    throw new GitError("into / from 不能为空", { code: "USAGE" });
  }
  if (!options.files.length) {
    throw new GitError("没有可应用的暂存文件（需要 resolvedContent）", {
      code: "NO_STASH_FILES",
    });
  }
  for (const f of options.files) {
    if (!f.path || f.resolvedContent == null) {
      throw new GitError(`暂存文件缺少 path 或 resolvedContent：${f.path}`, {
        code: "INVALID_STASH",
      });
    }
  }

  const messages: string[] = [];
  reportProgress(onProgress, 2, "检查工作区…");
  await assertCleanWorktree(repoRoot);

  const previousBranch = await currentBranch(repoRoot);
  reportProgress(onProgress, 8, "解析分支…");
  const intoSha = await ensureRev(repoRoot, into);
  const fromSha = await ensureRev(repoRoot, from);

  reportProgress(onProgress, 15, `创建临时分支 ${tempBranch}（基于 ${into}）…`);
  // -B：已存在则重置到 into，避免脏历史
  await runGit(repoRoot, ["checkout", "-B", tempBranch, intoSha]);

  reportProgress(onProgress, 35, `合并 ${from}（与预演同向）…`);
  const mergeRun = await runGit(
    repoRoot,
    ["merge", "--no-ff", "--no-commit", fromSha],
    { allowFail: true },
  );

  const unmerged = await listUnmerged(repoRoot);
  const stashPaths = new Set(options.files.map((f) => f.path.replace(/\\/g, "/")));

  if (mergeRun.code !== 0 || unmerged.length > 0) {
    reportProgress(onProgress, 50, `写入暂存解决结果（${options.files.length} 文件）…`);
    for (const f of options.files) {
      const rel = f.path.replace(/\\/g, "/");
      const abs = join(repoRoot, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, f.resolvedContent, "utf8");
      await runGit(repoRoot, ["add", "--", rel]);
    }

    const still = await listUnmerged(repoRoot);
    const missing = still.filter((p) => !stashPaths.has(p.replace(/\\/g, "/")));
    if (missing.length > 0) {
      // 尽量中止 merge，避免留下半成品
      await runGit(repoRoot, ["merge", "--abort"], { allowFail: true });
      if (previousBranch) {
        await runGit(repoRoot, ["checkout", previousBranch], { allowFail: true });
      }
      throw new GitError(
        `以下冲突文件没有暂存解决结果，已中止合并：\n${missing.join("\n")}`,
        { code: "UNRESOLVED_LEFT", args: missing },
      );
    }
    messages.push(`已按暂存覆盖 ${options.files.length} 个冲突文件`);
  } else {
    // 干净合并：仍写入暂存文件，保证与预演选择一致（若有）
    reportProgress(onProgress, 50, "合并无冲突，同步写入暂存文件…");
    for (const f of options.files) {
      const rel = f.path.replace(/\\/g, "/");
      const abs = join(repoRoot, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, f.resolvedContent, "utf8");
      await runGit(repoRoot, ["add", "--", rel]);
    }
    messages.push("git merge 无冲突；已按暂存内容对齐文件");
  }

  reportProgress(onProgress, 70, "提交解决冲突…");
  const commitMsg = [
    `resolve: merge ${from} into ${into} via ${tempBranch}`,
    "",
    "Applied stash choices from Git Insight merge preview (scheme A).",
  ].join("\n");

  // 若无任何变更可提交（极端情况）
  const staged = await runGit(repoRoot, ["diff", "--cached", "--quiet"], {
    allowFail: true,
  });
  const unstaged = await runGit(repoRoot, ["diff", "--quiet"], { allowFail: true });
  if (staged.code === 0 && unstaged.code === 0 && mergeRun.code === 0) {
    // merge --no-commit 成功但无 diff：仍需完成 merge commit
  }

  const commitRun = await runGit(repoRoot, ["commit", "-m", commitMsg], {
    allowFail: true,
  });
  if (commitRun.code !== 0) {
    await runGit(repoRoot, ["merge", "--abort"], { allowFail: true });
    if (previousBranch) {
      await runGit(repoRoot, ["checkout", previousBranch], { allowFail: true });
    }
    throw new GitError(
      `提交失败：${(commitRun.stderr || commitRun.stdout).trim()}`,
      { code: "COMMIT_FAILED" },
    );
  }

  const head = await runGit(repoRoot, ["rev-parse", "HEAD"]);
  const commitSha = head.stdout.trim();
  messages.push(`已提交 ${commitSha.slice(0, 7)} @ ${tempBranch}`);

  let pushed = false;
  if (doPush) {
    reportProgress(onProgress, 85, `推送 ${remote} ${tempBranch}…`);
    const pushRun = await runGit(
      repoRoot,
      ["push", "-u", remote, `HEAD:refs/heads/${tempBranch}`],
      { allowFail: true },
    );
    if (pushRun.code !== 0) {
      throw new GitError(
        `本地已提交，但推送失败：${(pushRun.stderr || pushRun.stdout).trim()}`,
        { code: "PUSH_FAILED", stderr: pushRun.stderr, stdout: pushRun.stdout },
      );
    }
    pushed = true;
    messages.push(`已推送 ${remote}/${tempBranch}`);
  }

  reportProgress(onProgress, 95, "生成创建 MR 链接…");
  const remoteUrl = await remoteHttpsOrSsh(repoRoot, remote);
  const createMrUrl = buildCreateMrUrl(remoteUrl, tempBranch, into);

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
    messages,
  };
}
