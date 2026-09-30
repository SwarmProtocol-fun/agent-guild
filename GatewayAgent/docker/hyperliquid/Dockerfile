# agent-guild-hyperliquid — minimal image for GatewayAgent's hyperliquid.mjs executor.
# Build: docker build -t agent-guild-hyperliquid:latest GatewayAgent/docker/hyperliquid
FROM python:3.11-slim

RUN pip install --no-cache-dir hyperliquid-python-sdk==0.*

WORKDIR /app
COPY place_order.py .

ENTRYPOINT ["python", "place_order.py"]
