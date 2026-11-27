# Build from the repository root: docker build -f packages/guard/Dockerfile .
FROM node:22-alpine AS build
WORKDIR /app
COPY tsconfig.base.json ./
COPY packages/core/package.json packages/core/tsconfig.json packages/core/tsconfig.build.json packages/core/
RUN cd packages/core && npm install --no-audit --no-fund
COPY packages/core/src packages/core/src
RUN cd packages/core && npm run build
COPY packages/guard/package.json packages/guard/tsconfig.json packages/guard/tsconfig.build.json packages/guard/
RUN cd packages/guard && npm install --no-audit --no-fund
COPY packages/guard/src packages/guard/src
RUN cd packages/guard && npm run build \
 && npm prune --omit=dev --no-audit --no-fund \
 && cd ../core && npm prune --omit=dev --no-audit --no-fund

FROM node:22-alpine
LABEL org.opencontainers.image.source="https://github.com/itssaharsh/alibi" org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production PORT=4319 ALIBI_DATA=/data
RUN mkdir /data && chown node:node /data
WORKDIR /app/packages
COPY --from=build /app/packages/core/package.json core/package.json
COPY --from=build /app/packages/core/dist core/dist
COPY --from=build /app/packages/guard/package.json guard/package.json
COPY --from=build /app/packages/guard/dist guard/dist
COPY --from=build /app/packages/guard/node_modules guard/node_modules
USER node
WORKDIR /app/packages/guard
VOLUME /data
EXPOSE 4319
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD wget -q --spider "http://127.0.0.1:${PORT}/healthz" || exit 1
CMD ["node", "dist/main.js"]
