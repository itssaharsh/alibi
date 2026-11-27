# Build from the repository root: docker build -f apps/web/Dockerfile -t alibi-board .
# The page uses the engine from packages/core source and the recorded runs from runs/, so both are copied in.
FROM node:22-alpine AS build
WORKDIR /repo
COPY tsconfig.base.json ./
COPY apps/web/package.json apps/web/
RUN cd apps/web && npm install --no-audit --no-fund
COPY packages/core packages/core
COPY runs runs
COPY apps/web apps/web
# The page opens as a live board against the guard the same web server forwards /api/ to.
# The live board links each open request to Jaeger, which the stack publishes on this address.
RUN cd apps/web && VITE_LIVE_SAME_ORIGIN=1 VITE_JAEGER_URL=http://127.0.0.1:16686 npm run build

FROM nginxinc/nginx-unprivileged:1.27-alpine
LABEL org.opencontainers.image.source="https://github.com/itssaharsh/alibi" org.opencontainers.image.licenses="MIT"
# Server-sent events (/api/events) must not be buffered: buffering would hold every event until the stream ends.
RUN cat > /etc/nginx/conf.d/default.conf <<'CONF'
server {
  listen 4173;
  root /usr/share/nginx/html;
  location /api/ {
    proxy_pass http://alibi:4319;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 1h;
  }
  location / {
    try_files $uri $uri/ /index.html;
  }
}
CONF
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 4173
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD wget -q --spider http://127.0.0.1:4173/ || exit 1
