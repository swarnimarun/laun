# Bun runs the TypeScript services and the exact-pinned Pi CLI directly.
FROM docker.io/oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS base
USER root
ARG PI_VERSION=1.5.2
ENV BUN_INSTALL=/opt/pi
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash curl ca-certificates git openssh-client ripgrep fd-find tar \
    && ln -sf /usr/bin/fdfind /usr/local/bin/fd \
    && rm -rf /var/lib/apt/lists/*

# Pi's package bin has a Node shebang; this explicit launcher chooses Bun.
RUN bun add --global --ignore-scripts "@earendil-works/pi-coding-agent@${PI_VERSION}" \
    && rm -f /usr/local/bin/pi \
    && printf '%s\n' '#!/bin/sh' 'exec bun /opt/pi/install/global/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js "$@"' > /usr/local/bin/pi \
    && chmod 755 /usr/local/bin/pi \
    && pi --version

# The container is an OpenShell client; its host runs the separately provisioned
# gateway. Install the exact portable CLI with release-published asset digests.
COPY deploy/openshell/install-cli.sh /usr/local/lib/laun/install-openshell-cli.sh
RUN sh /usr/local/lib/laun/install-openshell-cli.sh /usr/local/bin

WORKDIR /app
COPY package.json bun.lock ./
COPY packages ./packages
COPY apps ./apps
COPY vendor ./vendor
COPY deploy/openshell/policy.yaml /openshell/policy.yaml
RUN bun install --frozen-lockfile --ignore-scripts
ENV NODE_ENV=production
CMD ["bun", "apps/gateway/src/index.ts"]
