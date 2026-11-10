# One Dockerfile, one stage per service:
#   docker build -f deploy/Dockerfile --target api       -t qa-platform-api .
#   docker build -f deploy/Dockerfile --target dashboard -t qa-platform-dashboard .
#   docker build -f deploy/Dockerfile --target runner    -t qa-platform-runner .
# (deploy/docker-compose.yml builds all three.)

# ── Dependencies: the API, shared types and the engine's runtime packages ──────
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/runner/package.json apps/runner/
COPY apps/dashboard/package.json apps/dashboard/
RUN npm ci --omit=dev --no-audit --no-fund -w @qa/api -w @qa/shared -w @qa/runner --include-workspace-root

# ── API (also used for the one-shot migrate step) ──────────────────────────────
FROM node:22-bookworm-slim AS api
ENV NODE_ENV=production PORT=4100
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
USER node
EXPOSE 4100
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import", "tsx", "apps/api/src/server.ts"]

# ── Dashboard: build once, serve static files with nginx ──────────────────────
FROM node:22-bookworm-slim AS dashboard-build
# Shown on the terms and privacy pages
ARG VITE_OPERATOR_NAME=""
ARG VITE_CONTACT_EMAIL=""
ENV VITE_OPERATOR_NAME=$VITE_OPERATOR_NAME VITE_CONTACT_EMAIL=$VITE_CONTACT_EMAIL
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared packages/shared
COPY apps/dashboard apps/dashboard
COPY apps/api/package.json apps/api/
COPY apps/runner/package.json apps/runner/
RUN npm ci --no-audit --no-fund -w @qa/dashboard -w @qa/shared --include-workspace-root \
 && npm run build -w @qa/dashboard

FROM nginx:1.27-alpine AS dashboard
COPY deploy/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=dashboard-build /app/apps/dashboard/dist /usr/share/nginx/html
ENV API_UPSTREAM=api:4100
EXPOSE 8080

# ── Hosted runner: the engine plus Chromium for dashboard checks ──────────────
FROM mcr.microsoft.com/playwright:v1.63.0-noble AS runner
ENV NODE_ENV=production QA_CHROMIUM_ARGS="--no-sandbox --disable-dev-shm-usage"
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY packages/shared packages/shared
COPY src src
COPY apps/runner apps/runner
USER pwuser
CMD ["node", "--import", "tsx", "apps/runner/src/main.ts"]
