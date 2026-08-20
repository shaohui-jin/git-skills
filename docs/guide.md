# Git Insight · 用户手册 + 技术分享

> 面向日常用户：能按这个文档把工具用起来；协作者也能从实现细节快速接手维护。

## 一、产品架构

### 1.1 四个包的职责

```text
packages/core                  @shaohui_jin/git-insight-core    唯一 Git 引擎 + CLI（不单独发版）
packages/mcp                   @shaohui_jin/git-insight-mcp-server  MCP server（stdio）
packages/extension             git-insight           Cursor/VS Code 宿主
packages/extension/webview     Vue3 UI               同一套 Webview，扩展 / 浏览器共用
```

| 包 | 职责 |
|----|------|
| **core** | `runGit` / fetch / 分支图 / merge-tree 预演 / 批量矩阵 / 顺序推演 / worktree 落盘 / gh·glab·Token 建 MR + CLI |
| **mcp** | stdio MCP server；默认只读，写操作需 `GIT_INSIGHT_MCP_ALLOW_WRITE=1` + `confirm: true` |
| **extension** | Webview 桥接、确认框、globalState 配置、CLI 下载、终端登录、AI 选边桥、冲突预警常驻、Skill 同步 |
| **webview** | 分支树、G6 图、合并矩阵、冲突三栏、Git 配置、MR 对话框、深浅双主题 token；不直接 spawn git |

### 1.2 模块功能清单

| 模块 | 所在包 | 功能说明 | 实现逻辑概要 |
|------|--------|----------|-------------|
| **分支图 (Branch Graph)** | core | 拉取全量分支拓扑，G6 可视化展示 commit DAG，支持点到链路报告 | `git rev-list --parents` 遍历 commit DAG，`git for-each-ref` 收集分支 tip，`git merge-base` 计算分叉点，构造 G6 图数据 |
| **合并预演 (Merge Preview)** | core | 单对分支 `merge-tree` 只读检测，输出冲突文件列表 + 冲突正文 + blame 溯源 | `git merge-tree --write-tree` 检测冲突，`git show` 读三方内容，`git merge-file --diff3` 合成冲突标记，`git blame` 逐行溯源 |
| **批量矩阵 (Merge Survey)** | core | N×M 笛卡尔积批量预演，只报冲突路径不生成正文，整批只 fetch 一次 | fetch 一次 → `rev-parse` 取 sha → `merge-base` 找公共祖先 → `merge-tree` 判冲突，结果按 (intoSha, fromSha) 缓存 |
| **合入顺序推演 (Merge Order)** | core | 贪心推演多分支依次合入同一目标的最佳顺序，最大化 cleanPrefix | `merge-tree` 输出 resultTree → `commit-tree` 造游离 commit 模拟「先合 A 再合 B」，遇冲突即停 |
| **一键解决并推送 (Apply Resolve)** | core | 在独立 worktree 中创建临时分支、merge 选边结果、commit 并 push | `git worktree add` 建独立工作区 → `git merge --no-ff --no-commit` 执行合并 → 写入已选边文件 → `git commit` → `git push` → `git worktree remove` 清理 |
| **一键申请 MR (Create MR)** | core | 四套方案按序回退：本地 gh/glab → 下载 CLI → Token API → 浏览器创建页 | `gh pr create` / `glab mr create` 走 CLI；`POST /repos/{owner}/{repo}/pulls` 走 GitHub API；`POST /projects/{id}/merge_requests` 走 GitLab API |
| **冲突三栏选边 (Conflict Resolve Panel)** | webview | 左=线上 / 中=结果 / 右=我的，逐块或整文件选边，AI 辅助选边 | Vue 3 实时计算 ChangeHunk，`buildChangeHunks` 构建 diff3 块，本地暂存 localStorage，应用时 `applyHunkActions` 合成最终文件内容 |
| **AI 选边 (AI Resolve)** | extension | 调用模型（vscode.lm / OpenAI 兼容 / Ollama / Chat 桥）为冲突块推荐选边 | 构造带上下文（ours/theirs/base + commit 信息）的提示词 → 发送给模型 → 解析结果回填到 hunk 选边 |
| **Git 配置 (Git Config)** | webview | 选择 MR 方式、配置 Token、默认远程、AI 参数 | 存储到扩展 globalState，`methodReady` 计算链判定当前配置是否可用 |
| **冲突预警常驻 (Conflict Watcher)** | extension | 后台定时检查当前分支能否干净合入目标，变糟时弹通知 | 定时器 + 窗口 focus 事件 → `git fetch --prune` 静默同步 → `merge-tree` 对比上次结果，恶化才通知 |
| **合并矩阵 UI (Merge Matrix)** | webview | 矩阵表格展示批量预演结果，支持点格子跳转预演/申请 MR，PairProgress 追踪进度 | 按 (into, from) 笛卡尔积渲染表格，stageOf 五档状态机（open→ready→local→resolved→mr），pendingQueue 批处理流水线 |
| **MR 对话框 (Create MR Dialog)** | webview | 填写/编辑分支、标题、审核人，以 CLI / Token / 浏览器方式提交 MR | `prepareCreateMr` 获取 draft → `createMr` 调用对应方式提交，MrDialogDraft 记录 platform/method/candidates |
| **MCP Server** | mcp | 通过 stdio 暴露 git-insight 能力给 AI 客户端，支持只读 + 可选写操作 | 基于 `@modelcontextprotocol/server` 框架，工具注册到 listTools/callTool handlers，默认只读模式 |

### 1.3 只读保证

预演全靠 `git merge-tree`，结果树只在对象库里流转，不建分支、不改工作区。仅 `apply-resolve` / `create-mr` 写仓库，且走独立 worktree 或远程 API。

前置：系统 Git ≥ 2.38（`merge-tree --write-tree`）。

### 1.4 推荐使用流程

```text
① Git 配置（A gh/glab、B 下载 CLI、C Token、D 仅浏览器）
② 分支图（默认先 fetch，与线上对齐）
③ 合并预演（远程「线上目标」+「我的分支」→ 冲突选边 / AI 选边）
④ 有冲突 →「一键解决并推送」
⑤ 「一键申请 MR」
```

多条分支合入同一目标，走 **合并矩阵**（③④⑤ 同上，但由矩阵盯"哪条还没走完"）。

---

## 二、核心实现 + 核心 Git 命令

### 2.1 三档预演（按代价从轻到重挑）

| API / 命令 | 代价 | 给什么 |
|------------|------|--------|
| `surveyMerges` / `survey` | 最轻。整批一次 fetch + sha 缓存 | 每对结论 + 冲突文件路径 |
| `previewMerge` / — | 中。单对，一次 fetch | 冲突文件列表 |
| `rehearseMerge` / `preview-merge` | 最重。逐文件 `git show` + `merge-file` + `blame` | 冲突正文 + 逐块溯源 |

`previewMergeBySha` 是三者共用的纯计算核：已知两侧 sha，不 fetch、不解析 ref，批量场景直接用它。

#### 核心 Git 命令

```bash
# 1. surveyMerges（批量矩阵最轻）—— fetch → rev-parse → merge-base → merge-tree
git fetch --prune --progress <remote>                      # 一次拉取（只读）
git rev-parse --verify <ref>^{commit}                       # ref → SHA
git merge-base <into> <from>                               # 最近公共祖先（无共同祖先返回空）
git merge-tree --write-tree -z --messages --name-only \   # 核心冲突检测
  [--allow-unrelated-histories] <into> <from>
# 输出：exit 0 + 冲突文件路径 + 结果树 OID

# 2. previewMerge（单对）—— 在 survey 基础上加以下命令输出文件详情
（同上命令，额外输出冲突文件的 name-only 列）

# 3. rehearseMerge（逐文件正文 + 溯源）—— 对每个冲突文件跑以下全套
git cat-file -e <rev>:<path>                              # 文件在此 rev 是否存在
git show <into>:<path>                                    # ours（线上侧）
git show <from>:<path>                                    # theirs（我的侧）
git show <base>:<path>                                    # base（公共祖先）
git merge-file -p --diff3 \                               # 生成 diff3 三方冲突标记
  -L ours:<path> -L base -L theirs:<path> \
  ours.txt base.txt theirs.txt
git diff -U0 <base>...<into> -- <path>                    # 改动行号范围
git blame -l -w -L<start>,<end> --line-porcelain <rev> -- <path>  # 每行溯源到 commit

# 辅助：truncate 保护（代码层实现，超 24000 字符截断时保 diff3 头 >>>>>>> 完整）
```

> **注意**：`survey` 只报路径，不拿正文 —— N×M 对 × 100+ 文件跑全套 `show`/`merge-file`/`blame` 太慢。先看 survey 筛选，命中后再 rehearse 单对。

---

### 2.2 合并矩阵与合入顺序

**实现原理**：

- 笛卡尔积 fetch 一次；结果按 `(intoSha, fromSha)` 缓存
- 不要正文，只报路径（N×M × 100+ `git show` 吃不消）
- 详情里点格子 → 右栏看文件 + "去完整预演" 进单对

**顺序推演不落地的原理**：`merge-tree --write-tree` 除报冲突外还输出合并后的结果树 OID（挂在 `MergePreviewResult.resultTree`），交给 `git commit-tree` 造一个游离 commit 当作下一次 merge-tree 的一侧，从而模拟「先合 A、再合 B」。游离 commit 不被任何 ref 引用，由 git gc 自然回收。

**目标函数**是 **cleanPrefix**（从头连续干净合入几个），不是「总冲突数最少」：
- 一旦某步冲突，结果树里 blob 带着冲突标记，后续数字失真
- 遇第一处冲突即停，报「前 k 个能干净合入，第 k+1 个起要人工」
- 贪心不做全排列：「干净合入不会让后续更难」 → 每步任意取一可行分支都不牺牲 cleanPrefix 上界

#### 核心 Git 命令

```bash
# 矩阵预演 —— 每对复用相同的 merge-tree 命令（已在 2.1 列过）

# 顺序推演额外步骤：用 merge-tree 输出的 resultTree 造游离 commit
git commit-tree <resultTree> -p <parent1> -p <parent2> -m "<msg>"
# commit-tree 输出游离 commit SHA，当作下一轮 merge-tree 的 <into>
# 循环直到某对 merge-tree 报冲突 → 停止，报前 k 步 clean
```

---

### 2.3 一键解决并推送（独立 worktree）

实现走独立 worktree，防止污染主工作区。

#### 核心 Git 命令

```bash
# 1. 记录当前分支
git branch --show-current

# 2. 建临时 worktree
git branch --show-current                                            # 备份当前分支
git worktree add -B <tempBranch> <wtPath> <intoSha>
# -B 重置已存在的同名临时分支到 into tip
# 临时分支命名：merge/<from短名>-into-<into短名>（剥 origin/ 前缀）

# 3. 在 worktree 内执行合并（停在冲突）
git merge --no-ff --no-commit <fromSha>

# 4. 列出冲突文件
git diff --name-only --diff-filter=U

# 5. 写入选边（每文件）
echo "<resolved content>" > <path>
git add -- <path>

# 6. 失败回滚（任一 add/commit/push 失败）
git merge --abort

# 7. 提交解决结果
git commit -m "resolve: merge <from> into <into> via <tempBranch>"

# 8. 推送临时分支到远程
git push -u <remote> HEAD:refs/heads/<tempBranch>

# 9. 清理 worktree（无论成功失败）
git worktree remove --force <wtPath>
git worktree prune

# 10. push 失败时删除临时分支（cleanup hook）
git branch -D <tempBranch>

# 11. 获取远程 URL（在建 MR 链接时）
git remote get-url <remote>
```

> **方向约定**：临时分支基于 **线上 into**，再 merge 我的 from。反了的话冲突选边会左右颠倒。

---

### 2.4 冲突正文与追溯源

#### 核心 Git 命令

```bash
# 读一侧文件（冲突前内容）
git show <rev>:<path>

# 合成三方 diff3 冲突标记（<<<<<<< ||||||| ======= >>>>>>>）
git merge-file -p --diff3 \
  -L ours:<path> -L base -L theirs:<path> \
  ours.txt base.txt theirs.txt
# 输出带 diff3 标记的文本，写到临时文件

# 差异范围（用于定位 blame 行号）
git diff -U0 <base>...<tip> -- <path>

# 行级溯源（定位每行来自哪个 commit、哪个作者）
git blame -l -w -L<start>,<end> --line-porcelain <rev> -- <path>

# 检查文件在指定 rev 是否存在（add/delete 冲突时用）
git cat-file -e <rev>:<path>

# 暂存区读三方内容（worktree 内解决冲突时）
git show :1:<path>   # base
git show :2:<path>   # ours
git show :3:<path>   # theirs
```

---

### 2.5 一键申请 MR

三套方式按序回退：A（本机 gh/glab）→ A'（扩展目录下载 CLI）→ C（Token API）→ D（仅浏览器创建页）。

#### 核心 gh / glab CLI 命令

```bash
# ---------- gh（GitHub）----------
# 检测 CLI 是否可用
gh --version
gh auth status

# 拉取候选人（admin / maintain 角色）
gh api repos/{owner}/{repo}/collaborators?per_page=100 \
  --jq '.[] | select(.permissions.admin == true or .permissions.maintain == true or .role_name == "admin" or .role_name == "maintain") | {username: .login, name: (.name // .login), role: (if .role_name then .role_name elif .permissions.admin then "admin" else "maintain" end)}'
# 输出：每行一个 JSON {username, name, role}

# 创建 PR（一次性带 reviewer + assignee）
gh pr create \
  --base <targetBranch> \
  --head <sourceBranch> \
  --title "<title>" \
  --body "<body>" \
  --reviewer user1,user2 \
  --assignee user1,user2
# 输出：PR URL（stdout 最后一行）

# ---------- glab（GitLab）----------
# 检测 CLI 是否可用
glab --version
glab auth status

# 拉取项目成员（access_level >= 40，Maintainer+）
glab api "projects/{encodedProjectPath}/members/all?per_page=100"
# 输出：JSON 数组 [{id, username, name, access_level}]

# 创建 MR（逐个追加 reviewer / assignee）
glab mr create \
  --source-branch <sourceBranch> \
  --target-branch <targetBranch> \
  --title "<title>" \
  --description "<body>" \
  --yes \
  --reviewer user1 --assignee user1 \
  --reviewer user2 --assignee user2
# 输出：MR URL（正则从 stdout 提取）

# ---------- 辅助：检查本地/远程分支 ----------
git show-ref --verify --quiet refs/heads/<name>        # 本地分支是否存在
git show-ref --verify --quiet refs/remotes/<remote>/<name>  # 远程分支是否存在
```

#### GitHub REST API 调用（Token 模式下）

```bash
# 认证 Header
Authorization: Bearer <token>
Accept: application/vnd.github+json
User-Agent: git-insight

# 1. 获取仓库协作者（admin / maintain）
GET https://api.github.com/repos/{owner}/{repo}/collaborators?per_page=100
# 返回：[{login, role_name, permissions: {admin, maintain, push}}]
# 筛：role === "admin" 或 role === "maintain"

# 2. 创建 PR
POST https://api.github.com/repos/{owner}/{repo}/pulls
Body: { title, body, head: sourceBranch, base: targetBranch }
# 返回：{ html_url, number, errors }

# 3. 追加审核人（创建成功后）
POST https://api.github.com/repos/{owner}/{repo}/pulls/{number}/requested_reviewers
Body: { reviewers: ["user1", "user2"] }

# 4. 追加指派人
POST https://api.github.com/repos/{owner}/{repo}/issues/{number}/assignees
Body: { assignees: ["user1", "user2"] }
```

#### GitLab REST API 调用（Token 模式下）

```bash
# 认证 Header
PRIVATE-TOKEN: <token>
User-Agent: git-insight

# 1. 获取项目成员（Maintainer+，access_level >= 40）
GET {origin}/api/v4/projects/{encodedProjectPath}/members/all?per_page=100
# 返回：[{id, username, name, access_level}]
# 筛：access_level >= 40
# encodedProjectPath = encodeURIComponent("owner/subgroup/repo")

# 2. 用户名 → User ID 必须转换（MR API 只接受数字 ID）
GET {origin}/api/v4/users?username={username}
# 返回：[{id, username, name}]
# 不区分大小写逐个查询，匹配不到记入 missing 列表跳过

# 3. 创建 MR（assignee_ids / reviewer_ids 一并提交）
POST {origin}/api/v4/projects/{encodedProjectPath}/merge_requests
Body: {
  source_branch, target_branch,
  title, description,
  assignee_ids: [id1, id2],
  reviewer_ids: [id1, id2]
}
# 返回：{ web_url, message }
```

#### 浏览器创建 URL（兜底，非 API）

```
GitHub: {origin}/{path}/compare/{targetBranch}...{sourceBranch}?expand=1
GitLab: {origin}/{path}/-/merge_requests/new?merge_request%5Bsource_branch%5D={src}&merge_request%5Btarget_branch%5D={tgt}
```

#### detectMrPlatform 判定逻辑

```text
normalizeRemoteWebUrl(remoteUrl) → https 形式的 URL
host = URL .hostname.toLowerCase()
    host === "github.com" || host.endsWith(".github.com")          → "github"
    host === "gitlab.com" || host.endsWith(".gitlab.com") 
                              || host.includes("gitlab.")          → "gitlab"
    其他                                                          → "unknown"
```

`normalizeRemoteWebUrl` 支持输入：`git@host:group/repo.git`、`ssh://git@host/...`、`https://...`，自动去 `.git` 尾部、脱壳。

---

### 2.6 冲突预警常驻（默认关）

后台定时（默认 10 分钟）用 `merge-tree` 检查「当前分支 ⇢ 目标」还能不能干净合；**只在变糟时**弹通知。

| 约定 | 说明 |
|------|------|
| 绝不弹登录 | 用 `fetchRemoteQuiet`（非交互），拿不到凭据就退避重试 |
| 窗口重获焦点时也查一次 | — |
| settings 默认关 | — |
| 手动触发 | 命令面板 `Git Insight: 立即检查合并冲突`，或点状态栏 |

#### 核心 Git 命令

```bash
# 1. 静默 fetch（非交互，拿不到凭据就 ignore）
git fetch --prune <remote>    # GIT_TERMINAL_PROMPT=0, 失败 code 非 0

# 2. 凭据探测（curl 改 header 形式鉴权）
git ls-remote --exit-code <remote> HEAD
# code 0 → 能访；code 2/128 → 凭据/网络问题

# 3. merge-tree 同预演（已在 2.1）
# 4. 更恶化才通知，否则静默
```

---

## 三、MCP npm 发版

### 3.1 npm 发版流程

| | 扩展 `git-insight` | MCP `@shaohui_jin/git-insight-mcp-server` |
|--|-------------------|-------------------------------|
| 版本文件 | `packages/extension/package.json` | `packages/mcp/package.json` |
| Git tag | `v{version}` | `mcp-server-v{version}` |
| CI | `release-on-version.yml` | `release-mcp-server.yml` |
| Secret | `OVSX_PAT` | `NPM_TOKEN` |

CI 触发：推 `master` 且 `packages/mcp/**` 或 `core/**` 改动（或 `workflow_dispatch`）。是否发布以**远程是否已有 `mcp-server-v{version}` tag** 为准（"tag 代表已发布"），前置任何一步挂了都可原样重试。

#### 本地 dry-run 命令

```bash
npm whoami
npm access ls packages @shaohui_jin
npm publish --dry-run --access public --prefix "packages/mcp"
```

#### scope 备选

scope `@shaohui_jin` 不可用时改用 `@<npm-username>/mcp-server`。

### 3.2 用户接入（用户自己的 .cursor/mcp.json）

```json
{
  "mcpServers": {
    "git-insight": {
      "command": "npx",
      "args": ["-y", "@shaohui_jin/git-insight-mcp-server@latest"]
    }
  }
}
```

`GIT_INSIGHT_MCP_CWD` 现**已可选**；fallback 链：请求里传 `cwd` > `GIT_INSIGHT_MCP_CWD` 环境变量 > `process.cwd()` > 向上找 .git。

---

## 四、Agent Skill (`/git-branch-insight`)

装扩展即自动同步到 `~/.cursor/skills/git-branch-insight/`；任意仓库 Agent 输入 `/git-branch-insight` 再说需求即可。

---

## 五、视觉与主题

### 5.1 语义色

橙=我的（from）、蓝=线上（into）、紫=强调/选中、红=冲突、绿=干净、`--warn`=还差一步（矩阵的「已处理」「已开创建页」用它，浅/暗色取值与 `--mine` 不同，别混用）。

### 5.2 深/浅两套主题

- 不跟 IDE 主题色，只跟明暗（`activeColorTheme.kind`）
- 原子值与派生值必须同元素声明（`var()` 固化规则）
- G6 画布通过 `theme.ts` 的 `cssVar()` 把语义色传入，主题切换时重建画布

### 5.3 两层视觉

- 外壳层（顶栏/卡片/按钮/表单/弹层）柔和面、圆角、动效
- 图纸层（MERGE MAP/冲突三栏/分支图画布）网格底、等宽字、硬边

---

## 六、关键代码索引

| 模块 | 路径 |
|------|------|
| Git 运行器 | `packages/core/src/git/runner.ts` |
| Fetch / 鉴权 | `packages/core/src/git/fetch.ts`、`auth.ts` |
| 分支图 | `packages/core/src/graph/builder.ts` |
| 合并预演 | `packages/core/src/merge/preview.ts`、`rehearsal.ts` |
| 批量矩阵 | `packages/core/src/merge/survey.ts` |
| 顺序推演 | `packages/core/src/merge/chain.ts` |
| 一键落盘 | `packages/core/src/merge/applyResolve.ts` |
| 可插拔 resolver | `packages/core/src/merge/resolvers.ts` |
| 创建 MR | `packages/core/src/merge/createMr.ts`、`branchName.ts` |
| CLI | `packages/core/src/cli.ts` |
| MCP server | `packages/mcp/src/index.ts` |
| 宿主桥接 | `packages/extension/src/coreBridge.ts` |
| 冲突预警 | `packages/extension/src/mergeWatcher.ts` |
| 合并矩阵 UI | `packages/extension/webview/src/MergeMatrix.vue` |
| AI 选边 | `packages/extension/src/aiResolve*.ts` |
| 配置存储 | `packages/extension/src/gitConfigStore.ts` |
| 变更 UI | `packages/extension/webview/src/ConflictResolvePanel.vue` |
| 视觉 token | `packages/extension/webview/src/styles.css`（文件头有双主题约束） |
| 主题切换 | `packages/extension/webview/src/theme.ts` |

---

## 七、风险与约束

1. **into / from 不可填反**：左=线上（远程），右=我的
2. **目标分支仅远程**，本地互合同步不在本工具范围
3. **同名分支**（如 `master` ↔ `origin/master`）不预演、不申请 MR
4. 临时分支必须基于 **线上 into**，误从我的分支拉出再 merge 线上会左右对调
5. tip 变化后应重新预演再一键解决
6. 主工作区可有未提交改动（worktree 隔离）；同名临时分支已在主仓/其他 worktree 检出则拒绝
7. 冲突文件须全部有选边（或被 resolver 自动处理），否则 worktree 内 `--abort`
8. **resolver 配置绝不来自仓库内容**；**后台预警绝不弹弹登录框**

---

## 八、核心 Git 命令速查表

> 方便 Git 新人快速理解工具背后的操作。

| 场景 | Git 命令 |
|------|----------|
| 列所有 branch + upstream | `git for-each-ref --format='%(refname)%(refname:short)%(objectname)%(upstream:short)' refs/heads refs/remotes` |
| 列 commit DAG | `git rev-list --parents <shas...>` |
| 统计独有提交 | `git rev-list --count <base>..<sha>` |
| 公共祖先 | `git merge-base <a> <b>` |
| 冲突检测 | `git merge-tree --write-tree -z --messages --name-only <into> <from>` |
| 旧版 Git 冲突检测 | `git merge-tree <base> <into> <from>` |
| 读文件内容 | `git show <rev>:<path>` |
| 合并标记合成 | `git merge-file -p --diff3 -L ours -L base -L theirs <f1> <f2> <f3>` |
| 差异范围 | `git diff -U0 <base>...<tip> -- <path>` |
| blame 溯源 | `git blame -l -w -L<s>,<e> --line-porcelain <rev> -- <path>` |
| 游离 commit | `git commit-tree <tree> -p <p1> -p <p2> -m <msg>` |
| 建 worktree | `git worktree add -B <branch> <path> <sha>` |
| 清 worktree | `git worktree remove --force <path> && git worktree prune` |
| 列冲突文件 | `git diff --name-only --diff-filter=U` |
| abort merge | `git merge --abort` |
| 静默 fetch | `git fetch --prune <remote>` (GIT_TERMINAL_PROMPT=0) |
| 鉴权探测 | `git ls-remote --exit-code <remote> HEAD` |
| 仓库根目录 | `git rev-parse --show-toplevel` |

---

## 九、当前版本（2026-08-20）

| 组件 | 版本 | 发布渠道 |
|------|------|----------|
| 扩展 `git-insight` | 0.3.5 | Open VSX / Cursor 市场 |
| 引擎 `@shaohui_jin/git-insight-core` | 0.2.1 | monorepo 内 / CLI |
| MCP `@shaohui_jin/git-insight-mcp-server` | 0.2.1 | npm（CI 发版） |

> 本期（未发版候选）：候选人 5 分钟缓存 + skipCandidates 开关；矩阵多选 + into/from 隔离 + fillSuggested 覆盖式；toolbar 瘦身；链循环 guard；精准 platform 匹配；**移除 open_ui / open-ui 与浏览器 UI（含 uiServer、ws 依赖、webview 携带），MCP 不再耦合 extension**。详见 [roadmap.md](./roadmap.md)。

---

## 十、发布流程

### 10.1 扩展发布到 Open VSX / Cursor 市场

**前置条件**：
- 拥有 `jinshaohui` 命名空间在 Open VSX 的发布权限
- GitHub Secret `OVSX_PAT` 已配置（Open VSX Access Token）
- 本机安装了 `vsce` 和 `ovsx` CLI 工具

**自动发布（CI）**：
1. 修改 `packages/extension/package.json` 中的 `version` 字段
2. 推送到 `master` 分支
3. GitHub Actions `release-on-version.yml` 自动检测版本变化，执行构建 → 打包 VSIX → 发布到 Open VSX → 打 Git tag `v{version}`

**手动发布（本地）**：
```bash
# 1. 构建 webview（Vue 3 → 静态资源）
pnpm --filter @git-insight/webview run build

# 2. 构建扩展（esbuild → dist/extension.js + dist/cli.js）
pnpm --filter git-insight run build:ext

# 或一步到位
pnpm build

# 3. 打包 VSIX
pnpm --filter git-insight run package:vsix

# 输出到仓库根目录: git-insight.vsix

# 4. 本地安装测试
cursor --install-extension git-insight.vsix --force

# 5. 发布到 Open VSX（需 OVSX_PAT 环境变量）
pnpm --filter git-insight run publish:ovsx
# 等价于: ovsx publish ../../git-insight.vsix -p <OVSX_PAT>

# 6. 发布成功后打 Git tag
git tag -a v<version> -m "Release v<version>"
git push origin v<version>
```

**Cursor 市场自动同步**：Cursor 扩展市场以 Open VSX 为上游，发布到 Open VSX 后约 1-2 小时内自动同步到 Cursor 市场。用户可在 Cursor 扩展面板搜索 `Git Insight` 或 `jinshaohui.git-insight` 安装。

### 10.2 MCP Server 发布到 npm

**前置条件**：
- 拥有 `@shaohui_jin` scope 在 npm 的发布权限
- 已登录 npm：`npm login` 并配置 `npm whoami` 验证
- GitHub Secret `NPM_TOKEN` 已配置（npm Automation Token）

**自动发布（CI）**：
1. 修改 `packages/mcp/package.json` 中的 `version` 字段
2. 推送到 `master` 分支（或 `workflow_dispatch` 手动触发）
3. GitHub Actions `release-mcp-server.yml` 自动检测版本变化，执行构建 → 发布到 npm → 打 Git tag `mcp-server-v{version}`

**手动发布（本地）**：
```bash
# 1. 先检查 npm 登录状态
npm whoami

# 2. 构建 core 引擎（MCP 依赖 core，需先构建）
pnpm --filter @shaohui_jin/git-insight-core build

# 3. 构建 webview（扩展面板，MCP 不需要但 workspace 构建流程会引用）
pnpm --filter git-insight build:webview

# 4. 构建 MCP 包（esbuild → dist/index.js）
pnpm --filter @shaohui_jin/git-insight-mcp-server run check
pnpm --filter @shaohui_jin/git-insight-mcp-server run build

# 5. npm 发布前 dry-run 确认
npm publish --dry-run --access public --prefix "packages/mcp"

# 6. 正式发布
npm publish --access public --prefix "packages/mcp"

# 7. 发布成功后打 Git tag
git tag -a mcp-server-v<version> -m "Release MCP server v<version>"
git push origin mcp-server-v<version>
```

**用户接入方式**（在项目 `.cursor/mcp.json` 或全局配置中添加）：
```json
{
  "mcpServers": {
    "git-insight": {
      "command": "npx",
      "args": ["-y", "@shaohui_jin/git-insight-mcp-server@latest"]
    }
  }
}
```

环境变量配置：
- `GIT_INSIGHT_MCP_CWD`：可选，指定工作目录；fallback 链：请求里传 `cwd` > `GIT_INSIGHT_MCP_CWD` > `process.cwd()` > 向上找 `.git`
- `GIT_INSIGHT_MCP_ALLOW_WRITE=1`：启用写操作（apply-resolve / create-mr），默认只读

### 10.3 monorepo 构建命令速查

| 命令 | 作用 |
|------|------|
| `pnpm install` | 安装所有依赖 |
| `pnpm build` | 构建 extension（webview + ext 一起） |
| `pnpm --filter @shaohui_jin/git-insight-core build` | 仅构建 core 引擎 |
| `pnpm --filter @git-insight/webview run build` | 仅构建 webview（Vue 3 静态资源） |
| `pnpm --filter git-insight run build:ext` | 仅构建扩展（esbuild 打包 extension.js） |
| `pnpm --filter git-insight run package:vsix` | 打包 VSIX |
| `pnpm --filter git-insight run publish:ovsx` | 发布到 Open VSX |
| `pnpm --filter @shaohui_jin/git-insight-mcp-server run build` | 构建 MCP server |
| `pnpm --filter @shaohui_jin/git-insight-mcp-server run check` | TypeScript 类型检查 MCP |
| `pnpm --filter @git-insight/webview run dev` | webview 开发模式（watch 模式） |

### 10.4 发布注意事项

1. **版本号递增规则**：遵循 semver，修改 `package.json` 中的 `version` 字段
2. **tag 即已发布**：tag 在发布成功后才打，任何一步失败都可原样重试，不会浪费版本号
3. **扩展与 MCP 版本独立**：扩展 tag `v{version}`，MCP tag `mcp-server-v{version}`，互不抢占
4. **VSIX 不得引用 ws 模块**：构建脚本 `bundle.mjs` 会检查 `extension.js` 是否引用了 `ws`，请确保扩展代码避免引入 ws 依赖
