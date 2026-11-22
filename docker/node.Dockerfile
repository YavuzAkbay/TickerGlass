# Shared build stage for the web app and the alerts service (pnpm workspace).
# Node 24: the alerts service's script isolates (isolated-vm 7) need it; the package ships
# prebuilt binaries for Node 24 and 26 on linux x64/arm64 (glibc and musl), so no compiler here.
FROM node:24-slim AS build
# Release tag, stamped into the alerts service bundle (esbuild define) — see
# .github/workflows/release.yml. Empty/dev falls back to "dev" in the bundle.
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
# Release version: the vite config reads this when TICKERGLASS_VERSION is empty
# (compose passes an empty build arg unless overridden — see .github/workflows/release.yml).
COPY VERSION ./VERSION
RUN pnpm -r build
# Production node_modules of the alerts service: only the native addon (isolated-vm) and what it
# loads. Everything else is bundled into dist/index.js.
RUN pnpm --filter @tickerglass/alerts-service deploy --prod /deploy

FROM nginx:1.29-alpine AS web
# The official image renders /etc/nginx/templates/*.template into conf.d at start (envsubst over
# the defined env vars; nginx's own $host etc. are not env vars and survive).
COPY docker/nginx.conf.template /etc/nginx/templates/default.conf.template
# NGINX_ENVSUBST_FILTER: substitute only TG_* variables. Without it every env var of the
# container would be, so e.g. `-e host=x` would rewrite nginx's own $host.
ENV TG_LISTEN_PORT=80 TG_API_UPSTREAM=api:8000 NGINX_ENVSUBST_FILTER=^TG_
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 80

FROM node:24-slim AS alerts
WORKDIR /app
COPY --from=build /deploy/node_modules ./node_modules
# dist/index.js (service) and dist/isolate.js (the script runtime evaluated inside each isolate)
COPY --from=build /repo/services/alerts/dist ./dist
USER node
# isolated-vm needs --no-node-snapshot on Node 20+ (its README).
CMD ["node", "--no-node-snapshot", "dist/index.js"]
