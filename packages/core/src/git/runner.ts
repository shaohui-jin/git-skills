import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  gitAuthConfigArgs,
  gitInteractiveEnv,
  gitNonInteractiveEnv,
  type GitAuthOptions,
} from "./auth.js";

export class GitError extends Error {
  readonly code: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly args: string[];

  constructor(
    message: string,
    options: { code?: string; stdout?: string; stderr?: string; args?: string[] },
  ) {
    super(message);
    this.name = "GitError";
    this.code = options.code ?? "GIT_ERROR";
    this.stdout = options.stdout ?? "";
    this.stderr = options.stderr ?? "";
    this.args = options.args ?? [];
  }
}

export interface GitRunResult {
  stdout: string;
  stderr: string;
  code: number;
}

export async function runGit(
  cwd: string,
  args: string[],
  options?: {
    allowFail?: boolean;
    /** stderr 按行回调（git --progress 常用 \\r 刷新） */
    onStderrLine?: (line: string) => void;
    /** 注入 HTTPS Token（方案 C） */
    auth?: GitAuthOptions;
    /** true：允许 GCM / Cursor 弹窗登录（最后兜底） */
    interactive?: boolean;
    /** 额外环境变量 */
    env?: NodeJS.ProcessEnv;
  },
): Promise<GitRunResult> {
  return new Promise((resolvePromise, reject) => {
    const finalArgs = [...gitAuthConfigArgs(options?.auth), ...args];
    const baseEnv = options?.interactive
      ? gitInteractiveEnv(process.env)
      : gitNonInteractiveEnv(process.env);
    const child = spawn("git", finalArgs, {
      cwd,
      windowsHide: true,
      env: {
        ...baseEnv,
        ...options?.env,
      },
    });

    // 逐 chunk 调 toString 会把跨 chunk 边界的多字节字符切坏（中文提交信息、
    // 中文文件内容都会变成 U+FFFD），所以 stdout 攒完再解码，stderr 用增量解码器。
    const stdoutChunks: Buffer[] = [];
    const stderrDecoder = new StringDecoder("utf8");
    let stderr = "";
    let stderrBuf = "";

    const flushStderrLines = (chunk: string, final = false) => {
      stderrBuf += chunk;
      const parts = stderrBuf.split(/\r|\n/);
      stderrBuf = final ? "" : (parts.pop() ?? "");
      if (final && parts.length === 0 && stderrBuf) {
        parts.push(stderrBuf);
        stderrBuf = "";
      }
      for (const line of parts) {
        if (line.trim()) {
          options?.onStderrLine?.(line);
        }
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = stderrDecoder.write(chunk);
      if (!text) {
        return;
      }
      stderr += text;
      if (options?.onStderrLine) {
        flushStderrLines(text);
      }
    });
    child.on("error", (err) => {
      reject(
        new GitError(`无法启动 git：${err.message}`, {
          code: "GIT_SPAWN_FAILED",
          args: finalArgs,
        }),
      );
    });
    child.on("close", (code) => {
      const tail = stderrDecoder.end();
      if (tail) {
        stderr += tail;
        if (options?.onStderrLine) {
          flushStderrLines(tail);
        }
      }
      if (options?.onStderrLine && stderrBuf.trim()) {
        flushStderrLines("", true);
      }
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const exit = code ?? 1;
      if (exit !== 0 && !options?.allowFail) {
        reject(
          new GitError(
            stderr.trim() || stdout.trim() || `git ${finalArgs.join(" ")} failed`,
            {
              code: "GIT_COMMAND_FAILED",
              stdout,
              stderr,
              args: finalArgs,
            },
          ),
        );
        return;
      }
      resolvePromise({ stdout, stderr, code: exit });
    });
  });
}

export async function resolveRepoRoot(cwd?: string): Promise<string> {
  const start = resolve(cwd ?? process.cwd());
  const { stdout } = await runGit(start, ["rev-parse", "--show-toplevel"]);
  const root = stdout.trim();
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
}

export async function revParse(cwd: string, rev: string): Promise<string> {
  const { stdout } = await runGit(cwd, ["rev-parse", "--verify", `${rev}^{commit}`]);
  return stdout.trim();
}

export async function mergeBase(cwd: string, a: string, b: string): Promise<string> {
  const { stdout } = await runGit(cwd, ["merge-base", a, b]);
  return stdout.trim();
}

/** 无共同祖先时返回 null（不抛错），用于合并预演结构化输出 */
export async function tryMergeBase(
  cwd: string,
  a: string,
  b: string,
): Promise<string | null> {
  const result = await runGit(cwd, ["merge-base", a, b], { allowFail: true });
  if (result.code !== 0) {
    return null;
  }
  const sha = result.stdout.trim();
  return sha || null;
}

export async function ensureRev(cwd: string, rev: string): Promise<string> {
  try {
    return await revParse(cwd, rev);
  } catch {
    throw new GitError(`找不到引用：${rev}（可先 fetch，或确认分支名）`, {
      code: "REV_NOT_FOUND",
      args: ["rev-parse", rev],
    });
  }
}
