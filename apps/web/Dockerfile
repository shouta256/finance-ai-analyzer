# --- build ---
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json pnpm-lock.yaml* yarn.lock* .npmrc* ./
# お使いのパッケージマネージャに合わせて ↓ を選択
RUN corepack enable && corepack prepare pnpm@latest --activate
COPY . .
WORKDIR /app/apps/web
RUN pnpm install --frozen-lockfile
RUN pnpm build

# --- run ---
FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app/apps/web
COPY --from=builder /app/apps/web/.next ./.next
COPY --from=builder /app/apps/web/public ./public
COPY --from=builder /app/apps/web/package.json ./package.json
RUN corepack enable && corepack prepare pnpm@latest --activate && pnpm install --prod --frozen-lockfile
EXPOSE 3000
CMD ["pnpm","start"]  # next start (app routerなら next start)
