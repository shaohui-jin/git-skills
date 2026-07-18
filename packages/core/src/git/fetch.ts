import type { FetchResult } from "../types.js";
import { resolveRepoRoot, runGit } from "./runner.js";

export async function fetchRemote(
  cwd?: string,
  remote = "origin",
): Promise<FetchResult> {
  const repoRoot = await resolveRepoRoot(cwd);
  const result = await runGit(repoRoot, ["fetch", "--prune", remote], {
    allowFail: true,
  });
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
): Promise<boolean> {
  if (!enabled) {
    return false;
  }
  const result = await fetchRemote(cwd, remote);
  return result.ok;
}
