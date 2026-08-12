import { fromAiHunkId } from "./aiResolvePrompt.js";
import type {
  AiResolveHunkInput,
  AiResolveHunkResult,
  AiResolveRequestPayload,
  AiResolveResponsePayload,
} from "./aiResolveTypes.js";

/** 单批最多冲突块数（避免上下文/输出过长） */
export const AI_BATCH_MAX_HUNKS = 25;

/** 单批左右+base 文本字符上限 */
export const AI_BATCH_MAX_CHARS = 80_000;

export type AiBatchMeta = {
  batchIndex: number;
  batchTotal: number;
};

function normPath(p: string): string {
  return p.replace(/\\/g, "/");
}

function hunkTextChars(h: AiResolveHunkInput): number {
  return h.leftText.length + h.rightText.length + h.baseText.length;
}

function inputLocalId(h: AiResolveHunkInput): string {
  const decoded = fromAiHunkId(h.id);
  if (
    decoded.path != null &&
    (normPath(decoded.path) === normPath(h.path) || h.id.includes("::"))
  ) {
    return decoded.localId;
  }
  return h.id;
}

function hunkKey(path: string, localId: string): string {
  return `${normPath(path)}\0${localId}`;
}

/**
 * 按块数与字符数切分；单个超大 hunk 仍单独成批（文本在 buildAiUserPrompt 内截断）。
 */
export function splitAiResolveBatches(
  req: AiResolveRequestPayload,
  opts?: { maxHunks?: number; maxChars?: number },
): AiResolveRequestPayload[] {
  const maxHunks = opts?.maxHunks ?? AI_BATCH_MAX_HUNKS;
  const maxChars = opts?.maxChars ?? AI_BATCH_MAX_CHARS;
  if (!req.hunks.length) {
    return [];
  }

  const batches: AiResolveRequestPayload[] = [];
  let cur: AiResolveHunkInput[] = [];
  let curChars = 0;

  for (const h of req.hunks) {
    const c = hunkTextChars(h);
    const full =
      cur.length > 0 && (cur.length >= maxHunks || curChars + c > maxChars);
    if (full) {
      batches.push({ ...req, hunks: cur });
      cur = [];
      curChars = 0;
    }
    cur.push(h);
    curChars += c;
  }
  if (cur.length) {
    batches.push({ ...req, hunks: cur });
  }
  return batches;
}

/** 某批整体失败时把它的 hunk 全标成 pending，保住其它批次已拿到的裁决 */
export function pendingResultsForBatch(
  batch: AiResolveRequestPayload,
  reason: string,
): AiResolveHunkResult[] {
  return batch.hunks.map((h) => ({
    id: inputLocalId(h),
    path: h.path,
    choice: "pending" as const,
    reason,
  }));
}

/** 合并多批结果；缺漏的输入 hunk 补 pending */
export function mergeBatchedHunkResults(
  parts: AiResolveHunkResult[],
  allInput: AiResolveHunkInput[],
): AiResolveHunkResult[] {
  const byKey = new Map<string, AiResolveHunkResult>();
  for (const r of parts) {
    byKey.set(hunkKey(r.path, r.id), r);
  }
  return allInput.map((h) => {
    const localId = inputLocalId(h);
    const hit = byKey.get(hunkKey(h.path, localId));
    if (hit) {
      return hit;
    }
    return {
      id: localId,
      path: h.path,
      choice: "pending",
      reason: "分批结果中缺失该冲突块",
    };
  });
}

export function mergeBatchedResponses(
  parts: AiResolveResponsePayload[],
  allInput: AiResolveHunkInput[],
  batchTotal: number,
): AiResolveResponsePayload {
  const hunks = mergeBatchedHunkResults(
    parts.flatMap((p) => p.hunks),
    allInput,
  );
  const model = parts.map((p) => p.model).find(Boolean);
  const messages = [
    `自动分批：共 ${batchTotal} 批、${allInput.length} 个冲突块`,
    ...parts.flatMap((p) => p.messages ?? []),
  ];
  return { hunks, model, messages };
}

export function mapBatchProgress(
  batchIndex0: number,
  batchTotal: number,
  innerPercent: number,
): number {
  const lo = 8 + (batchIndex0 / batchTotal) * 82;
  const hi = 8 + ((batchIndex0 + 1) / batchTotal) * 82;
  const t = Math.max(0, Math.min(100, innerPercent)) / 100;
  return Math.round(lo + t * (hi - lo));
}
