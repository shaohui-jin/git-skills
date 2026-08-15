# Git Insight · 用户手册 + 技术分享

> 面向日常用户：能按这个文档把工具用起来；协作者也能从实现细节快速接手维护。

## 一、产品架构

### 1.1 四个包的职责

```text
packages/core                  @git-insight/core    唯一 Git 引擎 + CLI（不单独发版）
packages/mcp                   @git-insight/mcp-server  MCP server（stdio）
packages/extension             git-insight           Cursor/VS Code 宿主
packages/extension/webview     Vue3 UI               同一套 Webview，扩展 / 浏览器共用
```

| 包 | 职责 |
|----|------|
| **core** | `runGit` / fetch / 分支图 / merge-tree 预演 / 批量矩阵 / 顺序推演 / worktree 落盘 / gh·glab·Token 建 MR + CLI |
| **mcp** | stdio MCP server；默认只读，写操作需 `GIT_INSIGHT_MCP_ALLOW_WRITE=1` + `confirm: true` |
| **extension** | Webview 桥接、确认框、globalState 配置、CLI 下载、终端登录、AI 选边桥、冲突预警常驻、Skill 同步 |
| **webview** | 分支树、G6 图、合并矩阵、冲突三栏、Git 配置、MR 对话框、深浅双主题 token；不直接 spawn git |

### 1.2 只读保证

预演全靠 `git merge-tree`，结果树只在对象库里流转，不建分支、不改工作区。仅 `apply-resolve` / `create-mr` 写仓库，且走独立 worktree 或远程 API。

前置：系统 Git ≥ 2.38（`merge-tree --write-tree`）。

### 1.3 推荐使用流程

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

## 三、MCP 浏览器面板 + npm 发版

### 3.1 auto 唤起流程

```text
open_ui(into, from, cwd?, mode=auto)
        │
        ├─ mode=extension ──► vscode://jinshaohui.git-insight/preview?…
        │
        ├─ mode=browser ────► http://127.0.0.1:17341/?into=…&from=…&cwd=…&tab=preview
        │
        └─ mode=auto（默认）
              ├─ ① cursor --open-url 打开 vscode://…
              │      └─ 成功 → 扩展面板（现有行为）
              └─ ② 失败 → startUiServer(17341) + 打开浏览器 URL
                     └─ Webview 读 query，等价 seedPreview + 自动预演
```

#### CLI 命令对比（唤起）

```bash
# 直接让 cursor 打开（优先）
cursor --open-url vscode://jinshaohui.git-insight/preview?into=…&from=…
cursor vscode://jinshaohui.git-insight/preview?into=…&from=…

# Windows 下让系统默认浏览器打开 URL

pwsh -NoProfile -Command "Start-Process 'http://127.0.0.1:17341/...'"
powershell -NoProfile -Command "Start-Process 'http://127.0.0.1:17341/...'"

# macOS
open http://127.0.0.1:17341/

# Linux
xdg-open http://127.0.0.1:17341/

# MCP fallback：startUiServer 固定 17341 端口，同 key 只 listen 一次
export uiServer.ts → createServer + WebSocketServer({ server, path: "/ws" })
export stopUiServer → 关闭 wss + httpServer，释放端口
```

> **注意**：windowsHide:true + shell:false + detached:true，无 cmd 弹窗。

### 3.2 opensUiServer 固定端口单例

```typescript
// 同 host+port+webRoot 的重复调用直接返回已有实例
// 多个 open_ui → 只 listen 一次
startUiServer({ webRoot, port, initialCwd, onRequest }) → Promise<UiServerHandle>

// 清理
stopUiServer() → Promise<void>  // 关 wss + httpServer，释放端口
```

### 3.3 浏览器 vs 扩展（v1）

| 能力 | 扩展 | 浏览器 |
|------|------|--------|
| 配置 / 分支图 / 矩阵 / 预演 / 三栏 / 一键解决 / MR | ✅ | ✅ |
| Git 配置持久化 | globalState | 内存（浏览器 Phase 2 可 localStorage） |
| AI 选边 | ✅ | 暂不支持 |
| 冲突预警状态栏 | ✅ | ❌ |
| 选本地目录 | VS Code 对话框 | 路径输入 / GitHub URL |

UI **同一套**（`packages/extension/webview` + `coreBridge.handleWebviewRequest`），浏览器侧靠 WebSocket 桥接，不是第二套。

### 3.4 npm 发版流程

| | 扩展 `git-insight` | MCP `@git-insight/mcp-server` |
|--|-------------------|-------------------------------|
| 版本文件 | `packages/extension/package.json` | `packages/mcp/package.json` |
| Git tag | `v{version}` | `mcp-server-v{version}` |
| CI | `release-on-version.yml` | `release-mcp-server.yml` |
| Secret | `OVSX_PAT` | `NPM_TOKEN` |

CI 触发：推 `master` 且 `packages/mcp/**` 或 `core/**` 改动（或 `workflow_dispatch`）。是否发布以**远程是否已有 `mcp-server-v{version}` tag** 为准（"tag 代表已发布"），前置任何一步挂了都可原样重试。

#### 本地 dry-run 命令

```bash
npm whoami
npm access ls packages @git-insight
npm publish --dry-run --access public --prefix "packages/mcp"
```

#### scope 备选

scope `@git-insight` 不可用时改用 `@<npm-username>/mcp-server`。

### 3.5 用户接入（用户自己的 .cursor/mcp.json）

```json
{
  "mcpServers": {
    "git-insight": {
      "command": "npx",
      "args": ["-y", "@git-insight/mcp-server@latest"]
    }
  }
}
```

`GIT_INSIGHT_MCP_CWD` 现**已可选**；fallback 链：请求里传 `cwd` > `GIT_INSIGHT_MCP_CWD` 环境变量 > `process.cwd()` > 向上找 .git。

---

## 四、Agent Skill (`/git-branch-insight`)

装扩展即自动同步到 `~/.cursor/skills/git-branch-insight/`；任意仓库 Agent 输入 `/git-branch-insight` 再说需求即可。

Skill `open-ui` 与 MCP `open_ui` 共用 `openInsightUi()`，auto fallback 链相同。

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
| 唤起面板 | `packages/core/src/ui/openPanel.ts`、`uiServer.ts` |
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

## 九、当前版本（2026-08-15）

| 组件 | 版本 | 发布渠道 |
|------|------|----------|
| 扩展 `git-insight` | 0.3.0 | Open VSX / Cursor 市场 |
| 引擎 `@git-insight/core` | 0.1.0 | monorepo 内 / CLI |
| MCP `@git-insight/mcp-server` | 0.1.0 | npm（CI 发版） |

> 本期（未发版 0.3.1 候选）：候选人 5 分钟缓存 + skipCandidates 开关；矩阵多选 + into/from 隔离 + fillSuggested 覆盖式；toolbar 瘦身；stopUiServer 清理；链循环 guard；精准 platform 匹配；openPanel PowerShell 修复。详见 [roadmap.md](./roadmap.md)。
