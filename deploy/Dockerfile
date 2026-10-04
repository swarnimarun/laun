# Single Dockerfile for all laun services (Bun runs TS directly — no build step).
# Usage (from repo root):
#   docker build -f deploy/Dockerfile --build-arg APP=apps/gateway -t laun-gateway .
ARG APP=apps/gateway
FROM oven/bun:1.4 AS base
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates git && rm -rf /var/lib/apt/lists/*

# Pi CLI is required only in the executor image.
# pi.dev's installer refuses to run without Node >= 22.19 and a TTY — exactly
# what a Docker build lacks — so install pi from npm instead and FAIL the build
# if it is missing. The previous `|| echo WARNING` shipped an executor image
# with no agent in it at all. ripgrep + fd ship too, so pi never has to fetch
# them at runtime (blocked inside a sandbox).
ARG APP
RUN if [ "$APP" = "apps/executor" ]; then \
      curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && \
      apt-get install -y --no-install-recommends nodejs ripgrep fd-find && \
      ln -sf /usr/bin/fdfind /usr/local/bin/fd && \
      npm install -g --ignore-scripts @earendil-works/pi-coding-agent && \
      command -v pi >/dev/null && pi --version && \
      rm -rf /var/lib/apt/lists/*; \
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
COPY vendor ./vendor
RUN bun install --frozen-lockfile

# Persist the build arg as a runtime env (ARGs alone don't survive into the container).
ENV APP=${APP}
ENV NODE_ENV=production
CMD ["sh", "-c", "bun ${APP}/src/index.ts"]
