/**
 * 可插拔冲突 resolver：有些冲突不该让人一行行看。
 *
 * `.gitignore` 两边各加了几行、lockfile 两边各装了几个包、`CHANGELOG` 两边各加了一条——
 * 这些的正确解法是机械的，人工选边反而容易漏。resolver 就是把这类机械解法固化下来。
 *
 * ## 安全边界（改这个文件前务必读完）
 *
 * `regenerate` 类 resolver 会在冲突文件所在的 worktree 里**执行命令**。这意味着：
 *
 *   **绝不能让 resolver 配置来自被检出的仓库内容。**
 *
 * 不能从 `.git-insight/resolvers.json`、`package.json` 字段、或任何随分支切换的文件里读。
 * 否则任何人往仓库推一个分支，就能在预演它的人机器上执行任意命令——
 * 而「预演一个别人的分支」恰恰是本工具鼓励的动作，等于把 RCE 做成了主要用法。
 *
 * 配置只能来自两个地方，两者都在仓库之外、由本机用户掌控：
 *   1. 调用方在代码里显式传入（`ApplyResolveOptions.resolvers`）
 *   2. 用户级配置（`~/.git-insight/`）——本文件不读它，由上层显式加载后传进来
 *
 * 内置的 take-ours / take-theirs / union 不执行任何命令，无此风险。
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runGit } from "../git/runner.js";

export interface ResolveContext {
  /** 仓库内的相对路径，正斜杠 */
  path: string;
  /** 合入目标一侧（into / 左栏）的内容；文件在该侧不存在时为 null */
  ours: string | null;
  /** 待合入一侧（from / 右栏）的内容 */
  theirs: string | null;
  /** merge-base 一侧的内容 */
  base: string | null;
  /** 冲突所在的临时 worktree 根目录 */
  workDir: string;
  /** 在 workDir 里跑命令。仅 regenerate 类 resolver 需要 */
  run(cmd: string, args: string[]): Promise<{
    code: number;
    stdout: string;
    stderr: string;
  }>;
}

export interface ConflictResolver {
  id: string;
  label: string;
  /** 这个 resolver 管不管这个文件 */
  match(path: string): boolean;
  /** 返回解决后的完整内容；返回 null 表示「我处理不了，交给下一个」 */
  resolve(ctx: ResolveContext): Promise<string | null>;
}

/** 末尾换行跟着 ours；两边都没有就不加 */
function joinLines(lines: string[], sample: string | null): string {
  const body = lines.join("\n");
  return sample?.endsWith("\n") ? `${body}\n` : body;
}

function splitLines(text: string | null): string[] {
  if (!text) {
    return [];
  }
  return text.replace(/\r\n/g, "\n").split("\n");
}

export const takeOurs: ConflictResolver = {
  id: "take-ours",
  label: "总是保留线上（into）",
  match: () => true,
  resolve: async (ctx) => ctx.ours,
};

export const takeTheirs: ConflictResolver = {
  id: "take-theirs",
  label: "总是保留我的（from）",
  match: () => true,
  resolve: async (ctx) => ctx.theirs,
};

/**
 * 两边各加了几行、顺序无所谓的纯行集合文件：取并集。
 *
 * 两条刻意的取舍：
 *
 * 1. **只在「两边都只做了增量」时接手。** 任一侧删掉了 base 里的行，说明那是有意的移除，
 *    并集会把它悄悄加回来 —— 这种情况交还给人。
 * 2. **保持 ours 的原有顺序**，只把 theirs 独有的行追加到末尾；不排序。
 *    排序能得到一个与哪边是 ours 无关的规范结果，听着更「正确」，
 *    但代价是给一次加两行的改动生成一份整文件重排的 diff，review 的人看不出发生了什么。
 *    合并结果本来就偏向 ours，这里跟着这个惯例走。
 */
export const union: ConflictResolver = {
  id: "union",
  label: "取并集（.gitignore 这类行集合）",
  match: (path) => /(^|\/)(\.gitignore|\.dockerignore|\.eslintignore|\.npmignore)$/.test(path),
  resolve: async (ctx) => {
    if (ctx.ours == null || ctx.theirs == null) {
      return null;
    }
    const ours = splitLines(ctx.ours);
    const theirs = splitLines(ctx.theirs);
    const oursSet = new Set(ours.map((l) => l.trim()).filter(Boolean));
    const theirsSet = new Set(theirs.map((l) => l.trim()).filter(Boolean));

    for (const line of splitLines(ctx.base).map((l) => l.trim())) {
      if (line && (!oursSet.has(line) || !theirsSet.has(line))) {
        // 有一侧删了东西：不是纯增量，别自作主张
        return null;
      }
    }

    const merged = [...ours];
    const seen = new Set(oursSet);
    for (const line of theirs) {
      const t = line.trim();
      if (!t || seen.has(t)) {
        continue;
      }
      seen.add(t);
      merged.push(line);
    }
    // 末尾空行在合并两段文本时最容易堆出来，顺手压掉
    while (merged.length > 0 && merged[merged.length - 1]!.trim() === "") {
      merged.pop();
    }
    return joinLines(merged, ctx.ours);
  },
};

/**
 * 用命令重新生成，而不是合并文本。lockfile 的正确解法就是这个：
 * 先取一侧的 lock，再让包管理器按合并后的 manifest 重算。
 *
 * 造它就意味着执行命令，所以只能由调用方显式构造，永远不要从仓库文件里读出来。
 * 见本文件头部的安全边界。
 */
export function regenerate(opts: {
  id: string;
  label: string;
  match: (path: string) => boolean;
  /** 先落哪一侧再重算；默认 theirs（我的分支） */
  seed?: "ours" | "theirs";
  cmd: string;
  args: string[];
}): ConflictResolver {
  return {
    id: opts.id,
    label: opts.label,
    match: opts.match,
    resolve: async (ctx) => {
      const seed = (opts.seed ?? "theirs") === "ours" ? ctx.ours : ctx.theirs;
      if (seed == null) {
        return null;
      }
      const abs = join(ctx.workDir, ctx.path);
      // 先把一侧落到磁盘：包管理器要读到一个语法完整的 lock 才肯增量更新，
      // 带着冲突标记的文件会让它直接报错
      await writeFile(abs, seed, "utf8");
      const r = await ctx.run(opts.cmd, opts.args);
      if (r.code !== 0) {
        return null;
      }
      // 命令改的是磁盘上的文件，重新读回来才是结果
      try {
        return await readFile(abs, "utf8");
      } catch {
        return null;
      }
    },
  };
}

/** 内置且无副作用的那几个；take-ours / take-theirs 因为 match 全真，不放进默认集 */
export const builtinResolvers: readonly ConflictResolver[] = [union];

/**
 * 取冲突三方的内容。文件在某一侧不存在（增/删冲突）时该侧为 null。
 */
export async function readThreeWay(
  workDir: string,
  path: string,
): Promise<{ ours: string | null; theirs: string | null; base: string | null }> {
  // merge 期间 index 里 1=base 2=ours 3=theirs
  const stage = async (n: 1 | 2 | 3): Promise<string | null> => {
    const r = await runGit(workDir, ["show", `:${n}:${path}`], { allowFail: true });
    return r.code === 0 ? r.stdout : null;
  };
  const [base, ours, theirs] = await Promise.all([stage(1), stage(2), stage(3)]);
  return { base, ours, theirs };
}

export interface AutoResolveOutcome {
  path: string;
  resolverId: string;
  content: string;
}

/**
 * 对冲突文件依次试各个 resolver，第一个给出内容的胜出。
 * 没人接手的文件原样留在冲突态，由调用方按老路子处理（人工选边 / 报错中止）。
 */
export async function autoResolveConflicts(opts: {
  workDir: string;
  paths: readonly string[];
  resolvers: readonly ConflictResolver[];
  run: ResolveContext["run"];
}): Promise<AutoResolveOutcome[]> {
  const done: AutoResolveOutcome[] = [];
  for (const path of opts.paths) {
    const candidates = opts.resolvers.filter((r) => r.match(path));
    if (candidates.length === 0) {
      continue;
    }
    const three = await readThreeWay(opts.workDir, path);
    for (const resolver of candidates) {
      const content = await resolver.resolve({
        path,
        workDir: opts.workDir,
        run: opts.run,
        ...three,
      });
      if (content != null) {
        done.push({ path, resolverId: resolver.id, content });
        break;
      }
    }
  }
  return done;
}
