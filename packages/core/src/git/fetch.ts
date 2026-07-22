import type { FetchResult, ProgressReporter } from "../types.js";
import { mapProgress, reportProgress, withSoftProgress } from "../progress.js";
import { resolveRepoRoot, runGit } from "./runner.js";

function parseGitProgressPercent(line: string): number | null {
  const m = line.match(/(\d+)%/);
  if (!m) {
    return null;
  }
  const n = Number(m[1]);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
}

export async function fetchRemote(
  cwd?: string,
  remote = "origin",
  onProgress?: ProgressReporter,
): Promise<FetchResult> {
  const repoRoot = await resolveRepoRoot(cwd);

  const result = await withSoftProgress(
    onProgress,
    2,
    98,
    `Fetch ${remote}…`,
    () =>
      runGit(repoRoot, ["fetch", "--prune", "--progress", remote], {
        allowFail: true,
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
): Promise<boolean> {
  if (!enabled) {
    return false;
  }
  const result = await fetchRemote(cwd, remote, onProgress);
  return result.ok;
}
