# All-in-one image: API + alerts service + nginx (web) in one container, for single-container
# app UIs (Unraid, CasaOS). docs/design/app-store-templates.md. Build from the repo root:
#   docker build -f docker/aio.Dockerfile -t tickerglass .
# Both base images are pinned to the same Debian release: the alerts service's native addon
# (isolated-vm prebuilt binary) is built against that glibc, and the Node binary is copied from
# the node image into the python image.

# --- web + alerts bundles -----------------------------------------------------------------
# Same steps as the `build` stage of docker/node.Dockerfile; keep the two in sync.
FROM node:24-bookworm-slim AS node-build
ARG TICKERGLASS_VERSION=dev
ENV TICKERGLASS_VERSION=${TICKERGLASS_VERSION}
RUN npm install -g pnpm@12
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY packages/alerts/package.json packages/alerts/
COPY packages/engine/package.json packages/engine/
COPY packages/indicators/package.json packages/indicators/
COPY services/alerts/package.json services/alerts/
RUN pnpm install --frozen-lockfile
COPY apps ./apps
COPY packages ./packages
COPY services ./services
COPY VERSION ./VERSION
RUN pnpm -r build
RUN pnpm --filter @tickerglass/alerts-service deploy --prod /deploy

# --- API virtualenv -----------------------------------------------------------------------
# Same steps as api/Dockerfile.
FROM python:3.11-slim-bookworm AS api-build
ARG TICKERGLASS_VERSION=""
COPY --from=ghcr.io/astral-sh/uv:0.13 /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PROJECT_ENVIRONMENT=/opt/venv \
    TICKERGLASS_VERSION=${TICKERGLASS_VERSION}
WORKDIR /app
COPY api/pyproject.toml api/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY api/src ./src
RUN uv sync --frozen --no-dev

# Node runtime only (no npm/corepack): the alerts bundle needs nothing else.
FROM node:24-bookworm-slim AS node-runtime

# --- runtime ------------------------------------------------------------------------------
FROM python:3.11-slim-bookworm
RUN apt-get update \
    && apt-get install -y --no-install-recommends nginx gettext-base tini libstdc++6 \
    && rm -rf /var/lib/apt/lists/* /etc/nginx/sites-enabled /etc/nginx/conf.d/*
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
# uv installs the project editable: the venv points at /app/src, so both are copied.
COPY --from=api-build /opt/venv /opt/venv
COPY --from=api-build /app/src /app/src
COPY --from=node-build /deploy/node_modules /app/alerts/node_modules
COPY --from=node-build /repo/services/alerts/dist /app/alerts/dist
COPY --from=node-build /repo/apps/web/dist /usr/share/nginx/html
COPY docker/nginx.conf.template /etc/tickerglass/nginx.conf.template
COPY docker/aio/nginx-aio.conf /etc/tickerglass/nginx-aio.conf
COPY docker/aio/entrypoint.sh /usr/local/bin/tickerglass-aio

ENV PATH="/opt/venv/bin:$PATH" \
    DATABASE_URL=sqlite:////data/tickerglass.db \
    PUID=1000 PGID=1000
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --start-interval=1s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/api/health/ready')"]
ENTRYPOINT ["tini", "--", "/usr/local/bin/tickerglass-aio"]
