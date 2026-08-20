import { createWriteStream } from "node:fs";
import { access, mkdir, chmod, rm } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

export type BundledCliKind = "gh" | "glab";

function platformArch(): { os: "windows" | "macOS" | "linux"; arch: "amd64" | "arm64" } {
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  if (process.platform === "win32") {
    return { os: "windows", arch };
  }
  if (process.platform === "darwin") {
    return { os: "macOS", arch };
  }
  return { os: "linux", arch };
}

export function bundledCliPath(storageRoot: string, kind: BundledCliKind): string {
  const bin = process.platform === "win32" ? `${kind}.exe` : kind;
  return join(storageRoot, "cli", kind, bin);
}

export async function bundledCliExists(storageRoot: string, kind: BundledCliKind): Promise<boolean> {
  try {
    await access(bundledCliPath(storageRoot, kind));
    return true;
  } catch {
    return false;
  }
}

async function run(cmd: string, args: string[], cwd: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, windowsHide: true, shell: false });
    child.on("error", () => resolve(127));
    child.on("close", (code) => resolve(code ?? 1));
  });
}

async function downloadFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url, {
    headers: { "User-Agent": "git-insight-extension" },
    redirect: "follow",
  });
  if (!res.ok || !res.body) {
    throw new Error(`下载失败 HTTP ${res.status}: ${url}`);
  }
  const nodeStream = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream);
  await pipeline(nodeStream, createWriteStream(dest));
}

type GlabLink = { name?: string; url?: string; direct_asset_url?: string };

/** 新旧命名都尝试：windows_amd64.zip / Windows_x86_64.zip 等 */
function glabAssetNeedles(
  os: "windows" | "macOS" | "linux",
  arch: "amd64" | "arm64",
): string[] {
  if (os === "windows") {
    if (arch === "arm64") {
      return ["windows_arm64.zip", "Windows_arm64.zip"];
    }
    return ["windows_amd64.zip", "Windows_x86_64.zip", "windows_x86_64.zip"];
  }
  if (os === "macOS") {
    if (arch === "arm64") {
      return ["darwin_arm64.tar.gz", "macOS_arm64.tar.gz", "Darwin_arm64.tar.gz"];
    }
    return ["darwin_amd64.tar.gz", "macOS_x86_64.tar.gz", "Darwin_x86_64.tar.gz"];
  }
  if (arch === "arm64") {
    return ["linux_arm64.tar.gz", "Linux_arm64.tar.gz"];
  }
  return ["linux_amd64.tar.gz", "Linux_x86_64.tar.gz"];
}

function pickGlabLink(links: GlabLink[], needles: string[]): GlabLink | undefined {
  const named = links.filter((l) => (l.name || "").trim());
  for (const needle of needles) {
    const hit = named.find((l) => (l.name || "").toLowerCase().includes(needle.toLowerCase()));
    if (hit) {
      return hit;
    }
  }
  return undefined;
}

async function fetchGlabLinksFromGitlab(): Promise<GlabLink[]> {
  const api = await fetch(
    "https://gitlab.com/api/v4/projects/gitlab-org%2Fcli/releases/permalink/latest",
    { headers: { "User-Agent": "git-insight-extension" } },
  );
  if (!api.ok) {
    throw new Error(`无法获取 glab release（GitLab）：HTTP ${api.status}`);
  }
  const json = (await api.json()) as {
    assets?: { links?: GlabLink[] };
    name?: string;
    tag_name?: string;
  };
  return json.assets?.links ?? [];
}

async function resolveGlabAssetUrl(
  os: "windows" | "macOS" | "linux",
  arch: "amd64" | "arm64",
): Promise<string> {
  const needles = glabAssetNeedles(os, arch);
  const links = await fetchGlabLinksFromGitlab();
  const asset = pickGlabLink(links, needles);
  const url = asset?.direct_asset_url || asset?.url;
  if (url) {
    return url;
  }
  const names = links
    .map((l) => l.name)
    .filter(Boolean)
    .slice(0, 16)
    .join(", ");
  throw new Error(
    `未找到匹配 glab 资源（尝试 ${needles.join(" | ")}）。可用资源示例：${names || "（空）"}`,
  );
}

/**
 * 将官方 CLI 下载到扩展 globalStorage（按需、需用户确认后调用）。
 * gh: GitHub CLI releases；glab: GitLab CLI releases。
 */
export async function downloadBundledCli(
  storageRoot: string,
  kind: BundledCliKind,
  onProgress?: (label: string) => void,
): Promise<string> {
  const { os, arch } = platformArch();
  const dir = join(storageRoot, "cli", kind);
  await mkdir(dir, { recursive: true });
  const outBin = bundledCliPath(storageRoot, kind);

  onProgress?.(`正在解析 ${kind} 最新版本…`);

  let assetUrl = "";
  if (kind === "gh") {
    // 例：gh_2.62.0_windows_amd64.zip
    const api = await fetch("https://api.github.com/repos/cli/cli/releases/latest", {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "git-insight-extension",
      },
    });
    if (!api.ok) {
      throw new Error(`无法获取 gh release：HTTP ${api.status}`);
    }
    const json = (await api.json()) as {
      assets?: Array<{ name: string; browser_download_url: string }>;
    };
    const needle =
      os === "windows"
        ? `windows_${arch}.zip`
        : os === "macOS"
          ? `macOS_${arch}.zip`
          : `linux_${arch}.tar.gz`;
    const asset = json.assets?.find((a) => a.name.includes(needle));
    if (!asset) {
      throw new Error(`未找到匹配资源：*${needle}`);
    }
    assetUrl = asset.browser_download_url;
  } else {
    // glab 资源名曾用 Windows_x86_64.zip，现多为 windows_amd64.zip（goreleaser 常规命名）
    assetUrl = await resolveGlabAssetUrl(os, arch);
  }

  const archiveName = assetUrl.split("/").pop() || `${kind}-archive`;
  const archivePath = join(dir, archiveName);
  onProgress?.(`正在下载 ${archiveName}…`);
  await downloadFile(assetUrl, archivePath);

  onProgress?.("正在解压…");
  const extractDir = join(dir, "_extract");
  await rm(extractDir, { recursive: true, force: true });
  await mkdir(extractDir, { recursive: true });

  if (archiveName.endsWith(".zip")) {
    if (process.platform === "win32") {
      const code = await run(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}' -Force`,
        ],
        dir,
      );
      if (code !== 0) {
        throw new Error("解压 zip 失败（Expand-Archive）");
      }
    } else {
      const code = await run("unzip", ["-o", archivePath, "-d", extractDir], dir);
      if (code !== 0) {
        throw new Error("解压 zip 失败（unzip）");
      }
    }
  } else {
    const code = await run("tar", ["-xzf", archivePath, "-C", extractDir], dir);
    if (code !== 0) {
      throw new Error("解压 tar.gz 失败");
    }
  }

  // 在解压目录中找可执行文件
  const { readdir, stat, copyFile } = await import("node:fs/promises");
  async function findBin(root: string): Promise<string | null> {
    const entries = await readdir(root, { withFileTypes: true });
    for (const e of entries) {
      const p = join(root, e.name);
      if (e.isDirectory()) {
        const hit = await findBin(p);
        if (hit) {
          return hit;
        }
      } else if (
        e.name === kind ||
        e.name === `${kind}.exe` ||
        e.name === `glab` ||
        e.name === `gh`
      ) {
        return p;
      }
    }
    // bin/ 子目录常见
    try {
      const binDir = join(root, "bin");
      const st = await stat(binDir);
      if (st.isDirectory()) {
        return findBin(binDir);
      }
    } catch {
      // ignore
    }
    return null;
  }

  const found = await findBin(extractDir);
  if (!found) {
    throw new Error("解压后未找到可执行文件");
  }
  await copyFile(found, outBin);
  if (process.platform !== "win32") {
    await chmod(outBin, 0o755);
  }
  await rm(extractDir, { recursive: true, force: true });
  await rm(archivePath, { force: true });
  onProgress?.(`已安装到 ${outBin}`);
  return outBin;
}

/** 检测 PATH 或指定路径上的 CLI 是否安装 / 已登录 */
const CLI_CHECK_TIMEOUT_MS = 5000;

/**
 * 带超时的 spawn 探测。
 * `gh auth status` 会拿本地凭据去请求 GitHub API 验证有效性，
 * 在代理/网络受限环境下会长时间挂住，把整个面板初始化卡死；
 * 超时后 kill 并按失败处理。
 */
function spawnProbe(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs = CLI_CHECK_TIMEOUT_MS,
): Promise<{ code: number; timedOut: boolean }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: { code: number; timedOut: boolean }) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const child = spawn(cmd, args, {
      cwd,
      windowsHide: true,
      env: { ...process.env, GH_PROMPT_DISABLED: "1", GLAB_PROMPT_DISABLED: "1" },
    });
    const timer = setTimeout(() => {
      child.kill();
      finish({ code: -1, timedOut: true });
    }, timeoutMs);
    child.on("error", () => finish({ code: 127, timedOut: false }));
    child.on("close", (code) => finish({ code: code ?? 1, timedOut: false }));
  });
}

export async function checkCli(
  cwd: string,
  kind: BundledCliKind,
  binPath?: string,
): Promise<{ installed: boolean; loggedIn: boolean }> {
  const cmd = binPath || kind;
  // 一次探测到位：127 = 不存在（未安装）；其余非 0 含超时 = 未登录。
  // 不再先跑 --version 再跑 auth status，spawn 次数减半。
  const auth = await spawnProbe(cmd, ["auth", "status"], cwd);
  if (auth.code === 127) {
    return { installed: false, loggedIn: false };
  }
  return { installed: true, loggedIn: auth.code === 0 };
}

export async function checkSystemCli(
  cwd: string,
  kind: BundledCliKind,
): Promise<{ installed: boolean; loggedIn: boolean }> {
  return checkCli(cwd, kind);
}

/** 扩展目录内 CLI：先看文件是否存在，再跑 auth status */
export async function checkBundledCli(
  storageRoot: string,
  kind: BundledCliKind,
  cwd: string,
): Promise<{ installed: boolean; loggedIn: boolean }> {
  if (!(await bundledCliExists(storageRoot, kind))) {
    return { installed: false, loggedIn: false };
  }
  return checkCli(cwd, kind, bundledCliPath(storageRoot, kind));
}

/** 供终端 sendText 使用的命令行引号 */
export function shellQuotePath(path: string): string {
  if (process.platform === "win32") {
    return `"${path.replace(/"/g, '""')}"`;
  }
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

/**
 * 在集成终端中执行「可执行文件 + 参数」。
 * PowerShell 对带引号路径必须用调用运算符 `&`，否则会当成字符串字面量。
 */
export function shellExecCommand(
  executable: string,
  args: string[],
  shellPath?: string,
): string {
  const quoted = shellQuotePath(executable);
  const rest = args.join(" ");
  const shell = (shellPath || "").toLowerCase();
  const isPowerShell =
    process.platform === "win32" &&
    (shell.includes("powershell") || shell.includes("pwsh") || !shellPath);
  if (isPowerShell) {
    return rest ? `& ${quoted} ${rest}` : `& ${quoted}`;
  }
  return rest ? `${quoted} ${rest}` : quoted;
}
