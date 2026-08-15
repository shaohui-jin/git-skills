/**
 * 桩声明：避免 tsc 类型检查时拉取 extension 源码（extension 依赖 vscode 类型，
 * 但 MCP server 是纯 Node 运行时，没有 vscode 类型也不想耦合。
 *
 * MCP 的真实构建走 esbuild bundle（scripts/bundle.mjs），会内联 extension 代码，
 * 所以这里的桩只影响 tsc --noEmit 的类型检查，不影响运行时。
 */

// VS Code 全局类型兜底（extension 文件引用 Thenable 等）
declare type Thenable<T> = PromiseLike<T>;

declare module "../../extension/src/coreBridge.js" {
  export function handleWebviewRequest(
    req: unknown,
    cwd: string | null,
    options: {
      previewMode: boolean;
      configMemento: ConfigMemento;
      cliStorageDir: string;
      onProgress?: (update: { percent: number; label: string }) => Promise<void>;
    },
  ): Promise<{ messages: unknown[]; cwd?: string | null }>;

  export function busyLabelForRequest(req: unknown): string | undefined;
  export function requestStreamsProgress(req: unknown): boolean;
  export function resolveWorkspaceCwd(path: string): Promise<string | null>;
}

declare module "../../extension/src/gitConfigStore.js" {
  export interface ConfigMemento {
    get<T>(key: string): T | undefined;
    update(key: string, value: unknown): Promise<void>;
  }
}

declare module "../../extension/src/remoteRepo.js" {
  export function isRemoteOnlyMode(): boolean;
  export function looksLikeRemoteRepo(path: string): boolean;
}

declare module "../../extension/src/protocol.js" {
  export interface WebviewRequest {
    type: string;
    nonce?: string;
    path?: string;
    [key: string]: unknown;
  }
}
