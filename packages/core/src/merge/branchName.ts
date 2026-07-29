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
