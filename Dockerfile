FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip ca-certificates \
  && python3 -m pip install --break-system-packages yt-dlp \
  && npm install -g pnpm@10.6.1 \
  && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json vitest.config.ts eslint.config.mjs .prettierrc.json ./
COPY apps ./apps
COPY packages ./packages
COPY config ./config

RUN pnpm install --frozen-lockfile
RUN find . -name '*.tsbuildinfo' -delete && pnpm build

ENV NODE_ENV=production
ENV MEDIA_INGEST_CONFIG_PATH=/app/config/app.yaml

CMD ["node", "apps/api/dist/main.js"]
