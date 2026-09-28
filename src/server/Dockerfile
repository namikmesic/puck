# The puck-server image. Build from the repository root:
#   docker build -f src/server/Dockerfile -t puck-server .
#
# Configuration comes from the environment (see src/server/config.ts);
# no secret is baked in. Supply the GitHub App's client secret and private
# key, and the token key, at run time as variables or as *_FILE paths to
# mounted secret files. The store lives on /data.

FROM node:22.23.3-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
# Only the bundler needs the dev dependencies; skip install scripts so the
# Electron binary is never downloaded.
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY scripts/build-server.mjs scripts/
COPY src/server src/server
COPY src/channel src/channel
COPY src/harness src/harness
RUN node scripts/build-server.mjs

FROM node:22.23.3-bookworm-slim
ENV NODE_ENV=production \
    PUCK_SERVER_HOST=0.0.0.0 \
    PUCK_SERVER_PORT=8080 \
    PUCK_SERVER_DB=/data/puck-server.db
WORKDIR /app
COPY --from=build /src/.webpack/server/puck-server.js /src/.webpack/server/puck-server.meta.json ./
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --start-interval=1s --retries=3 \
  CMD ["node", "/app/puck-server.js", "health"]
CMD ["node", "--disable-warning=ExperimentalWarning", "/app/puck-server.js"]
