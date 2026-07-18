export interface BranchRemoteGroup {
  remote: string;
  branches: Array<{ name: string; full: string }>;
}

export interface BranchTreeModel {
  local: Array<{ name: string; full: string }>;
  remotes: BranchRemoteGroup[];
}

/**
 * Flat short refs → tree: 本地 / 远程(按 remote 名再分一层)
 * - master → 本地
 * - origin/master → 远程 / origin / master
 */
export function buildBranchTree(branches: string[]): BranchTreeModel {
  const local: BranchTreeModel["local"] = [];
  const remoteMap = new Map<string, Array<{ name: string; full: string }>>();

  for (const full of branches) {
    const slash = full.indexOf("/");
    if (slash === -1) {
      local.push({ name: full, full });
      continue;
    }
    const remote = full.slice(0, slash);
    const name = full.slice(slash + 1);
    if (!name || name === "HEAD") {
      continue;
    }
    const list = remoteMap.get(remote) ?? [];
    list.push({ name, full });
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
