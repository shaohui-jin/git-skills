import { spawn } from "node:child_process";
import { platform } from "node:os";

/**
 * Native OS folder picker on the Node/extension host.
 *
 * This does NOT use the browser File System Access API, so it does NOT require
 * HTTPS. Browser pages cannot get absolute paths securely; we ask the OS instead.
 */
export async function pickFolderNative(): Promise<string | null> {
  const os = platform();
  if (os === "win32") {
    return pickWindows();
  }
  if (os === "darwin") {
    return pickMac();
  }
  return pickLinux();
}

function pickWindows(): Promise<string | null> {
  // TopMost owner form so the dialog is not buried under the browser window.
  const ps = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.StartPosition = 'Manual'
$owner.Size = New-Object System.Drawing.Size(0, 0)
$owner.Location = New-Object System.Drawing.Point(-2000, -2000)
$null = $owner.Show()
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '选择 Git 仓库目录'
$dialog.ShowNewFolderButton = $false
try { $dialog.UseDescriptionForTitle = $true } catch { }
$result = $dialog.ShowDialog($owner)
$owner.Close()
$owner.Dispose()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.Write($dialog.SelectedPath)
}
`;
  return runCapture("powershell.exe", [
    "-NoProfile",
    "-STA",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    ps,
  ]);
}

function pickMac(): Promise<string | null> {
  const script =
    'POSIX path of (choose folder with prompt "选择 Git 仓库目录")';
  return runCapture("osascript", ["-e", script]).then((p) => {
    if (!p) {
      return null;
    }
    return p.replace(/\/$/, "");
  });
}

function pickLinux(): Promise<string | null> {
  return runCapture("zenity", [
    "--file-selection",
    "--directory",
    "--title=选择 Git 仓库目录",
  ]).catch(async () =>
    runCapture("kdialog", ["--getexistingdirectory", ".", "--title", "选择 Git 仓库目录"]),
  );
}

function runCapture(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      windowsHide: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b: Buffer) => {
      stdout += b.toString("utf8");
    });
    child.stderr.on("data", (b: Buffer) => {
      stderr += b.toString("utf8");
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      const path = stdout.trim();
      if (code !== 0 || !path) {
        if (stderr.trim()) {
          console.warn(`[pickFolder] ${command} failed:`, stderr.trim());
        }
        resolve(null);
        return;
      }
      resolve(path);
    });
  });
}
