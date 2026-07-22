export interface BranchOption {
  /** git 可用的短名：main、feature/x、origin/main */
  name: string;
  /** 是否来自 refs/remotes（勿用名字里是否含 / 判断） */
  remote: boolean;
}

export interface BranchRemoteGroup {
  remote: string;
  branches: Array<{ name: string; full: string }>;
}

export interface BranchTreeModel {
  local: Array<{ name: string; full: string }>;
  remotes: BranchRemoteGroup[];
}

/**
 * 兼容宿主发送的 `{ name, remote }[]` 或旧版 `string[]`，避免列表全空。
 */
export function normalizeBranches(input: unknown): BranchOption[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const out: BranchOption[] = [];
  for (const item of input) {
    if (typeof item === "string") {
      const name = item.trim();
      if (!name || name === "HEAD") {
        continue;
      }
      // 旧协议只有短名：无法可靠区分本地 feature/x，暂按「含 / 则远程」兼容
      out.push({ name, remote: name.includes("/") });
      continue;
    }
    if (item && typeof item === "object" && "name" in item) {
      const name = String((item as { name: unknown }).name ?? "").trim();
      if (!name || name === "HEAD") {
        continue;
      }
      out.push({
        name,
        remote: !!(item as { remote?: unknown }).remote,
      });
    }
  }
  return out;
}

/**
 * 按 remote 标记建树：本地可含 `/`；远程 short 为 `remote/branch...`
 */
export function buildBranchTree(branches: BranchOption[]): BranchTreeModel {
  const local: BranchTreeModel["local"] = [];
  const remoteMap = new Map<string, Array<{ name: string; full: string }>>();

  for (const b of normalizeBranches(branches)) {
    if (!b.remote) {
      local.push({ name: b.name, full: b.name });
      continue;
    }
    const slash = b.name.indexOf("/");
    if (slash === -1) {
      continue;
    }
    const remote = b.name.slice(0, slash);
    const name = b.name.slice(slash + 1);
    if (!name || name === "HEAD") {
      continue;
    }
    const list = remoteMap.get(remote) ?? [];
    list.push({ name, full: b.name });
    remoteMap.set(remote, list);
  }

  local.sort((a, b) => a.name.localeCompare(b.name));
  const remotes: BranchRemoteGroup[] = [...remoteMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([remote, items]) => ({
      remote,
      branches: items.sort((a, b) => a.name.localeCompare(b.name)),
    }));

  return { local, remotes };
}
