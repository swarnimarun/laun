# Single Dockerfile for all cloudbear services (Bun runs TS directly — no build step).
# Usage (from repo root):
#   docker build -f deploy/Dockerfile --build-arg APP=apps/gateway -t cloudbear-gateway .
ARG APP=apps/gateway
FROM oven/bun:1.4 AS base
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates git && rm -rf /var/lib/apt/lists/*

# Pi CLI is required only in the executor image.
ARG APP
RUN if [ "$APP" = "apps/executor" ]; then \
      curl -fsSL https://pi.dev/install.sh | sh; \
      command -v pi || echo "WARNING: pi not on PATH after install — set PI_BIN explicitly"; \
    fi
# OpenShell is best-effort at build time (needs Linux + container runtime on the host to be useful).
# If this step fails, the executor still runs with OPENSHELL_ENABLED=false.
RUN if [ "$APP" = "apps/executor" ]; then \
      curl -LsSf https://raw.githubusercontent.com/NVIDIA/OpenShell/main/install.sh | sh || echo "openshell install skipped"; \
    fi

WORKDIR /app
COPY package.json bun.lock ./
COPY packages ./packages
COPY apps ./apps
RUN bun install --frozen-lockfile

ENV NODE_ENV=production
CMD ["sh", "-c", "bun ${APP}/src/index.ts"]
