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
 * 鉴权顺序：
 * 1. 本机 Git 凭据（非交互，不弹窗）
 * 2. 方案 C Token（非交互）
 * 3. 本机 Git 凭据 + 允许弹窗登录（接近 WebStorm）
 */
export async function fetchRemote(
  cwd?: string,
  remote = "origin",
  onProgress?: ProgressReporter,
  auth?: GitAuthOptions,
): Promise<FetchResult> {
  const repoRoot = await resolveRepoRoot(cwd);
  const token = auth?.token?.trim();
  const tokenAuth: GitAuthOptions | undefined = token
    ? { token, provider: auth?.provider ?? "unknown" }
    : undefined;

  await reportProgress(onProgress, 1, "Fetch 远程分支…");

  // 1) 本机凭据（已登录缓存 / SSH），不弹窗
  let result = await runFetchOnce(repoRoot, remote, onProgress, {
    label: `Fetch ${remote}（本机凭据）…`,
  });

  // 2) 方案 C Token
  if (result.code !== 0 && tokenAuth) {
    await reportProgress(onProgress, 2, "本机凭据不可用，尝试配置 Token…");
    result = await runFetchOnce(repoRoot, remote, onProgress, {
      auth: tokenAuth,
      label: `Fetch ${remote}（配置 Token）…`,
    });
  }

  // 3) 再走 Git 凭据，允许弹窗登录
  if (result.code !== 0) {
    await reportProgress(
      onProgress,
      3,
      "Token 不可用，请在弹窗中完成 Git 登录…",
    );
    result = await runFetchOnce(repoRoot, remote, onProgress, {
      interactive: true,
      label: `Fetch ${remote}（交互登录）…`,
    });
  }

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
