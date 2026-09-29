# The puck-server image. Build from the repository root:
#   docker build -f src/server/Dockerfile -t puck-server .
#
# Configuration comes from the environment (see src/server/config.ts);
# no secret is baked in. Supply the GitHub App's client secret and private
# key, and the token key, at run time as variables or as *_FILE paths to
# mounted secret files. The store lives on /data.
#
# The development image (--build-arg PUCK_DEVELOPMENT=true, what compose.yaml
# builds) also carries this version's runner packages (linux-x64,
# linux-arm64, macos-arm64, each with its pinned and sha256-checked Node
# runtime) and runs the server in development mode, serving them from
# PUCK_RUNNER_DOWNLOADS. The default image carries no runner packages and
# never serves any.
ARG PUCK_DEVELOPMENT=false

# The sources both bundles share.
FROM node:22.23.3-bookworm-slim AS deps
WORKDIR /src
COPY package.json package-lock.json ./
# Only the bundler needs the dev dependencies; skip install scripts so the
# Electron binary is never downloaded.
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY src/channel src/channel
COPY src/harness src/harness

FROM deps AS build
COPY scripts/build-server.mjs scripts/
COPY src/server src/server
RUN node scripts/build-server.mjs

# The runner packages, built only for the development image. Nothing here
# runs a target binary, so any build host architecture packages all three. The cache mount keeps the downloaded Node
# archives across rebuilds; the script checks their sha256 before every use.
FROM deps AS runner
COPY LICENSE ./
COPY scripts/build-runner.mjs scripts/package-runner.mjs scripts/
COPY src/puck-runner src/puck-runner
RUN --mount=type=cache,target=/src/.cache/runner-node \
    node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/package-runner.mjs --out /src/runner-downloads

FROM node:22.23.3-bookworm-slim AS server-false
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

FROM server-false AS server-true
COPY --from=runner /src/runner-downloads /app/runner-downloads
ENV PUCK_DEVELOPMENT=true \
    PUCK_RUNNER_DOWNLOADS=/app/runner-downloads

# The image: server-false by default, server-true for development. BuildKit
# builds only the stages the chosen one needs.
FROM server-${PUCK_DEVELOPMENT}
