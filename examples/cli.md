# CLI 速查

完整说明见 [docs/guide.md](../docs/guide.md)。

```bash
pnpm --filter @shaohui_jin/git-insight-core build

# 零参分支图（默认 fetch）
pnpm exec git-insight graph
# 或
pnpm --filter @shaohui_jin/git-insight-core exec node dist/cli.js graph

# 任意两分支预演
pnpm --filter @shaohui_jin/git-insight-core exec node dist/cli.js preview-merge --into main --from feature/x

# 远程跟踪分支
pnpm --filter @shaohui_jin/git-insight-core exec node dist/cli.js preview-merge --into main --from origin/feature/x

# 冲突溯源
pnpm --filter @shaohui_jin/git-insight-core exec node dist/cli.js conflict-blame --into main --from feature/x

# 跳过 fetch
pnpm --filter @shaohui_jin/git-insight-core exec node dist/cli.js preview-merge --into main --from feature/x --no-fetch
```
