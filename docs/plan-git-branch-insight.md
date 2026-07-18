# Git 分支可视化与冲突预演：Skill + 扩展双形态方案（保留稿）

> 本文件为计划保留副本，供实现对照。CLI 约定已按后续讨论校准：只认分支名；默认 fetch；不依赖平台 PR。

## 目标与约束

- **主交付**：Cursor Agent Skill（自然语言 → 报告 / Mermaid）+ 可发布 npm 包 `@git-insight/core`
- **次交付**：Cursor 扩展打开网页版可视化（复用同一 npm 包）
- **数据源**：本地 Git；远程通过 `git fetch` 同步后再本地预演（任意两分支）

## CLI 约定（定稿）

| 命令 | 参数 | 说明 |
|------|------|------|
| `graph` | 可选 `--cwd`、`--max` | 默认零参，基于当前仓库 refs |
| `fetch` | 可选 `--cwd`、`--remote` | 显式拉取远端 |
| `preview-merge`（合并预演） | `--into` 目标、`--from` 待合并 | 默认 fetch；输出冲突文件 + 冲突正文 + 溯源（`conflict-blame` 为兼容别名） |

`--from` / `--into` 可为本地分支名或 `origin/xxx`。不把 PR 号作为核心参数。

## Skill 行为

- 调用预演 / 溯源 / 出图前：**默认 fetch**，避免本地与远端不同步
- 网页端（扩展 Webview）提供手动 **Fetch** 按钮；操作默认不自动 fetch

## 架构

Skill / 网页 → `@git-insight/core`（唯一 Git 能力源）→ 系统 `git`（`merge-tree` / `rev-list` / `blame`）
