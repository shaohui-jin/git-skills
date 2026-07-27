/**
 * 方案 C：Token 格式与 API 有效性校验（GitHub / GitLab）。
 */

export type TokenPlatform = "github" | "gitlab";

export interface TokenFormatResult {
  ok: boolean;
  kind?: string;
  message: string;
}

export interface TokenValidateResult {
  platform: TokenPlatform;
  formatOk: boolean;
  formatMessage: string;
  /** API 探测是否执行 */
  apiChecked: boolean;
  apiOk: boolean;
  login?: string;
  /** ISO 日期（仅日期或含时间）；null=永不过期/未设置；undefined=未知 */
  expiresAt?: string | null;
  /** 给人看的有效期说明 */
  expiresMessage?: string;
  error?: string;
  /** 综合是否可用（格式对且 API 成功） */
  ok: boolean;
}

/** GitHub：经典 PAT / fine-grained / OAuth 等常见前缀 */
const GITHUB_PAT =
  /^(ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,}|gho_[A-Za-z0-9]{36}|ghu_[A-Za-z0-9]{36}|ghs_[A-Za-z0-9]{36}|ghr_[A-Za-z0-9]{36})$/;

/** GitLab Personal Access Token（含常见 glpat-） */
const GITLAB_PAT = /^(glpat-[A-Za-z0-9_\-]{20,}|gldt-[A-Za-z0-9_\-]{20,}|gloas-[A-Za-z0-9_\-]{20,})$/;

export function validateGithubTokenFormat(token: string): TokenFormatResult {
  const t = token.trim();
  if (!t) {
    return { ok: false, message: "请填写 GitHub Token" };
  }
  if (t.includes(" ") || t.includes("\n")) {
    return { ok: false, message: "Token 不应包含空格或换行" };
  }
  if (GITHUB_PAT.test(t)) {
    const kind = t.startsWith("github_pat_")
      ? "fine-grained PAT"
      : t.startsWith("ghp_")
        ? "classic PAT"
        : "GitHub token";
    return { ok: true, kind, message: `格式正确（${kind}）` };
  }
  if (/^gh[pousr]_/i.test(t) || /^github_pat_/i.test(t)) {
    return {
      ok: false,
      message: "前缀像 GitHub Token，但长度或字符不符合常见格式，请检查是否复制完整",
    };
  }
  return {
    ok: false,
    message: "格式不符：期望 ghp_… / github_pat_… 等 GitHub Personal Access Token",
  };
}

export function validateGitlabTokenFormat(token: string): TokenFormatResult {
  const t = token.trim();
  if (!t) {
    return { ok: false, message: "请填写 GitLab Token" };
  }
  if (t.includes(" ") || t.includes("\n")) {
    return { ok: false, message: "Token 不应包含空格或换行" };
  }
  if (GITLAB_PAT.test(t)) {
    const kind = t.startsWith("gldt-")
      ? "deploy token"
      : t.startsWith("gloas-")
        ? "OAuth token"
        : "personal access token";
    return { ok: true, kind, message: `格式正确（${kind}）` };
  }
  // 部分自建 GitLab 仍发放无前缀长 token
  if (/^[A-Za-z0-9_\-]{20,64}$/.test(t) && !t.includes(".")) {
    return {
      ok: true,
      kind: "legacy/opaque",
      message: "格式可接受（无 glpat- 前缀的长 token，常见于自建实例）",
    };
  }
  if (/^glpat-/i.test(t)) {
    return {
      ok: false,
      message: "前缀像 GitLab Token，但长度不足或含非法字符，请检查是否复制完整",
    };
  }
  return {
    ok: false,
    message: "格式不符：期望 glpat-…（GitLab Personal Access Token）",
  };
}

function formatExpiryMessage(expiresAt: string | null | undefined): string | undefined {
  if (expiresAt === undefined) {
    return "有效期：未知（平台未返回）";
  }
  if (expiresAt === null) {
    return "有效期：未设置过期（或永久）";
  }
  const ms = Date.parse(expiresAt);
  if (Number.isNaN(ms)) {
    return `有效期：${expiresAt}`;
  }
  const days = Math.floor((ms - Date.now()) / (24 * 60 * 60 * 1000));
  const local = new Date(ms).toLocaleString();
  if (days < 0) {
    return `已过期（${local}）`;
  }
  if (days === 0) {
    return `即将过期（今日，${local}）`;
  }
  return `有效期至 ${local}（约 ${days} 天）`;
}

/**
 * 校验 GitHub Token：格式 + GET /user；尽量读响应头中的过期时间。
 */
export async function validateGithubToken(token: string): Promise<TokenValidateResult> {
  const format = validateGithubTokenFormat(token);
  if (!format.ok) {
    return {
      platform: "github",
      formatOk: false,
      formatMessage: format.message,
      apiChecked: false,
      apiOk: false,
      ok: false,
      error: format.message,
    };
  }
  const t = token.trim();
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${t}`,
        "User-Agent": "git-insight",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    const expHeader = res.headers.get("github-authentication-token-expiration");
    let expiresAt: string | null | undefined;
    if (expHeader) {
      const parsed = Date.parse(expHeader);
      expiresAt = Number.isNaN(parsed) ? expHeader : new Date(parsed).toISOString();
    } else {
      // 经典 PAT 常无此头 → 视为未返回过期信息
      expiresAt = undefined;
    }

    if (res.status === 401 || res.status === 403) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      return {
        platform: "github",
        formatOk: true,
        formatMessage: format.message,
        apiChecked: true,
        apiOk: false,
        expiresAt,
        expiresMessage: formatExpiryMessage(expiresAt),
        ok: false,
        error: body.message || `GitHub 拒绝该 Token（HTTP ${res.status}）`,
      };
    }
    if (!res.ok) {
      return {
        platform: "github",
        formatOk: true,
        formatMessage: format.message,
        apiChecked: true,
        apiOk: false,
        ok: false,
        error: `GitHub API 异常：HTTP ${res.status}`,
      };
    }
    const user = (await res.json()) as { login?: string };
    const expiresMessage = formatExpiryMessage(expiresAt);
    const expired =
      expiresAt != null && !Number.isNaN(Date.parse(expiresAt)) && Date.parse(expiresAt) < Date.now();
    return {
      platform: "github",
      formatOk: true,
      formatMessage: format.message,
      apiChecked: true,
      apiOk: !expired,
      login: user.login,
      expiresAt: expiresAt === undefined ? undefined : expiresAt,
      expiresMessage,
      ok: !expired,
      error: expired ? "Token 已过期" : undefined,
    };
  } catch (err) {
    return {
      platform: "github",
      formatOk: true,
      formatMessage: format.message,
      apiChecked: true,
      apiOk: false,
      ok: false,
      error: `无法连接 GitHub API：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * 校验 GitLab Token：格式 + GET /user；再试 personal_access_tokens/self 取 expires_at。
 * @param apiOrigin 如 https://gitlab.com 或自建实例 origin
 */
export async function validateGitlabToken(
  token: string,
  apiOrigin: string,
): Promise<TokenValidateResult> {
  const format = validateGitlabTokenFormat(token);
  if (!format.ok) {
    return {
      platform: "gitlab",
      formatOk: false,
      formatMessage: format.message,
      apiChecked: false,
      apiOk: false,
      ok: false,
      error: format.message,
    };
  }
  let origin: string;
  try {
    origin = new URL(apiOrigin).origin;
  } catch {
    return {
      platform: "gitlab",
      formatOk: true,
      formatMessage: format.message,
      apiChecked: false,
      apiOk: false,
      ok: false,
      error: "无法解析 GitLab 地址，请确认仓库 origin 可访问",
    };
  }
  const t = token.trim();
  const headers = {
    "PRIVATE-TOKEN": t,
    "User-Agent": "git-insight",
  };
  try {
    const res = await fetch(`${origin}/api/v4/user`, { headers });
    if (res.status === 401 || res.status === 403) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      return {
        platform: "gitlab",
        formatOk: true,
        formatMessage: format.message,
        apiChecked: true,
        apiOk: false,
        ok: false,
        error: body.message || `GitLab 拒绝该 Token（HTTP ${res.status}）`,
      };
    }
    if (!res.ok) {
      return {
        platform: "gitlab",
        formatOk: true,
        formatMessage: format.message,
        apiChecked: true,
        apiOk: false,
        ok: false,
        error: `GitLab API 异常：HTTP ${res.status}`,
      };
    }
    const user = (await res.json()) as { username?: string; name?: string };
    let expiresAt: string | null | undefined = undefined;
    try {
      const self = await fetch(`${origin}/api/v4/personal_access_tokens/self`, {
        headers,
      });
      if (self.ok) {
        const pat = (await self.json()) as {
          expires_at?: string | null;
          active?: boolean;
          revoked?: boolean;
        };
        if (pat.revoked) {
          return {
            platform: "gitlab",
            formatOk: true,
            formatMessage: format.message,
            apiChecked: true,
            apiOk: false,
            login: user.username,
            ok: false,
            error: "Token 已被撤销",
          };
        }
        if (pat.active === false) {
          return {
            platform: "gitlab",
            formatOk: true,
            formatMessage: format.message,
            apiChecked: true,
            apiOk: false,
            login: user.username,
            ok: false,
            error: "Token 未处于 active 状态",
          };
        }
        expiresAt = pat.expires_at === undefined ? null : pat.expires_at;
        if (expiresAt) {
          // GitLab 常返回 YYYY-MM-DD
          const end = Date.parse(`${expiresAt}T23:59:59Z`);
          if (!Number.isNaN(end) && end < Date.now()) {
            return {
              platform: "gitlab",
              formatOk: true,
              formatMessage: format.message,
              apiChecked: true,
              apiOk: false,
              login: user.username,
              expiresAt,
              expiresMessage: formatExpiryMessage(expiresAt),
              ok: false,
              error: "Token 已过期",
            };
          }
        }
      }
    } catch {
      // self 接口旧版可能不存在，忽略
    }
    return {
      platform: "gitlab",
      formatOk: true,
      formatMessage: format.message,
      apiChecked: true,
      apiOk: true,
      login: user.username,
      expiresAt,
      expiresMessage: formatExpiryMessage(expiresAt),
      ok: true,
    };
  } catch (err) {
    return {
      platform: "gitlab",
      formatOk: true,
      formatMessage: format.message,
      apiChecked: true,
      apiOk: false,
      ok: false,
      error: `无法连接 GitLab API：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export function summarizeTokenValidation(r: TokenValidateResult): string {
  const parts: string[] = [];
  if (r.login) {
    parts.push(`账号 ${r.login}`);
  }
  if (r.expiresMessage) {
    parts.push(r.expiresMessage);
  }
  if (r.ok) {
    return `Token 有效${parts.length ? `：${parts.join("；")}` : ""}`;
  }
  return r.error || r.formatMessage || "Token 校验失败";
}
