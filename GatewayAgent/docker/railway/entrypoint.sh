#!/bin/sh
# Registers this worker with the hub (idempotent — safe to run on every boot)
# then starts the daemon. Railway restarts the container on crash/redeploy
# with a fresh filesystem (no persistent volume by default), so this worker
# re-registers as a new identity each time rather than resuming a prior one.
set -e

node scripts/gateway.mjs register
exec node scripts/gateway.mjs daemon
