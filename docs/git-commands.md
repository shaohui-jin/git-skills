# Git Insight 用到的原生 Git 指令（知识点）

> 本文记录本项目实际调用的 **原生 `git` 命令行**，并说明各语法含义。  
> 原则：**只读分析**，不执行会改动工作区 / index 的 `checkout`、`merge`、`rebase`、`reset`、`add`、`commit` 等。  
> 每节末尾的 **Mock 输出** 为示意样例（SHA / 路径已简化），便于对照理解；真实仓库结果会不同。  
> 文中 `<NUL>` 表示 ASCII `0x00`（命令里的 `%00` / `-z`）。

---

## 目录

1. [版本与仓库定位](#1-版本与仓库定位)
2. [远程同步](#2-远程同步)
3. [分支 tip 列举](#3-分支-tip-列举)
4. [提交图（DAG）](#4-提交图dag)
5. [提交元信息](#5-提交元信息)
6. [合并祖先与预演](#6-合并祖先与预演)
7. [冲突文件内容](#7-冲突文件内容)
8. [冲突溯源](#8-冲突溯源)
9. [常量：空 tree](#9-常量空-tree)
10. [可选：GitHub CLI](#10-可选github-cli)
11. [语法速查表](#11-语法速查表)
12. [按功能串联](#12-按功能串联)

---

## 1. 版本与仓库定位

### `git --version`

```bash
git --version
```

- **含义**：打印已安装的 Git 版本号。
- **本项目用途**：检测是否 ≥ 2.38（现代 `merge-tree --write-tree` 需要）。

**Mock 输出（stdout）：**

```text
git version 2.45.1.windows.1
```

---

### `git rev-parse --show-toplevel`

```bash
git rev-parse --show-toplevel
```

| 语法 | 含义 |
|------|------|
| `rev-parse` | 解析「修订 / 路径 / 选项」，是 Git 的底层查询工具 |
| `--show-toplevel` | 输出当前仓库工作区根目录的绝对路径 |

- **本项目用途**：从任意子目录定位仓库根，后续命令都在根目录执行。

**Mock 输出（stdout）：**

```text
D:/work/my-app
```

---

### `git rev-parse --verify <rev>^{commit}`

```bash
git rev-parse --verify main^{commit}
git rev-parse --verify origin/feature/foo^{commit}
```

| 语法 | 含义 |
|------|------|
| `--verify` | 要求对象必须存在，否则非 0 退出 |
| `<rev>` | 任意可解析的修订：分支名、tag、SHA、`HEAD` 等 |
| `^{commit}` | **peel（剥皮）**：若 `<rev>` 是 tag 等，剥到其指向的 **commit** 对象 |

- **本项目用途**：把用户选的分支名可靠地解析成 commit SHA（`ensureRev`）。

**Mock 输出（成功，stdout）：**

```text
a1b2c3d4e5f6789012345678901234567890abcd
```

**Mock 输出（失败，stderr + exit ≠ 0）：**

```text
fatal: Needed a single revision
```

---

## 2. 远程同步

### `git fetch --prune --progress <remote>`

```bash
git fetch --prune --progress origin
```

| 语法 | 含义 |
|------|------|
| `fetch` | 从远程下载对象与更新远程跟踪分支（`refs/remotes/...`），**不合并进当前分支** |
| `--prune` | 删除远程已不存在、本地仍残留的远程跟踪分支 |
| `--progress` | 在 stderr 输出进度（含百分比），便于 UI 展示 |
| `<remote>` | 远程名，默认 `origin` |

- **本项目用途**：图 / 合并预演前刷新远程 tip；允许失败（离线仍可用本地 refs）。

**Mock 输出（stderr，进度用 `\r` 刷新同一行）：**

```text
remote: Enumerating objects: 42, done.
remote: Counting objects: 100% (42/42), done.
remote: Compressing objects: 100% (18/18), done.
Receiving objects:  35% (120/342), 1.20 MiB | 800.00 KiB/s
Receiving objects: 100% (342/342), 2.10 MiB | 1.10 MiB/s, done.
Resolving deltas: 100% (210/210), completed with 40 local objects.
From https://github.com/org/repo
   a1b2c3d..e4f5a6b  main       -> origin/main
 * [new branch]      feature/x  -> origin/feature/x
 - [deleted]         (none)     -> origin/old-branch
```

成功时 stdout 通常为空；离线失败示例（stderr）：

```text
fatal: unable to access 'https://github.com/org/repo.git/': Could not resolve host
```

---

### `git fetch --all --prune`

```bash
git fetch --all --prune
```

| 语法 | 含义 |
|------|------|
| `--all` | 对所有已配置 remote 执行 fetch |

- **本项目用途**：远程 URL 缓存副本场景下，更新本地只读副本。

**Mock 输出（stderr）：**

```text
Fetching origin
From https://github.com/org/repo
   a1b2c3d..e4f5a6b  main -> origin/main
Fetching upstream
From https://github.com/other/repo
 * [new branch]      develop -> upstream/develop
```

---

### `git clone -- <url> <dir>`

```bash
git clone -- https://github.com/org/repo.git /path/to/cache/dir
```

| 语法 | 含义 |
|------|------|
| `clone` | 克隆远程仓库到本地目录 |
| `--` | 结束选项解析，后面一律当路径/URL（避免 URL 被误解析为选项） |
| `<url>` | 远程仓库地址 |
| `<dir>` | 目标目录 |

- **本项目用途**：首次把远程仓库拉到本地缓存，再只读分析。

**Mock 输出（stderr）：**

```text
Cloning into '/path/to/cache/dir'...
remote: Enumerating objects: 1200, done.
remote: Counting objects: 100% (1200/1200), done.
Receiving objects: 100% (1200/1200), 3.40 MiB | 2.00 MiB/s, done.
Resolving deltas: 100% (800/800), done.
```

---

## 3. 分支 tip 列举

### `git for-each-ref … refs/heads refs/remotes`

```bash
# 分支图：含 SHA、upstream
git for-each-ref \
  --format='%(refname)%00%(refname:short)%00%(objectname)%00%(upstream:short)' \
  refs/heads refs/remotes

# UI 下拉：仅 ref 名
git for-each-ref \
  --format='%(refname)%00%(refname:short)' \
  refs/heads refs/remotes
```

| 语法 | 含义 |
|------|------|
| `for-each-ref` | 遍历指定命名空间下的引用 |
| `--format=…` | 自定义每行输出字段 |
| `%(refname)` | 完整引用名，如 `refs/heads/main`、`refs/remotes/origin/dev` |
| `%(refname:short)` | 短名，如 `main`、`origin/dev` |
| `%(objectname)` | tip 的完整 SHA |
| `%(upstream:short)` | 配置的上游跟踪分支短名（无则空） |
| `%00` | NUL 分隔符，避免分支名含空格/特殊字符时拆错 |
| `refs/heads` | **本地分支** |
| `refs/remotes` | **远程跟踪分支** |

- **本项目用途**：画分支 tip、填充分支选择器；用 `refs/heads` vs `refs/remotes` 区分本地/远程（含带 `/` 的本地分支名）。

**Mock 输出（分支图格式，`<NUL>` = `%00`）：**

```text
refs/heads/main<NUL>main<NUL>a1b2c3d4e5f6789012345678901234567890abcd<NUL>origin/main
refs/heads/feature/login<NUL>feature/login<NUL>b2c3d4e5f6789012345678901234567890abcde1<NUL>
refs/remotes/origin/main<NUL>origin/main<NUL>a1b2c3d4e5f6789012345678901234567890abcd<NUL>
refs/remotes/origin/feature/x<NUL>origin/feature/x<NUL>c3d4e5f6789012345678901234567890abcdef12<NUL>
```

可读对照（把 `<NUL>` 想成 `|`）：

```text
refs/heads/main | main | a1b2c3d4…abcd | origin/main
refs/heads/feature/login | feature/login | b2c3d4e5…cde1 | （无 upstream）
refs/remotes/origin/main | origin/main | a1b2c3d4…abcd |
refs/remotes/origin/feature/x | origin/feature/x | c3d4e5f6…ef12 |
```

**Mock 输出（下拉精简格式）：**

```text
refs/heads/main<NUL>main
refs/heads/feature/login<NUL>feature/login
refs/remotes/origin/main<NUL>origin/main
```

---

## 4. 提交图（DAG）

### `git rev-list --parents …`

```bash
# 全量 / 截断：从多个 tip 往回走
git rev-list --parents <tip1> <tip2> …
git rev-list --parents --max-count=200 <tips…>

# 双分支聚焦：into + from，并排除 merge-base 更早的历史
git rev-list --parents <intoSha> <fromSha> ^<baseSha>^@
```

| 语法 | 含义 |
|------|------|
| `rev-list` | 按可达性列出提交（默认从近到远） |
| `--parents` | 每行输出：`sha parent1 parent2 …`，可直接建 DAG 边 |
| `--max-count=N` | 最多输出 N 个提交（截断大图） |
| `<tip>…` | 作为遍历起点的提交 |
| `^X` | **排除**可达自 X 的提交 |
| `X^@` | X 的**所有父提交**（不含 X 自身） |
| `^base^@` | 排除 base 的所有父提交一侧历史，常用来收窄「两分支相对 merge-base」的窗口 |

- **本项目用途**：构建分支提交图的节点与父子边。

**Mock 输出（stdout，近 → 远；合并提交有两个 parent）：**

```text
e4f5a6b7890123456789012345678901234567aa d4e5f6a7890123456789012345678901234567bb c3d4e5f6789012345678901234567890abcdef12
d4e5f6a7890123456789012345678901234567bb b2c3d4e5f6789012345678901234567890abcde1
c3d4e5f6789012345678901234567890abcdef12 b2c3d4e5f6789012345678901234567890abcde1
b2c3d4e5f6789012345678901234567890abcde1 a1b2c3d4e5f6789012345678901234567890abcd
a1b2c3d4e5f6789012345678901234567890abcd
```

解读第一行：

```text
e4f5a6b7…7aa   ← 当前提交（合并提交）
  └─ parents: d4e5f6a7…7bb , c3d4e5f6…ef12
```

根提交只有 SHA、没有 parent：

```text
a1b2c3d4e5f6789012345678901234567890abcd
```

---

### 范围语法：`A..B` / `A...B`

```bash
git rev-list --count <base>..<tip>
git rev-list --reverse --max-count=1 <base>..<from>
```

| 语法 | 含义 |
|------|------|
| `A..B` | 可达 **B**、不可达 **A** 的提交（「B 相对 A 多出来的」） |
| `A...B` | 三点：相对 **merge-base(A,B)** 的对称差（见下方 `diff`） |
| `--count` | 只输出数量 |
| `--reverse` | 从旧到新 |
| `--max-count=1` | 只要 1 个 → 配合 `--reverse` 得到「分叉后第一个独有提交」 |

- **本项目用途**：lineage（一侧独有提交数、分叉点附近首提交）。

**Mock 输出：**

```bash
# git rev-list --count a1b2c3d..e4f5a6b
```

```text
12
```

```bash
# git rev-list --reverse --max-count=1 a1b2c3d..c3d4e5f
```

```text
b2c3d4e5f6789012345678901234567890abcde1
```

含义：从共同祖先之后，`from` 侧**最早**的那一个独有提交。

---

## 5. 提交元信息

### `git show -s --format=… <sha>…`

```bash
git show -s --format='%H%00%P%00%an%00%at%00%s' <sha1> <sha2> …
```

| 语法 | 含义 |
|------|------|
| `show` | 展示对象（commit / tree / blob / tag） |
| `-s` / `--no-patch` | **不显示 patch**，只要元数据 |
| `--format=…` | 自定义 commit 一行格式 |
| `%H` | 完整 commit hash |
| `%P` | 父提交 hashes（空格分隔） |
| `%an` | author 名 |
| `%at` | author 时间（Unix 秒） |
| `%s` | subject（提交说明第一行） |
| `%00` | NUL 字段分隔 |

- **本项目用途**：批量给图节点填作者、时间、说明（分块调用，避免 Windows 参数过长）。

**Mock 输出（stdout，每提交一行；字段间为 `<NUL>`）：**

```text
e4f5a6b7890123456789012345678901234567aa<NUL>d4e5f6a7890123456789012345678901234567bb c3d4e5f6789012345678901234567890abcdef12<NUL>Alice<NUL>1719123456<NUL>Merge branch 'feature/x'
d4e5f6a7890123456789012345678901234567bb<NUL>b2c3d4e5f6789012345678901234567890abcde1<NUL>Bob<NUL>1719120000<NUL>fix login timeout
a1b2c3d4e5f6789012345678901234567890abcd<NUL><NUL>Carol<NUL>1719000000<NUL>Initial commit
```

可读对照（`|` = `<NUL>`）：

```text
e4f5a6b7…7aa | d4e5f6a7…7bb c3d4e5f6…ef12 | Alice | 1719123456 | Merge branch 'feature/x'
d4e5f6a7…7bb | b2c3d4e5…cde1              | Bob   | 1719120000 | fix login timeout
a1b2c3d4…abcd | （无父）                   | Carol | 1719000000 | Initial commit
```

---

## 6. 合并祖先与预演

### `git merge-base <into> <from>`

```bash
git merge-base <intoSha> <fromSha>
```

| 语法 | 含义 |
|------|------|
| `merge-base` | 找两提交的**最佳共同祖先**（三方合并的 base） |
| 失败（非 0） | 通常表示 **无关历史**（unrelated histories），无共同祖先 |

- **本项目用途**：预演与 lineage 的 base；失败时走「无关历史」分支，不直接抛裸错误。

**Mock 输出（有共同祖先，stdout）：**

```text
a1b2c3d4e5f6789012345678901234567890abcd
```

**Mock 输出（无关历史，stderr + exit ≠ 0）：**

```text
fatal: Not a valid object name ...
# 或仅非 0 退出、几乎无 stdout（视 Git 版本/参数而定）
```

---

### 现代：`git merge-tree --write-tree …`

```bash
git merge-tree --write-tree -z --messages --name-only <into> <from>
git merge-tree --write-tree -z --messages --name-only \
  --allow-unrelated-histories <into> <from>
```

| 语法 | 含义 |
|------|------|
| `merge-tree` | 在内存做树级三方合并，**不改工作区 / index** |
| `--write-tree` | 现代模式：写出合并结果树（Git ≥ 2.38） |
| `-z` | NUL 分隔输出块，便于机器解析 |
| `--messages` | 输出冲突相关说明信息 |
| `--name-only` | 侧重冲突路径名 |
| `--allow-unrelated-histories` | 允许无共同祖先时仍尝试合并（类似 `merge` 同名选项） |
| `<into> <from>` | 把 `from` 合进 `into` 的预演 |

- **本项目用途**：合并冲突预演的主路径。

**Mock 输出 A — 干净可合并（stdout，首块为结果 tree SHA）：**

```text
f1e2d3c4b5a697887766554433221100ffeeddcc
```

（无冲突时可能只有 tree OID；exit 0。）

**Mock 输出 B — 有内容冲突（示意；真实块由 `-z` 分隔）：**

```text
9a8b7c6d5e4f32109876543210fedcba98765432<NUL>src/config.ts<NUL>CONFLICT (content): Merge conflict in src/config.ts<NUL>README.md
```

可读拆块：

```text
[0] 9a8b7c6d…5432          ← 即便有冲突也可能给出（不完整）结果 tree
[1] src/config.ts          ← 冲突路径
[2] CONFLICT (content): …  ← 说明信息
[3] README.md              ← 另一冲突路径
```

> 不同 Git 小版本下 `--messages` / `--name-only` 的块顺序可能略有差异；本项目会同时扫 stdout+stderr 与 `CONFLICT` 关键字。

---

### 经典 fallback：`git merge-tree <base> <into> <from>`

```bash
git merge-tree <baseSha> <intoSha> <fromSha>
```

| 语法 | 含义 |
|------|------|
| 三参数经典形式 | 显式指定 merge-base，输出带冲突标记的合并结果文本 |

- **本项目用途**：现代模式拿不到冲突列表时的回退。

**Mock 输出（stdout 片段，含冲突标记）：**

```text
merged
  base   100644 a1b2c3d4e5f6789012345678901234567890aaaa src/config.ts
  our    100644 b2c3d4e5f6789012345678901234567890bbbb src/config.ts
  their  100644 c3d4e5f6789012345678901234567890cccc src/config.ts
@@ -1,3 +1,7 @@
 export const API = {
<<<<<<< .our
   timeout: 3000,
=======
   timeout: 5000,
>>>>>>> .their
 };
```

干净合并时多为无 `<<<<<<<` 的合并结果文本；本项目用「是否含冲突标记 / 能否抽出路径」判断 `clean`。

---

## 7. 冲突文件内容

### `git show <rev>:<path>`

```bash
git show HEAD:src/App.vue
git show abcdef1:packages/core/src/index.ts
```

| 语法 | 含义 |
|------|------|
| `<rev>:<path>` | 取出该修订下路径对应的 **blob** 内容（不经过工作区） |

- **本项目用途**：分别取 ours / theirs / base 三侧文件原文。

**Mock 输出（文件存在，stdout = 文件全文）：**

```text
export const API = {
  timeout: 3000,
  baseUrl: "/api",
};
```

**Mock 输出（路径不存在，stderr + exit ≠ 0）：**

```text
fatal: path 'src/deleted.ts' does not exist in 'abcdef1'
```

---

### `git merge-file -p --diff3 …`

```bash
git merge-file -p --diff3 \
  -L ours:src/config.ts \
  -L base \
  -L theirs:src/config.ts \
  /tmp/ours /tmp/base /tmp/theirs
```

| 语法 | 含义 |
|------|------|
| `merge-file` | **文件级**三方合并（输入是三个文件路径） |
| `-p` | 结果打印到 stdout，不写回第一个文件 |
| `--diff3` | 冲突块含 base（`\|\|\|\|\|\|\|` 段），便于对照 |
| `-L <label>` | 冲突标记里显示的标签（可写三次：ours / base / theirs） |

- **本项目用途**：生成带 `<<<<<<<` 的冲突正文，供 UI「像 WebStorm 一样」选边解决（仍不写回真实工作区）。
- **注意**：有冲突时 exit code 通常为冲突个数（非 0），但 `-p` 仍把结果打到 stdout；本项目 `allowFail: true`。

**Mock 输入三文件（示意）：**

```text
# ours
timeout: 3000

# base
timeout: 2000

# theirs
timeout: 5000
```

**Mock 输出（stdout，diff3）：**

```text
<<<<<<< ours:src/config.ts
timeout: 3000
||||||| base
timeout: 2000
=======
timeout: 5000
>>>>>>> theirs:src/config.ts
```

无冲突时 stdout 即为合并后的完整文件内容，且 exit 0。

---

## 8. 冲突溯源

### `git cat-file -e <rev>:<path>`

```bash
git cat-file -e main:README.md
```

| 语法 | 含义 |
|------|------|
| `cat-file` | 检查 / 打印对象 |
| `-e` | 仅检查对象是否存在（存在 exit 0，否则非 0） |
| `<rev>:<path>` | 该路径在该修订下的 blob |

- **本项目用途**：判断某侧是否存在该文件（增删冲突等）。

**Mock 输出：**

```text
# 存在：无 stdout，exit 0

# 不存在：exit ≠ 0，stderr 可能为
fatal: Not a valid object name main:missing.ts
```

---

### `git diff -U0 <base>...<tip> -- <path>`

```bash
git diff -U0 <baseSha>...<tipSha> -- src/config.ts
```

| 语法 | 含义 |
|------|------|
| `diff` | 比较差异 |
| `-U0` | 统一 diff，**零行上下文**，方便解析 hunk 行号 |
| `A...B`（三点） | 比较 **merge-base(A,B)** 到 B 的变化（相对共同祖先） |
| `-- <path>` | 限制到指定路径（`--` 之后是路径） |

- **本项目用途**：找出 tip 相对 base 改动了哪些行，再交给 `blame -L`。

**Mock 输出（stdout）：**

```text
diff --git a/src/config.ts b/src/config.ts
index b2c3d4e..c3d4e5f 100644
--- a/src/config.ts
+++ b/src/config.ts
@@ -2,0 +3,2 @@
+  timeout: 5000,
+  retries: 3,
@@ -10 +12 @@
-  debug: false,
+  debug: true,
```

解读 `-U0` 的 hunk 头 `@@ -旧起点,旧行数 +新起点,新行数 @@`：

| hunk | 含义（新文件侧） |
|------|------------------|
| `@@ -2,0 +3,2 @@` | 从新文件第 **3** 行起新增 **2** 行 → 区间 `[3,4]` |
| `@@ -10 +12 @@` | 省略时行数默认为 1 → 新侧第 **12** 行有改动 → `[12,12]` |

---

### `git blame -l -w -Lstart,end --line-porcelain <rev> -- <path>`

```bash
git blame -l -w -L3,4 --line-porcelain c3d4e5f6789012345678901234567890abcdef12 -- src/config.ts
```

| 语法 | 含义 |
|------|------|
| `blame` | 逐行标注「最后改这一行的提交」 |
| `-l` | 输出完整 SHA |
| `-w` | 忽略纯空白差异 |
| `-Lstart,end` | 只 blame 该行号区间 |
| `--line-porcelain` | 机器可读、按行重复元数据（author / summary 等） |
| `<rev> -- <path>` | 在指定提交上对文件做 blame |

- **本项目用途**：把冲突行归到引入提交（作者、说明），可选再挂 PR。

**Mock 输出（stdout 片段，一行对应一块元数据 + 以 tab 开头的源码行）：**

```text
c3d4e5f6789012345678901234567890abcdef12 3 3 1
author Bob
author-mail <bob@example.com>
author-time 1719120000
author-tz +0800
committer Bob
committer-mail <bob@example.com>
committer-time 1719120000
committer-tz +0800
summary feat: raise timeout and add retries
filename src/config.ts
	  timeout: 5000,
c3d4e5f6789012345678901234567890abcdef12 4 4 1
author Bob
author-mail <bob@example.com>
author-time 1719120000
author-tz +0800
committer Bob
committer-mail <bob@example.com>
committer-time 1719120000
committer-tz +0800
summary feat: raise timeout and add retries
filename src/config.ts
	  retries: 3,
```

本项目主要解析：行首 40 位 SHA、`author `、`summary `、以及以 `\t` 开头的内容行。

---

## 9. 常量：空 tree

代码中写死空 tree SHA，**不现场执行**：

```text
4b825dc642cb6eb9a060e54bf8d0927f6fb5fb496
```

等价于：

```bash
git hash-object -t tree --stdin </dev/null
```

| 语法 | 含义 |
|------|------|
| `hash-object` | 计算对象哈希（可选写入对象库） |
| `-t tree` | 指定对象类型为 tree |
| `--stdin` | 从标准输入读内容 |
| 空输入 | 得到「空目录树」的固定 SHA |

- **本项目用途**：无关历史 / 无 base 时，作为虚拟 merge-base 继续生成冲突正文。

**Mock 输出（stdout）：**

```text
4b825dc642cb6eb9a060e54bf8d0927f6fb5fb496
```

（全球所有空 tree 的 OID 都是这个值。）

---

## 10. 可选：GitHub CLI

非 Git，失败则静默跳过：

```bash
gh pr list --search abcdef1 --state all --json number --limit 1
```

| 语法 | 含义 |
|------|------|
| `gh pr list` | 列 Pull Request |
| `--search` | 按关键字搜索（这里用短 SHA） |
| `--state all` | 含已关闭 / 已合并 |
| `--json number` | 只取 PR 编号字段 |
| `--limit 1` | 最多 1 条 |

**Mock 输出（找到 PR）：**

```json
[{"number":128}]
```

**Mock 输出（未找到）：**

```json
[]
```

---

## 11. 语法速查表

| 写法 | 一句话 | Mock 直觉 |
|------|--------|-----------|
| `A..B` | B 有、A 没有的提交 | `rev-list --count A..B` → `12` |
| `A...B` | 相对 merge-base 的差异（diff 语境） | `diff A...B` ≈「B 相对共同祖先改了啥」 |
| `^X` | 排除可达自 X 的提交 | 收窄 rev-list 窗口 |
| `X^@` | X 的所有父提交 | 常写成 `^base^@` |
| `X^{commit}` | 剥到 commit | 输出 40 位 SHA |
| `rev:path` | 某版本下的文件内容 | `show` 直接吐文件正文 |
| `--` | 选项结束，后面当路径/URL | 防 `-` 开头路径被当选项 |
| `%00` / `-z` | NUL 分隔，利于机器解析 | 文档里写成 `<NUL>` |
| `refs/heads` | 本地分支 | `refs/heads/main` |
| `refs/remotes` | 远程跟踪分支 | `refs/remotes/origin/main` |

---

## 12. 按功能串联

```text
打开仓库     → git rev-parse --show-toplevel / git --version
刷新远程     → git fetch … / git clone …
分支图       → for-each-ref → rev-list --parents → show -s
合并预演     → fetch → rev-parse → merge-base → merge-tree
冲突正文     → show rev:path → merge-file --diff3
冲突溯源     → cat-file -e → diff A...B → blame -L
```

---

## 代码位置索引

| 能力 | 主要文件 |
|------|----------|
| `runGit` / rev-parse / merge-base | `packages/core/src/git/runner.ts` |
| 版本检测 | `packages/core/src/git/version.ts` |
| fetch | `packages/core/src/git/fetch.ts` |
| 分支图 | `packages/core/src/graph/builder.ts` |
| merge-tree 预演 | `packages/core/src/merge/preview.ts` |
| merge-file 冲突正文 | `packages/core/src/merge/conflictContent.ts` |
| blame 溯源 | `packages/core/src/merge/blame.ts` |
| clone / fetch 缓存 | `packages/extension/src/remoteRepo.ts` |
| 分支下拉 | `packages/extension/src/coreBridge.ts` |

---

*文档随实现维护；若增删 `runGit` 调用，请同步更新本节与 Mock 样例。*
