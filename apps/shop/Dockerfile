# Build from the repository root: docker build -f apps/shop/Dockerfile .
# The shop uses the helpers from packages/otel-helpers, so that folder is copied in next to it.
FROM node:22-alpine
WORKDIR /app/apps/shop
ENV NODE_ENV=production
COPY packages/otel-helpers /app/packages/otel-helpers
COPY apps/shop/package.json apps/shop/package-lock.json apps/shop/.npmrc ./
RUN npm ci --omit=dev
COPY apps/shop/src ./src
USER node
EXPOSE 8080
CMD ["node", "--import", "./src/telemetry.js", "./src/server.js"]
