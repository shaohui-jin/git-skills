import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  defaultGitInsightConfig,
  GIT_INSIGHT_CONFIG_FILE,
  GIT_INSIGHT_DIR,
  userConfigHomePath,
  type GitInsightProjectConfig,
  type MrMethod,
} from "@git-insight/core";

/** Cursor/VS Code globalState 键：Token 与 MR 方式全仓库共用 */
export const GLOBAL_CONFIG_KEY = "gitInsight.userConfig";
/** 扩展 globalStorage 内备份文件名（与 globalState 双写，避免仅内存态丢失） */
export const GLOBAL_CONFIG_FILE = "user-config.json";

export type ConfigMemento = {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
};

export function configPathLabel(storageDir?: string | null): string {
  if (storageDir) {
    return `扩展全局配置（${join(storageDir, GLOBAL_CONFIG_FILE)}）`;
  }
  return "扩展全局配置（各仓库共用，不写进项目）";
}

/** 兼容：曾写入项目内的旧配置路径 */
function legacyProjectConfigPath(repoRoot: string): string {
  return join(repoRoot, GIT_INSIGHT_DIR, GIT_INSIGHT_CONFIG_FILE);
}

function normalizeConfig(raw: Partial<GitInsightProjectConfig> | undefined): GitInsightProjectConfig {
  const base = defaultGitInsightConfig();
  if (!raw) {
    return base;
  }
  return {
    ...base,
    ...raw,
    version: 1,
    mrMethod: (raw.mrMethod as MrMethod | null | undefined) ?? null,
    githubToken: raw.githubToken ?? "",
    gitlabToken: raw.gitlabToken ?? "",
    defaultRemote: raw.defaultRemote?.trim() || base.defaultRemote || "origin",
    aiApiBaseUrl: raw.aiApiBaseUrl ?? base.aiApiBaseUrl ?? "",
    aiApiKey: raw.aiApiKey ?? "",
    aiModel: raw.aiModel ?? base.aiModel ?? "",
    updatedAt: raw.updatedAt ?? Date.now(),
  };
}

function configHasUserData(c: Partial<GitInsightProjectConfig> | undefined): boolean {
  if (!c) {
    return false;
  }
  return (
    c.mrMethod != null ||
    !!c.githubToken?.trim() ||
    !!c.gitlabToken?.trim() ||
    !!c.aiApiKey?.trim()
  );
}

async function tryLoadLegacyProject(repoRoot: string | null): Promise<GitInsightProjectConfig | null> {
  if (!repoRoot) {
    return null;
  }
  try {
    const raw = await readFile(legacyProjectConfigPath(repoRoot), "utf8");
    return normalizeConfig(JSON.parse(raw) as Partial<GitInsightProjectConfig>);
  } catch {
    return null;
  }
}

async function tryLoadStorageFile(
  storageDir: string | null | undefined,
): Promise<GitInsightProjectConfig | null> {
  if (!storageDir) {
    return null;
  }
  try {
    const raw = await readFile(join(storageDir, GLOBAL_CONFIG_FILE), "utf8");
    return normalizeConfig(JSON.parse(raw) as Partial<GitInsightProjectConfig>);
  } catch {
    return null;
  }
}

async function writeStorageFile(
  storageDir: string | null | undefined,
  config: GitInsightProjectConfig,
): Promise<void> {
  if (!storageDir) {
    return;
  }
  await mkdir(storageDir, { recursive: true });
  await writeFile(
    join(storageDir, GLOBAL_CONFIG_FILE),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );
}

/**
 * 从扩展 globalState 读取；并与 globalStorage 文件双读双写。
 * 若为空且项目里有旧文件，则迁移一次到全局。
 */
export async function loadUserConfig(
  memento: ConfigMemento,
  repoRoot?: string | null,
  storageDir?: string | null,
): Promise<GitInsightProjectConfig> {
  const stored = memento.get<Partial<GitInsightProjectConfig>>(GLOBAL_CONFIG_KEY);
  const fromFile = await tryLoadStorageFile(storageDir);

  // 取更新时间较新的一侧
  if (configHasUserData(stored) && fromFile) {
    const a = stored!.updatedAt ?? 0;
    const b = fromFile.updatedAt ?? 0;
    const newer = a >= b ? normalizeConfig(stored) : fromFile;
    // 回填较弱一侧
    if (a < b) {
      await memento.update(GLOBAL_CONFIG_KEY, newer);
    } else if (b < a) {
      await writeStorageFile(storageDir, newer);
    }
    await writeHomeConfigMirror(newer);
    return newer;
  }
  if (configHasUserData(stored)) {
    const cfg = normalizeConfig(stored);
    await writeStorageFile(storageDir, cfg);
    await writeHomeConfigMirror(cfg);
    return cfg;
  }
  if (fromFile) {
    await memento.update(GLOBAL_CONFIG_KEY, fromFile);
    await writeHomeConfigMirror(fromFile);
    return fromFile;
  }

  const legacy = await tryLoadLegacyProject(repoRoot ?? null);
  if (legacy) {
    await memento.update(GLOBAL_CONFIG_KEY, legacy);
    await writeStorageFile(storageDir, legacy);
    await writeHomeConfigMirror(legacy);
    return legacy;
  }
  const fresh = defaultGitInsightConfig();
  await writeHomeConfigMirror(fresh);
  return fresh;
}

async function writeHomeConfigMirror(config: GitInsightProjectConfig): Promise<void> {
  try {
    const path = userConfigHomePath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  } catch {
    // 家目录不可写时不影响扩展主配置
  }
}

export async function saveUserConfig(
  memento: ConfigMemento,
  config: GitInsightProjectConfig,
  storageDir?: string | null,
): Promise<GitInsightProjectConfig> {
  const next: GitInsightProjectConfig = {
    version: 1,
    mrMethod: config.mrMethod,
    githubToken: config.githubToken ?? "",
    gitlabToken: config.gitlabToken ?? "",
    defaultRemote: config.defaultRemote?.trim() || "origin",
    aiApiBaseUrl: config.aiApiBaseUrl ?? "https://api.openai.com/v1",
    aiApiKey: config.aiApiKey ?? "",
    aiModel: config.aiModel ?? "gpt-4o-mini",
    updatedAt: Date.now(),
  };
  await memento.update(GLOBAL_CONFIG_KEY, next);
  await writeStorageFile(storageDir, next);
  await writeHomeConfigMirror(next);
  return next;
}

/** @deprecated 兼容旧名 */
export const loadProjectConfig = async (
  repoRoot: string,
  memento?: ConfigMemento,
  storageDir?: string | null,
): Promise<GitInsightProjectConfig> => {
  if (memento) {
    return loadUserConfig(memento, repoRoot, storageDir);
  }
  return (await tryLoadLegacyProject(repoRoot)) ?? defaultGitInsightConfig();
};

/** @deprecated 兼容旧名 */
export const saveProjectConfig = async (
  _repoRoot: string,
  config: GitInsightProjectConfig,
  memento?: ConfigMemento,
  storageDir?: string | null,
): Promise<GitInsightProjectConfig> => {
  if (!memento) {
    throw new Error("saveProjectConfig 需要扩展 globalState");
  }
  return saveUserConfig(memento, config, storageDir);
};

export function configPath(storageDir?: string | null): string {
  return configPathLabel(storageDir);
}

/**
 * 用户尚未选择 MR 方式时的默认项：
 * - 本机存在对应 gh/glab → A（cli）
 * - 否则 → D（browser）
 */
export function resolveDefaultMrMethod(ctx: {
  platformHint: "github" | "gitlab" | "unknown";
  systemGhInstalled: boolean;
  systemGlabInstalled: boolean;
}): MrMethod {
  const { platformHint, systemGhInstalled, systemGlabInstalled } = ctx;
  if (platformHint === "github" && systemGhInstalled) {
    return "cli";
  }
  if (platformHint === "gitlab" && systemGlabInstalled) {
    return "cli";
  }
  if (platformHint === "unknown" && (systemGhInstalled || systemGlabInstalled)) {
    return "cli";
  }
  return "browser";
}

/** 方式是否已配置到可执行程度（不含「必须先一键推送」） */
export function isMrMethodReady(
  config: GitInsightProjectConfig,
  ctx: {
    platformHint: "github" | "gitlab" | "unknown";
    systemCliOk: boolean;
    bundledCliOk: boolean;
  },
): { ok: boolean; reason?: string } {
  if (!config.mrMethod) {
    return { ok: false, reason: "请先在「Git 配置」中选择 MR 方式" };
  }
  switch (config.mrMethod) {
    case "cli":
      return ctx.systemCliOk
        ? { ok: true }
        : {
            ok: false,
            reason: "本机 gh/glab 未就绪：请安装并登录（可用选项内「登录」按钮）",
          };
    case "download-cli":
      return ctx.bundledCliOk
        ? { ok: true }
        : {
            ok: false,
            reason: "扩展内 CLI 未就绪：请先下载，再登录（可用选项内按钮）",
          };
    case "token": {
      if (ctx.platformHint === "github") {
        return config.githubToken?.trim()
          ? { ok: true }
          : { ok: false, reason: "请填写 GitHub Token（失焦后自动校验并保存）" };
      }
      if (ctx.platformHint === "gitlab") {
        return config.gitlabToken?.trim()
          ? { ok: true }
          : { ok: false, reason: "请填写以 glpat- 开头的 GitLab Token" };
      }
      return { ok: false, reason: "无法识别远程平台，Token 方式不可用" };
    }
    case "browser":
      return { ok: true };
    default:
      return { ok: false, reason: "未知的 MR 方式" };
  }
}
