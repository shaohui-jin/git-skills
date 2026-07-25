import { spawn } from "node:child_process";
import type { MrMethod } from "../config/gitInsightConfig.js";
import { GitError, resolveRepoRoot, runGit } from "../git/runner.js";
import { buildCreateMrUrl, defaultTempBranchName } from "./applyResolve.js";

export type MrPlatform = "github" | "gitlab" | "unknown";

export interface MrCandidate {
  username: string;
  name?: string;
  /** collaborator / member 等原始角色提示 */
  role?: string;
}

export interface PrepareCreateMrOptions {
  cwd?: string;
  into: string;
  from: string;
  /** 源分支；默认优先临时分支名，否则 from */
  sourceBranch?: string;
  remote?: string;
  /** 优先使用的 CLI 可执行文件路径（扩展目录下载的 gh/glab） */
  cliPath?: string;
  /** Token 方式下列成员 / 建单 */
  token?: string;
  method?: MrMethod | null;
}

export interface PrepareCreateMrResult {
  repoRoot: string;
  platform: MrPlatform;
  cli: "gh" | "glab" | null;
  remote: string;
  remoteUrl: string;
  sourceBranch: string;
  targetBranch: string;
  /** 建议的 MR 标题 */
  title: string;
  candidates: MrCandidate[];
  /** 浏览器创建页（CLI 不可用时的回退） */
  createMrUrl: string | null;
  messages: string[];
  /** CLI 未登录或不可用时的说明 */
  cliError?: string;
}

export interface CreateMergeRequestOptions {
  cwd?: string;
  sourceBranch: string;
  targetBranch: string;
  title?: string;
  body?: string;
  /** reviewer / assignee 用户名 */
  reviewers?: string[];
  remote?: string;
  method?: MrMethod | null;
  cliPath?: string;
  token?: string;
}

export interface CreateMergeRequestResult {
  platform: MrPlatform;
  /** 实际使用的通道 */
  via: "gh" | "glab" | "token" | "browser";
  url: string | null;
  sourceBranch: string;
  targetBranch: string;
  messages: string[];
}

function runCmd(
  cmd: string,
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      windowsHide: true,
      shell: false,
      env: {
        ...process.env,
        GH_PROMPT_DISABLED: "1",
        GLAB_PROMPT_DISABLED: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b: Buffer) => {
      stdout += b.toString("utf8");
    });
    child.stderr.on("data", (b: Buffer) => {
      stderr += b.toString("utf8");
    });
    child.on("error", (err) => {
      resolve({ code: 127, stdout: "", stderr: err.message });
    });
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

/** 规范化 remote URL → https origin + path */
export function normalizeRemoteWebUrl(remoteUrl: string): string | null {
  let url = remoteUrl.trim();
  if (!url) {
    return null;
  }
  if (url.startsWith("git@")) {
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
    return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

export function detectMrPlatform(remoteUrl: string): MrPlatform {
  const web = normalizeRemoteWebUrl(remoteUrl);
  if (!web) {
    return "unknown";
  }
  try {
    const host = new URL(web).hostname.toLowerCase();
    if (host.includes("github")) {
      return "github";
    }
    if (host.includes("gitlab") || host.includes("git.")) {
      return "gitlab";
    }
    return "gitlab";
  } catch {
    return "unknown";
  }
}

/** API / CLI 用的分支短名（去掉 refs、remote 前缀） */
export function branchNameForMr(ref: string): string {
  return ref
    .replace(/^refs\/heads\//, "")
    .replace(/^refs\/remotes\/[^/]+\//, "")
    .trim();
}

function parseOwnerRepo(remoteUrl: string): { owner: string; repo: string; projectPath: string } | null {
  const web = normalizeRemoteWebUrl(remoteUrl);
  if (!web) {
    return null;
  }
  try {
    const path = new URL(web).pathname.replace(/^\/+|\/+$/g, "");
    const parts = path.split("/").filter(Boolean);
    if (parts.length < 2) {
      return null;
    }
    const repo = parts[parts.length - 1]!;
    const owner = parts[parts.length - 2]!;
    return { owner, repo, projectPath: path };
  } catch {
    return null;
  }
}

async function remoteUrl(cwd: string, remote: string): Promise<string> {
  const r = await runGit(cwd, ["remote", "get-url", remote], { allowFail: true });
  return r.stdout.trim();
}

async function localBranchExists(cwd: string, name: string): Promise<boolean> {
  const r = await runGit(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`], {
    allowFail: true,
  });
  return r.code === 0;
}

async function remoteBranchExists(
  cwd: string,
  remote: string,
  name: string,
): Promise<boolean> {
  const r = await runGit(
    cwd,
    ["show-ref", "--verify", "--quiet", `refs/remotes/${remote}/${name}`],
    { allowFail: true },
  );
  return r.code === 0;
}

async function resolveDefaultSource(
  cwd: string,
  into: string,
  from: string,
  remote: string,
  explicit?: string,
): Promise<string> {
  if (explicit?.trim()) {
    return branchNameForMr(explicit);
  }
  const temp = defaultTempBranchName(into, from);
  if (
    (await localBranchExists(cwd, temp)) ||
    (await remoteBranchExists(cwd, remote, temp))
  ) {
    return temp;
  }
  return branchNameForMr(from);
}

async function checkGh(
  cwd: string,
  cliPath = "gh",
): Promise<{ ok: boolean; error?: string }> {
  const ver = await runCmd(cliPath, ["--version"], cwd);
  if (ver.code !== 0) {
    return { ok: false, error: "未找到 gh CLI，请安装 GitHub CLI：https://cli.github.com/" };
  }
  const auth = await runCmd(cliPath, ["auth", "status"], cwd);
  if (auth.code !== 0) {
    return {
      ok: false,
      error: "gh 未登录。请在终端执行：gh auth login（扩展目录 CLI 同样需要登录一次）",
    };
  }
  return { ok: true };
}

async function checkGlab(
  cwd: string,
  cliPath = "glab",
): Promise<{ ok: boolean; error?: string }> {
  const ver = await runCmd(cliPath, ["--version"], cwd);
  if (ver.code !== 0) {
    return {
      ok: false,
      error: "未找到 glab CLI，请安装 GitLab CLI：https://gitlab.com/gitlab-org/cli",
    };
  }
  const auth = await runCmd(cliPath, ["auth", "status"], cwd);
  if (auth.code !== 0) {
    return {
      ok: false,
      error: "glab 未登录。请在终端执行：glab auth login（扩展目录 CLI 同样需要登录一次）",
    };
  }
  return { ok: true };
}

async function listGithubCandidatesByToken(
  remoteUrlStr: string,
  token: string,
): Promise<MrCandidate[]> {
  const parsed = parseOwnerRepo(remoteUrlStr);
  if (!parsed) {
    return [];
  }
  const res = await fetch(
    `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/collaborators?per_page=100`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "git-insight",
      },
    },
  );
  if (!res.ok) {
    return [];
  }
  const arr = (await res.json()) as Array<{ login?: string; role_name?: string }>;
  return arr
    .filter((u) => u.login)
    .map((u) => ({ username: u.login!, role: u.role_name }));
}

async function listGitlabCandidatesByToken(
  remoteUrlStr: string,
  token: string,
): Promise<MrCandidate[]> {
  const parsed = parseOwnerRepo(remoteUrlStr);
  if (!parsed) {
    return [];
  }
  const web = normalizeRemoteWebUrl(remoteUrlStr);
  if (!web) {
    return [];
  }
  const origin = new URL(web).origin;
  const project = encodeURIComponent(parsed.projectPath);
  const res = await fetch(`${origin}/api/v4/projects/${project}/members/all?per_page=100`, {
    headers: {
      "PRIVATE-TOKEN": token,
      "User-Agent": "git-insight",
    },
  });
  if (!res.ok) {
    return [];
  }
  const arr = (await res.json()) as Array<{
    username?: string;
    name?: string;
    access_level?: number;
  }>;
  return arr
    .filter((u) => u.username)
    .map((u) => ({
      username: u.username!,
      name: u.name,
      role: accessLevelLabel(u.access_level),
    }));
}

async function createGithubPrByToken(options: {
  remoteUrl: string;
  token: string;
  sourceBranch: string;
  targetBranch: string;
  title: string;
  body: string;
  reviewers: string[];
}): Promise<string | null> {
  const parsed = parseOwnerRepo(options.remoteUrl);
  if (!parsed) {
    throw new GitError("无法解析 GitHub 仓库路径", { code: "BAD_REMOTE" });
  }
  const res = await fetch(
    `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/pulls`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${options.token}`,
        "User-Agent": "git-insight",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: options.title,
        body: options.body,
        head: options.sourceBranch,
        base: options.targetBranch,
      }),
    },
  );
  const json = (await res.json()) as { html_url?: string; number?: number; message?: string };
  if (!res.ok) {
    throw new GitError(`GitHub API 创建 PR 失败：${json.message || res.status}`, {
      code: "CREATE_MR_FAILED",
    });
  }
  if (options.reviewers.length && json.number) {
    await fetch(
      `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/pulls/${json.number}/requested_reviewers`,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${options.token}`,
          "User-Agent": "git-insight",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ reviewers: options.reviewers }),
      },
    );
  }
  return json.html_url ?? null;
}

async function createGitlabMrByToken(options: {
  remoteUrl: string;
  token: string;
  sourceBranch: string;
  targetBranch: string;
  title: string;
  body: string;
  reviewers: string[];
}): Promise<string | null> {
  const parsed = parseOwnerRepo(options.remoteUrl);
  const web = normalizeRemoteWebUrl(options.remoteUrl);
  if (!parsed || !web) {
    throw new GitError("无法解析 GitLab 仓库路径", { code: "BAD_REMOTE" });
  }
  const origin = new URL(web).origin;
  const project = encodeURIComponent(parsed.projectPath);
  const res = await fetch(`${origin}/api/v4/projects/${project}/merge_requests`, {
    method: "POST",
    headers: {
      "PRIVATE-TOKEN": options.token,
      "Content-Type": "application/json",
      "User-Agent": "git-insight",
    },
    body: JSON.stringify({
      source_branch: options.sourceBranch,
      target_branch: options.targetBranch,
      title: options.title,
      description: options.body,
      reviewer_ids: [], // 用户名需再查 id；先创建 MR
    }),
  });
  const json = (await res.json()) as {
    web_url?: string;
    message?: string | string[];
  };
  if (!res.ok) {
    const msg = Array.isArray(json.message) ? json.message.join("; ") : json.message;
    throw new GitError(`GitLab API 创建 MR 失败：${msg || res.status}`, {
      code: "CREATE_MR_FAILED",
    });
  }
  // 可选：按 username 查 id 再更新 reviewers（略，标题已创建成功）
  void options.reviewers;
  return json.web_url ?? null;
}

async function listGithubCandidates(
  cwd: string,
  remoteUrlStr: string,
  cliPath = "gh",
): Promise<MrCandidate[]> {
  const parsed = parseOwnerRepo(remoteUrlStr);
  if (!parsed) {
    return [];
  }
  const { owner, repo } = parsed;
  const api = await runCmd(
    cliPath,
    [
      "api",
      `repos/${owner}/${repo}/collaborators?per_page=100`,
      "--jq",
      ".[] | {username: .login, name: (.name // .login), role: .role_name}",
    ],
    cwd,
  );
  if (api.code !== 0) {
    // 回退：可指派用户
    const alt = await runCmd(
      cliPath,
      [
        "api",
        `repos/${owner}/${repo}/assignable_users?per_page=100`,
        "--jq",
        ".[] | {username: .login, name: (.name // .login), role: \"assignable\"}",
      ],
      cwd,
    );
    if (alt.code !== 0) {
      return [];
    }
    return parseJsonLinesOrArray(alt.stdout);
  }
  return parseJsonLinesOrArray(api.stdout);
}

async function listGitlabCandidates(
  cwd: string,
  remoteUrlStr: string,
  cliPath = "glab",
): Promise<MrCandidate[]> {
  const parsed = parseOwnerRepo(remoteUrlStr);
  if (!parsed) {
    return [];
  }
  const project = encodeURIComponent(parsed.projectPath);
  const api = await runCmd(
    cliPath,
    ["api", `projects/${project}/members/all?per_page=100`],
    cwd,
  );
  if (api.code !== 0) {
    return [];
  }
  try {
    const arr = JSON.parse(api.stdout) as Array<{
      username?: string;
      name?: string;
      access_level?: number;
    }>;
    return arr
      .filter((u) => u.username)
      .map((u) => ({
        username: u.username!,
        name: u.name,
        role: accessLevelLabel(u.access_level),
      }))
      .sort((a, b) => a.username.localeCompare(b.username));
  } catch {
    return [];
  }
}

function accessLevelLabel(level?: number): string | undefined {
  if (level == null) {
    return undefined;
  }
  if (level >= 40) {
    return "maintainer+";
  }
  if (level >= 30) {
    return "developer";
  }
  if (level >= 20) {
    return "reporter";
  }
  return `level:${level}`;
}

function parseJsonLinesOrArray(text: string): MrCandidate[] {
  const t = text.trim();
  if (!t) {
    return [];
  }
  try {
    if (t.startsWith("[")) {
      const arr = JSON.parse(t) as MrCandidate[];
      return arr.filter((x) => x.username);
    }
  } catch {
    // jq 可能逐行输出对象
  }
  const out: MrCandidate[] = [];
  for (const line of t.split("\n")) {
    const s = line.trim();
    if (!s) {
      continue;
    }
    try {
      const obj = JSON.parse(s) as MrCandidate;
      if (obj.username) {
        out.push(obj);
      }
    } catch {
      // ignore
    }
  }
  return out;
}

/**
 * 准备创建 MR：识别平台、检查 CLI/Token、拉取候选评审人、给出默认源/目标分支。
 */
export async function prepareCreateMr(
  options: PrepareCreateMrOptions,
): Promise<PrepareCreateMrResult> {
  const repoRoot = await resolveRepoRoot(options.cwd);
  const remote = options.remote ?? "origin";
  const into = options.into.trim();
  const from = options.from.trim();
  if (!into || !from) {
    throw new GitError("into / from 不能为空", { code: "USAGE" });
  }

  const url = await remoteUrl(repoRoot, remote);
  const platform = detectMrPlatform(url);
  const targetBranch = branchNameForMr(into);
  const sourceBranch = await resolveDefaultSource(
    repoRoot,
    into,
    from,
    remote,
    options.sourceBranch,
  );
  const title = `Merge ${sourceBranch} into ${targetBranch}`;
  const createMrUrl = buildCreateMrUrl(url, sourceBranch, targetBranch);
  const messages: string[] = [];
  const method = options.method ?? null;

  let cli: "gh" | "glab" | null = null;
  let cliError: string | undefined;
  let candidates: MrCandidate[] = [];

  if (method === "browser") {
    messages.push("已选择浏览器创建页方式");
    return {
      repoRoot,
      platform,
      cli: null,
      remote,
      remoteUrl: url,
      sourceBranch,
      targetBranch,
      title,
      candidates: [],
      createMrUrl,
      messages,
    };
  }

  if (method === "token" && options.token?.trim()) {
    if (platform === "github") {
      candidates = await listGithubCandidatesByToken(url, options.token.trim());
      messages.push(`已通过 Token API 加载 ${candidates.length} 位协作者`);
    } else if (platform === "gitlab") {
      candidates = await listGitlabCandidatesByToken(url, options.token.trim());
      messages.push(`已通过 Token API 加载 ${candidates.length} 位成员`);
    }
    return {
      repoRoot,
      platform,
      cli: null,
      remote,
      remoteUrl: url,
      sourceBranch,
      targetBranch,
      title,
      candidates,
      createMrUrl,
      messages,
    };
  }

  const ghBin = platform === "github" ? options.cliPath || "gh" : "gh";
  const glabBin = platform === "gitlab" ? options.cliPath || "glab" : "glab";

  if (platform === "github") {
    const check = await checkGh(repoRoot, ghBin);
    if (check.ok) {
      cli = "gh";
      candidates = await listGithubCandidates(repoRoot, url, ghBin);
      messages.push(`已通过 gh 加载 ${candidates.length} 位协作者/可指派用户`);
    } else {
      cliError = check.error;
      messages.push(check.error ?? "gh 不可用");
    }
  } else if (platform === "gitlab") {
    const check = await checkGlab(repoRoot, glabBin);
    if (check.ok) {
      cli = "glab";
      candidates = await listGitlabCandidates(repoRoot, url, glabBin);
      messages.push(`已通过 glab 加载 ${candidates.length} 位项目成员`);
    } else {
      cliError = check.error;
      messages.push(check.error ?? "glab 不可用");
    }
  } else {
    cliError = "无法识别远程平台（非 GitHub / GitLab）";
    messages.push(cliError);
  }

  return {
    repoRoot,
    platform,
    cli,
    remote,
    remoteUrl: url,
    sourceBranch,
    targetBranch,
    title,
    candidates,
    createMrUrl,
    messages,
    cliError,
  };
}

/**
 * 按配置方式创建 PR/MR（CLI / 扩展目录 CLI / Token / 浏览器仅返回链接）。
 */
export async function createMergeRequest(
  options: CreateMergeRequestOptions,
): Promise<CreateMergeRequestResult> {
  const repoRoot = await resolveRepoRoot(options.cwd);
  const remote = options.remote ?? "origin";
  const url = await remoteUrl(repoRoot, remote);
  const platform = detectMrPlatform(url);
  const sourceBranch = branchNameForMr(options.sourceBranch);
  const targetBranch = branchNameForMr(options.targetBranch);
  const title =
    options.title?.trim() || `Merge ${sourceBranch} into ${targetBranch}`;
  const body = options.body?.trim() || "Created via Git Insight.";
  const reviewers = [...new Set((options.reviewers ?? []).map((r) => r.trim()).filter(Boolean))];
  const messages: string[] = [];
  const method = options.method ?? "cli";

  if (method === "browser") {
    const link = buildCreateMrUrl(url, sourceBranch, targetBranch);
    messages.push("浏览器创建页模式：请在打开的页面中提交 MR/PR");
    return {
      platform,
      via: "browser",
      url: link,
      sourceBranch,
      targetBranch,
      messages,
    };
  }

  if (method === "token") {
    const token = options.token?.trim();
    if (!token) {
      throw new GitError("未配置 Token，请在「Git 配置」中填写并保存", {
        code: "NO_TOKEN",
      });
    }
    if (platform === "github") {
      const prUrl = await createGithubPrByToken({
        remoteUrl: url,
        token,
        sourceBranch,
        targetBranch,
        title,
        body,
        reviewers,
      });
      messages.push("已用 GitHub Token API 创建 PR");
      return {
        platform,
        via: "token",
        url: prUrl,
        sourceBranch,
        targetBranch,
        messages,
      };
    }
    if (platform === "gitlab") {
      const mrUrl = await createGitlabMrByToken({
        remoteUrl: url,
        token,
        sourceBranch,
        targetBranch,
        title,
        body,
        reviewers,
      });
      messages.push("已用 GitLab Token API 创建 MR");
      return {
        platform,
        via: "token",
        url: mrUrl,
        sourceBranch,
        targetBranch,
        messages,
      };
    }
    throw new GitError("无法识别远程平台", { code: "UNKNOWN_PLATFORM" });
  }

  // cli | download-cli
  if (platform === "github") {
    const bin = options.cliPath || "gh";
    const check = await checkGh(repoRoot, bin);
    if (!check.ok) {
      throw new GitError(check.error ?? "gh 不可用", { code: "CLI_UNAVAILABLE" });
    }
    const args = [
      "pr",
      "create",
      "--base",
      targetBranch,
      "--head",
      sourceBranch,
      "--title",
      title,
      "--body",
      body,
    ];
    if (reviewers.length > 0) {
      args.push("--reviewer", reviewers.join(","));
    }
    const run = await runCmd(bin, args, repoRoot);
    if (run.code !== 0) {
      throw new GitError(
        `gh pr create 失败：${(run.stderr || run.stdout).trim()}`,
        { code: "CREATE_MR_FAILED", stderr: run.stderr, stdout: run.stdout },
      );
    }
    const prUrl = (run.stdout.trim().split("\n").filter(Boolean).pop() ?? "").trim();
    messages.push(`已用 gh 创建 PR`);
    return {
      platform,
      via: "gh",
      url: prUrl || buildCreateMrUrl(url, sourceBranch, targetBranch),
      sourceBranch,
      targetBranch,
      messages,
    };
  }

  if (platform === "gitlab") {
    const bin = options.cliPath || "glab";
    const check = await checkGlab(repoRoot, bin);
    if (!check.ok) {
      throw new GitError(check.error ?? "glab 不可用", { code: "CLI_UNAVAILABLE" });
    }
    const args = [
      "mr",
      "create",
      "--source-branch",
      sourceBranch,
      "--target-branch",
      targetBranch,
      "--title",
      title,
      "--description",
      body,
      "--yes",
    ];
    for (const r of reviewers) {
      args.push("--reviewer", r);
    }
    const run = await runCmd(bin, args, repoRoot);
    if (run.code !== 0) {
      throw new GitError(
        `glab mr create 失败：${(run.stderr || run.stdout).trim()}`,
        { code: "CREATE_MR_FAILED", stderr: run.stderr, stdout: run.stdout },
      );
    }
    const mrUrl =
      run.stdout.match(/https?:\/\/\S+/)?.[0] ??
      buildCreateMrUrl(url, sourceBranch, targetBranch);
    messages.push(`已用 glab 创建 MR`);
    return {
      platform,
      via: "glab",
      url: mrUrl,
      sourceBranch,
      targetBranch,
      messages,
    };
  }

  throw new GitError("无法识别远程平台，请确认 origin 为 GitHub 或 GitLab", {
    code: "UNKNOWN_PLATFORM",
  });
}
