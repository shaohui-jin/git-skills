/**
 * API / 展示用的分支短名（去掉 refs 与 remote 前缀，如 origin/feature → feature）。
 * 不改写磁盘上的 git ref；仅用于 MR API、临时分支 slug 等。
 */
export function branchNameForMr(ref: string, remotes: string[] = ["origin"]): string {
  let s = ref
    .trim()
    .replace(/^refs\/heads\//, "")
    .replace(/^refs\/remotes\/[^/]+\//, "");
  // 长名优先：remote 名允许带 /，`a` 与 `a/b` 同时存在时应剥掉更长的那个
  // （与 splitRemoteTipName 的匹配顺序保持一致）
  const byLongest = [...remotes]
    .map((r) => r.trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  for (const remote of byLongest) {
    const prefix = `${remote}/`;
    if (s.startsWith(prefix)) {
      s = s.slice(prefix.length);
      break;
    }
  }
  return s;
}

/**
 * 规范化后源/目标同名（如 master 与 origin/master）。
 * 此类同步请用户自行 push/pull，本工具不建临时分支、不申请 MR。
 */
export function isSameBranchForMr(
  into: string,
  from: string,
  remotes: string[] = ["origin"],
): boolean {
  const a = branchNameForMr(into, remotes);
  const b = branchNameForMr(from, remotes);
  return !!a && !!b && a === b;
}

/** @deprecated 使用 isSameBranchForMr */
export const needsTempBranchForMr = isSameBranchForMr;
