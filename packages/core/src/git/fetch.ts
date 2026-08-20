import type { FetchResult, ProgressReporter } from "../types.js";
import { mapProgress, reportProgress, withSoftProgress } from "../progress.js";
import type { GitAuthOptions } from "./auth.js";
import { resolveRepoRoot, runGit } from "./runner.js";

function parseGitProgressPercent(line: string): number | null {
  const m = line.match(/(\d+)%/);
  if (!m) {
    return null;
  }
  const n = Number(m[1]);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
}

async function runFetchOnce(
  repoRoot: string,
  remote: string,
  onProgress: ProgressReporter | undefined,
  opts: {
    auth?: GitAuthOptions;
    interactive?: boolean;
    label: string;
  },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return withSoftProgress(onProgress, 2, 98, opts.label, () =>
    runGit(repoRoot, ["fetch", "--prune", "--progress", remote], {
      allowFail: true,
      auth: opts.auth,
      interactive: opts.interactive,
      onStderrLine: (line) => {
        const pct = parseGitProgressPercent(line);
        if (pct == null) {
          return;
        }
        mapProgress(onProgress, 5, 95, pct / 100, `Fetch ${remote}：${pct}%`);
      },
    }),
  );
}

/**
 * 非交互探测：本机 Git 是否已能访问远程（凭据/SSH/已登录）。
 */
export async function probeRemoteAccess(
  repoRoot: string,
  remote = "origin",
): Promise<boolean> {
  const result = await runGit(
    repoRoot,
    ["ls-remote", "--exit-code", remote, "HEAD"],
    { allowFail: true },
  );
  return result.code === 0;
}

/** @deprecated 保留导出 */
export async function resolveFetchAuth(
  _repoRoot: string,
  _remote: string,
  auth?: GitAuthOptions,
): Promise<GitAuthOptions | undefined> {
  const token = auth?.token?.trim();
  if (!token) {
    return undefined;
  }
  return { token, provider: auth?.provider ?? "unknown" };
}

/**
 * 使用本机 Git 凭据 fetch（允许弹窗登录）。
 * Token 仅用于一键申请 MR，不参与 fetch。
 */
export async function fetchRemote(
  cwd?: string,
  remote = "origin",
  onProgress?: ProgressReporter,
  _auth?: GitAuthOptions,
): Promise<FetchResult> {
  const repoRoot = await resolveRepoRoot(cwd);

  await reportProgress(onProgress, 1, "Fetch 远程分支…");

  const result = await runFetchOnce(repoRoot, remote, onProgress, {
    interactive: true,
    label: `Fetch ${remote}…`,
  });

  const ok = result.code === 0;
  await reportProgress(
    onProgress,
    100,
    ok ? "Fetch 完成" : "Fetch 失败（将使用本地缓存 refs，可能与线上不一致）",
  );
  return {
    repoRoot,
    remote,
    ok,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

/**
 * 后台用的静默 fetch：**绝不弹登录框**。
 *
 * 前台的 fetchRemote 允许弹窗，因为用户正盯着结果等；后台轮询不行——
 * 人在写代码时被 GCM / Connect to GitHub 抢走焦点是不能接受的。
 * 拿不到凭据就让这一轮失败，调用方据此退避即可。
 */
export async function fetchRemoteQuiet(
  cwd?: string,
  remote = "origin",
): Promise<FetchResult> {
  const repoRoot = await resolveRepoRoot(cwd);
  const result = await runGit(repoRoot, ["fetch", "--prune", remote], {
    allowFail: true,
    interactive: false,
  });
  return {
    repoRoot,
    remote,
    ok: result.code === 0,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

export async function maybeFetch(
  cwd: string,
  enabled: boolean,
  remote = "origin",
  onProgress?: ProgressReporter,
  auth?: GitAuthOptions,
): Promise<boolean> {
  if (!enabled) {
    return false;
  }
  const result = await fetchRemote(cwd, remote, onProgress, auth);
  return result.ok;
}
