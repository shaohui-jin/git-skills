/**
 * 冲突预警常驻：后台定期算一次「我手上的分支现在还能干净合进目标吗」，变糟了才吭声。
 *
 * 三条设计约束，改动时别破坏：
 *   1. **只在变糟时打扰**。从干净变冲突、或冲突文件变多才弹通知；变好、持平都只更新状态栏。
 *      否则每 10 分钟弹一次「还是那 3 个冲突」，两轮就被用户关掉了。
 *   2. **绝不弹登录框**。用 fetchRemoteQuiet，拿不到凭据就退避，不抢焦点。
 *   3. **默认关闭**。后台跑 git 是要花电和网的，得用户明确开。
 *
 * 成本上靠 surveyMerges 的 sha 级缓存兜底：两侧 sha 没变时整轮几乎不花钱，
 * 只有 fetch 真的拉到新提交才会重新跑 merge-tree。
 */
import {
  fetchRemoteQuiet,
  resolveRemoteName,
  runGit,
  surveyMerges,
  type MergeSurveyCell,
} from "@shaohui_jin/git-insight-core";
import * as vscode from "vscode";
import { resolveWorkspaceCwd } from "./coreBridge.js";

type NotifyMode = "worse" | "always" | "never";

interface WatcherConfig {
  enabled: boolean;
  intervalMinutes: number;
  into: string;
  branches: string[];
  notify: NotifyMode;
}

const MIN_INTERVAL_MINUTES = 2;
/** 连续失败时退避的倍数上限，避免离线时每 10 分钟空转一次 */
const MAX_BACKOFF = 6;
const TRUNK_FALLBACKS = ["main", "master", "develop"];

function readConfig(): WatcherConfig {
  const cfg = vscode.workspace.getConfiguration("gitInsight.conflictWatcher");
  const raw = cfg.get<number>("intervalMinutes", 10);
  return {
    enabled: cfg.get<boolean>("enabled", false),
    intervalMinutes: Math.max(MIN_INTERVAL_MINUTES, Number.isFinite(raw) ? raw : 10),
    into: (cfg.get<string>("into", "") || "").trim(),
    branches: (cfg.get<string[]>("branches", []) ?? []).map((b) => b.trim()).filter(Boolean),
    notify: cfg.get<NotifyMode>("notify", "worse"),
  };
}

async function currentBranch(cwd: string): Promise<string | null> {
  const r = await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"], {
    allowFail: true,
  });
  const name = r.stdout.trim();
  return r.code === 0 && name && name !== "HEAD" ? name : null;
}

/** 目标分支没配时的猜测：remote 的 HEAD → main/master/develop */
async function guessInto(cwd: string, remote: string): Promise<string | null> {
  const head = await runGit(cwd, ["symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`], {
    allowFail: true,
  });
  const symbolic = head.stdout.trim();
  if (head.code === 0 && symbolic) {
    return symbolic;
  }
  for (const name of TRUNK_FALLBACKS) {
    const ref = `${remote}/${name}`;
    const probe = await runGit(cwd, ["rev-parse", "--verify", `${ref}^{commit}`], {
      allowFail: true,
    });
    if (probe.code === 0) {
      return ref;
    }
  }
  return null;
}

interface Snapshot {
  /** `from\0into` → 冲突文件数；-1 表示这一对没算成 */
  counts: Map<string, number>;
  dirtyPairs: number;
  totalFiles: number;
}

function snapshotOf(cells: MergeSurveyCell[]): Snapshot {
  const counts = new Map<string, number>();
  let dirtyPairs = 0;
  const files = new Set<string>();
  for (const c of cells) {
    if (c.outcome === "error" || c.outcome === "same") {
      counts.set(`${c.from}\u0000${c.into}`, -1);
      continue;
    }
    counts.set(`${c.from}\u0000${c.into}`, c.conflictPaths.length);
    if (c.conflictPaths.length > 0) {
      dirtyPairs += 1;
    }
    for (const p of c.conflictPaths) {
      files.add(p);
    }
  }
  return { counts, dirtyPairs, totalFiles: files.size };
}

/** 变糟 = 任意一对从「能合」变成「不能合」，或冲突文件变多 */
function worsenedBranches(prev: Snapshot | null, next: Snapshot): string[] {
  if (!prev) {
    // 首轮没有基线：只把本来就有冲突的那几条报出来
    return [...next.counts].filter(([, n]) => n > 0).map(([key]) => fromOf(key));
  }
  const hits: string[] = [];
  for (const [key, count] of next.counts) {
    if (count <= 0) {
      continue;
    }
    const before = prev.counts.get(key);
    if (before === undefined || before < 0 || count > before) {
      hits.push(fromOf(key));
    }
  }
  return hits;
}

function fromOf(key: string): string {
  return key.split("\u0000")[0] ?? key;
}

export class MergeWatcher implements vscode.Disposable {
  private readonly status: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private last: Snapshot | null = null;
  private failures = 0;
  /** 退避到期时间；离线时不必每个周期都去撞一次远程 */
  private cooldownUntil = 0;
  /** 用户点了「本次会话不再提醒」；改设置或重开窗口才恢复 */
  private muted = false;

  public constructor() {
    this.status = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100,
    );
    this.status.command = "gitInsight.checkConflicts";
    this.disposables.push(this.status);

    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("gitInsight.conflictWatcher")) {
          this.restart();
        }
      }),
      // 切回窗口时顺手看一眼：人离开的这段时间往往正是别人推东西的时候
      vscode.window.onDidChangeWindowState((state) => {
        if (state.focused) {
          void this.tick();
        }
      }),
    );

    this.restart();
  }

  public dispose(): void {
    this.stopTimer();
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  /** 命令面板手动触发：无论开关、静音和退避如何都跑一次，并把结果说清楚 */
  public async checkNow(): Promise<void> {
    if (this.running) {
      void vscode.window.showInformationMessage("Git Insight：正在检查中…");
      return;
    }
    this.cooldownUntil = 0;
    if (this.muted) {
      // 手动来问了，说明人又想看了：恢复轮询，这一轮的结论下面照常汇报
      this.muted = false;
      this.startTimer();
    }
    const result = await this.runOnce();
    if (!result) {
      void vscode.window.showWarningMessage(
        "Git Insight：没有可检查的分支（请打开一个 git 仓库，或在设置里配置 gitInsight.conflictWatcher.branches）",
      );
      return;
    }
    if (result.dirtyPairs === 0) {
      void vscode.window.showInformationMessage("Git Insight：当前都能干净合入。");
      return;
    }
    void this.showConflictMessage(result.dirtyPairs, result.totalFiles);
  }

  private restart(): void {
    this.stopTimer();
    // 改过设置就当人重新表过态，之前的静音作废
    this.muted = false;
    if (!readConfig().enabled) {
      this.status.hide();
      return;
    }
    this.status.text = "$(git-merge) 合并预警：待检查";
    this.status.tooltip = "Git Insight 冲突预警（点击立即检查）";
    this.status.show();
    this.startTimer();
    void this.tick();
  }

  private startTimer(): void {
    this.stopTimer();
    this.timer = setInterval(
      () => {
        void this.tick();
      },
      readConfig().intervalMinutes * 60_000,
    );
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    if (
      this.muted ||
      this.running ||
      Date.now() < this.cooldownUntil ||
      !readConfig().enabled
    ) {
      return;
    }
    await this.runOnce();
  }

  private backOff(): void {
    this.failures = Math.min(this.failures + 1, MAX_BACKOFF);
    const base = readConfig().intervalMinutes * 60_000;
    this.cooldownUntil = Date.now() + base * this.failures;
  }

  private async runOnce(): Promise<Snapshot | null> {
    if (this.running) {
      return null;
    }
    this.running = true;
    try {
      const cwd = await resolveWorkspaceCwd(
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      );
      if (!cwd) {
        return null;
      }
      const cfg = readConfig();
      const { remote } = await resolveRemoteName(cwd);
      const into = cfg.into || (await guessInto(cwd, remote));
      if (!into) {
        this.setStatus("$(question) 合并预警：未找到目标分支", "配置 gitInsight.conflictWatcher.into");
        return null;
      }

      let froms = cfg.branches;
      if (froms.length === 0) {
        const head = await currentBranch(cwd);
        froms = head ? [head] : [];
      }
      if (froms.length === 0) {
        return null;
      }

      const fetched = await fetchRemoteQuiet(cwd, remote);
      if (fetched.ok) {
        this.failures = 0;
        this.cooldownUntil = 0;
      } else {
        // 继续往下算：本地缓存的 refs 仍反映上一次已知的线上状态，
        // 只是把下一轮推远一点，别在离线时每个周期都去撞远程
        this.backOff();
        this.setStatus(
          "$(cloud-offline) 合并预警：无法访问远程",
          `fetch ${remote} 失败，下面的结论基于本地缓存的 refs。\n${fetched.stderr}`,
        );
      }

      const survey = await surveyMerges({
        cwd,
        pairs: froms.map((from) => ({ into, from })),
        // 上面已经 fetch 过了，这里再来一次纯属浪费
        fetch: false,
      });

      const next = snapshotOf(survey.cells);
      const hits = worsenedBranches(this.last, next);
      this.last = next;

      this.setStatus(
        next.dirtyPairs === 0
          ? "$(check) 合并预警：干净"
          : `$(warning) 合并预警：${next.totalFiles} 个文件冲突`,
        survey.cells
          .map((c) => {
            const state =
              c.outcome === "clean"
                ? "可干净合入"
                : c.outcome === "conflicts"
                  ? `${c.conflictPaths.length} 个文件冲突`
                  : c.outcome === "same"
                    ? "同名，跳过"
                    : c.outcome === "unrelated"
                      ? "无共同祖先"
                      : `检查失败：${c.error ?? "未知原因"}`;
            return `${c.from} → ${c.into}：${state}`;
          })
          .join("\n"),
      );

      const shouldNotify =
        cfg.notify === "always"
          ? next.dirtyPairs > 0
          : cfg.notify === "never"
            ? false
            : hits.length > 0;
      if (shouldNotify) {
        void this.showConflictMessage(next.dirtyPairs, next.totalFiles);
      }
      return next;
    } catch (err) {
      this.backOff();
      this.setStatus(
        "$(warning) 合并预警：检查失败",
        err instanceof Error ? err.message : String(err),
      );
      return null;
    } finally {
      this.running = false;
    }
  }

  private setStatus(text: string, tooltip: string): void {
    this.status.text = text;
    this.status.tooltip = `${tooltip}\n\n点击立即重新检查`;
  }

  private async showConflictMessage(pairs: number, files: number): Promise<void> {
    const picked = await vscode.window.showWarningMessage(
      `Git Insight：${pairs} 条分支合不进目标了，共 ${files} 个文件冲突。`,
      "打开预演",
      "本次会话不再提醒",
    );
    if (picked === "打开预演") {
      await vscode.commands.executeCommand("gitInsight.previewMerge");
    } else if (picked === "本次会话不再提醒") {
      this.muted = true;
      this.stopTimer();
      this.setStatus(
        "$(bell-slash) 合并预警：已静音",
        "本次会话不再自动检查（点击可立即检查并恢复）",
      );
    }
  }
}

export function registerMergeWatcher(
  context: vscode.ExtensionContext,
): MergeWatcher {
  const watcher = new MergeWatcher();
  context.subscriptions.push(
    watcher,
    vscode.commands.registerCommand("gitInsight.checkConflicts", () => {
      void watcher.checkNow();
    }),
  );
  return watcher;
}
