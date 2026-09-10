FROM ghcr.io/cloud-cli/image-node:latest AS cloud-node

FROM docker.io/node:24-bookworm-slim

LABEL org.opencontainers.image.source="https://github.com/apphorde/classy"

ENV PIP_BREAK_SYSTEM_PACKAGES=1
ENV HOME=/home/node

USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    build-essential \
    ca-certificates \
    curl \
    ffmpeg \
    git \
    nano \
    openssh-client \
    python3 \
    python3-pip \
  && rm -rf /var/lib/apt/lists/*

# Preserve Cloud CLI's hooks, import-map support, and entrypoint behavior.
COPY --from=cloud-node /home/node /home/node

RUN npm install --global npm@latest foreman@latest \
  && corepack enable \
  && corepack prepare pnpm@latest --activate \
  && mkdir -p /home/app \
  && chown -R node:node /home

WORKDIR /home/app
COPY --chown=node:node . .

RUN pnpm install --node-linker=hoisted \
  && pip3 install --no-cache-dir -r requirements.txt

USER node
ENV PATH="$PATH:/home/node/npm/bin:/home/app/node_modules/.bin"
ENV NODE_OPTIONS="--no-warnings --import file:///home/node/hooks.mjs"
ENTRYPOINT ["/bin/bash", "/home/node/entrypoint.sh"]
