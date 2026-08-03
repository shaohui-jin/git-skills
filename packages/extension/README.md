# Git Insight

Cursor / VS Code 扩展：Git 分支图、合并冲突预演、冲突选边 / AI 选边、一键解决并推送、申请 MR/PR；安装后附带 Agent Skill `/git-branch-insight`。

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

Reload 后扩展会把 Skill 同步到 `~/.cursor/skills/git-branch-insight/`（及 `~/.agents/skills/…`），并写入自带 CLI 路径。若斜杠菜单没有，命令面板执行：`Git Insight: 同步 Agent Skill 到全局`。

## 使用

### 面板（可视化）

1. 命令面板：`Git Insight: Open Web` 或 `Git Insight: 合并预演`
2. 在面板完成 Git 配置（A 本机 CLI / B 下载 CLI / C Token / D 浏览器；可选「AI 选边」模型回退）
3. 分支图 → 合并预演 →（如有冲突）一键解决并推送 → 申请 MR

### Agent Skill（任意仓库）

```text
/git-branch-insight
把 feature/x 合进 origin/develop；能开 MR 再问我
```

闭环：预演 →（确认后）落盘 → 申请 MR 时三选一（本机 `gh`/`glab` · Token · 唤起本扩展 UI）。

约定：

- **目标分支**仅远程（如 `origin/test`）；**我的分支**可选本地或远程
- 源/目标短名相同（如 `master` ↔ `origin/master`）不处理，请自行 `git push` / `pull`
- 「AI 选边（模型）」可选：`vscode.lm` → OpenAI 兼容 API / Ollama → Chat 桥（详见 [docs/guide.md §2.5](https://github.com/shaohui-jin/git-skills/blob/master/docs/guide.md#25-ai-选边扩展)）

完整说明：[docs/guide.md](https://github.com/shaohui-jin/git-skills/blob/master/docs/guide.md)（§1.4 安装 · §四 Skill）。  
变更记录：[CHANGELOG.md](./CHANGELOG.md)（随 VSIX 发布，Cursor / Open VSX 市场可见）。
