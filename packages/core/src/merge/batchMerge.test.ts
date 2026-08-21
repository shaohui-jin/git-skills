/**
 * 批量合并技术预演用例（方案 3.8）。
 *
 * node:test + 临时 fixture 仓库（init + file:// 远端，全程离线）：
 * 1. merge-tree 干跑结果树 vs worktree 真合并结果树逐字节一致（等价性验证）
 * 2. 「d 冲突已解决，但 d 的临时分支与已合入的 b 冲突」→ 干跑能拦住
 * 3. up-to-date 跳过（源已是 into 祖先时不造冗余合并）
 * 4. 干跑后人为移动 ref → 实跑护栏触发（BATCH_STALE）
 * 5. 实跑产出批量分支并推送到 file:// 远端（MR 建单部分离线无法覆盖，验证到 push 为止）
 *
 * 另附：applyResolve keepLocal 语义（矩阵模式解决不推送、分支保留）。
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { runGit } from "../git/runner.js";
import {
  planBatchMerge,
  precheckBatchMr,
  runBatchMerge,
} from "./batchMerge.js";
import { applyStashedResolve } from "./applyResolve.js";

interface Fixture {
  /** 工作仓库（主工作区） */
  work: string;
  /** file:// 远端仓库（bare），当 origin */
  origin: string;
}

let fx: Fixture;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await runGit(cwd, args);
  return r.stdout.trim();
}

async function commitFile(
  cwd: string,
  path: string,
  content: string,
  message: string,
): Promise<string> {
  await writeFile(join(cwd, path), content, "utf8");
  await git(cwd, "add", "--", path);
  await git(cwd, "commit", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

before(async () => {
  const base = await mkdtemp(join(tmpdir(), "git-insight-batch-test-"));
  const work = join(base, "work");
  const origin = join(base, "origin.git");
  fx = { work, origin };

  await git(base, "init", "-b", "main", "work");
  await git(base, "init", "--bare", "-b", "main", "origin.git");

  await git(work, "config", "user.name", "tester");
  await git(work, "config", "user.email", "tester@example.com");
  await git(work, "remote", "add", "origin", origin);

  await commitFile(work, "base.txt", "base\n", "init");
  await git(work, "push", "-u", "origin", "main");
});

after(async () => {
  if (fx) {
    await rm(join(fx.work, ".."), { recursive: true, force: true }).catch(() => {});
  }
});

/** 建一条从 main 拉出的分支并写一个文件（不同文件名 → 各自与 main 干净、彼此不冲突） */
async function branchWithFile(
  name: string,
  file: string,
  content: string,
): Promise<void> {
  await git(fx.work, "checkout", "-b", name, "origin/main");
  await commitFile(fx.work, file, content, `${name}: ${file}`);
  await git(fx.work, "checkout", "main");
}

describe("批量干跑 planBatchMerge", () => {
  it("等价性：干跑结果树与 worktree 真合并结果树一致", async () => {
    await branchWithFile("b1", "b1.txt", "b1\n");
    await branchWithFile("b2", "b2.txt", "b2\n");

    const plan = await planBatchMerge({
      cwd: fx.work,
      into: "main",
      entries: [{ from: "b1" }, { from: "b2" }],
      fetch: false,
    });
    assert.equal(plan.clean, true, "两个不相交文件理应干跑全绿");
    assert.equal(plan.steps.length, 2);
    assert.ok(plan.steps.every((s) => s.outcome === "clean"));
    assert.equal(plan.changedFiles, 2);

    // 手工做一遍真合并，比对两个 HEAD 的树对象
    const run = await runBatchMerge({
      cwd: fx.work,
      into: "main",
      batchBranch: `merge/batch-test-${Date.now()}`,
      items: plan.items,
      fetch: false,
    });
    assert.equal(run.pushed, true);

    const wt = await mkdtemp(join(tmpdir(), "git-insight-equiv-"));
    try {
      await git(fx.work, "worktree", "add", "--detach", wt, "main");
      await git(wt, "merge", "--no-ff", "-m", "manual", plan.items[0]!.sourceSha);
      await git(wt, "merge", "--no-ff", "-m", "manual", plan.items[1]!.sourceSha);
      const manualTree = await git(wt, "rev-parse", "HEAD^{tree}");
      const batchTree = await git(fx.work, "rev-parse", `${run.batchBranch}^{tree}`);
      assert.equal(
        batchTree,
        manualTree,
        "干跑所代表的批量分支树应与逐个真合并的树逐字节一致",
      );
    } finally {
      await git(fx.work, "worktree", "remove", "--force", wt).catch(() => {});
    }
  });

  it("resolved 格子的新冲突：d 的临时分支与已合入的 b 冲突 → 干跑拦住", async () => {
    // b3 改 file.txt 上半，d 改 file.txt 下半：b3、d 各自与 main 干净
    await git(fx.work, "fetch", "--all");
    await git(fx.work, "checkout", "-b", "b3", "origin/main");
    await commitFile(fx.work, "file.txt", "a\nb3\nc\nd\ne\n", "b3 edit");
    await git(fx.work, "checkout", "main");

    await git(fx.work, "checkout", "-b", "d", "origin/main");
    await commitFile(fx.work, "file.txt", "a\nb\nc\nd-edit\ne\n", "d edit");
    await git(fx.work, "checkout", "main");

    // 模拟「d 已解决」：用 applyResolve keepLocal 产出本地临时分支（与 main 干净，直接 commit）
    const resolved = await applyStashedResolve({
      cwd: fx.work,
      into: "main",
      from: "d",
      files: [],
      push: false,
      keepLocal: true,
    });
    assert.equal(resolved.pushed, false);
    // keepLocal：本地分支必须保留
    const tempRef = await git(fx.work, "rev-parse", "--verify", `refs/heads/${resolved.tempBranch}`);
    assert.ok(tempRef, "keepLocal 模式下本地临时分支应保留");

    // 干跑：先合 b3（与 main 干净），再合 d 的临时分支 —— file.txt 改了同一区域会冲突
    const plan = await planBatchMerge({
      cwd: fx.work,
      into: "main",
      entries: [{ from: "b3" }, { from: "d", resolved: true }],
      fetch: false,
    });
    assert.equal(plan.clean, false, "d 临时分支与已合入的 b3 冲突，干跑必须拦住");
    assert.equal(plan.blockedAt, "d");
    assert.ok(plan.blockedPaths.includes("file.txt"));
    assert.match(plan.blockedReason ?? "", /冲突/);

    // 反过来先合 d 再合 b3 同样要拦（矩阵里两格各自与 main 干净，不等于批量序贯干净）
    const plan2 = await planBatchMerge({
      cwd: fx.work,
      into: "main",
      entries: [{ from: "d", resolved: true }, { from: "b3" }],
      fetch: false,
    });
    assert.equal(plan2.clean, false);
    assert.equal(plan2.blockedAt, "b3");
  });

  it("up-to-date：源已包含在目标里 → 跳过，不造冗余合并提交", async () => {
    // b4 = main 上直接推一个提交，b4 本身就在 main 的历史里
    const sha = await commitFile(fx.work, "already.txt", "x\n", "already in main");
    await git(fx.work, "branch", "b4", sha);
    await git(fx.work, "push", "origin", "main");

    const plan = await planBatchMerge({
      cwd: fx.work,
      into: "main",
      entries: [{ from: "b4" }],
      fetch: false,
    });
    assert.equal(plan.clean, true);
    assert.equal(plan.steps[0]!.outcome, "up-to-date");
    assert.equal(plan.changedFiles, 0);
  });

  it("sha 护栏：干跑后移动源 ref → 实跑拒绝（BATCH_STALE）", async () => {
    await branchWithFile("s1", "s1.txt", "s1\n");
    const plan = await planBatchMerge({
      cwd: fx.work,
      into: "main",
      entries: [{ from: "s1" }],
      fetch: false,
    });
    assert.equal(plan.clean, true);

    // 干跑与实跑之间，有人往 s1 推了新提交
    await git(fx.work, "checkout", "s1");
    await commitFile(fx.work, "s1.txt", "s1\ns1-more\n", "s1 moved");
    await git(fx.work, "checkout", "main");

    await assert.rejects(
      runBatchMerge({
        cwd: fx.work,
        into: "main",
        batchBranch: `merge/batch-stale-${Date.now()}`,
        items: plan.items,
        fetch: false,
      }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /已移动|已不存在/);
        return true;
      },
    );
  });

  it("实跑：批量分支推送到远端，MR 前终检 upToDate/clean", async () => {
    await branchWithFile("r1", "r1.txt", "r1\n");
    await branchWithFile("r2", "r2.txt", "r2\n");

    const plan = await planBatchMerge({
      cwd: fx.work,
      into: "main",
      entries: [{ from: "r1" }, { from: "r2" }],
      fetch: false,
    });
    assert.equal(plan.clean, true);

    const batchBranch = `merge/batch-push-${Date.now()}`;
    const run = await runBatchMerge({
      cwd: fx.work,
      into: "main",
      batchBranch,
      items: plan.items,
      fetch: false,
    });
    assert.equal(run.pushed, true, `推送失败：${run.pushError}`);
    assert.deepEqual(
      run.steps.map((s) => s.outcome),
      ["merged", "merged"],
    );

    // 远端确实有这条分支
    const remoteSha = await git(
      fx.work,
      "rev-parse",
      "--verify",
      `refs/remotes/origin/${batchBranch}`,
    );
    assert.equal(remoteSha, run.commitSha);

    // MR 前终检：into 没动过 → up-to-date（main 是批量分支的祖先）
    const pre = await precheckBatchMr({
      cwd: fx.work,
      into: "main",
      batchBranch,
      fetch: false,
    });
    assert.equal(pre.upToDate, true);
    assert.equal(pre.clean, true);

    // 远端同名批量分支必须被拒绝，绝不静默覆盖
    await assert.rejects(
      runBatchMerge({
        cwd: fx.work,
        into: "main",
        batchBranch,
        items: plan.items,
        fetch: false,
      }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /已存在同名批量分支/);
        return true;
      },
    );
  });
});

describe("applyResolve keepLocal 语义", () => {
  it("矩阵模式：push false + keepLocal → 本地分支保留", async () => {
    await git(fx.work, "fetch", "--all");
    await git(fx.work, "checkout", "-b", "k1", "origin/main");
    await commitFile(fx.work, "k1.txt", "k1\n", "k1 work");
    await git(fx.work, "checkout", "main");

    const res = await applyStashedResolve({
      cwd: fx.work,
      into: "main",
      from: "k1",
      files: [],
      push: false,
      keepLocal: true,
    });
    assert.equal(res.pushed, false);
    const exists = await runGit(fx.work, [
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${res.tempBranch}`,
    ]);
    assert.equal(exists.code, 0, "keepLocal 时本地临时分支必须保留");

    // 干跑应把这条本地临时分支解析为 temp-local 源
    const plan = await planBatchMerge({
      cwd: fx.work,
      into: "main",
      entries: [{ from: "k1", resolved: true }],
      fetch: false,
    });
    assert.equal(plan.clean, true);
    assert.equal(plan.items[0]!.sourceKind, "temp-local");
    assert.equal(plan.items[0]!.source, res.tempBranch);
  });

  it("单预演页（无 keepLocal）：push 失败即删净本地分支", async () => {
    await git(fx.work, "fetch", "--all");
    await git(fx.work, "checkout", "-b", "k2", "origin/main");
    await commitFile(fx.work, "k2.txt", "k2\n", "k2 work");
    await git(fx.work, "checkout", "main");

    // remote 指向不存在的仓库 → push 必败
    await assert.rejects(
      applyStashedResolve({
        cwd: fx.work,
        into: "main",
        from: "k2",
        files: [],
        push: true,
        remote: "nonexistent",
      }),
      /推送失败/,
    );
    // 旧语义：推失败 → 分支删干净
    const tempBranch = "merge/k2-into-main";
    const r = await runGit(fx.work, [
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${tempBranch}`,
    ], { allowFail: true });
    assert.notEqual(r.code, 0, "无 keepLocal 时推送失败应删除本地临时分支");
  });
});
