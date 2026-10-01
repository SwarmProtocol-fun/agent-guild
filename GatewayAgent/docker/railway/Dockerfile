# agent-guild-gateway-railway — single-image GatewayAgent worker for PaaS
# hosts (Railway, Render, etc.) that don't expose a Docker socket, so the
# worker can't shell out to `docker run` like the comfyui/docker task types
# do. Bundles Node (for gateway.mjs) and Python + hyperliquid-python-sdk
# (for the hyperliquid task type's place_order.py) in one image, and the
# hyperliquid executor invokes place_order.py as a direct subprocess instead
# of a nested container (see scripts/executors/hyperliquid.mjs).
#
# Build context must be the GatewayAgent/ directory — set Railway's service
# Root Directory to "GatewayAgent" and dockerfilePath to
# "docker/railway/Dockerfile" (see railway.json), or locally:
#   docker build -f docker/railway/Dockerfile -t agent-guild-gateway-railway .
FROM node:20-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*

# Debian's system pip refuses installs outside a venv (PEP 668) — give
# hyperliquid-python-sdk its own venv and put it first on PATH so the
# executor's plain `python3` resolves here.
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:${PATH}"
RUN pip install --no-cache-dir hyperliquid-python-sdk==0.*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts || npm install --omit=dev --ignore-scripts

COPY scripts/ ./scripts/
COPY docker/hyperliquid/place_order.py ./docker/hyperliquid/place_order.py
COPY docker/railway/entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

# No HTTP port — this is a background worker (WS client to the hub), not a
# web service. In Railway, set this service's type accordingly / omit a
# healthcheckPath in railway.json.
CMD ["./entrypoint.sh"]
