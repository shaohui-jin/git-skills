# Git Insight · 技术分享与操作手册

> **本文是仓库唯一完整说明。** 面向日常操作与技术分享：先讲主流程，再按模块列出实际调用的 `git` / `gh` / `glab` 指令，最后是核心实现与 Agent Skill。

---

## 目录

1. [主流程梳理](#一主流程梳理)
2. [各模块操作与实际指令](#二各模块操作与实际指令技术分享)
3. [核心模块实现说明](#三核心模块实现说明)
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

安装后 **Reload Window**，命令面板：

- `Git Insight: Open Web Visualization` — 打开面板（默认 **Git 配置**）
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
| 探测平台 | `git remote get-url origin` → 解析 GitHub / GitLab |
| 检测 CLI | `gh --version` / `glab --version` |
| 登录状态 | `gh auth status` / `glab auth status` |
| 唤起登录 | 集成终端：`gh auth login` 或 `glab auth login`（扩展内二进制用 PowerShell `& "path" auth login`） |
| Token 校验（C） | GitHub `GET https://api.github.com/user`（Bearer）；GitLab `GET <origin>/api/v4/user` + `personal_access_tokens/self` |
| 浏览器（D） | 根据 remote URL 拼创建页 → `openExternal` |

代码：`packages/extension/src/gitConfigStore.ts`、`cliBundle.ts`、`webview/.../GitConfigPanel.vue`。

---

### 2.2 Fetch（分支图 / 预演 / 手动 Fetch）

**操作要点**

加载分支图、合并预演默认会先 fetch；顶栏也可点「Fetch」。

**核心指令**

```bash
git fetch --prune --progress origin
```

**鉴权（仅本机 Git，不用方案 C Token）**

Token **不参与** fetch（不能替代本机 Git 登录拉代码）；仅用于一键申请 MR。

直接走本机 Git 凭据，**允许弹窗登录**（与 WebStorm 类似；已有缓存凭据时通常不会弹窗）。

| UI 状态 | 含义 |
|---------|------|
| `（已 fetch）` | 本次成功，远程跟踪分支已刷新 |
| `（fetch 失败，可能与线上不一致）` | fetch 失败，图来自本地旧 refs |
| `（未 fetch）` | 请求带了 `noFetch` / CLI `--no-fetch` |

代码：`packages/core/src/git/fetch.ts`；扩展侧不再把 Token 传入 fetch。

---

### 2.2.1 分支协议（短名 + gitRef）

宿主列出分支时**不改写**磁盘 refs，只发结构化字段：

| 字段 | 含义 | 示例（本地 `main`） | 示例（远程） |
|------|------|---------------------|--------------|
| `name` | 短名（无 remote 前缀） | `main` | `feature/x` |
| `remote` | 是否 `refs/remotes` | `false` | `true` |
| `remoteName` | 远程名（仅远程） | — | `origin` |
| `gitRef` | git 操作身份 | `main` | `origin/feature/x` |

- **UI 树**：本地 / 远程分组，路径按短名 `name` 分层（远程叶子挂在 `origin` 下显示 `feature/x`）
- **预演 / 一键解决**：请求里的 `into` / `from` 传 **`gitRef`**
- **申请 MR**：API 的 source/target 用短名（`branchNameForMr(gitRef)` 去掉 `origin/` 等前缀；实现见 `packages/core/src/merge/branchName.ts`）
- 同名本地与 `origin/同名` 靠 `gitRef` + `remote` 区分，不再把 `origin/xxx` 当作唯一协议形态

代码：`packages/extension/src/coreBridge.ts`（`listBranchNames`）、`webview/.../branchTree.ts`、`packages/core/src/merge/branchName.ts`。

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

**实际指令**

| 用途 | 指令 |
|------|------|
| 预演合并树 | `git merge-tree --write-tree -z --messages --name-only [--allow-unrelated-histories] <intoSha> <fromSha>` |
| 旧版 fallback | `git merge-tree <base> <intoSha> <fromSha>` |
| 读一侧文件 | `git show <rev>:<path>` |
| 合成冲突标记 | `git merge-file -p --diff3 -L ours:… -L base -L theirs:…` |
| 路径是否存在 | `git cat-file -e <rev>:<path>` |
| 差异范围 | `git diff -U0 <base>...<tip> -- <path>` |
| 行级溯源 | `git blame -l -w -L<start>,<end> --line-porcelain <rev> -- <path>` |
| （可选）关联 PR | `gh pr list --search <sha7> --state all --json number --limit 1`（失败静默） |

空 tree 常量：`4b825dc642cb6eb9a060e54bf8d0927f6fb5fb496`（不现场 `hash-object`）。

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

代码：`packages/extension/src/aiResolve*.ts`、`webview/.../AiResolveDialog.vue`。

---

### 2.6 一键解决并推送（独立 worktree）

**操作要点**

宿主确认后，在**独立 worktree**完成 merge / 写文件 / commit / push，**主工作区不 checkout**。

**实际指令**

| 步骤 | 指令 |
|------|------|
| 建 worktree + 临时分支 | `git worktree add -B <tempBranch> <wtPath> <intoSha>` |
| 同向 merge（停在冲突） | `git merge --no-ff --no-commit <fromSha>` |
| 列出未合并 | `git diff --name-only --diff-filter=U` |
| 写入选边正文 | 写文件 + `git add -- <path>` |
| 提交 | `git commit -m <msg>` |
| 读 SHA | `git rev-parse HEAD` |
| 推送 | `git push -u <remote> HEAD:refs/heads/<tempBranch>` |
| 失败回滚 | `git merge --abort` |
| 清理 | `git worktree remove --force <wtPath>` + `git worktree prune` |

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

**公共 git**

| 用途 | 指令 |
|------|------|
| 远程 URL | `git remote get-url <remote>` |
| 本地分支是否存在 | `git show-ref --verify --quiet refs/heads/<name>` |
| 远程分支 | `git show-ref --verify --quiet refs/remotes/<remote>/<name>` |

**GitHub · gh**

| 用途 | 指令 |
|------|------|
| 版本 / 登录 | `gh --version`；`gh auth status` |
| 协作者（审阅人） | `gh api repos/<owner>/<repo>/collaborators?per_page=100`，仅保留 **admin / maintain**（不含 write；write 无法合保护分支） |
| 建 PR | `gh pr create --base <tgt> --head <src> --title … --body … [--reviewer a,b]` |

**GitLab · glab**

| 用途 | 指令 |
|------|------|
| 版本 / 登录 | `glab --version`；`glab auth status` |
| 成员（审阅人） | `glab api projects/<encoded>/members/all?per_page=100`，仅 **Maintainer+**（`access_level >= 40`，含 Owner） |
| 建 MR | `glab mr create --source-branch … --target-branch … --title … --description … --yes [--reviewer x]…` |

**Token（C）**：GitHub REST `collaborators` / `pulls`（审阅人同样仅 admin/maintain）；GitLab `members/all` + `merge_requests`（审阅人同样 Maintainer+）。  
**浏览器（D）**：拼创建页 URL → `openExternal`。

源/目标分支名提交给平台前都会经 `branchNameForMr` 去掉 remote 前缀（实现：`packages/core/src/merge/branchName.ts`）。

代码：`packages/core/src/merge/createMr.ts`；UI：`CreateMrDialog.vue`。

---
### 2.8 打开远程仓库（扩展）

| 用途 | 指令 |
|------|------|
| 克隆 | `git clone -- <url> <dir>` |
| 已有缓存更新 | `git fetch --all --prune` |

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

底层：`packages/core/src/git/runner.ts`（默认非交互；`interactive: true` 时允许弹窗）。

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

打包：`pnpm package:vsix` → `git-insight.vsix`。

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

### 5.2 CLI 速查

```text
git-insight graph [--cwd] [--max] [--into] [--from] [--no-fetch]
git-insight fetch [--cwd] [--remote]
git-insight preview-merge --into <线上目标> --from <我的分支> [--cwd] [--no-fetch]
git-insight conflict-blame …   # 同 preview-merge
```

### 5.3 与 WebStorm 的差异（Fetch）

WebStorm 默认允许交互取凭据。本扩展 fetch 同样直接允许弹窗登录（已有本机凭据时通常不弹）。方案 C Token 不参与 fetch。

---

*行为变更时请同步更新本文。Skill / 根 README / 各包 README 均指向本文。*
