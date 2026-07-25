/** 一键申请 MR 的鉴权/执行方式 */
export type MrMethod = "cli" | "download-cli" | "token" | "browser";

export interface GitInsightProjectConfig {
  version: 1;
  /** null = 用户尚未选择 */
  mrMethod: MrMethod | null;
  /** 扩展 globalState 持久化（各仓库共用）；旧版曾写项目内 config.local.json */
  githubToken?: string;
  gitlabToken?: string;
  updatedAt: number;
}

export const GIT_INSIGHT_DIR = ".git-insight";
export const GIT_INSIGHT_CONFIG_FILE = "config.local.json";

export function defaultGitInsightConfig(): GitInsightProjectConfig {
  return {
    version: 1,
    mrMethod: null,
    githubToken: "",
    gitlabToken: "",
    updatedAt: Date.now(),
  };
}

export function mrMethodLabel(method: MrMethod): string {
  switch (method) {
    case "cli":
      return "A. 本机已安装的 gh / glab";
    case "download-cli":
      return "B. 下载 CLI 到扩展目录";
    case "token":
      return "C. Token（API）";
    case "browser":
      return "D. 仅打开浏览器创建页";
    default:
      return method;
  }
}
