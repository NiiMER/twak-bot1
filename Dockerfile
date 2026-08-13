# PLIMSOLL trading agent — 24/7 container image (Railway / any Docker host).
# Runs the continuous live runner (`npm run dev` → tsx src/agent.ts → runContinuous).
FROM node:22-slim

# git + ca-certs for any runtime fetches; base64/sh come with the image.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# The TWAK CLI is the sole signing/execution path — install the exact pinned version.
RUN npm install -g @trustwallet/cli@0.17.0

WORKDIR /app

# Install deps first (cache layer). tsx is a devDependency, so include dev deps.
COPY package.json package-lock.json ./
RUN npm ci --include=dev

# App source. constitution.json (loadConstitution) and universe.yaml
# (loadUniverse) are both READ AT RUNTIME — without them the agent refuses to
# start, so they must be in the image, not just the repo.
COPY tsconfig.json ./
COPY constitution.json ./
COPY universe.yaml ./
COPY src ./src
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

# Persistent state (weights/peak/positions/ledger/snapshot) lives here — mount a
# Railway volume at this path so learning + the drawdown floor survive restarts.
ENV PLIMSOLL_STATE_DIR=/data

ENTRYPOINT ["./docker-entrypoint.sh"]
