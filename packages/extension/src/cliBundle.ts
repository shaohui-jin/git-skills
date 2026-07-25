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
    const api = await fetch(
      "https://gitlab.com/api/v4/projects/gitlab-org%2Fcli/releases/permalink/latest",
      { headers: { "User-Agent": "git-insight-extension" } },
    );
    if (!api.ok) {
      throw new Error(`无法获取 glab release：HTTP ${api.status}`);
    }
    const json = (await api.json()) as {
      assets?: {
        links?: Array<{ name?: string; url?: string; direct_asset_url?: string }>;
      };
    };
    const links = json.assets?.links ?? [];
    const needle =
      os === "windows"
        ? `Windows_${arch === "amd64" ? "x86_64" : "arm64"}.zip`
        : os === "macOS"
          ? `macOS_${arch === "amd64" ? "x86_64" : "arm64"}.tar.gz`
          : `Linux_${arch === "amd64" ? "x86_64" : "arm64"}.tar.gz`;
    const asset = links.find((l) => (l.name || "").includes(needle));
    const url = asset?.direct_asset_url || asset?.url;
    if (!url) {
      throw new Error(`未找到匹配 glab 资源：*${needle}`);
    }
    assetUrl = url;
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
export async function checkCli(
  cwd: string,
  kind: BundledCliKind,
  binPath?: string,
): Promise<{ installed: boolean; loggedIn: boolean }> {
  const cmd = binPath || kind;
  const ver = await new Promise<{ code: number }>((resolve) => {
    const child = spawn(cmd, ["--version"], { cwd, windowsHide: true });
    child.on("error", () => resolve({ code: 127 }));
    child.on("close", (code) => resolve({ code: code ?? 1 }));
  });
  if (ver.code !== 0) {
    return { installed: false, loggedIn: false };
  }
  const auth = await new Promise<{ code: number }>((resolve) => {
    const child = spawn(cmd, ["auth", "status"], {
      cwd,
      windowsHide: true,
      env: { ...process.env, GH_PROMPT_DISABLED: "1", GLAB_PROMPT_DISABLED: "1" },
    });
    child.on("error", () => resolve({ code: 127 }));
    child.on("close", (code) => resolve({ code: code ?? 1 }));
  });
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
