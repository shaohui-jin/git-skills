import type { ProgressReporter } from "./types.js";

export async function reportProgress(
  onProgress: ProgressReporter | undefined,
  percent: number,
  label: string,
): Promise<void> {
  if (!onProgress) {
    return;
  }
  const p = Number.isFinite(percent) ? Math.round(percent) : 0;
  await onProgress({
    percent: Math.max(0, Math.min(100, p)),
    label,
  });
}

/** Map local 0–1 progress into [from, to] percent range. */
export async function mapProgress(
  onProgress: ProgressReporter | undefined,
  from: number,
  to: number,
  local01: number,
  label: string,
): Promise<void> {
  const t = Math.max(0, Math.min(1, local01));
  await reportProgress(onProgress, from + (to - from) * t, label);
}

/**
 * 长耗时单步等待时，在 [from, to) 内缓慢爬升，避免界面一直停在 0%。
 * 真正结束时再落到 to。
 */
export async function withSoftProgress<T>(
  onProgress: ProgressReporter | undefined,
  from: number,
  to: number,
  label: string,
  work: () => Promise<T>,
): Promise<T> {
  await reportProgress(onProgress, from, label);
  if (!onProgress) {
    return work();
  }
  let soft = from;
  const cap = Math.max(from, to - 1);
  let tickChain: Promise<void> = Promise.resolve();
  const timer = setInterval(() => {
    if (soft >= cap) {
      return;
    }
    soft = Math.min(cap, soft + Math.max(0.4, (cap - soft) * 0.07));
    const next = soft;
    tickChain = tickChain.then(() => reportProgress(onProgress, next, label));
  }, 280);
  try {
    return await work();
  } finally {
    clearInterval(timer);
    await tickChain;
    await reportProgress(onProgress, to, label);
  }
}
