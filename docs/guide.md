# Git Insight · 技术分享与操作手册

> **本文是仓库唯一完整说明。** 面向日常操作与技术分享：先讲主流程，再按模块列出实际调用的 `git` / `gh` / `glab` 指令，最后是核心实现与 Agent Skill。

---

## 目录

1. [主流程梳理](#一主流程梳理)
2. [各模块操作与实际指令](#二各模块操作与实际指令技术分享)
3. [核心模块实现说明](#三核心模块实现说明)（含 [发布到 Cursor 市场](#36-发布到-cursor-市场open-vsx)）
4. [Skill 说明](#四skill-说明)
5. [附录：FAQ 与命令速查](#五附录faq-与命令速查)

---

## 一、主流程梳理

### 1.1 产品定位

| 能力 | 交付面 | 是否改工作区 |
|------|--------|--------------|
| 分支图 / 合并预演 | CLI Skill + 扩展 Webview | **否**（`merge-tree` 等只读） |
| 冲突选边 / AI 选边 | 扩展 Webview | 否（仅 UI / 暂存） |
| 一键解决并推送 | 扩展 → core | **是**（独立 **worktree**，主工作区不 checkout） |
| 一键申请 MR/PR | 扩展 → core | 否（`gh` / `glab` / Token API / 浏览器） |

前置：**系统 Git ≥ 2.38**（依赖新版 `merge-tree --write-tree`）。

### 1.2 业务角色（勿填反）

业务上是把**我的分支**合进**线上目标**（再提 MR）。

| 业务称呼 | UI | 变量 | 预演三栏 |
|----------|-----|------|----------|
| **线上 / 合入目标**（如 `test`） | 目标分支 | `into` | **左栏** |
| **我的分支 / 待提交**（如 `feature/xxx`） | 我的分支 | `from` | **右栏** |

排错对照：站在线上分支上 `merge` 我的分支时，git 的 **ours = 线上(into)**、**theirs = 我的(from)**。口语「我的=ours」容易和 git 叫反，界面只用「线上 / 我的」。

### 1.3 推荐使用顺序

```text
① Git 配置（选 A / B / C / D）
② 分支图（默认先 fetch，与线上对齐）
③ 合并预演（选「线上目标」+「我的分支」→ 冲突选边 / AI 选边）
④ 有冲突 →「一键解决并推送」
⑤ 「一键申请 MR」
```

```mermaid
flowchart TD
  cfg[Git 配置 A/B/C/D] --> graph[分支图 · 默认 fetch]
  graph --> preview[合并预演 线上into / 我的from]
  preview --> stash[三栏选边 / AI 选边]
  stash --> resolve[一键解决并推送 · 独立 worktree]
  resolve --> mr[一键申请 MR]
  preview -->|干净合并| mr
```

| 场景 | 能否直接申请 MR |
|------|----------------|
| 预演有冲突 | 须先「一键解决并推送」成功 |
| 预演可干净合并 | 可直接申请（源一般为已推送的我的分支） |

### 1.4 安装与打开面板

```bash
# 仓库根目录
pnpm install
pnpm package:vsix
cursor --install-extension git-insight.vsix --force
```

扩展 ID：`jinshaohui.git-insight`。  
- 本地安装：见上方 VSIX 命令  
- Cursor 扩展市场：搜 `Git Insight` / `jinshaohui.git-insight`（上游为 Open VSX；**维护者上架流程见 [§3.6](#36-发布到-cursor-市场open-vsx)**）

安装后 **Reload Window**，命令面板：

- `Git Insight: Open Web` — 打开面板（默认 **Git 配置**）
- `Git Insight: 合并预演` — 打开并切到合并预演

面板顶部输入本机仓库路径或 GitHub `owner/repo`，点「打开」。

> 浏览器 `pnpm preview` 仅看 UI：**不能**写仓库 / 推送 / 申请 MR。

---

## 二、各模块操作与实际指令（技术分享）

下列指令为代码中**真实 argv**（经 `spawn("git"|"gh"|"glab", …)` 或集成终端 `sendText`）。分享时可按模块对照讲解。

### 2.1 Git / MR 配置

**操作要点**

四种方式四选一（切换即保存到扩展全局配置）：

| 方式 | 说明 | 何时用 |
|------|------|--------|
| **A** 本机 gh / glab | PATH 中已安装并登录 | 本机已有 CLI（推荐） |
| **B** 下载 CLI 到扩展目录 | 不占系统 PATH | 不想装系统 CLI |
| **C** Token（API） | GitHub / GitLab PAT | 无 CLI、或仅用 Token |
| **D** 仅打开浏览器创建页 | 打开预填 MR/PR 页 | 临时 / 无自动化需求 |

方案 C：

- 按远程平台只填一侧；GitLab Token **必须以 `glpat-` 开头**
- 标签上方有「打开创建 Token 页面」按钮（GitHub / GitLab）
- Token `change` 后自动校验并保存；标题旁显示有效期（中国时间）

配置**双写**（各仓库共用同一套 Token / MR 方式）：

| 位置 | 键 / 路径 |
|------|-----------|
| 扩展 `globalState` | `gitInsight.userConfig` |
| 扩展 `globalStorage` | `user-config.json` |

**实际指令 / 行为**

| 用途 | 指令 / 行为 |
|------|-------------|
| 探测平台 | `git remote get-url origin` → 解析主机名（含 `github` / `gitlab` / `git.`） |
| 检测系统 CLI | `gh --version`；`glab --version` |
| 检测扩展内 CLI | 同上，可执行文件路径为扩展 `globalStorage` 下下载的 `gh` / `glab` |
| 登录状态 | `gh auth status`；`glab auth status` |
| 唤起登录 | 集成终端 `sendText`：`gh auth login` / `glab auth login`；扩展内二进制用 PowerShell：`& "<path>\gh.exe" auth login`（或 glab） |
| 下载 gh（B） | `GET https://api.github.com/repos/cli/cli/releases/latest` → 按 OS/arch 下 zip/tar |
| 下载 glab（B） | `GET https://gitlab.com/api/v4/projects/gitlab-org%2Fcli/releases/permalink/latest` → 匹配 `windows_amd64.zip` 等 |
| Token 校验（C）·GitHub | `GET https://api.github.com/user`（`Authorization: Bearer <token>`） |
| Token 校验（C）·GitLab | `GET <origin>/api/v4/user`（`PRIVATE-TOKEN`）+ `GET …/personal_access_tokens/self`（读过期时间） |
| 浏览器创建页（D） | 见 §2.7 拼 URL → `openExternal`（无 CLI） |

代码：`packages/extension/src/gitConfigStore.ts`、`cliBundle.ts`、`webview/.../GitConfigPanel.vue`。

---

### 2.2 Fetch（分支图 / 预演 / 手动 Fetch）

**操作要点**

加载分支图、合并预演默认会先 fetch；顶栏也可点「Fetch」。  
**工作区 fetch**（分支图 / 预演 / 手动）：只用本机 Git 凭据，**允许弹窗**；方案 C Token **不参与**。

**实际指令**

| 用途 | 指令 |
|------|------|
| Fetch | `git fetch --prune --progress <remote>`（默认 `origin`） |
| 探测可达（可选） | `git ls-remote --exit-code <remote> HEAD`（`probeRemoteAccess`） |

**环境变量（`interactive: true`）**

| 变量 | 值 | 含义 |
|------|-----|------|
| `GIT_TERMINAL_PROMPT` | `1` | 允许终端提示 |
| `GCM_INTERACTIVE` | `always` | 允许 GCM 弹窗 |
| askpass | 保留 Cursor/VS Code 注入 | 允许 IDE 登录弹窗 |

（对比：非交互默认 `GIT_TERMINAL_PROMPT=0`、`GCM_INTERACTIVE=never`、清空 askpass——用于其它仍需静默的调用。）

| UI 状态 | 含义 |
|---------|------|
| `（已 fetch）` | 本次成功，远程跟踪分支已刷新 |
| `（fetch 失败，可能与线上不一致）` | fetch 失败，图来自本地旧 refs |
| `（未 fetch）` | 请求带了 `noFetch` / CLI `--no-fetch` |

CLI：`git-insight fetch [--cwd] [--remote]`

代码：`packages/core/src/git/fetch.ts`、`git/runner.ts`、`git/auth.ts`。

---

### 2.2.1 分支协议（短名 + gitRef）

宿主列出分支时**不改写**磁盘 refs，只发结构化字段。

**实际指令**

```bash
git for-each-ref --format=%(refname)%00%(refname:short) refs/heads refs/remotes
```

跳过 `refs/remotes/*/HEAD`；本地 → `gitRef = short`；远程 `refs/remotes/<remote>/<path>` → `name=path`，`gitRef=<remote>/<path>`。

| 字段 | 含义 | 示例（本地 `main`） | 示例（远程） |
|------|------|---------------------|--------------|
| `name` | 短名（无 remote 前缀） | `main` | `feature/x` |
| `remote` | 是否 `refs/remotes` | `false` | `true` |
| `remoteName` | 远程名（仅远程） | — | `origin` |
| `gitRef` | git 操作身份 | `main` | `origin/feature/x` |

- **UI 树**：本地 / 远程分组，路径按短名 `name` 分层
- **预演 / 一键解决**：`into` / `from` 传 **`gitRef`**
- **申请 MR**：source/target 用短名（`branchNameForMr`，见 `merge/branchName.ts`）

代码：`packages/extension/src/coreBridge.ts`（`listBranchNames`）、`webview/.../branchTree.ts`。

---
### 2.3 分支图

**操作要点**

1. 点「加载分支图」（扩展默认全量 tip，`maxNodes: 0`）
2. 画布：绿色=本地 tip，蓝色=远程 tip；边从左到右表示「较近 tip 祖先 → 子分支」（不是完整 commit 链）
3. 点击 tip：高亮到根源链路，右侧出链路报告；底部图例文案不随点击变化
4. Ctrl+F 或「搜索节点」：按分支名 / sha 定位

**注意：** fetch 主要更新 `origin/*`；**本地分支 tip 不会因 fetch 自动快进**。对照线上请看 `origin/xxx`。

**实际指令**

| 用途 | 指令 |
|------|------|
| 枚举 tip | `git for-each-ref --format=%(refname)%00%(refname:short)%00%(objectname)%00%(upstream:short) refs/heads refs/remotes` |
| 提交 DAG | `git rev-list --parents [--max-count=N] <tips…>` |
| 双分支裁剪 | `git rev-list --parents <into> <from> ^<base>^@` |
| 提交元数据 | `git log --no-walk=unsorted --pretty=format:%H%x00%P%x00%an%x00%at%x00%s%x00 <sha…>`（分块） |
| 领先计数 | `git rev-list --count <base>..<tip>` |
| 分叉点 | `git rev-list --reverse --max-count=1 <base>..<from>` |
| merge-base | `git merge-base <a> <b>` |

CLI：

```bash
git-insight graph
git-insight graph --into main --from feature/x
git-insight graph --max 0
git-insight graph --no-fetch
```

代码：`packages/core/src/graph/builder.ts`；UI：`webview/src/graph/toG6Data.ts`、`GraphView.vue`。

---

### 2.4 合并预演（只读）

**操作要点**

1. 选线上目标 + 我的分支 →「开始预演」
2. 冲突三栏：左=线上、右=我的；采用线上 / 我的，或 AI 选边
3. 「一键解决并推送」前会写入 localStorage 暂存（键含 cwd + into + from）
4. 预演本身**不改工作区**

**实际指令（预演前通常先 §2.2 fetch）**

| 用途 | 指令 |
|------|------|
| 解析 tip | `git rev-parse --verify <into\|from>^{commit}` |
| 共同祖先 | `git merge-base <intoSha> <fromSha>`（无则走无关历史） |
| 预演合并树 | `git merge-tree --write-tree -z --messages --name-only [--allow-unrelated-histories] <intoSha> <fromSha>` |
| 旧版 fallback | `git merge-tree <baseSha> <intoSha> <fromSha>` |
| 读一侧文件 | `git show <rev>:<path>` |
| 合成冲突标记 | `git merge-file -p --diff3 -L ours:<path> -L base -L theirs:<path> <oursFile> <baseFile> <theirsFile>`（临时文件） |
| 路径是否存在 | `git cat-file -e <rev>:<path>` |
| 差异范围 | `git diff -U0 <base>...<tip> -- <path>` |
| 行级溯源 | `git blame -l -w -L<start>,<end> --line-porcelain <rev> -- <path>` |
| （可选）关联 PR | `gh pr list --search <sha7> --state all --json number --limit 1`（`GH_PROMPT_DISABLED=1`，失败静默） |

空 tree 常量：`4b825dc642cb6eb9a060e54bf8d0927f6fb5fb496`（不现场 `hash-object`）。  
前置：`git --version` ≥ 2.38（`merge-tree --write-tree`）。

CLI：

```bash
git-insight preview-merge --into develop --from feature/x
git-insight preview-merge --into develop --from origin/feature/x --no-fetch
# 兼容旧名
git-insight conflict-blame --into <线上> --from <我的>
```

代码：`merge/preview.ts`、`merge/rehearsal.ts`、`merge/blame.ts`、`merge/conflictContent.ts`。

**冲突暂存（无 git）**

| 项 | 说明 |
|----|------|
| 存储 | Webview `localStorage` |
| 键 | `git-insight:merge-resolve:v1:{cwd}\0{into}\0{from}` |
| 内容 | choices + `resolvedContent` |
| 代码 | `webview/src/conflict/resolveStore.ts` |

---

### 2.5 AI 选边（扩展）

**操作要点**

1. 勾选规则：默认偏我的 / 偏线上（互斥）、新覆盖旧、可合并则合并；可填额外说明
2. 裁决优先级：额外说明 → 新覆盖旧 → 可合并则合并 → 偏我的/偏线上 → 否则 pending
3. 模型路径：`vscode.lm` → 已配置 OpenAI 兼容 API → Cursor Chat 本地回传桥
4. Chat 桥：冲突数据写入临时 JSON，提示词只引用路径；超长自动分批（约 25 块 / 8 万字符）
5. **须人工核对**后再推送 / 申请 MR

**回传约定（技术分享重点）**

| 方式 | 说明 |
|------|------|
| A | Agent `curl` POST 到本机 `http://127.0.0.1:<port>/result` |
| B | 把 JSON 贴回弹层「粘贴结果并应用」 |

若配置了 **MCP feedback** 等旁路：Agent 可能停在确认而不 curl——扩展**只认** HTTP 回传或粘贴，请用方式 B。临时 `conflicts` / `prompt` 文件在回传或取消后删除。

**实际指令：** 本功能**不调用** `git` / `gh` / `glab`（只读预演结果 + 本地模型/HTTP）。

代码：`packages/extension/src/aiResolve*.ts`、`webview/.../AiResolveDialog.vue`。

---

### 2.6 一键解决并推送（独立 worktree）

**操作要点**

宿主确认后，在**独立 worktree**完成 merge / 写文件 / commit / push，**主工作区不 checkout**。

**实际指令**

| 步骤 | 指令 |
|------|------|
| 当前分支（主仓） | `git branch --show-current` |
| 解析 tip | `git rev-parse --verify <into\|from>^{commit}` |
| 建 worktree + 临时分支 | `git worktree add -B <tempBranch> <wtPath> <intoSha>` |
| 同向 merge（停在冲突） | `git merge --no-ff --no-commit <fromSha>`（在 worktree cwd） |
| 列出未合并 | `git diff --name-only --diff-filter=U` |
| 写入选边正文 | 写文件 + `git add -- <path>`（每个暂存文件） |
| 提交 | `git commit -m "resolve: merge <from> into <into> via <tempBranch>\n\n…"` |
| 读 SHA | `git rev-parse HEAD` |
| 推送 | `git push -u <remote> HEAD:refs/heads/<tempBranch>` |
| 拼浏览器 MR 链 | `git remote get-url <remote>` → `buildCreateMrUrl`（不调 API） |
| 失败回滚 | `git merge --abort` |
| 清理 | `git worktree remove --force <wtPath>`；`git worktree prune` |

默认临时分支名：`merge/<from短名>-into-<into短名>`（slug 已去掉 `origin/` 等前缀）。  
方向：临时分支**基于线上 into**，再 merge **我的 from**。

**`worktree add -B` 说明**

`-B` 会把已存在的同名临时分支**重置**到当前 into tip，再挂到独立 worktree。注意：

| 风险 | 说明 |
|------|------|
| 同名临时分支已有提交 | 会被重置；设计上临时分支可重建，勿当长期分支用 |
| 同名分支已在**其他** worktree 检出 | `worktree add` 失败（扩展会提示） |
| 同名分支已在**主工作区**检出 | 同样拒绝，避免抢检出 |

代码：`packages/core/src/merge/applyResolve.ts`。

---
### 2.7 一键申请 MR

**操作要点**

1. 依赖配置就绪（A/B 已登录，或 C Token 有效，或 D）
2. 有冲突须先推送成功；干净合并可直接申请
3. MR 方向：临时分支（或我的分支）→ **线上目标（into）**
4. 对话框多选 = **指派人 + 审核人**（同一批人两种角色；指派有邮件提醒）

源/目标分支名经 `branchNameForMr` 去掉 `origin/` 等前缀（`merge/branchName.ts`）。

**公共 git（prepare / 探测）**

| 用途 | 指令 |
|------|------|
| 远程 URL | `git remote get-url <remote>` |
| 本地分支是否存在 | `git show-ref --verify --quiet refs/heads/<name>` |
| 远程跟踪是否存在 | `git show-ref --verify --quiet refs/remotes/<remote>/<name>` |

**GitHub · gh（A / B）**

| 用途 | 完整指令 |
|------|----------|
| 版本 | `gh --version` |
| 登录 | `gh auth status` |
| 候选（指派/审核） | `gh api repos/<owner>/<repo>/collaborators?per_page=100 --jq '<仅 admin/maintain>'` |
| 建 PR | `gh pr create --base <tgt> --head <src> --title <t> --body <b> [--assignee a,b] [--reviewer a,b]` |

候选过滤：仅 **admin / maintain**（不含 write）。

**GitLab · glab（A / B）**

| 用途 | 完整指令 |
|------|----------|
| 版本 | `glab --version` |
| 登录 | `glab auth status` |
| 候选（指派/审核） | `glab api projects/<urlencoded-path>/members/all?per_page=100`，再滤 `access_level >= 40` |
| 建 MR | `glab mr create --source-branch <src> --target-branch <tgt> --title <t> --description <b> --yes [--assignee u]… [--reviewer u]…` |

**Token（C）· GitHub REST**

| 步骤 | 请求 |
|------|------|
| 候选 | `GET https://api.github.com/repos/<owner>/<repo>/collaborators?per_page=100`（Bearer；滤 admin/maintain） |
| 建 PR | `POST https://api.github.com/repos/<owner>/<repo>/pulls`（`title/body/head/base`） |
| 审核人 | `POST …/pulls/<n>/requested_reviewers`（`{ reviewers: [...] }`） |
| 指派人 | `POST …/issues/<n>/assignees`（`{ assignees: [...] }`） |

**Token（C）· GitLab REST**

| 步骤 | 请求 |
|------|------|
| 候选 | `GET <origin>/api/v4/projects/<urlencoded>/members/all?per_page=100`（`PRIVATE-TOKEN`；滤 ≥40） |
| 用户 id | `GET <origin>/api/v4/users?username=<u>`（每人一次） |
| 建 MR | `POST <origin>/api/v4/projects/<urlencoded>/merge_requests`（`source_branch/target_branch/title/description` + `assignee_ids` + `reviewer_ids`） |

**浏览器（D）· 拼 URL（无 CLI）**

| 平台 | URL 形态 |
|------|----------|
| GitHub | `<origin>/<path>/compare/<tgt>...<src>?expand=1` |
| GitLab | `<origin>/<path>/-/merge_requests/new?merge_request[source_branch]=…&merge_request[target_branch]=…` |

**接口请求 mock（方案 C Token，与代码 `fetch` 一致）**

下列可本地用 curl 复现；占位符：`OWNER`/`REPO`、`ORIGIN`（如 `https://gitlab.example.com`）、`TOKEN`、分支名、用户名。响应只列代码会读的字段。

<details>
<summary>GitHub · 校验 Token / 列候选 / 建 PR + 指派 + 审核</summary>

```bash
# 1) 校验 Token（配置页）
curl -sS -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
  -H "User-Agent: git-insight" \
  https://api.github.com/user
# 关注：login、（可选）过期相关字段由后续接口补

# 2) 指派人/审核人候选
curl -sS -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
  -H "User-Agent: git-insight" \
  "https://api.github.com/repos/$OWNER/$REPO/collaborators?per_page=100"
# 响应元素字段（代码读取）：login, role_name, permissions.admin|maintain|push
# 过滤后仅保留 admin / maintain

# 3) 创建 PR
curl -sS -X POST -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
  -H "User-Agent: git-insight" -H "Content-Type: application/json" \
  "https://api.github.com/repos/$OWNER/$REPO/pulls" \
  -d '{
    "title": "Merge feature/x into develop",
    "body": "Created via Git Insight.",
    "head": "feature/x",
    "base": "develop"
  }'
# 关注响应：number, html_url

# 4) 请求审核（与对话框同一批人）
curl -sS -X POST -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
  -H "User-Agent: git-insight" -H "Content-Type: application/json" \
  "https://api.github.com/repos/$OWNER/$REPO/pulls/$PR_NUMBER/requested_reviewers" \
  -d '{ "reviewers": ["alice", "bob"] }'

# 5) 指派（邮件提醒；PR 走 issues assignees）
curl -sS -X POST -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
  -H "User-Agent: git-insight" -H "Content-Type: application/json" \
  "https://api.github.com/repos/$OWNER/$REPO/issues/$PR_NUMBER/assignees" \
  -d '{ "assignees": ["alice", "bob"] }'
```

</details>

<details>
<summary>GitLab · 校验 Token / 列候选 / 查 id / 建 MR</summary>

```bash
# 1) 校验 Token（配置页）
curl -sS -H "PRIVATE-TOKEN: $TOKEN" -H "User-Agent: git-insight" \
  "$ORIGIN/api/v4/user"
curl -sS -H "PRIVATE-TOKEN: $TOKEN" -H "User-Agent: git-insight" \
  "$ORIGIN/api/v4/personal_access_tokens/self"
# 关注：expires_at 等（用于 UI 展示有效期）

# 2) 指派人/审核人候选（PROJECT 为 URL 编码后的 path，如 group%2Frepo）
curl -sS -H "PRIVATE-TOKEN: $TOKEN" -H "User-Agent: git-insight" \
  "$ORIGIN/api/v4/projects/$PROJECT/members/all?per_page=100"
# 响应元素：username, name, access_level；过滤 access_level >= 40（Maintainer+）

# 3) username → id（每个选中用户一次）
curl -sS -H "PRIVATE-TOKEN: $TOKEN" -H "User-Agent: git-insight" \
  "$ORIGIN/api/v4/users?username=alice"
# 响应数组元素：id, username

# 4) 创建 MR（assignee_ids 与 reviewer_ids 同一批 id）
curl -sS -X POST -H "PRIVATE-TOKEN: $TOKEN" -H "Content-Type: application/json" \
  -H "User-Agent: git-insight" \
  "$ORIGIN/api/v4/projects/$PROJECT/merge_requests" \
  -d '{
    "source_branch": "feature/x",
    "target_branch": "develop",
    "title": "Merge feature/x into develop",
    "description": "Created via Git Insight.",
    "assignee_ids": [101, 102],
    "reviewer_ids": [101, 102]
  }'
# 关注响应：web_url
```

</details>

<details>
<summary>方案 A/B · gh / glab 等价命令（非 HTTP mock，便于对照）</summary>

```bash
# GitHub 候选（与代码 --jq 过滤 admin/maintain 一致）
gh api "repos/$OWNER/$REPO/collaborators?per_page=100" --jq \
  '.[] | select(.permissions.admin == true or .permissions.maintain == true or .role_name == "admin" or .role_name == "maintain") | {username: .login, name: (.name // .login), role: (if .role_name then .role_name elif .permissions.admin then "admin" else "maintain" end)}'

# 建 PR + 指派 + 审核
gh pr create --base develop --head feature/x \
  --title "Merge feature/x into develop" --body "Created via Git Insight." \
  --assignee alice,bob --reviewer alice,bob

# GitLab 候选
glab api "projects/$PROJECT/members/all?per_page=100"

# 建 MR + 指派 + 审核
glab mr create --source-branch feature/x --target-branch develop \
  --title "Merge feature/x into develop" --description "Created via Git Insight." \
  --yes --assignee alice --reviewer alice --assignee bob --reviewer bob
```

</details>

代码：`packages/core/src/merge/createMr.ts`、`config/validateToken.ts`；UI：`CreateMrDialog.vue`。

---

### 2.8 打开远程仓库（扩展）

面板输入 `owner/repo` 时：克隆到扩展数据目录，或对已有缓存 fetch。  
**注意：** 此路径仍可能走 Token（与工作区 §2.2 fetch 不同）。

| 步骤 | 指令 / 行为 |
|------|-------------|
| 首次克隆 ① | `git clone -- <httpsUrl> <dir>`（本机凭据，非交互） |
| 首次克隆 ② | `git clone -- <httpsUrl带token> <dir>` + 可选 `git -c http.extraHeader=Authorization: Basic …`（有 GitHub Token 时） |
| 首次克隆 ③ | `git clone -- <httpsUrl> <dir>`（`interactive: true` 允许弹窗） |
| 已有缓存 ①②③ | `git fetch --all --prune`（同样：静默 → Token → 交互） |

代码：`packages/extension/src/remoteRepo.ts`。

---

### 2.9 公共 Git 基础设施

| 用途 | 指令 | 代码 |
|------|------|------|
| 版本 | `git --version` | `git/version.ts` |
| 仓库根 | `git rev-parse --show-toplevel` | `git/runner.ts` |
| 解析 tip | `git rev-parse --verify <rev>^{commit}` | 多处 |
| 共同祖先 | `git merge-base <a> <b>` | graph / merge |
| 当前分支 | `git branch --show-current` | applyResolve |
| HTTPS Token 注入（仅仍需要时，如 remoteRepo） | `git -c http.extraHeader=Authorization: Basic <base64(user:token)> …`；GitHub user=`x-access-token`，GitLab user=`oauth2` | `git/auth.ts` |

底层：`packages/core/src/git/runner.ts` — `spawn("git", args)`；默认非交互环境；`interactive: true` 时见 §2.2。

---

## 三、核心模块实现说明

### 3.1 仓库结构

```text
packages/core                 @git-insight/core   — 唯一 Git/MR 引擎 + CLI
packages/extension            git-insight         — Cursor/VS Code 宿主
packages/extension/webview    @git-insight/webview — Vue3 UI（G6 分支图）
skills/git-branch-insight     Agent Skill（只读 CLI）
docs/guide.md                 本文（唯一完整说明）
```

| 包 | 职责 |
|----|------|
| **core** | `runGit` / fetch / 分支图 / merge-tree 预演 / worktree 落盘 / gh·glab·Token 建 MR |
| **extension** | Webview 桥接、确认框、globalState 配置、CLI 下载、终端登录、AI 选边桥 |
| **webview** | 分支树、G6 图、冲突三栏、Git 配置、MR 对话框；**不直接 spawn git** |

### 3.2 @git-insight/core

构建与 CLI：

```bash
pnpm --filter @git-insight/core build
pnpm --filter @git-insight/core exec node dist/cli.js graph
pnpm --filter @git-insight/core exec node dist/cli.js preview-merge --into <线上> --from <我的>
pnpm --filter @git-insight/core exec node dist/cli.js fetch
```

输出 JSON：`{ ok, command, data, report?, mermaid? }`。

**CLI 不包含**一键 resolve / create MR（仅扩展调用库函数）。

程序化 API 示例：

```ts
import {
  buildBranchGraph,
  rehearseMerge,
  fetchRemote,
  applyStashedResolve,
  createMergeRequest,
} from "@git-insight/core";

await fetchRemote("/path/to/repo");
const preview = await rehearseMerge({
  into: "main",
  from: "feature/x",
  cwd: "/path/to/repo",
});
```

### 3.3 扩展与 Webview

| Tab / 面板 | 功能 | 主要协议 |
|------------|------|----------|
| Git 配置 | A–D、Token、下载 CLI、登录 | `getGitConfig` / `saveGitConfig` / `downloadCli` / `cliAuthLogin` |
| 分支图 | tip 图 + 链路报告 | `graph` → `buildBranchGraph` |
| 合并预演 | 冲突三栏、AI 选边、一键解决、申请 MR | `preview` / `applyResolve` / `prepareCreateMr` / `createMr` / `aiResolveConflicts` |

开发：

```bash
pnpm --filter @git-insight/core build
pnpm --filter git-insight build
# F5：Run Git Insight Extension
# 浏览器只读预览：pnpm preview
```

打包：`pnpm package:vsix` → 仓库根目录 `git-insight.vsix`。  
发布到 Cursor 市场：见下方 **§3.6**。

### 3.4 关键代码索引

| 模块 | 路径 |
|------|------|
| Git 运行器 | `packages/core/src/git/runner.ts` |
| Fetch / 鉴权 | `packages/core/src/git/fetch.ts`、`auth.ts` |
| 分支图 | `packages/core/src/graph/builder.ts` |
| 合并预演 | `packages/core/src/merge/preview.ts`、`rehearsal.ts` |
| 一键落盘 | `packages/core/src/merge/applyResolve.ts` |
| 创建 MR | `packages/core/src/merge/createMr.ts`、`branchName.ts` |
| CLI | `packages/core/src/cli.ts` |
| 宿主桥接 | `packages/extension/src/coreBridge.ts` |
| AI 选边 | `packages/extension/src/aiResolveBridge.ts`、`aiResolveLm.ts`、`aiResolveBatch.ts` |
| CLI 下载 | `packages/extension/src/cliBundle.ts` |
| 配置存储 | `packages/extension/src/gitConfigStore.ts` |
| 冲突 UI | `packages/extension/webview/src/ConflictResolvePanel.vue` |
| Skill 入口 | `skills/git-branch-insight/SKILL.md` → 本文 §四 |

### 3.5 风险与约定

1. **into / from 不可填反**：左=线上、右=我的；与预演选边、一键落盘同向。
2. 临时分支必须基于 **线上 into**；误从我的分支拉出再 merge 线上会左右对调。
3. tip 变化后应重新预演再一键解决。
4. 主工作区可有未提交改动（worktree 隔离）；临时分支名已在主仓检出则拒绝。
5. 冲突文件须全部有选边，否则 worktree 内 `merge --abort`。
6. PowerShell 执行扩展内 CLI：`& "…\gh.exe" auth login`（不可省略 `&`）。

### 3.6 发布到 Cursor 市场（Open VSX）

Cursor 扩展市场上游是 **[Open VSX](https://open-vsx.org)**（不是 Microsoft VS Code Marketplace）。  
**现行唯一发版流程**：改扩展 `version` → push 到 `master`/`main` → GitHub Actions 自动打 tag 并发布到 Open VSX → Cursor 市场稍后同步。

| 项 | 值 |
|----|-----|
| 扩展 ID | `jinshaohui.git-insight` |
| publisher / namespace | `jinshaohui` |
| name | `git-insight` |
| 工作流 | [`.github/workflows/release-on-version.yml`](../.github/workflows/release-on-version.yml) |

```text
【一次性】Open VSX 账号 + Token + create-namespace + GitHub Secret OVSX_PAT
                              ↓
【日常】改 packages/extension/package.json 的 version（升高）
                              ↓
              git commit && git push origin master
                              ↓
         CI：version 相对上一提交有变化？
                    ↓ 是
         打 tag v{version} 并 push
                    ↓
         pnpm package:vsix → ovsx publish
                    ↓
         Open VSX 有新版本 → Cursor 扩展市场同步（数小时内）
```

> **Open VSX Token（`OVSX_PAT`）≠ 扩展面板里的 GitHub/GitLab Token。**  
> 只用于发版；不要写进代码、不要提交 git、不要填进「Git 配置」。

#### 3.6.1 一次性配置（按顺序 ①→②→③→④）

**① Open VSX 账号与协议**

1. 打开 [https://open-vsx.org](https://open-vsx.org)，用 **GitHub** 登录。  
2. 注册 / 登录 [eclipse.org](https://accounts.eclipse.org)（**GitHub Username** 须与上一步一致）。  
3. open-vsx.org → 头像 → **Settings** → **Log in with Eclipse** → 授权。  
4. **Show Publisher Agreement** → 读完点 **Agree**。

**② 生成 Access Token**

1. [Access Tokens](https://open-vsx.org/user-settings/tokens) → **Generate New Token**（描述如 `git-insight-ci`）。  
2. **立刻复制保存**（关闭后不再显示）。

本机首次建 namespace 时临时使用：

```powershell
$env:OVSX_PAT="粘贴刚才的 token"
```

**③ 创建 namespace 并校验（本机只做一次）**

```powershell
# 与 package.json 的 publisher 同名
npx ovsx create-namespace jinshaohui -p $env:OVSX_PAT

# 校验 Token 可向该 namespace 发版
npx ovsx verify-pat jinshaohui -p $env:OVSX_PAT
```

- `already exists` → 跳过 create 即可。  
- 未授权 → 回到 ① 检查 Eclipse / Agreement。  
- CI **不会**自动 `create-namespace`。

**④ 写入 GitHub，供 CI 发版**

| 配什么 | 在哪里 | 说明 |
|--------|--------|------|
| Secret **`OVSX_PAT`** | [Settings → Secrets → Actions](https://github.com/shaohui-jin/git-skills/settings/secrets/actions) → New repository secret | Name 必须是 `OVSX_PAT`；Value = ② 的 Token |
| 启用 Actions | Settings → Actions → General | 允许 workflow 运行 |
| 推送 workflow | 默认分支含 `release-on-version.yml` | Actions 列表出现 **Release on version bump** |

不需要：VS Code Marketplace PAT、额外「打 tag」Token（CI 用 `GITHUB_TOKEN` 打 tag）。

#### 3.6.2 日常发版（现行流程）

配置完成后，**不要自己 `git tag`**，只需：

```powershell
# 1) 升高版本号（须高于 Open VSX 已有版本）
#    编辑 packages/extension/package.json → "version": "0.1.7"

# 2) 提交并推到默认分支
git add packages/extension/package.json
git commit -m "chore(extension): bump version to 0.1.7"
git push origin master
```

| CI 判定 | 行为 |
|---------|------|
| 推到 `master`/`main`，改了扩展 `package.json`，且 **version 相对上一提交变了** | 打 `v{version}` → 打包 → `ovsx publish` |
| 只改了 description 等、version 未变 | 可能触发 workflow，但**跳过**发版 |

打开 GitHub → **Actions** → **Release on version bump** 看日志。  
成功后：仓库有 tag `v0.1.7`；https://open-vsx.org/extension/jinshaohui/git-insight 有新版本。

#### 3.6.3 在 Cursor 里确认

1. Open VSX 网页已有该版本后，Cursor 一般 **数小时内**同步。  
2. 扩展面板搜 `Git Insight` / `jinshaohui.git-insight` → 安装 → Reload Window。  
3. 市场暂未搜到：`Extensions: Install from VSIX…` 装本地 `pnpm package:vsix` 产物。

#### 3.6.4 常见报错

| 现象 | 处理 |
|------|------|
| Namespace 不存在 / 404 | 未做 §3.6.1 **③ create-namespace** |
| Publisher Agreement / Eclipse | 未完成 §3.6.1 **①** |
| CI：Missing secret `OVSX_PAT` | 未做 §3.6.1 **④** |
| 401 / invalid token | Token 错或过期；更新 Secret |
| CI：远程已存在 tag | 提高 `version` 再推，或删除误打的远程 tag |
| Open VSX：version already exists | 该版本已发过；提高 `version` 再推 |
| 市场搜不到但 Open VSX 有 | 等同步；或本地装 VSIX；检查 `engines.vscode` 是否高于 Cursor 内置 VS Code |

官方：[Open VSX · Publishing Extensions](https://github.com/eclipse/openvsx/wiki/Publishing-Extensions)。

---

## 四、Skill 说明

Cursor 加载入口：[`skills/git-branch-insight/SKILL.md`](../skills/git-branch-insight/SKILL.md)（frontmatter + 指向本文）。

### 4.1 范围

| | Skill | 扩展 |
|--|-------|------|
| Fetch | 默认自动 | 加载图 / 预演默认 fetch |
| 交互 | 对话 + 报告 | 可视化 + 一键解决 / MR |
| 引擎 | 同一 `@git-insight/core` | 同一 |
| 一键 resolve / MR | **不做** | 支持 |

Agent **不要**为了预演去真实 `merge` / `checkout` / `push`。

### 4.2 前置

- Git ≥ 2.38
- 在仓库根执行，或 `--cwd <repo>`
- 先：`pnpm --filter @git-insight/core build`
- 调用：`pnpm --filter @git-insight/core exec node dist/cli.js <command> …`

### 4.3 Agent 工作流

1. 确认仓库路径  
2. 映射意图 → `graph` 或 `preview-merge`  
3. 执行 CLI，解析 JSON  
4. `ok: false` → 解释 `error`  
5. `ok: true`：展示 `report`；有冲突时必须列出文件、`conflictContent` 与溯源；需要图时附 `mermaid`  

默认先 fetch；仅用户明确要求离线时加 `--no-fetch`。

### 4.4 输出约定

```markdown
## 结论
（干净合并 / 冲突 N 个文件）

## 冲突详情
（每个文件：路径、溯源、冲突内容代码块）

## 图
（mermaid）
```

### 4.5 不要做的事

- 不要为预演执行真实 `git merge` / `checkout` / `push`
- 不要把 PR 号当作核心参数
- 不要跳过默认 fetch（除非用户要求离线）
- 冲突时不要只汇报「有冲突」而省略冲突正文

### 4.6 预演 JSON 要点

```json
{
  "ok": true,
  "command": "preview-merge",
  "data": {
    "clean": false,
    "conflictFiles": [
      {
        "path": "file.txt",
        "conflictContent": "<<<<<<< ours:file.txt\n...\n=======",
        "hunks": []
      }
    ]
  },
  "report": "# 合并预演\n...",
  "mermaid": "flowchart TB\n..."
}
```

---

## 五、附录：FAQ 与命令速查

### 5.1 FAQ

**Fetch 失败，但 WebStorm 可以**  
确认本机 Git / Credential Manager 能对同一仓库 `git fetch`；方案 C Token **不参与** fetch。若弹窗未出现，检查是否被策略禁用了交互凭据。

**分支图和线上不一致**  
看是否「已 fetch」。成功后本地分支 tip 仍可能旧，请对照远程分组下的同名短分支（`gitRef` 形如 `origin/分支名`）。

**链路报告「无提交说明」**  
重新加载分支图（提交元数据已改为 `git log --no-walk` 解析）。

**预览模式下一键按钮是灰的**  
浏览器 preview 禁止写仓库；请在 Cursor 扩展面板操作。

**GitLab Token 格式**  
必须 `glpat-`；不要把 `ghp_` 填进 GitLab 框。Token 仅用于申请 MR，不能代替 fetch 登录。

**AI 选边一直等不到结果**  
检查是否停在 MCP feedback；把 JSON 粘贴到弹层兜底。

**发布 Cursor 市场失败 / 找不到扩展**  
见 **§3.6**：按 ①→④ 配好后，日常只改 `version` 推 master。市场搜不到时先看 open-vsx.org。

### 5.2 CLI 速查（git-insight 封装）

```text
git-insight graph [--cwd] [--max] [--into] [--from] [--no-fetch]
git-insight fetch [--cwd] [--remote]
git-insight preview-merge --into <线上目标> --from <我的分支> [--cwd] [--no-fetch]
git-insight conflict-blame …   # 同 preview-merge
```

一键 resolve / create MR **无** CLI 子命令，仅扩展调库。

### 5.3 底层指令速查（按功能）

| 功能 | 核心命令（详见 §二） |
|------|----------------------|
| 配置 / CLI | `gh\|glab --version` · `auth status` · 终端 `auth login` · 下载 release API |
| 工作区 Fetch | `git fetch --prune --progress <remote>`（可弹窗） |
| 分支列表 | `git for-each-ref … refs/heads refs/remotes` |
| 分支图 | `for-each-ref` · `rev-list --parents` · `log --no-walk` · `merge-base` · `rev-list --count` |
| 合并预演 | `merge-tree --write-tree` · `show` · `merge-file` · `diff -U0` · `blame` · 可选 `gh pr list` |
| AI 选边 | 无 git/gh/glab |
| 一键解决推送 | `worktree add -B` · `merge --no-ff --no-commit` · `add` · `commit` · `push -u` · `worktree remove` |
| 申请 MR · gh | `gh api …/collaborators` · `gh pr create --assignee --reviewer` |
| 申请 MR · glab | `glab api …/members/all` · `glab mr create --assignee --reviewer` |
| 申请 MR · Token | GitHub `pulls` + `requested_reviewers` + `issues/…/assignees`；GitLab `users?username` + `merge_requests` |
| 打开远程仓 | `git clone --` / `git fetch --all --prune`（可 Token / 弹窗） |

### 5.4 与 WebStorm 的差异（Fetch）

WebStorm 默认允许交互取凭据。本扩展**工作区** fetch 同样直接允许弹窗（已有本机凭据时通常不弹）；方案 C Token **不**用于工作区 fetch。打开 `owner/repo` 远程缓存时仍可能注入 Token（§2.8）。

---

*行为变更时请同步更新本文。Skill / 根 README / 各包 README 均指向本文。*
