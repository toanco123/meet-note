# syntax=docker/dockerfile:1.7
# Một image dùng cho cả api, worker và migrate — chỉ khác lệnh chạy (xem compose.yaml).

ARG NODE_VERSION=24.21.0
ARG PNPM_VERSION=12.11.2

# ---------- base: Node + pnpm ----------
FROM node:${NODE_VERSION}-alpine AS base
ARG PNPM_VERSION
# Không dùng corepack: Node ≥ 25 đã bỏ corepack khỏi bản cài mặc định.
RUN npm install -g pnpm@${PNPM_VERSION}
WORKDIR /app

# ---------- deps: cài toàn bộ dependency (cache theo lockfile) ----------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# ---------- build: biên dịch TS, rồi bỏ devDependencies ----------
FROM deps AS build
COPY . .
RUN pnpm build && pnpm prune --prod

# ---------- runtime: chỉ những gì cần để chạy ----------
FROM node:${NODE_VERSION}-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/migrations ./migrations
USER node
EXPOSE 3000
# exec form → node là PID 1 và nhận SIGTERM trực tiếp (graceful shutdown).
CMD ["node", "--enable-source-maps", "dist/main.js"]
