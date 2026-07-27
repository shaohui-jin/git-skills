import { createHash } from "node:crypto";
import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { httpsUrlWithToken, runGit } from "@git-insight/core";

export interface RemoteRepoSpec {
  host: string;
  owner: string;
  repo: string;
  /** 不含凭据的 https clone URL */
  httpsUrl: string;
}

const DEFAULT_HOSTS = ["github.com"];

function allowedHosts(): string[] {
  const raw = process.env.GIT_INSIGHT_ALLOW_HOSTS?.trim();
  if (!raw) {
    return DEFAULT_HOSTS;
  }
  return raw
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

/** 是否像远程仓库规格（GitHub URL / owner/repo） */
export function looksLikeRemoteRepo(input: string): boolean {
  const t = input.trim();
  if (!t) {
    return false;
  }
  if (/^(https?:\/\/|git@)/i.test(t)) {
    return true;
  }
  // owner/repo 或 owner/repo.git（排除 Windows 盘符路径）
  if (/^[A-Za-z]:[\\/]/.test(t) || t.startsWith("/") || t.startsWith("\\\\")) {
    return false;
  }
  return /^[\w.-]+\/[\w.-]+(?:\.git)?$/.test(t);
}

export function parseRemoteRepoSpec(input: string): RemoteRepoSpec {
  const t = input.trim().replace(/\/+$/, "");
  let host = "github.com";
  let owner = "";
  let repo = "";

  const https = t.match(/^https?:\/\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (https) {
    host = https[1].toLowerCase();
    owner = https[2];
    repo = https[3].replace(/\.git$/i, "");
  } else {
    const ssh = t.match(/^git@([^:]+):([^/]+)\/([^/]+?)(?:\.git)?$/i);
    if (ssh) {
      host = ssh[1].toLowerCase();
      owner = ssh[2];
      repo = ssh[3].replace(/\.git$/i, "");
    } else {
      const short = t.match(/^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
      if (!short) {
        throw new Error(
          `无法解析远程仓库：${input}（支持 https://github.com/owner/repo 或 owner/repo）`,
        );
      }
      owner = short[1];
      repo = short[2].replace(/\.git$/i, "");
    }
  }

  if (!allowedHosts().includes(host)) {
    throw new Error(
      `不允许的 Git 主机：${host}（允许：${allowedHosts().join(", ")}）`,
    );
  }

  return {
    host,
    owner,
    repo,
    httpsUrl: `https://${host}/${owner}/${repo}.git`,
  };
}

function dataRoot(): string {
  return (
    process.env.GIT_INSIGHT_DATA_DIR?.trim() ||
    join(tmpdir(), "git-insight-repos")
  );
}

function envGithubToken(): string | undefined {
  return (
    process.env.GITHUB_TOKEN?.trim() ||
    process.env.GH_TOKEN?.trim() ||
    process.env.GIT_INSIGHT_GITHUB_TOKEN?.trim() ||
    undefined
  );
}

function repoDir(spec: RemoteRepoSpec): string {
  const key = createHash("sha1")
    .update(`${spec.host}/${spec.owner}/${spec.repo}`)
    .digest("hex")
    .slice(0, 12);
  return join(dataRoot(), `${spec.owner}__${spec.repo}__${key}`);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const locks = new Map<string, Promise<string>>();

/**
 * 用系统 git clone / fetch 准备仓库工作副本，返回本地路径。
 * @param authToken 优先使用扩展配置的 Token，其次环境变量
 */
export async function ensureRemoteRepo(
  input: string,
  authToken?: string,
): Promise<string> {
  const spec = parseRemoteRepoSpec(input);
  const dir = repoDir(spec);

  const prev = locks.get(dir);
  if (prev) {
    return prev;
  }

  const job = (async () => {
    await mkdir(dataRoot(), { recursive: true });
    const token = authToken?.trim() || envGithubToken();
    const exists = await pathExists(join(dir, ".git"));
    const bareUrl = spec.httpsUrl;
    const authedUrl = httpsUrlWithToken(bareUrl, token, "github");
    const auth = token ? { token, provider: "github" as const } : undefined;

    if (!exists) {
      // 先试本机凭据/匿名；失败再用 Token（方案 C 兜底）
      const first = await runGit(dataRoot(), ["clone", "--", bareUrl, dir], {
        allowFail: true,
      });
      if (first.code !== 0) {
        if (!token) {
          throw new Error(
            first.stderr.trim() ||
              first.stdout.trim() ||
              "clone 失败：未登录且未配置 GitHub Token",
          );
        }
        await runGit(dataRoot(), ["clone", "--", authedUrl, dir], { auth });
      }
    } else {
      const first = await runGit(dir, ["fetch", "--all", "--prune"], {
        allowFail: true,
      });
      if (first.code !== 0 && token) {
        await runGit(dir, ["fetch", "--all", "--prune"], { auth });
      } else if (first.code !== 0) {
        throw new Error(
          first.stderr.trim() ||
            first.stdout.trim() ||
            "fetch 失败：未登录且未配置 GitHub Token",
        );
      }
    }
    return dir;
  })();

  locks.set(dir, job);
  try {
    return await job;
  } finally {
    locks.delete(dir);
  }
}

export function isRemoteOnlyMode(): boolean {
  const mode = process.env.GIT_INSIGHT_MODE?.trim().toLowerCase();
  return mode === "remote" || mode === "cloud";
}
