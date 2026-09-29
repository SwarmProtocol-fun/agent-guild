# Build context must be AgentGuildConnect/ (the parent of this fleet/ dir) so this
# Dockerfile can see both scripts/ and fleet/ — set Railway's service Root Directory
# to "AgentGuildConnect" and dockerfilePath to "fleet/Dockerfile" (see railway.json).
FROM node:20-alpine

WORKDIR /app

# Zero runtime dependencies (see ../package.json) — just copy source, preserving the
# scripts/ + fleet/ sibling layout that fleet.mjs's relative paths assume.
COPY scripts ./scripts
COPY fleet ./fleet

WORKDIR /app/fleet

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8080/health', (r) => r.statusCode === 200 ? process.exit(0) : process.exit(1))"

CMD ["node", "fleet.mjs"]
