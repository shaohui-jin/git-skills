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
  /** 给人看的有效期说明（中国时间） */
  expiresMessage?: string;
  /** 标题旁短状态，如「有效」「无效」「格式错误」 */
  statusLabel: string;
  error?: string;
  /** 综合是否可用（格式对且 API 成功） */
  ok: boolean;
}

/** GitHub：经典 PAT / fine-grained / OAuth 等常见前缀 */
const GITHUB_PAT =
  /^(ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,}|gho_[A-Za-z0-9]{36}|ghu_[A-Za-z0-9]{36}|ghs_[A-Za-z0-9]{36}|ghr_[A-Za-z0-9]{36})$/;

/** GitLab：仅允许 glpat- 前缀的 Personal Access Token */
const GITLAB_PAT = /^glpat-[A-Za-z0-9_\-]{20,}$/;

/** 格式化为中国时区：yyyy/MM/dd HH:mm:ss */
export function formatChinaDateTime(input: string): string {
  let ms = Date.parse(input);
  if (Number.isNaN(ms) && /^\d{4}-\d{2}-\d{2}$/.test(input)) {
    // GitLab 常只返回日期：按当天中国时间 23:59:59
    ms = Date.parse(`${input}T23:59:59+08:00`);
  }
  if (Number.isNaN(ms)) {
    return input;
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(ms));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  const hour = get("hour") === "24" ? "00" : get("hour");
  return `${get("year")}/${get("month")}/${get("day")} ${hour}:${get("minute")}:${get("second")}`;
}

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
  if (/^gh[pousr]_/i.test(t) || /^github_pat_/i.test(t)) {
    return {
      ok: false,
      message: "这是 GitHub Token 格式，GitLab 必须使用 glpat- 前缀",
    };
  }
  if (GITLAB_PAT.test(t)) {
    return { ok: true, kind: "personal access token", message: "格式正确（glpat-）" };
  }
  if (/^glpat-/i.test(t)) {
    return {
      ok: false,
      message: "须以 glpat- 开头，且后面至少 20 位字母数字/下划线/连字符",
    };
  }
  return {
    ok: false,
    message: "格式不符：GitLab Token 必须以 glpat- 为前缀",
  };
}

function formatExpiryMessage(
  expiresAt: string | null | undefined,
  platform?: TokenPlatform,
  token?: string,
): string | undefined {
  if (expiresAt === undefined) {
    // 拿不到过期时间的原因按平台/前缀区分，比一句「有效期未知」更有诊断价值：
    if (platform === "github") {
      if (token?.startsWith("github_pat_")) {
        return "有效（fine-grained token 不返回有效期，以 GitHub 设置页为准）";
      }
      // classic PAT（ghp_）本应返回 github-authentication-token-expiration 响应头；
      // 拿不到常见原因：token 创建时选了 No expiration，或代理/网关剥掉了非标准头。
      return "有效（未返回有效期：永不过期的 token 不带此信息；若经代理访问，代理可能剥掉该响应头）";
    }
    if (platform === "gitlab") {
      return "有效（未能读取有效期：token 需含 read_api 权限或服务版本较旧）";
    }
    return "有效期未知";
  }
  if (expiresAt === null) {
    return "永久有效";
  }
  const china = formatChinaDateTime(expiresAt);
  let ms = Date.parse(expiresAt);
  if (Number.isNaN(ms) && /^\d{4}-\d{2}-\d{2}$/.test(expiresAt)) {
    ms = Date.parse(`${expiresAt}T23:59:59+08:00`);
  }
  if (Number.isNaN(ms)) {
    return `有效期 ${china}`;
  }
  const days = Math.floor((ms - Date.now()) / (24 * 60 * 60 * 1000));
  if (days < 0) {
    return `已过期（${china}）`;
  }
  if (days === 0) {
    return `今日到期（${china}）`;
  }
  return `至 ${china}`;
}

function statusFromResult(partial: {
  ok: boolean;
  formatOk: boolean;
  apiChecked: boolean;
  error?: string;
}): string {
  if (!partial.formatOk) {
    return "格式错误";
  }
  if (!partial.apiChecked) {
    return "未校验";
  }
  if (partial.ok) {
    return "有效";
  }
  if (partial.error?.includes("过期")) {
    return "已过期";
  }
  return "无效";
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
      statusLabel: "格式错误",
      ok: false,
      error: format.message,
    };
  }
  const t = token.trim();
  const expiryFor = (exp: string | null | undefined) =>
    formatExpiryMessage(exp, "github", t);
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
      expiresAt = undefined;
    }

    if (res.status === 401 || res.status === 403) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      const error = body.message || `GitHub 拒绝该 Token（HTTP ${res.status}）`;
      return {
        platform: "github",
        formatOk: true,
        formatMessage: format.message,
        apiChecked: true,
        apiOk: false,
        expiresAt,
        expiresMessage: expiryFor(expiresAt),
        statusLabel: statusFromResult({ ok: false, formatOk: true, apiChecked: true, error }),
        ok: false,
        error,
      };
    }
    if (!res.ok) {
      const error = `GitHub API 异常：HTTP ${res.status}`;
      return {
        platform: "github",
        formatOk: true,
        formatMessage: format.message,
        apiChecked: true,
        apiOk: false,
        statusLabel: "无效",
        ok: false,
        error,
      };
    }
    const user = (await res.json()) as { login?: string };
    const expiresMessage = expiryFor(expiresAt);
    const expired =
      expiresAt != null &&
      !Number.isNaN(Date.parse(expiresAt)) &&
      Date.parse(expiresAt) < Date.now();
    const ok = !expired;
    return {
      platform: "github",
      formatOk: true,
      formatMessage: format.message,
      apiChecked: true,
      apiOk: ok,
      login: user.login,
      expiresAt: expiresAt === undefined ? undefined : expiresAt,
      expiresMessage,
      statusLabel: statusFromResult({
        ok,
        formatOk: true,
        apiChecked: true,
        error: expired ? "Token 已过期" : undefined,
      }),
      ok,
      error: expired ? "Token 已过期" : undefined,
    };
  } catch (err) {
    const error = `无法连接 GitHub API：${err instanceof Error ? err.message : String(err)}`;
    return {
      platform: "github",
      formatOk: true,
      formatMessage: format.message,
      apiChecked: true,
      apiOk: false,
      statusLabel: "无效",
      ok: false,
      error,
    };
  }
}

/**
 * 校验 GitLab Token：格式 + GET /user；再试 personal_access_tokens/self 取 expires_at。
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
      statusLabel: "格式错误",
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
      statusLabel: "无效",
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
      const error = body.message || `GitLab 拒绝该 Token（HTTP ${res.status}）`;
      return {
        platform: "gitlab",
        formatOk: true,
        formatMessage: format.message,
        apiChecked: true,
        apiOk: false,
        statusLabel: "无效",
        ok: false,
        error,
      };
    }
    if (!res.ok) {
      return {
        platform: "gitlab",
        formatOk: true,
        formatMessage: format.message,
        apiChecked: true,
        apiOk: false,
        statusLabel: "无效",
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
            statusLabel: "无效",
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
            statusLabel: "无效",
            ok: false,
            error: "Token 未处于 active 状态",
          };
        }
        expiresAt = pat.expires_at === undefined ? null : pat.expires_at;
        if (expiresAt) {
          const end = Date.parse(
            /^\d{4}-\d{2}-\d{2}$/.test(expiresAt)
              ? `${expiresAt}T23:59:59+08:00`
              : expiresAt,
          );
          if (!Number.isNaN(end) && end < Date.now()) {
            return {
              platform: "gitlab",
              formatOk: true,
              formatMessage: format.message,
              apiChecked: true,
              apiOk: false,
              login: user.username,
            expiresAt,
            expiresMessage: formatExpiryMessage(expiresAt, "gitlab", t),
            statusLabel: "已过期",
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
      expiresMessage: formatExpiryMessage(expiresAt, "gitlab", t),
      statusLabel: "有效",
      ok: true,
    };
  } catch (err) {
    return {
      platform: "gitlab",
      formatOk: true,
      formatMessage: format.message,
      apiChecked: true,
      apiOk: false,
      statusLabel: "无效",
      ok: false,
      error: `无法连接 GitLab API：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** 标题旁展示：状态 · 有效期 */
export function titleSideStatus(r: TokenValidateResult): string {
  const parts = [r.statusLabel];
  if (r.ok && r.login) {
    parts.push(r.login);
  }
  // 校验失败时优先显示具体错误原因，而不是模糊的"有效期未知"
  if (!r.ok && r.error && r.formatOk) {
    parts.push(r.error);
  } else if (r.expiresMessage) {
    parts.push(r.expiresMessage);
  } else if (!r.formatOk && r.formatMessage) {
    parts.push(r.formatMessage);
  }
  return parts.join(" · ");
}

export function summarizeTokenValidation(r: TokenValidateResult): string {
  return titleSideStatus(r);
}
