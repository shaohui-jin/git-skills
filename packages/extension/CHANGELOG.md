# Changelog

本文件随 VSIX 发布到 Open VSX / Cursor 扩展市场，用于展示版本变更记录。

| 版本     | 日期 | 变更项 |
|--------|------|--------|
| 0.1.14 | 2026-08-03 | 1. 预演页加强 MERGE MAP：图纸网格、硬边终端、虚线桥轨与印章态；侧栏改为 LEGEND<br>2. 冲突三栏表头改为 mono 大写语义色条<br>3. 分支图底部图例与报告文案改为琥珀=本地 / 蓝色=远程（与节点色一致） |
| 0.1.13 | 2026-08-03 | 1. Webview UI：顶栏主次 CTA、步骤 Tab、状态 checks 条、合并方向侧栏与分支 chip<br>2. Webview UI：高密度布局 + Soft 分区；冲突区主 CTA「一键解决并推送」、未就绪时 MR 降为次按钮<br>3. 文档：补充 Git 配置「AI 选边（模型）」说明（`vscode.lm` → OpenAI 兼容 API → Chat 桥） |
| 0.1.12 | 2026-08-02 | 1. 补充 `CHANGELOG.md`，Cursor / Open VSX 市场可展示变更记录<br>2. 同步主文档：目标分支仅远程、同名分支自行 push/pull 等约定 |
| 0.1.11 | 2026-08-02 | 1. 精简同名分支相关文案与安装说明<br>2. 扩展 README / 主文档与 Skill 摘要对齐当前行为 |
| 0.1.10 | 2026-08-02 | 1. 目标分支（into）仅可选远程跟踪分支；待合并分支（from）仍可选本地或远程<br>2. 源/目标规范化后同名（如 `master` ↔ `origin/master`）不再预演 / 推临时分支 / 申请 MR<br>3. 默认目标优先 `origin/master` → `main` → `develop`<br>4. 修复：避免同名分支误创建 MR/PR 导致 `Validation Failed` |
| 0.1.9  | 2026-08-02 | 1. 调整同名分支场景下的提示与确认框文案（后续在 0.1.10 改为不处理同名同步） |
| 0.1.8  | 2026-07 | 1. 一键申请 MR/PR：支持 GitHub / GitLab（本机 CLI、扩展目录 CLI、Token API、浏览器创建页）<br>2. MR 对话框支持指派人与审核人；Git 配置页 Token 校验 / CLI 下载与登录引导<br>3. 一键解决冲突改为独立 git worktree，不切换主工作区分支<br>4. Fetch：本机凭据 → Token → 交互登录；冲突面板与 AI 选边交互优化 |
| 0.1.0  | 2026-07 | 1. 首版：分支图、合并冲突预演、冲突选边、一键解决并推送<br>2. 基于 `@git-insight/core`（`merge-tree` 只读预演） |
