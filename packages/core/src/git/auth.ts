/**
 * 将扩展配置中的 Token 注入 git HTTPS 请求，避免唤起系统 GitHub 登录框。
 */

export type GitAuthProvider = "github" | "gitlab" | "unknown";

export interface GitAuthOptions {
  token?: string;
  provider?: GitAuthProvider;
  /**
   * true（默认）：先探测本机 Git 是否已能访问远程（已登录/SSH/凭据缓存）；
   * 只有探测失败时才使用 token（方案 C 兜底）。
   * false：始终带 token。
   */
  preferExisting?: boolean;
}

/** 供 spawn 使用的环境变量：禁止终端/GCM 弹交互登录 */
export function gitNonInteractiveEnv(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...base,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    GIT_ASKPASS: "",
    // 部分环境下 VS Code/Cursor 会注入 askpass；清空避免弹 Connect to GitHub
    VSCODE_GIT_ASKPASS_NODE: "",
    VSCODE_GIT_ASKPASS_MAIN: "",
    VSCODE_GIT_IPC_HANDLE: "",
    LANG: "C",
  };
}

/**
 * 生成 `git -c http.extraHeader=...` 参数前缀。
 * GitHub / GitLab PAT 均可用 Bearer。
 */
export function gitAuthConfigArgs(auth?: GitAuthOptions): string[] {
  const token = auth?.token?.trim();
  if (!token) {
    return [];
  }
  // 注意：-c 的值里不要让 shell 拆分；spawn 数组传参即可
  return ["-c", `http.extraHeader=Authorization: Bearer ${token}`];
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
  // GitHub 及默认
  return httpsUrl.replace(
    /^https:\/\//i,
    `https://x-access-token:${encodeURIComponent(t)}@`,
  );
}
