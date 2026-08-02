# Changelog

本文件随 VSIX 发布到 Open VSX / Cursor 扩展市场，用于展示版本变更记录。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [0.1.12] - 2026-08-02

### Added

- 补充 `CHANGELOG.md`，Cursor / Open VSX 市场可展示变更记录

### Changed

- 同步主文档：目标分支仅远程、同名分支自行 push/pull 等约定（见仓库 `docs/guide.md`）

## [0.1.11] - 2026-08-02

### Changed

- 精简同名分支相关文案与安装说明
- 扩展 README / 主文档与 Skill 摘要对齐当前行为

## [0.1.10] - 2026-08-02

### Changed

- **目标分支（into）仅可选远程跟踪分支**；待合并分支（from）仍可选本地或远程
- **源/目标规范化后同名**（如 `master` ↔ `origin/master`）不再预演、不推临时分支、不申请 MR，提示自行 `git push` / `git pull`
- 默认目标优先 `origin/master` → `main` → `develop`

### Fixed

- 避免同名分支误调 GitHub/GitLab 创建 MR/PR 导致 `Validation Failed`

## [0.1.9] - 2026-08-02

### Changed

- 调整同名分支场景下的提示与确认框文案（后续在 0.1.10 改为不处理同名同步）

## [0.1.8] - 2026-07

### Added

- 一键申请 MR/PR：支持 GitHub / GitLab（本机 `gh`/`glab`、扩展目录 CLI、Token API、浏览器创建页）
- MR 对话框支持指派人与审核人（同一批人）
- Git 配置页：Token 校验与持久化；CLI 下载与登录引导

### Changed

- 一键解决冲突改为独立 **git worktree**，不切换主工作区分支
- Fetch：本机凭据 → Token → 交互登录
- 冲突面板与 AI 选边交互优化

## [0.1.0] - 2026-07

### Added

- 首版：分支图、合并冲突预演、冲突选边、一键解决并推送
- 基于 `@git-insight/core`（`merge-tree` 只读预演）
