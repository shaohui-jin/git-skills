export interface BranchOption {
  /** 短名（无 remote 前缀）：main、feature/x */
  name: string;
  /** 是否来自 refs/remotes（勿用名字里是否含 / 判断） */
  remote: boolean;
  /** 远程名，仅 remote 时有值，如 origin */
  remoteName?: string;
  /** git 操作身份：本地为短名；远程为 origin/main */
  gitRef: string;
}

/** 路径树节点：文件夹可折叠；若 full 有值则可点选（该段本身也是分支 tip） */
export interface PathTreeNode {
  /** 当前段显示名（不含父路径） */
  segment: string;
  /** 完整 gitRef（仅 tip 有值；选中身份） */
  full?: string;
  children: PathTreeNode[];
}

export interface BranchRemoteGroup {
  remote: string;
  /** 相对 remote 的路径树（段用短名 path） */
  tree: PathTreeNode[];
  /** 叶子数量（用于角标） */
  leafCount: number;
}

export interface BranchTreeModel {
  local: PathTreeNode[];
  localLeafCount: number;
  remotes: BranchRemoteGroup[];
}

/**
 * 规范化宿主发送的 `{ name, remote, remoteName?, gitRef }[]`。
 * 仅接受新协议对象；缺 gitRef 时由 remoteName + name 推导。
 */
export function normalizeBranches(input: unknown): BranchOption[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const out: BranchOption[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object" || !("name" in item)) {
      continue;
    }
    const raw = item as {
      name?: unknown;
      remote?: unknown;
      remoteName?: unknown;
      gitRef?: unknown;
    };
    const name = String(raw.name ?? "").trim();
    if (!name || name === "HEAD") {
      continue;
    }
    const remote = !!raw.remote;
    const remoteNameRaw = String(raw.remoteName ?? "").trim();
    const remoteName = remote && remoteNameRaw ? remoteNameRaw : undefined;
    let gitRef = String(raw.gitRef ?? "").trim();
    if (!gitRef) {
      if (remote && !remoteName) {
        continue;
      }
      gitRef = remote && remoteName ? `${remoteName}/${name}` : name;
    }
    out.push({
      name,
      remote,
      ...(remoteName ? { remoteName } : {}),
      gitRef,
    });
  }
  return out;
}

/** 触发器展示：本地短名；远程 remote/name（与 gitRef 一致） */
export function branchDisplayLabel(b: BranchOption): string {
  if (b.remote && b.remoteName) {
    return `${b.remoteName}/${b.name}`;
  }
  return b.name;
}

export function findBranchByGitRef(
  branches: BranchOption[],
  gitRef: string,
): BranchOption | undefined {
  return branches.find((b) => b.gitRef === gitRef);
}

function countLeaves(nodes: PathTreeNode[]): number {
  let n = 0;
  for (const node of nodes) {
    if (node.full) {
      n += 1;
    }
    n += countLeaves(node.children);
  }
  return n;
}

/**
 * 将 `a/b`、`a/c` 建成树：文件夹 `a` → 叶子 `b`、`c`。
 * 若同时存在 tip `a` 与 `a/b`，则 `a` 节点既可点选又有子节点。
 */
export function buildPathTree(items: Array<{ path: string; full: string }>): PathTreeNode[] {
  const root: PathTreeNode[] = [];

  const ensureChild = (list: PathTreeNode[], segment: string): PathTreeNode => {
    let node = list.find((n) => n.segment === segment);
    if (!node) {
      node = { segment, children: [] };
      list.push(node);
    }
    return node;
  };

  for (const item of items) {
    const parts = item.path.split("/").filter(Boolean);
    if (parts.length === 0) {
      continue;
    }
    let list = root;
    for (let i = 0; i < parts.length; i++) {
      const seg = parts[i]!;
      const node = ensureChild(list, seg);
      if (i === parts.length - 1) {
        node.full = item.full;
      }
      list = node.children;
    }
  }

  const sortRec = (nodes: PathTreeNode[]) => {
    nodes.sort((a, b) => {
      const af = a.children.length > 0 ? 0 : 1;
      const bf = b.children.length > 0 ? 0 : 1;
      if (af !== bf) {
        return af - bf;
      }
      return a.segment.localeCompare(b.segment);
    });
    for (const n of nodes) {
      sortRec(n.children);
    }
  };
  sortRec(root);
  return root;
}

/** 收集树中全部 tip（用于键盘导航 / 筛选） */
export function flattenPathTree(nodes: PathTreeNode[]): Array<{ full: string; label: string }> {
  const out: Array<{ full: string; label: string }> = [];
  const walk = (list: PathTreeNode[], prefix: string) => {
    for (const n of list) {
      const label = prefix ? `${prefix}/${n.segment}` : n.segment;
      if (n.full) {
        out.push({ full: n.full, label });
      }
      if (n.children.length) {
        walk(n.children, label);
      }
    }
  };
  walk(nodes, "");
  return out;
}

/**
 * 筛选：匹配 full / 段名时保留该节点完整子树；否则只保留通往命中 tip 的骨架。
 */
export function filterPathTree(nodes: PathTreeNode[], query: string): PathTreeNode[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    return nodes;
  }

  const filterClean = (list: PathTreeNode[]): PathTreeNode[] => {
    const out: PathTreeNode[] = [];
    for (const n of list) {
      const childFiltered = filterClean(n.children);
      const hitSelf =
        (n.full && n.full.toLowerCase().includes(q)) ||
        n.segment.toLowerCase().includes(q);
      if (hitSelf) {
        out.push({
          segment: n.segment,
          full: n.full,
          children: n.children,
        });
      } else if (childFiltered.length > 0) {
        out.push({
          segment: n.segment,
          full: n.full,
          children: childFiltered,
        });
      }
    }
    return out;
  };

  return filterClean(nodes);
}

/**
 * 按 remote 标记建树：本地/远程路径均按短名 `/` 分层；叶子 full = gitRef。
 */
export function buildBranchTree(branches: BranchOption[]): BranchTreeModel {
  const localItems: Array<{ path: string; full: string }> = [];
  const remoteMap = new Map<string, Array<{ path: string; full: string }>>();

  for (const b of normalizeBranches(branches)) {
    if (!b.remote) {
      localItems.push({ path: b.name, full: b.gitRef });
      continue;
    }
    const remote = b.remoteName;
    if (!remote || !b.name || b.name === "HEAD") {
      continue;
    }
    const list = remoteMap.get(remote) ?? [];
    list.push({ path: b.name, full: b.gitRef });
    remoteMap.set(remote, list);
  }

  const local = buildPathTree(localItems);
  const remotes: BranchRemoteGroup[] = [...remoteMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([remote, items]) => {
      const tree = buildPathTree(items);
      return { remote, tree, leafCount: countLeaves(tree) };
    });

  return {
    local,
    localLeafCount: countLeaves(local),
    remotes,
  };
}
