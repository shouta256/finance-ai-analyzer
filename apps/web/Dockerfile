# --- build ---
FROM node:20-alpine AS builder
WORKDIR /app
# Build context is apps/web. Copy app manifests and source.
COPY package*.json pnpm-lock.yaml* yarn.lock* .npmrc* ./
RUN corepack enable && corepack prepare pnpm@latest --activate
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# --- run ---
FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app
# Copy built artifacts and runtime manifests from builder stage
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/pnpm-lock.yaml ./pnpm-lock.yaml
RUN corepack enable && corepack prepare pnpm@latest --activate \
	&& pnpm install --prod --frozen-lockfile
EXPOSE 3000
CMD ["pnpm","start"]
