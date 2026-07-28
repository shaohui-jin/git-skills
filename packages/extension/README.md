# Git Insight

Cursor / VS Code 扩展：Git 分支图、合并冲突预演、冲突选边 / AI 选边、一键解决并推送、申请 MR。

引擎：`@git-insight/core`。

## 使用

1. 命令面板：`Git Insight: Open Web Visualization`
2. 在面板完成 Git 配置（A 本机 CLI / B 下载 CLI / C Token / D 浏览器）
3. 分支图 → 合并预演 →（如有冲突）一键解决并推送 → 申请 MR

完整操作与指令说明见仓库文档 `docs/guide.md`（勿在本 README 使用指向仓库外的相对链接，以免 `vsce package` 失败）。

## 开发

```bash
# 仓库根目录
pnpm package:vsix
cursor --install-extension git-insight.vsix --force
```
