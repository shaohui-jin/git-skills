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

/**
 * 非交互探测：本机 Git 是否已能访问远程（凭据/SSH/已登录）。
 * 不注入 Token，且禁止弹登录框。
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

/**
 * 决定本次 fetch 是否带 Token：
 * - 无 Token → 不带
 * - preferExisting !== false（默认）且本机已能访问 → 不带
 * - 否则带 Token（方案 C 兜底）
 */
export async function resolveFetchAuth(
  repoRoot: string,
  remote: string,
  auth?: GitAuthOptions,
): Promise<GitAuthOptions | undefined> {
  const token = auth?.token?.trim();
  if (!token || !auth) {
    return undefined;
  }
  const preferExisting = auth.preferExisting !== false;
  if (preferExisting) {
    const ok = await probeRemoteAccess(repoRoot, remote);
    if (ok) {
      return undefined;
    }
  }
  return { token, provider: auth.provider ?? "unknown" };
}

export async function fetchRemote(
  cwd?: string,
  remote = "origin",
  onProgress?: ProgressReporter,
  auth?: GitAuthOptions,
): Promise<FetchResult> {
  const repoRoot = await resolveRepoRoot(cwd);

  await reportProgress(onProgress, 1, "检测远程访问方式…");
  const effectiveAuth = await resolveFetchAuth(repoRoot, remote, auth);
  const authHint = effectiveAuth?.token
    ? "（使用配置 Token）"
    : auth?.token?.trim()
      ? "（本机 Git 已可访问）"
      : "";

  const result = await withSoftProgress(
    onProgress,
    2,
    98,
    `Fetch ${remote}${authHint}…`,
    () =>
      runGit(repoRoot, ["fetch", "--prune", "--progress", remote], {
        allowFail: true,
        auth: effectiveAuth,
        onStderrLine: (line) => {
          const pct = parseGitProgressPercent(line);
          if (pct == null) {
            return;
          }
          mapProgress(onProgress, 5, 95, pct / 100, `Fetch ${remote}：${pct}%`);
        },
      }),
  );

  await reportProgress(
    onProgress,
    100,
    result.code === 0 ? "Fetch 完成" : "Fetch 结束（可能失败/离线）",
  );
  return {
    repoRoot,
    remote,
    ok: result.code === 0,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

/**
 * Skill / preview default path: try fetch, but do not hard-fail if offline
 * or remote is missing — local refs may still be enough.
 */
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
