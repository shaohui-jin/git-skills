import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { resolveRepoRoot, runGit } from "./runner.js";
import { GIT_INSIGHT_DIR } from "../config/gitInsightConfig.js";

export interface GitRemoteInfo {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

/** 用户级配置镜像（扩展保存时写入，供 CLI / Skill 读取 defaultRemote） */
export const USER_CONFIG_HOME_FILE = "user-config.json";

export function userConfigHomePath(): string {
  const override = process.env.GIT_INSIGHT_USER_CONFIG?.trim();
  if (override) {
    return override;
  }
  return join(homedir(), GIT_INSIGHT_DIR, USER_CONFIG_HOME_FILE);
}

/**
 * 在已配置名与仓库实际 remotes 之间解析默认远程。
 * 优先：configured（若存在于列表）→ origin（若存在）→ 列表第一项 → "origin"。
 */
export function resolveDefaultRemote(
  configured: string | undefined | null,
  remoteNames: string[],
): string {
  const names = remoteNames.map((n) => n.trim()).filter(Boolean);
  const pref = configured?.trim();
  if (pref && names.includes(pref)) {
    return pref;
  }
  if (names.includes("origin")) {
    return "origin";
  }
  return names[0] ?? "origin";
}

/** 列出仓库 remotes（git remote -v） */
export async function listRemotes(cwd?: string): Promise<GitRemoteInfo[]> {
  const repoRoot = await resolveRepoRoot(cwd);
  const { stdout } = await runGit(repoRoot, ["remote", "-v"], { allowFail: true });
  if (!stdout.trim()) {
    return [];
  }
  const map = new Map<string, GitRemoteInfo>();
  for (const line of stdout.split("\n")) {
    const m = line.trim().match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
    if (!m) {
      continue;
    }
    const name = m[1]!;
    const url = m[2]!;
    const kind = m[3]!;
    const cur = map.get(name) ?? { name, fetchUrl: "", pushUrl: "" };
    if (kind === "fetch") {
      cur.fetchUrl = url;
    } else {
      cur.pushUrl = url;
    }
    map.set(name, cur);
  }
  return [...map.values()];
}

/** 从 tip 短名（refname:short）按已知 remotes 拆出 remote + 分支短名 */
export function splitRemoteTipName(
  tipName: string,
  knownRemotes: string[],
): { remoteName: string; shortName: string } | null {
  const name = tipName.trim();
  if (!name.includes("/")) {
    return null;
  }
  const sorted = [...knownRemotes]
    .map((r) => r.trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  for (const remote of sorted) {
    const prefix = `${remote}/`;
    if (name.startsWith(prefix) && name.length > prefix.length) {
      return { remoteName: remote, shortName: name.slice(prefix.length) };
    }
  }
  const i = name.indexOf("/");
  if (i <= 0 || i === name.length - 1) {
    return null;
  }
  return { remoteName: name.slice(0, i), shortName: name.slice(i + 1) };
}

/** 读取用户配置里的 defaultRemote（家目录镜像或环境变量路径） */
export async function readConfiguredDefaultRemote(): Promise<string | undefined> {
  const fromEnv = process.env.GIT_INSIGHT_DEFAULT_REMOTE?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  try {
    const raw = await readFile(userConfigHomePath(), "utf8");
    const parsed = JSON.parse(raw) as { defaultRemote?: string };
    const v = parsed.defaultRemote?.trim();
    return v || undefined;
  } catch {
    return undefined;
  }
}

/**
 * 解析本次操作应使用的远程名：显式参数 → 配置 → 仓库 remotes 兜底。
 */
export async function resolveRemoteName(
  cwd: string | undefined,
  explicit?: string | null,
): Promise<{ remote: string; remotes: GitRemoteInfo[] }> {
  const remotes = await listRemotes(cwd);
  const names = remotes.map((r) => r.name);
  if (explicit?.trim()) {
    return { remote: explicit.trim(), remotes };
  }
  const configured = await readConfiguredDefaultRemote();
  return { remote: resolveDefaultRemote(configured, names), remotes };
}
