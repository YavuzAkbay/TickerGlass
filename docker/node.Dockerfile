# Shared build stage for the web app and the alerts service (pnpm workspace).
FROM node:22-slim AS build
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
RUN pnpm -r build

FROM nginx:1.29-alpine AS web
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 80

FROM node:22-slim AS alerts
WORKDIR /app
COPY --from=build /repo/services/alerts/dist ./dist
USER node
CMD ["node", "dist/index.js"]
