# 真实 git 预览服务（非静态写死数据）
# docker run -p 8080:8080 -e GIT_INSIGHT_MODE=remote ghcr.io/<owner>/git-skill:latest

FROM node:22-bookworm-slim AS build
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.13.1 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY skills ./skills
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @git-insight/core build \
  && pnpm --filter @git-insight/webview build \
  && pnpm --filter git-insight run build:ext

FROM node:22-bookworm-slim AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.13.1 --activate
WORKDIR /app
ENV NODE_ENV=production \
  HOST=0.0.0.0 \
  PORT=8080 \
  GIT_INSIGHT_MODE=remote \
  GIT_INSIGHT_DATA_DIR=/data/repos
COPY --from=build /app /app
RUN mkdir -p /data/repos
VOLUME ["/data/repos"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["pnpm", "--filter", "git-insight", "preview:prod"]
