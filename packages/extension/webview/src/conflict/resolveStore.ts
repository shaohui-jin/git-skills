import type { ConflictChoice } from "./parseConflict";

export interface StashedFileResolve {
  path: string;
  /** conflict 块 id → 选择 */
  choices: Record<string, ConflictChoice>;
  /** 应用选择后的完整文件内容 */
  resolvedContent: string;
  updatedAt: number;
}

export interface StashedMergeResolve {
  cwd: string;
  into: string;
  from: string;
  files: Record<string, StashedFileResolve>;
  updatedAt: number;
}

function storageKey(cwd: string, into: string, from: string): string {
  return `git-insight:merge-resolve:v1:${cwd}\0${into}\0${from}`;
}

export function loadStash(
  cwd: string,
  into: string,
  from: string,
): StashedMergeResolve | null {
  try {
    const raw = localStorage.getItem(storageKey(cwd, into, from));
    if (!raw) {
      return null;
    }
    return JSON.parse(raw) as StashedMergeResolve;
  } catch {
    return null;
  }
}

export function saveStash(stash: StashedMergeResolve): void {
  try {
    localStorage.setItem(
      storageKey(stash.cwd, stash.into, stash.from),
      JSON.stringify(stash),
    );
  } catch {
    // quota / private mode — 忽略，内存侧仍可用
  }
}

export function clearStash(cwd: string, into: string, from: string): void {
  try {
    localStorage.removeItem(storageKey(cwd, into, from));
  } catch {
    // ignore
  }
}
