# Git Insight

Cursor / VS Code 扩展：Git 分支图、合并冲突预演、冲突选边 / AI 选边、一键解决并推送、申请 MR/PR。

- 扩展 ID：`jinshaohui.git-insight`
- 引擎：`@git-insight/core`
- 仓库：[shaohui-jin/git-skills](https://github.com/shaohui-jin/git-skills)

## 安装

**Cursor 扩展市场（Open VSX）**

1. 扩展面板搜索 `Git Insight` 或 `jinshaohui.git-insight`
2. 安装并 Reload Window

**本地 VSIX**

```bash
# 仓库根目录
pnpm package:vsix
cursor --install-extension git-insight.vsix --force
```

## 使用

1. 命令面板：`Git Insight: Open Web`
2. 在面板完成 Git 配置（A 本机 CLI / B 下载 CLI / C Token / D 浏览器）
3. 分支图 → 合并预演 →（如有冲突）一键解决并推送 → 申请 MR

约定：

- **目标分支**仅远程（如 `origin/test`）；**我的分支**可选本地或远程
- 源/目标短名相同（如 `master` ↔ `origin/master`）不处理，请自行 `git push` / `pull`

完整说明：[docs/guide.md](https://github.com/shaohui-jin/git-skills/blob/master/docs/guide.md)。  
变更记录：[CHANGELOG.md](./CHANGELOG.md)（随 VSIX 发布，Cursor / Open VSX 市场可见）。

## 发布到 Cursor 市场（维护者）

现行流程（唯一）：一次性配置 Open VSX + GitHub Secret `OVSX_PAT` → 日常升高本包 `package.json` 的 `version` **并更新 `CHANGELOG.md`**，再 push 到 `master`/`main`，CI 自动打 tag 并发布。

→ **[docs/guide.md §3.6](https://github.com/shaohui-jin/git-skills/blob/master/docs/guide.md#36-发布到-cursor-市场open-vsx)**
