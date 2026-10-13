# Aurora: self-hosted image.
#
#   docker compose up -d            (see docker-compose.yml and docs/self-hosting.md)
#
# Stages: deps (production node_modules), web (Vite build), runtime (Node 26 + Python, uv,
# Chromium, bubblewrap, yt-dlp). The library and actors live in the /data volume.

ARG NODE_IMAGE=docker.io/library/node:26-trixie-slim
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.12.13

FROM ${UV_IMAGE} AS uv

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM ${NODE_IMAGE} AS web
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY core ./core
COPY web ./web
RUN npm run build

FROM ${NODE_IMAGE} AS runtime

# chromium: sr.browser and builder probes (driven by playwright-core, headless).
# bubblewrap: actor sandbox (works only when the container allows user namespaces; see compose).
# python3 + uv: Python actors. util-linux provides prlimit. tini reaps Chromium's children.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates tini python3 bubblewrap util-linux \
      chromium fonts-liberation fonts-dejavu-core fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/*

COPY --from=uv /uv /uvx /usr/local/bin/

# yt-dlp as a standalone tool (its own venv under /opt), on PATH for the host side.
RUN UV_TOOL_DIR=/opt/uv-tools UV_TOOL_BIN_DIR=/usr/local/bin UV_PYTHON_DOWNLOADS=never \
      uv tool install --python /usr/bin/python3 yt-dlp \
 && rm -rf /root/.cache

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY core ./core
COPY server ./server
COPY --from=web /app/web/dist ./web/dist

RUN mkdir -p /data && chown node:node /data

# Inside the container the server must listen on all interfaces so the published port reaches
# it. docker-compose.yml publishes that port on 127.0.0.1 of the host only.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    ALLOW_NON_LOCAL=1 \
    SR_TRUST_NETWORK=1 \
    PORT=4317 \
    SOCIAL_READER_DATA=/data \
    CHROMIUM_PATH=/usr/bin/chromium \
    HOME=/home/node

USER node
VOLUME ["/data"]
EXPOSE 4317

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||4317)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/main.ts"]
