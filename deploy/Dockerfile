# One comprehensive image for every laun service (Bun runs TS directly — no build step).
# Gateway, executor, and telegram-bridge all run from this image; compose selects the
# entrypoint with `command:` (see deploy/docker-compose.yml). The executor's agent
# tooling (Node, pi, ripgrep, fd, OpenShell) is baked in unconditionally so the image
# is usable in any of those roles without separate variants.
# Usage (from repo root):
#   docker build -f deploy/Dockerfile -t laun .
FROM oven/bun:1.4 AS base
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates git && rm -rf /var/lib/apt/lists/*

# Node 24 + pi: pi.dev's installer refuses to run without Node >= 22.19 and a TTY —
# exactly what a Docker build lacks — so install pi from npm instead and FAIL the
# build if it is missing. The previous `|| echo WARNING` shipped an image with no
# agent in it at all. ripgrep + fd ship too, so pi never has to fetch them at
# runtime (blocked inside a sandbox).
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && \
    apt-get install -y --no-install-recommends nodejs ripgrep fd-find && \
    ln -sf /usr/bin/fdfind /usr/local/bin/fd && \
    npm install -g --ignore-scripts @earendil-works/pi-coding-agent && \
    command -v pi >/dev/null && pi --version && \
    rm -rf /var/lib/apt/lists/*

# OpenShell is best-effort at build time (needs Linux + container runtime on the host to be useful).
# If this step fails, services still run with OPENSHELL_ENABLED=false.
RUN curl -LsSf https://raw.githubusercontent.com/NVIDIA/OpenShell/main/install.sh | sh || echo "openshell install skipped"

WORKDIR /app
COPY package.json bun.lock ./
COPY packages ./packages
COPY apps ./apps
COPY vendor ./vendor
# Rendered OpenShell policy (no secrets — hosts and paths only). The executor
# reads it via OPENSHELL_POLICY when sandboxing is enabled.
COPY deploy/openshell/policy.yaml /openshell/policy.yaml
RUN bun install --frozen-lockfile

ENV NODE_ENV=production
# Default entrypoint is the gateway; compose overrides this per service.
CMD ["bun", "apps/gateway/src/index.ts"]
