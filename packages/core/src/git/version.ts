import { GitError, runGit } from "./runner.js";

export interface GitVersion {
  major: number;
  minor: number;
  patch: number;
  raw: string;
}

export async function getGitVersion(cwd: string): Promise<GitVersion> {
  const { stdout } = await runGit(cwd, ["--version"]);
  const raw = stdout.trim();
  const match = raw.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    throw new GitError(`无法解析 git 版本：${raw}`, { code: "GIT_VERSION_PARSE" });
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    raw,
  };
}

/** 同一进程内 git 版本不会变，避免每次预演都多 spawn 一次 `git --version` */
const supportedCache = new Map<string, GitVersion>();

/** merge-tree --write-tree needs Git >= 2.38 */
export async function assertMergeTreeSupported(cwd: string): Promise<GitVersion> {
  const cached = supportedCache.get(cwd);
  if (cached) {
    return cached;
  }
  const version = await getGitVersion(cwd);
  const ok =
    version.major > 2 ||
    (version.major === 2 && version.minor > 38) ||
    (version.major === 2 && version.minor === 38);
  if (!ok) {
    throw new GitError(
      `冲突预演需要 Git >= 2.38（当前 ${version.raw}）。请升级 Git 后重试。`,
      { code: "GIT_TOO_OLD" },
    );
  }
  supportedCache.set(cwd, version);
  return version;
}
