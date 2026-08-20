/** 一键申请 MR 的鉴权/执行方式 */
export type MrMethod = "cli" | "download-cli" | "token" | "browser";

export interface GitInsightProjectConfig {
  version: 1;
  /** null = 用户尚未选择 */
  mrMethod: MrMethod | null;
  /** 扩展 globalState 持久化（各仓库共用）；旧版曾写项目内 config.local.json */
  githubToken?: string;
  gitlabToken?: string;
  /**
   * 默认远程名（如 origin / upstream）。fetch、图合并、剥前缀、CLI 未传 --remote 时使用。
   * 以仓库实际 `git remote` 为准；不存在时回退 origin 或第一项。
   */
  defaultRemote?: string;
  /**
   * AI 选边：OpenAI 兼容 API（Cursor 的 vscode.lm 常为空时使用）
   * 例：https://api.openai.com/v1 或 http://127.0.0.1:11434/v1
   */
  aiApiBaseUrl?: string;
  aiApiKey?: string;
  /** 例：gpt-4o-mini / deepseek-chat / qwen2.5-coder */
  aiModel?: string;
  /**
   * 是否启用冲突自动解决（总开关）。false/null = 仅用内置 union，不使用任何预设模板。
   * 这是"出问题时一键关闭、退回安全默认"的逃生通道。
   */
  autoResolveEnabled?: boolean;
  /**
   * 已启用的预设模板 id 列表（见 core 的 resolverTemplateMeta）。仅 autoResolveEnabled=true 时生效。
   * 未知 id 会被忽略（容错，不崩）。
   */
  autoResolveTemplates?: string[];
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
    defaultRemote: "origin",
    aiApiBaseUrl: "https://api.openai.com/v1",
    aiApiKey: "",
    aiModel: "gpt-4o-mini",
    autoResolveEnabled: false,
    autoResolveTemplates: [],
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
