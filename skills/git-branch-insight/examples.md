# 示例

## 用户：画出当前仓库分支关系

```bash
git-insight graph
```

## 用户：预演把 feature/x 合进 develop

```bash
git-insight preview-merge --into develop --from feature/x
```

若有冲突：根据 `report` / `data.conflictFiles[].conflictContent` 列出冲突文件与冲突正文，并说明两侧作者。

## 用户：远端 feature 和本地 develop 会不会冲突

```bash
git-insight preview-merge --into develop --from origin/feature/x
```

## 用户：离线，别 fetch

```bash
git-insight preview-merge --into main --from topic --no-fetch
```
