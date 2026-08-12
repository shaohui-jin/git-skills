# Git Insight · 技术分享与操作手册

> **本文是仓库唯一完整说明。** 面向日常操作与技术分享：先讲主流程，再按模块列出实际调用的 `git` / `gh` / `glab` 指令，最后是核心实现与 Agent Skill。

---

## 目录

1. [主流程梳理](#一主流程梳理)
2. [各模块操作与实际指令](#二各模块操作与实际指令技术分享)
3. [核心模块实现说明](#三核心模块实现说明)（含 [发布到 Cursor 市场](#36-发布到-cursor-市场open-vsx)）
4. [Skill 说明](#四skill-说明)
5. [附录：指令一览、FAQ 与命令速查](#五附录指令一览faq-与命令速查)
   - [5.1 Cursor 扩展指令](#51-cursor-扩展指令命令面板--uri)
   - [5.2 Skill / CLI 指令](#52-skill--cli-指令)
   - [5.3 扩展 ↔ Skill 能力对照](#53-扩展--skill-能力对照)
   - [5.4 FAQ](#54-faq)
   - [5.5 CLI 一行速查](#55-cli-一行速查git-insight-封装)

---

## 一、主流程梳理

### 1.1 产品定位

| 能力 | 交付面 | 是否改工作区 |
|------|--------|--------------|
| 分支图 / 合并预演 | Agent Skill（`/git-branch-insight`）+ 扩展 Webview | **否**（`merge-tree` 等只读） |
| 冲突选边 / AI 选边 | 扩展 Webview；Skill 对话确认 | 否（仅 UI / 暂存） |
| 一键解决并推送 | 扩展或 Skill → core `apply-resolve` | **是**（独立 **worktree**，主工作区不 checkout） |
| 一键申请 MR/PR | 扩展或 Skill（cli / token / ui）→ core | 否（`gh` / `glab` / Token API / 浏览器） |

前置：**系统 Git ≥ 2.38**（依赖新版 `merge-tree --write-tree`）。

### 1.2 业务角色（勿填反）

业务上是把**我的分支**合进**线上目标**（再提 MR）。本工具面向 **MR/PR 流程**，不是本地 `pull` / `merge` 替代品。

| 业务称呼 | UI | 变量 | 预演三栏 | 可选范围 |
|----------|-----|------|----------|----------|
| **线上 / 合入目标**（如 `origin/test`） | 目标分支 | `into` | **左栏** | **仅远程**跟踪分支 |
| **我的分支 / 待合入**（如 `feature/xxx`） | 我的分支 | `from` | **右栏** | 本地或远程均可 |

排错对照：站在线上分支上 `merge` 我的分支时，git 的 **ours = 线上(into)**、**theirs = 我的(from)**。口语「我的=ours」容易和 git 叫反，界面只用「线上 / 我的」。

**同名分支不处理**

规范化短名相同（`branchNameForMr` / `isSameBranchForMr`）时——例如本地 `master` 与 `origin/master`——**不预演、不推临时分支、不申请 MR**。这类同步请自行 `git push` / `git pull`。

### 1.3 推荐使用顺序

```text
① Git 配置（选 A / B / C / D）
② 分支图（默认先 fetch，与线上对齐）
③ 合并预演（远程「线上目标」+「我的分支」→ 冲突选边 / AI 选边）
④ 有冲突 →「一键解决并推送」
⑤ 「一键申请 MR」
```

```mermaid
flowchart TD
  cfg[Git 配置 A/B/C/D] --> graph[分支图 · 默认 fetch]
  graph --> preview[合并预演 远程into / 我的from]
  preview -->|同名分支| skip[自行 push / pull]
  preview --> stash[三栏选边 / AI 选边]
  stash --> resolve[一键解决并推送 · 独立 worktree]
  resolve --> mr[一键申请 MR]
  preview -->|干净合并且不同名| mr
```

| 场景 | 能否申请 MR |
|------|-------------|
| 目标不是远程分支 | 否（选择器已过滤本地） |
| 源/目标规范化后同名 | 否（自行 push / pull） |
| 预演有冲突 | 须先「一键解决并推送」成功 |
| 预演可干净合并且不同名 | 可直接申请（源一般为已推送的我的分支） |

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

安装后 **Reload Window**，命令面板（`Ctrl+Shift+P` / `Cmd+Shift+P`）搜 **Git Insight**：

| 面板标题 | 命令 ID | 作用 |
|----------|---------|------|
| Git Insight: Open Web | `gitInsight.openWeb` | 打开面板（默认 **Git 配置** Tab） |
| Git Insight: 合并预演 | `gitInsight.previewMerge` | 打开面板并切到 **合并预演** |
| Git Insight: 打开预演（可带 into/from） | `gitInsight.openPreview` | 打开预演；可种入 `into` / `from` / `cwd`，并默认自动跑预演（Skill / URI 用） |
| Git Insight: 同步 Agent Skill 到全局 | `gitInsight.syncSkill` | 把 `/git-branch-insight` 写到用户 Skill 目录（启动时也会自动同步） |

> **只有一条「合并预演」**：旧命令 `gitInsight.conflictBlame`（面板曾显示「合并预演（兼容）」）已移除，勿再依赖。完整 URI / CLI 清单见 [§五](#五附录指令一览faq-与命令速查)。

面板顶部输入本机仓库路径或 GitHub `owner/repo`，点「打开」。

**Agent Skill（装扩展即有）：** Reload 后扩展会把 Skill 同步到 `~/.cursor/skills/git-branch-insight/`（及 `~/.agents/skills/…`），并写入自带 CLI 路径。任意仓库 Agent 输入 `/git-branch-insight` 再说需求即可。详见 [§四](#四skill-说明)。

> 浏览器 `pnpm preview` 仅看 UI：**不能**写仓库 / 推送 / 申请 MR。

---

## 二、各模块操作与实际指令（技术分享）

下列指令为代码中**真实 argv**（经 `spawn("git"|"gh"|"glab", …)` 或集成终端 `sendText`）。

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

**默认远程**（同页，与 A–D 并列配置）：

| 项 | 说明 |
|----|------|
| 字段 | 全局配置 `defaultRemote`（默认偏好名，如 `origin`） |
| UI | 左侧「MR 方式」卡片顶部紧凑条：下拉 + 当前 remote 的 fetch URL（ellipsis）；AI 选边默认折叠 |
| 加载 | 进入配置页 / 打开仓库时执行 `git remote -v` |
| 下拉 | 仅列出当前仓库实际 remotes；切换即保存 |
| 无仓库 / 无 remote | 条内红色短提示，请先打开仓库 |
| 回退 | 配置名不在仓库 remotes 中 → `origin`（若有）→ 列表第一项 |
| 用途 | fetch、分支图「本地↔默认远程」合并、MR 短名剥前缀、平台探测 URL |
| CLI 镜像 | 扩展保存/加载时写入 `~/.git-insight/user-config.json`；CLI 未传 `--remote` 时读取（可用 `GIT_INSIGHT_DEFAULT_REMOTE` / `GIT_INSIGHT_USER_CONFIG` 覆盖） |

<img src="https://shaohui-jin.github.io/picx-images-hosting/git-skill/image.8adz6x3r82.webp" style="height: 100px" />
<img src="https://shaohui-jin.github.io/picx-images-hosting/git-skill/image.1sfrdlv94y.webp" style="height: 100px" />
<img src="https://shaohui-jin.github.io/picx-images-hosting/git-skill/image.2ksmvcfjen.webp" style="height: 100px" />

**AI 选边（模型）**（同页下方，可选，与 A–D 无关）：

| 项 | 说明 |
|----|------|
| 作用 | 合并预演冲突面板点「AI 选边」时的**模型回退**配置 |
| 是否必填 | **否**。不用 AI、或宿主 `vscode.lm` / Chat 桥够用时可不填 |
| 字段 | Base URL、API Key、模型名（OpenAI 兼容：官方 API / 代理 / 本地 Ollama） |
| 生效条件 | Base URL + 模型名必填；云端还需 API Key；`localhost` / `127.0.0.1` 可留空 Key |
| 调用顺序 | 见 §2.5：优先 `vscode.lm` → 本配置 → Cursor Chat 本地回传桥 |
| Ollama 示例 | Base URL=`http://127.0.0.1:11434/v1`，模型=`qwen2.5-coder`，Key 留空 |

默认会预填 `https://api.openai.com/v1` + `gpt-4o-mini`；**未填 Key 时不会调用 OpenAI**，会落到 Chat 桥。

配置**双写 / 三写**（各仓库共用同一套 Token / MR 方式 / 默认远程 / AI 模型配置）：

| 位置 | 键 / 路径 |
|------|-----------|
| 扩展 `globalState` | `gitInsight.userConfig` |
| 扩展 `globalStorage` | `user-config.json` |
| 用户家目录（供 CLI） | `~/.git-insight/user-config.json` |

**实际指令 / 行为**

| 用途 | 指令 / 行为 |
|------|-------------|
| 列远程 | `git remote -v` → 配置页下拉 + 解析默认远程 URL |
| 探测平台 | 默认远程的 fetch URL → 解析主机名（含 `github` / `gitlab` / `git.`） |
| 检测 CLI | 打开仓库时对系统/扩展内 `gh`·`glab` 做 `--version` + `auth status`；**四路 `Promise.all` 并行** |
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
**工作区 fetch**（分支图 / 预演 / 手动）：只用本机 Git 凭据，**允许弹窗**；


<img src="https://shaohui-jin.github.io/picx-images-hosting/git-skill/image.5j4wyupdgx.webp" style="height: 100px" />
<img src="https://shaohui-jin.github.io/picx-images-hosting/git-skill/image.pg22q5jlh.webp" style="height: 100px" />

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
- **合并预演 · 目标分支**：仅远程（`BranchTreeSelect` 的 `remoteOnly`）；待合并分支可选本地或远程
- **预演 / 一键解决**：`into` / `from` 传 **`gitRef`**
- **申请 MR**：source/target 用短名（`branchNameForMr`）；同名判定见 `isSameBranchForMr`（`merge/branchName.ts`）

代码：`packages/extension/src/coreBridge.ts`（`listBranchNames`）、`webview/.../branchTree.ts`、`BranchTreeSelect.vue`。

---
### 2.3 分支图

**操作要点**

1. 点「加载分支图」（扩展默认全量 tip，`maxNodes: 0`）
2. 节点标签为**短分支名**（如 `foo`，不写 `origin/foo`）；颜色区分本地 / 各 remote
3. **合并展示**：本地与**默认远程**同短名且 tip sha 相同 → 只画一个节点（默认远程色）；sha 不一致则仍画两条
4. 其它 remote 各自成点；右上角（搜索下方）色块图例：本地 + 各 remote 名
5. 边从左到右表示「较近 tip 祖先 → 子分支」（不是完整 commit 链）
6. 点击 tip：高亮到根源链路，右侧出链路报告；底部仅保留操作说明
7. Ctrl+F 或「搜索节点」：按分支名 / sha 定位

**注意：** fetch 更新默认远程下的跟踪分支；**本地 tip 不会因 fetch 自动快进**。默认远程在 §2.1 配置。

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

### 2.4 合并预演

<img src="https://shaohui-jin.github.io/picx-images-hosting/git-skill/image.msiplcgy.webp" style="height: 100px" />
<img src="https://shaohui-jin.github.io/picx-images-hosting/git-skill/image.86ud97qygk.webp" style="height: 100px" />

**操作要点**

1. 选线上目标 + 我的分支 →「开始预演」
2. 冲突三栏：左=线上、右=我的；采用线上 / 我的，或 AI 选边
3. 「一键解决并推送」前会写入 localStorage 暂存（键含 cwd + into + from）
4. 预演本身**不改工作区**

**冲突解决面板（Webview）**

| 项 | 说明 |
|----|------|
| 三栏含义 | 左=线上目标（into）、中=结果、右=我的分支（from） |
| 左侧「冲突文件」 | **仅列出有红块（需手选）的文件**；上行：文件名 + 右对齐角标 `已解决/冲突数`；**选中行第二行** secondary「线上 / 我的」整文件选边 |
| 「仅自动合并（N）」 | 折叠分组：无冲突红块、只有绿/蓝自动变更的文件；角标 `NΔ`（Δ=自动变更数）。默认折叠，可展开查看 |
| 为何还有 `NΔ` 文件 | `merge-tree` 可能仍报该路径，但三方 diff 后无需手选；**一键解决仍会写入这些文件**，并非目录错误 |
| 文件内导航 | 「↑ 上一处 / ↓ 下一处」：在当前文件的冲突块间跳转（优先未解决） |
| 文件间导航 | 左侧列表头 `‹ n/N ›`：**只在有冲突红块的文件间**循环跳转（不进入「仅自动合并」列表） |
| 整文件选边 | 选中文件第二行「线上 / 我的」：该文件全部冲突块采用对应侧 |
| 冲突块选边 | 主工具条「采用线上 / 采用我的」：仅作用于当前冲突块 |
| 代码 | `webview/src/ConflictResolvePanel.vue`、`conflict/buildChangeHunks.ts` |

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

空 tree 常量：`4b825dc642cb6eb9a060e54bf8d69288fbee4904`（不现场 `hash-object`；见 `core/src/git/constants.ts`）。  
前置：`git --version` ≥ 2.38（`merge-tree --write-tree`）。

CLI：

```bash
git-insight preview-merge --into develop --from feature/x
git-insight preview-merge --into develop --from origin/feature/x --no-fetch
# CLI 旧名别名（等同 preview-merge；命令面板无对应项）
git-insight conflict-blame --into <线上> --from <我的>
```

代码：`merge/preview.ts`、`merge/rehearsal.ts`、`merge/blame.ts`、`merge/conflictContent.ts`；面板 UI 见上表与 `ConflictResolvePanel.vue`。

**冲突暂存（无 git）**

| 项 | 说明 |
|----|------|
| 存储 | Webview `localStorage` |
| 键 | `git-insight:merge-resolve:v1:{cwd}\0{into}\0{from}` |
| 内容 | choices + `resolvedContent` |
| 代码 | `webview/src/conflict/resolveStore.ts` |

---

### 2.5 AI 选边

**操作要点**

1. 勾选规则：默认偏我的 / 偏线上（互斥）、新覆盖旧、可合并则合并；可填额外说明
2. 裁决优先级：额外说明 → 新覆盖旧 → 可合并则合并 → 偏我的/偏线上 → 否则 pending
3. 模型路径（按序尝试，见下表）
4. Chat 桥：冲突数据写入临时 JSON，提示词只引用路径；超长自动分批（约 25 块 / 8 万字符）
5. **须人工核对**后再推送 / 申请 MR

**模型路径**

| 优先级 | 路径 | 何时走这条 |
|--------|------|------------|
| 1 | 宿主 `vscode.lm` | Cursor / VS Code 能选出 Chat 模型 |
| 2 | Git 配置「AI 选边（模型）」 | `vscode.lm` 不可用，且已配齐 OpenAI 兼容接口（见 §2.1） |
| 3 | Cursor Chat 回传桥 | 前两步都不可用；打开 Chat（**须 Agent 模式**），粘贴提示词后回传 JSON |

说明：

- 「AI 选边（模型）」是**可选回退**，不是申请 MR 的前置；只影响冲突面板的「AI 选边」
- Cursor 里 `vscode.lm` 经常拿不到模型，配 API / Ollama 可减少对 Chat 桥的依赖
- 仅手动选边、不用 AI 时，可不配置该区块

**回传约定**

| 方式 | 说明 |
|------|------|
| A（首选） | Agent 把结果 JSON 写入临时目录里的 `result*.json`，扩展用 `fs.watch` + 800ms 轮询监听 |
| B（兜底） | POST 到本机 `http://127.0.0.1:<port>/result/<secret>`；提示词按平台给 PowerShell 或 bash 写法 |

只有这两条通道，都没走通就等于没交付；因此**必须用 Agent 模式**，普通 Ask 会话既不能写文件也不能跑终端。若配置了 **MCP feedback** 等旁路，Agent 可能停在确认上，需要催它继续写结果文件。

Windows 注意：PowerShell 里 `curl` 是 `Invoke-WebRequest` 的别名，直接用会报 `CannotConvertArgumentTypeToMessage`；提示词已按平台分叉给 `Invoke-RestMethod`。

单批等待上限 20 分钟。分批时**某批失败只把该批的块标成 `pending`**，其余批次已拿到的裁决会保留；只有用户主动取消才会中断整轮。临时 `conflicts` / `prompt` / `result` 文件在回传、超时或取消后连目录一起删除。

**实际指令：** 本功能**不调用** `git` / `gh` / `glab`（只读预演结果 + 本地模型/HTTP）。

代码：`packages/extension/src/aiResolve*.ts`、`aiResolveLm.ts`、`webview/.../AiResolveDialog.vue`、`GitConfigPanel.vue`。

---

### 2.6 一键解决并推送（独立 worktree）

<img src="https://shaohui-jin.github.io/picx-images-hosting/git-skill/image.41yrx3u0dl.webp" style="height: 100px" />
<img src="https://shaohui-jin.github.io/picx-images-hosting/git-skill/image.2dpezx6oyk.webp" style="height: 100px" />

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

<img src="https://shaohui-jin.github.io/picx-images-hosting/git-skill/image.et89l2gkr.webp" style="height: 100px" />
<img src="https://shaohui-jin.github.io/picx-images-hosting/git-skill/image.362ahnpqqo.webp" style="height: 100px" />


**操作要点**

1. 依赖配置就绪（A/B 已登录，或 C Token 有效，或 D）
2. **into 须为远程**；`branchNameForMr(into) === branchNameForMr(from)` 时拒绝（提示自行 push / pull）
3. 有冲突须先「一键解决并推送」成功；干净合并且不同名可直接申请
4. MR 方向：临时分支（或我的分支）→ **线上目标（into 短名）**
5. 对话框多选 = **指派人 + 审核人**（同一批人两种角色；指派有邮件提醒）

源/目标分支名经 `branchNameForMr` 去掉 `origin/` 等前缀；同名拦截见 `isSameBranchForMr`（`merge/branchName.ts`）。GitHub Token 建 PR 失败时会附带 API `errors[]` 详情。

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
skills/git-branch-insight     Agent Skill 仓库副本（与 .cursor/skills 同步）
packages/extension/skills/…  打进 VSIX；启动时同步到用户全局 Skill 目录
docs/guide.md                 本文（唯一完整说明）
```

| 包 | 职责 |
|----|------|
| **core** | `runGit` / fetch / 分支图 / merge-tree 预演 / worktree 落盘 / gh·glab·Token 建 MR + CLI |
| **extension** | Webview 桥接、确认框、globalState 配置、CLI 下载、终端登录、AI 选边桥、**Skill 全局同步** |
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

CLI 另含写操作（供 Skill 闭环，须用户确认后调用）：

```bash
pnpm --filter @git-insight/core exec node dist/cli.js apply-resolve --into <线上> --from <我的> --stash stash.json
pnpm --filter @git-insight/core exec node dist/cli.js prepare-mr --into <线上> --from <我的>
pnpm --filter @git-insight/core exec node dist/cli.js create-mr --source <源> --target <目标> --method cli
pnpm --filter @git-insight/core exec node dist/cli.js open-ui --into <线上> --from <我的>
```

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
| Git 配置 | A–D、Token、下载 CLI、登录、AI 模型回退 | `getGitConfig` / `saveGitConfig` / `downloadCli` / `cliAuthLogin` |
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
| Skill 入口 | 扩展 `skills/git-branch-insight`（装完同步到 `~/.cursor/skills`）· 仓库副本见 §四 → 本文 §四 |

### 3.5 风险与约定

1. **into / from 不可填反**：左=线上（远程）、右=我的；与预演选边、一键落盘同向。
2. **目标分支仅远程**；本地互合同步不在本工具范围内。
3. **同名分支**（如 `master` ↔ `origin/master`）不预演、不申请 MR，请自行 push / pull。
4. 临时分支必须基于 **线上 into**；误从我的分支拉出再 merge 线上会左右对调。
5. tip 变化后应重新预演再一键解决。
6. 主工作区可有未提交改动（worktree 隔离）；临时分支名已在主仓检出则拒绝。
7. 冲突文件须全部有选边，否则 worktree 内 `merge --abort`。
8. PowerShell 执行扩展内 CLI：`& "…\gh.exe" auth login`（不可省略 `&`）。

### 3.6 发布到 Cursor 市场（Open VSX）

Cursor 扩展市场上游是 **[Open VSX](https://open-vsx.org)**（不是 Microsoft VS Code Marketplace）。  
**现行唯一发版流程**：改扩展 `version` → 更新 `CHANGELOG.md` → push 到 `master`/`main` → GitHub Actions 自动打 tag 并发布到 Open VSX → Cursor 市场稍后同步。

| 项 | 值 |
|----|-----|
| 扩展 ID | `jinshaohui.git-insight` |
| publisher / namespace | `jinshaohui` |
| name | `git-insight` |
| 变更记录 | [`packages/extension/CHANGELOG.md`](../packages/extension/CHANGELOG.md)（打进 VSIX，市场「Changelog」页展示） |
| 工作流 | [`.github/workflows/release-on-version.yml`](../.github/workflows/release-on-version.yml) |

```text
【一次性】Open VSX 账号 + Token + create-namespace + GitHub Secret OVSX_PAT
                              ↓
【日常】改 packages/extension/package.json 的 version（升高）
        并在 CHANGELOG.md 表格顶部追加行（版本 | 日期 | 变更项）
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

> **市场变更记录**：`vsce package` 会收录扩展目录下的 `CHANGELOG.md`（包内为 `changelog.md`）。  
> 格式为表格三列：**版本 | 日期 | 变更项**（每个版本一行；变更项用 `1. …` / `2. …`，项之间用 `<br>` 换行）。每次升 `version` 务必同步写 changelog，否则 Cursor / Open VSX 详情页没有可读的版本说明。

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

一个 Skill：`git-branch-insight`。用户侧只记斜杠调用；CLI / 扩展是它的执行出口，不是另一套产品。

### 4.1 用户怎么用

```text
/git-branch-insight
把 feature/x 合进 origin/develop；有冲突列出来；能开 MR 再问我
```

1. Agent 聊天输入 `/`，选 `git-branch-insight`（`disable-model-invocation: true`，不会自动抢戏）
2. 同一条或下一条写清：目标远程分支、我的分支、是否只预演 / 是否开 MR

### 4.2 安装扩展如何得到 Skill（推荐）

装 Git Insight（市场或 VSIX）并 **Reload** 后：

| 机制 | 说明 |
|------|------|
| 启动同步 | `onStartupFinished` 激活时，把扩展内 `skills/git-branch-insight/SKILL.md` 写到用户全局目录，并把 `__GIT_INSIGHT_CLI__` 替换为扩展自带 `dist/cli.js` 绝对路径 |
| 写入位置 | `~/.cursor/skills/git-branch-insight/`、`~/.agents/skills/git-branch-insight/`（Windows 即 `%USERPROFILE%\.cursor\skills\…`） |
| `chatSkills` | `package.json` → `contributes.chatSkills` 指向同一 Skill（宿主支持时直接贡献） |
| 手动补同步 | 命令面板：`Git Insight: 同步 Agent Skill 到全局` |

**自检：**

1. 打开 `~/.cursor/skills/git-branch-insight/SKILL.md`，确认 CLI 行已是真实路径，而不是 `__GIT_INSIGHT_CLI__`
2. 任意业务仓库 Agent 输入 `/git-branch-insight` 能搜到
3. （可选）用 Skill 里的路径跑：`node "<扩展目录>\dist\cli.js" graph --no-fetch`

升级扩展后若路径变了：Reload 或再跑一次「同步 Agent Skill 到全局」。

开发本仓库（未依赖扩展全局 Skill）时仍可用：

- [`.cursor/skills/git-branch-insight/SKILL.md`](../.cursor/skills/git-branch-insight/SKILL.md)
- [`skills/git-branch-insight/SKILL.md`](../skills/git-branch-insight/SKILL.md)
- 扩展打包源：[packages/extension/skills/git-branch-insight/SKILL.md](../packages/extension/skills/git-branch-insight/SKILL.md)

### 4.3 范围

| | Skill | 扩展 |
|--|-------|------|
| Fetch / 分支图 / 预演 | CLI | Webview |
| 冲突选边 | 对话确认 → `apply-resolve` stash | 三栏 / AI 选边 |
| 一键 resolve | CLI `apply-resolve`（worktree） | 同一 core API |
| 申请 MR | **三选一**：cli / token / **open-ui** | 面板内配置后一键申请 |
| 引擎 | 同一 `@git-insight/core`（扩展 VSIX 内打进 `dist/cli.js`） | 同一 |

Skill 与扩展**联动**：对话跑完分析后，可选 `open-ui` 唤起面板并种入 `into`/`from`（沿用扩展已配 Token/CLI）。

### 4.4 前置与 CLI 调用

- Git ≥ 2.38
- 在目标仓库根执行，或 `--cwd <repo>`

**终端用户（已装扩展）：** 使用 Skill 文件里注入的路径：

```bash
node "<Cursor扩展目录>/jinshaohui.git-insight-<version>/dist/cli.js" <command> …
```

**本仓库开发：**

```bash
pnpm --filter @git-insight/core build
pnpm --filter @git-insight/core exec node dist/cli.js <command> …
```

**CLI 子命令（Skill 执行出口，完整表见 [§5.2](#52-skill--cli-指令)）**

| 阶段 | 命令 | 读写 |
|------|------|------|
| 同步 | `fetch [--cwd] [--remote]` | 只读（网络） |
| 图 | `graph [--cwd] [--max] [--into] [--from] [--no-fetch] [--remote]` | 只读 |
| 预演 | `preview-merge --into <远程> --from <我的> [--cwd] [--no-fetch]` | 只读 |
| 落盘 | `apply-resolve --into … --from … --stash <json> [--cwd] [--no-push]` | **写**（须确认） |
| 准备 MR | `prepare-mr --into … --from …` | 只读准备 |
| 创建 MR | `create-mr --source … --target … --method cli\|token …` | **写远端**（须确认） |
| 唤起 UI | `open-ui --into … --from … [--cwd] [--no-open]` | 打开扩展 |

别名（等同 `preview-merge`，**仅 CLI**，不会出现在命令面板）：`conflict-blame`、`merge-rehearsal`。帮助：`-h` / `--help`。

### 4.5 Agent 工作流（业务闭环）

1. 确认仓库路径；默认 `fetch`（离线加 `--no-fetch`）
2. 可选 `graph` → 展示 `report` / `mermaid`
3. `preview-merge --into <远程> --from <我的>`
4. 同名 → 停止，告知自行 push/pull
5. 有冲突 → 列出 `conflictContent` + 建议选边 → **用户确认** → 写 `stash.json` → `apply-resolve`
6. 干净或已推临时分支 → **询问 MR 方式**（见下）→ 执行

**申请 MR 三选一（必须先问用户）：**

| 选择 | CLI | 说明 |
|------|-----|------|
| cli | `create-mr --method cli --source … --target …` | 本机 `gh` / `glab` 已登录 |
| token | `create-mr --method token --token …`（或环境变量 `GIT_INSIGHT_GITHUB_TOKEN` / `GIT_INSIGHT_GITLAB_TOKEN`） | 无 CLI 时 |
| ui | `open-ui --into … --from …` | 已装扩展则拉起预演面板（URI `vscode://jinshaohui.git-insight/preview?…`）；也可命令 `gitInsight.openPreview` |

`prepare-mr` 会返回 `mrChoices` 供 Agent 展示选项。

### 4.6 输出约定

```markdown
## 结论
（干净合并 / 冲突 N 个文件 / 同名跳过）

## 冲突详情
（每个文件：路径、溯源、冲突内容代码块）

## 图
（mermaid）

## 建议动作
- 选边确认 / apply-resolve
- 申请 MR：cli | token | ui（待用户选）

## 结果
（临时分支 / MR URL / 已打开扩展）
```

### 4.7 不要做的事

- 不要为**预演**执行真实 `git merge` / `checkout`（预演只用 CLI 只读命令）
- 不要在用户未确认时执行 `apply-resolve` / `create-mr`
- 不要对同名分支强行建 MR
- 不要把 PR 号当作核心参数
- 不要跳过默认 fetch（除非用户要求离线）
- 冲突时不要只汇报「有冲突」而省略冲突正文

### 4.8 预演 JSON 要点

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

## 五、附录：指令一览、FAQ 与命令速查

### 5.1 Cursor 扩展指令（命令面板 / URI）

命令面板搜 **Git Insight**（与 `package.json` → `contributes.commands` 一致）：

| 面板标题 | 命令 ID | 作用 |
|----------|---------|------|
| Git Insight: Open Web | `gitInsight.openWeb` | 打开面板 → 默认 **Git 配置** |
| Git Insight: 合并预演 | `gitInsight.previewMerge` | 打开面板 → **合并预演** |
| Git Insight: 打开预演（可带 into/from） | `gitInsight.openPreview` | 打开预演并种入分支；供 Skill / 程序 / URI 调用 |
| Git Insight: 同步 Agent Skill 到全局 | `gitInsight.syncSkill` | 同步 Skill 到 `~/.cursor/skills` 与 `~/.agents/skills` |

`gitInsight.openPreview` 参数：

| 参数 | 说明 |
|------|------|
| `into` | 线上目标（建议远程，如 `origin/develop`） |
| `from` | 我的分支 |
| `cwd` | 仓库路径（可选） |
| `autoPreview` | 默认 `true`；`false` 时只种入分支、不自动跑预演 |

**URI 唤起**（扩展 ID `jinshaohui.git-insight`）：

| Path | 作用 | Query |
|------|------|--------|
| `/preview`（或 `/`、`/open`） | 打开合并预演并种入分支 | `into`、`from`、`cwd`、`autoPreview`（`0` / `false` 关闭自动预演） |
| `/config` | 打开 Git 配置 | — |
| `/graph` | 打开分支图 | — |

示例：

```text
vscode://jinshaohui.git-insight/preview?into=origin/develop&from=feature/x&autoPreview=1
```

> 已删除命令面板中的 `gitInsight.conflictBlame`（「合并预演（兼容）」）。日常只用 **合并预演**；需要带分支参数时用 **打开预演** 或上表 URI。

### 5.2 Skill / CLI 指令

| 项 | 内容 |
|----|------|
| 斜杠入口 | **`/git-branch-insight`** |
| Skill 名 | `git-branch-insight` |
| 调用策略 | `disable-model-invocation: true`（须用户主动 `/`，模型不会自动抢调） |

调用形态：

```bash
# 已装扩展（路径见 Skill 文件内注入值）
node "<扩展目录>/jinshaohui.git-insight-<version>/dist/cli.js" <command> …

# 本仓库开发
pnpm --filter @git-insight/core exec node dist/cli.js <command> …
```

| 命令 | 主要参数 | 说明 |
|------|----------|------|
| `fetch` | `[--cwd]` `[--remote]` | 拉远程（默认 `origin`） |
| `graph` | `[--cwd]` `[--max]` `[--into]` `[--from]` `[--no-fetch]` `[--remote]` | 分支图 + `report` / `mermaid` |
| `preview-merge` | **必填** `--into` `--from`；`[--cwd]` `[--no-fetch]` | 合并预演（只读） |
| `conflict-blame` | 同 `preview-merge` | CLI 旧名别名 |
| `merge-rehearsal` | 同 `preview-merge` | CLI 旧名别名 |
| `apply-resolve` | `--into` `--from` `--stash <file.json>` `[--cwd]` `[--no-push]` | worktree 落盘；干净合并可用 `{ "files": [] }`；**须确认** |
| `prepare-mr` | `--into` `--from` `[--source]` `[--method]` `[--token]` `[--cwd]` | 准备 MR，返回可选方式等 |
| `create-mr` | `--source` `--target` `[--method cli\|token]` `[--token]` `[--title]` `[--body]` `[--reviewers a,b]` `[--cwd]` | 创建 MR/PR；**须确认** |
| `open-ui` | `--into` `--from` `[--cwd]` `[--no-open]` | 生成/打开扩展预演 URI |

Skill 约定闭环：

```text
fetch / graph → preview-merge
  →（有冲突：确认选边 → apply-resolve）
  → 询问 MR：cli | token | ui
  → create-mr 或 open-ui
```

硬性规则见 [§4.7](#47-不要做的事) 与 Skill 正文：`--into` 用远程；同名分支停止；写仓 / 开 MR 前确认；冲突展示 `conflictContent`；左=线上、右=我的。

### 5.3 扩展 ↔ Skill 能力对照

| 能力 | 命令面板 / URI | Skill CLI |
|------|----------------|-----------|
| 打开配置 | `openWeb` / URI `/config` | —（或面板） |
| 分支图 | URI `/graph`（面板内） | `graph` |
| Fetch | 面板内 | `fetch` |
| 合并预演 | `previewMerge`；带参用 `openPreview` / URI `/preview` | `preview-merge` |
| 冲突解决落盘 | 面板「一键解决并推送」 | `apply-resolve` |
| 准备 / 创建 MR | 面板内 | `prepare-mr` / `create-mr` |
| 唤起 UI | `openPreview` | `open-ui` |
| 同步 Skill | `syncSkill` | — |

### 5.4 FAQ

**命令面板里为什么曾有两条「合并预演」？**  
旧命令 ID `gitInsight.conflictBlame` 曾以「合并预演（兼容）」保留，与 `previewMerge` 重复。现已删除兼容项，面板只保留 **Git Insight: 合并预演**。CLI 仍可用 `conflict-blame` 作为 `preview-merge` 别名（不会出现在命令面板）。

**「合并预演」和「打开预演（可带 into/from）」有何区别？**  
前者只打开预演 Tab；后者可传入 `into` / `from` / `cwd` 并默认自动预演，供 Skill、`open-ui`、URI 使用。

**Fetch 失败，但 WebStorm 可以**  
确认本机 Git / Credential Manager 能对同一仓库 `git fetch`；方案 C Token **不参与** fetch。若弹窗未出现，检查是否被策略禁用了交互凭据。

**分支图和线上不一致**  
看是否「已 fetch」。成功后本地分支 tip 仍可能旧，请对照远程分组下的同名短分支（`gitRef` 形如 `origin/分支名`）。

**链路报告「无提交说明」**  
重新加载分支图（提交元数据已改为 `git log --no-walk` 解析）。

**预览模式下一键按钮是灰的**  
浏览器 preview 禁止写仓库；请在 Cursor 扩展面板操作。

**目标分支选不到本地分支？**  
设计如此：目标（`into`）只列远程跟踪分支。本地 ↔ 本地或本地 ↔ 其远程同名分支，请自行 `git merge` / `push` / `pull`。

**提示「源/目标是同一分支」**  
短名相同（如 `master` 与 `origin/master`）。本工具不做同名同步与 MR；请在终端 push / pull。

**GitLab Token 格式**  
必须 `glpat-`；不要把 `ghp_` 填进 GitLab 框。Token 仅用于申请 MR，不能代替 fetch 登录。

**AI 选边一直等不到结果**  
检查是否停在 MCP feedback；把 JSON 粘贴到弹层兜底。也可在 Git 配置填 OpenAI 兼容 API / 本地 Ollama（§2.1「AI 选边（模型）」），绕过 Chat 桥。

**Git 配置里「AI 选边（模型）」要不要填？**  
可选。优先用宿主 `vscode.lm`；没有再用这里的 API；再没有走 Chat 桥。不用 AI 选边时完全可留空（默认 URL 无 Key 也不会调云端）。详见 §2.1 / §2.5。

**左侧文件角标是 `8Δ`、没有 `x/y`？**  
表示该文件**无冲突红块**，只有绿/蓝自动变更（Δ=变更数）。主列表只显示有冲突的文件；这类文件在折叠分组「仅自动合并」里，一键解决仍会写入。详见 §2.4「冲突解决面板」。

**发布 Cursor 市场失败 / 找不到扩展**  
见 **§3.6**：按 ①→④ 配好后，日常只改 `version` 推 master。市场搜不到时先看 open-vsx.org。

**装了扩展但 Agent 没有 `/git-branch-insight`？**  
1. `Developer: Reload Window`  
2. 命令面板：`Git Insight: 同步 Agent Skill 到全局`  
3. 确认存在 `~/.cursor/skills/git-branch-insight/SKILL.md`，且其中 CLI 不是占位符 `__GIT_INSIGHT_CLI__`  
4. 新开一条 Agent 对话再试 `/`

**Skill 里的 CLI 路径失效（升级/换机后）？**  
再跑「同步 Agent Skill 到全局」或 Reload；扩展会按当前安装目录重写路径。

**只装扩展、不打开面板，能用 Skill 吗？**  
能。Skill 用扩展自带 `dist/cli.js`；写操作与开 MR 仍须在对话里确认。面板用于可视化选边与配置 Token/CLI。

### 5.5 CLI 一行速查（git-insight 封装）

完整说明见 [§5.2](#52-skill--cli-指令)。简表：

```text
git-insight graph [--cwd] [--max] [--into] [--from] [--no-fetch] [--remote]
git-insight fetch [--cwd] [--remote]
git-insight preview-merge --into <线上目标> --from <我的分支> [--cwd] [--no-fetch]
git-insight conflict-blame|merge-rehearsal …   # 同 preview-merge（仅 CLI 别名）
git-insight apply-resolve --into … --from … --stash <json> [--cwd] [--no-push]
git-insight prepare-mr --into … --from … [--source] [--method] [--token] [--cwd]
git-insight create-mr --source … --target … --method cli|token [--token] [--title] [--body] [--reviewers] [--cwd]
git-insight open-ui --into … --from … [--cwd] [--no-open]
```

终端用户：用扩展目录下 `dist/cli.js`（见 §4.2 / Skill 文件内路径）。本仓库开发：`pnpm --filter @git-insight/core exec node dist/cli.js …`。写操作须用户确认后再由 Agent 调用。

### 5.6 底层指令速查（按功能）

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

### 5.7 与 WebStorm 的差异（Fetch）

WebStorm 默认允许交互取凭据。本扩展**工作区** fetch 同样直接允许弹窗（已有本机凭据时通常不弹）；方案 C Token **不**用于工作区 fetch。打开 `owner/repo` 远程缓存时仍可能注入 Token（§2.8）。

---

*行为变更时请同步更新本文。Skill / 根 README / 各包 README 均指向本文。*
