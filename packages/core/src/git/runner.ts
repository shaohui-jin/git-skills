import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

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
  },
): Promise<GitRunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, {
      cwd,
      windowsHide: true,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        LANG: "C",
      },
    });

    let stdout = "";
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
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr += text;
      if (options?.onStderrLine) {
        flushStderrLines(text);
      }
    });
    child.on("error", (err) => {
      reject(
        new GitError(`无法启动 git：${err.message}`, {
          code: "GIT_SPAWN_FAILED",
          args,
        }),
      );
    });
    child.on("close", (code) => {
      if (options?.onStderrLine && stderrBuf.trim()) {
        flushStderrLines("", true);
      }
      const exit = code ?? 1;
      if (exit !== 0 && !options?.allowFail) {
        reject(
          new GitError(stderr.trim() || stdout.trim() || `git ${args.join(" ")} failed`, {
            code: "GIT_COMMAND_FAILED",
            stdout,
            stderr,
            args,
          }),
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
