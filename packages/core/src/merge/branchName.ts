/**
 * API / 展示用的分支短名（去掉 refs 与 remote 前缀，如 origin/feature → feature）。
 * 不改写磁盘上的 git ref；仅用于 MR API、临时分支 slug 等。
 */
export function branchNameForMr(ref: string, remotes: string[] = ["origin"]): string {
  let s = ref
    .trim()
    .replace(/^refs\/heads\//, "")
    .replace(/^refs\/remotes\/[^/]+\//, "");
  for (const remote of remotes) {
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
