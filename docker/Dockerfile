# syntax=docker/dockerfile:1.7
# Hai target (xem compose.yaml):
#   runtime — api + migrate (khác nhau ở lệnh chạy)
#   worker  — runtime + ffmpeg + whisper.cpp (M6); api không mang theo hai thứ này

ARG NODE_VERSION=24.21.0
ARG PNPM_VERSION=12.11.2
# Pin tag (không build `master`): đổi phiên bản là đổi có chủ đích, kèm 09-versions.md.
ARG WHISPER_CPP_VERSION=v1.9.5

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

# ---------- whisper: build whisper.cpp từ source (M6) ----------
# Alpine không có gói whisper.cpp. Build static (không kèm .so của ggml), chỉ CPU.
FROM node:${NODE_VERSION}-alpine AS whisper
ARG WHISPER_CPP_VERSION
RUN apk add --no-cache build-base cmake git
RUN git clone --depth 1 --branch ${WHISPER_CPP_VERSION} https://github.com/ggml-org/whisper.cpp /src
WORKDIR /src
# BẪY: GGML_NATIVE mặc định ON = `-march=native` → binary theo CPU của MÁY BUILD (runner CI có
# AVX-512) → chạy trên máy khác chết `SIGILL`. OFF = bản chung + chọn đường SIMD lúc chạy.
RUN cmake -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF \
      -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON \
    && cmake --build build -j"$(nproc)" --target whisper-cli \
    && strip build/bin/whisper-cli

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

# ---------- worker: + ffmpeg + whisper-cli (M6) ----------
FROM runtime AS worker
USER root
# libstdc++ / libgomp: whisper-cli link C++ runtime + OpenMP (đa luồng của ggml) động.
RUN apk add --no-cache ffmpeg libstdc++ libgomp
COPY --from=whisper /src/build/bin/whisper-cli /usr/local/bin/whisper-cli
USER node
# Model ggml KHÔNG nằm trong image (148 MB – 1,6 GB): mount vào /models (compose.yaml).
ENV WHISPER_MODEL_PATH=/models/ggml-base.bin
CMD ["node", "--enable-source-maps", "dist/worker.js"]
