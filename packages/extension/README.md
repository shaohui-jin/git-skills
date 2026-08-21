# Git Insight

Cursor / VS Code 扩展：Git 分支图、合并冲突预演、冲突选边 / AI 选边、一键解决并推送、合并矩阵与批量合并（单个总 MR）、合入顺序建议、申请 MR/PR；安装后附带 Agent Skill `/git-branch-insight`。

- 扩展 ID：`jinshaohui.git-insight`
- 引擎：`@shaohui_jin/git-insight-core`
- 仓库：[shaohui-jin/git-skills](https://github.com/shaohui-jin/git-skills)
- **功能与实现进度**：[docs/features.md](../../docs/features.md)

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

1. 命令面板搜 Git Insight：`打开面板` / `合并预演` / `打开预演（可带 into/from）` / `立即检查合并冲突` / `同步 Agent Skill 到全局`（合并矩阵在面板内切换）
2. 在面板完成 Git 配置：默认远程 + gh/glab/Token/浏览器四种 MR 方式（AI 选边、冲突自动解决可折叠配置）
3. 单对流程：分支图 → 合并预演 →（如有冲突）选边 → 一键解决并推送 → 申请 MR
4. 多分支批量：合并矩阵 → 看清 N×M 两两冲突 → 算顺序 → 逐条解决（矩阵模式只提交本地临时分支）→「一键处理合并并推送」（干跑预演 → 确认清单可排除/调序 → 累积合并 + 单次推送）→ 一键申请总 MR

### Agent Skill（任意仓库）

```text
/git-branch-insight
把 feature/x 合进 origin/develop；能开 MR 再问我
```

闭环：预演 →（确认后）落盘 → 申请 MR 时三选一（本机 `gh`/`glab` · Token · 唤起本扩展 UI）。

约定：

- **目标分支**仅远程（如 `origin/test`）；**我的分支**可选本地或远程
- 源/目标短名相同（如 `master` ↔ `origin/master`）不处理，请自行 `git push` / `pull`
- 批量合并前先干跑预演：序贯冲突（分支间互相冲突）或源分支已变动（sha 护栏）会在执行前拦截
- 「AI 选边（模型）」可选：`vscode.lm` → OpenAI 兼容 API / Ollama → Chat 桥（详见 [docs/guide.md §2.5](https://github.com/shaohui-jin/git-skills/blob/master/docs/guide.md#25-ai-选边扩展)）

完整说明：[docs/guide.md](https://github.com/shaohui-jin/git-skills/blob/master/docs/guide.md)（§1.4 安装 · §四 Skill · **§五 指令一览**）。  
变更记录：[CHANGELOG.md](./CHANGELOG.md)（随 VSIX 发布，Cursor / Open VSX 市场可见）。
