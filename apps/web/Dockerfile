# --- build ---
FROM node:20-alpine AS builder
WORKDIR /app
# Copy only workspace manifests and web app manifests for faster caching
COPY package*.json pnpm-lock.yaml* yarn.lock* .npmrc* ./
COPY apps/web/package*.json apps/web/pnpm-lock.yaml* apps/web/.npmrc* apps/web/
# Enable pnpm and install deps (workspace aware)
RUN corepack enable && corepack prepare pnpm@latest --activate
RUN pnpm install --frozen-lockfile
# Copy the full repo and build the web app
COPY . .
WORKDIR /app/apps/web
RUN pnpm build

# --- run ---
FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app
# Copy only the built artifacts and runtime manifests for the web app
COPY --from=builder /app/apps/web/.next ./apps/web/.next
COPY --from=builder /app/apps/web/public ./apps/web/public
COPY --from=builder /app/apps/web/package.json ./apps/web/package.json
COPY --from=builder /app/apps/web/pnpm-lock.yaml ./apps/web/pnpm-lock.yaml
# Install only production deps within the web app directory
WORKDIR /app/apps/web
RUN corepack enable && corepack prepare pnpm@latest --activate \
	&& pnpm install --prod --frozen-lockfile
EXPOSE 3000
CMD ["pnpm","start"]
