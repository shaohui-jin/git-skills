/**
 * Git HTTPS 鉴权：本机凭据 / 方案 C Token / 交互登录。
 */

export type GitAuthProvider = "github" | "gitlab" | "unknown";

export interface GitAuthOptions {
  token?: string;
  provider?: GitAuthProvider;
  /**
   * @deprecated 鉴权顺序已固定为：本机凭据 → Token → 交互登录
   */
  preferExisting?: boolean;
}

/** 禁止弹窗：用已有凭据缓存或 Token，不唤起 Connect to GitHub */
export function gitNonInteractiveEnv(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...base,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    GIT_ASKPASS: "",
    VSCODE_GIT_ASKPASS_NODE: "",
    VSCODE_GIT_ASKPASS_MAIN: "",
    VSCODE_GIT_IPC_HANDLE: "",
    LANG: "C",
  };
}

/**
 * 允许弹窗登录：保留 Cursor/VS Code askpass 与 GCM 交互，接近 WebStorm 行为。
 */
export function gitInteractiveEnv(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    GIT_TERMINAL_PROMPT: "1",
    GCM_INTERACTIVE: "always",
    LANG: "C",
  };
  // 若上层曾清空 askpass，恢复为未设置，让 Cursor 默认注入生效
  if (env.GIT_ASKPASS === "") {
    delete env.GIT_ASKPASS;
  }
  return env;
}

/**
 * 生成 `git -c http.extraHeader=...` 参数前缀。
 *
 * 注意：git 走 HTTPS Smart HTTP 时，与弹窗登录一致的是 Basic 认证：
 * - GitHub：username=`x-access-token`，password=`<PAT>`
 * - GitLab：username=`oauth2`，password=`<PAT>`
 * 仅用 `Authorization: Bearer` 对部分 Git/GCM 组合会失败（Token 本身有效也会挂）。
 */
export function gitAuthConfigArgs(auth?: GitAuthOptions): string[] {
  const token = auth?.token?.trim();
  if (!token) {
    return [];
  }
  const user =
    auth?.provider === "gitlab"
      ? "oauth2"
      : "x-access-token";
  const basic = Buffer.from(`${user}:${token}`, "utf8").toString("base64");
  return ["-c", `http.extraHeader=Authorization: Basic ${basic}`];
}

/** 把 Token 写入 HTTPS clone URL（clone 场景更稳） */
export function httpsUrlWithToken(
  httpsUrl: string,
  token: string | undefined,
  provider: GitAuthProvider = "github",
): string {
  const t = token?.trim();
  if (!t) {
    return httpsUrl;
  }
  if (provider === "gitlab") {
    return httpsUrl.replace(/^https:\/\//i, `https://oauth2:${encodeURIComponent(t)}@`);
  }
  return httpsUrl.replace(
    /^https:\/\//i,
    `https://x-access-token:${encodeURIComponent(t)}@`,
  );
}
