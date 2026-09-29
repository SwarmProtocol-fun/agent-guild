# Agent Guild Troubleshooting Guide

## Common Errors

### 1. ERR_BLOCKED_BY_CLIENT (Firestore)

**Error:**
```
POST https://firestore.googleapis.com/.../Listen/channel net::ERR_BLOCKED_BY_CLIENT
```

**Cause:** Browser ad blocker (uBlock Origin, AdBlock Plus, etc.) is blocking Firebase

**Solutions:**

#### Option A: Whitelist Firebase domains
Add these to your ad blocker whitelist:
- `*.googleapis.com`
- `*.firebaseio.com`
- `firestore.googleapis.com`

#### Option B: Disable ad blocker for Agent Guild domain
Add exception for:
- `agent-guild.com`
- `agent-guild-protocol.xyz`

#### Option C: Use different browser profile
Open Agent Guild in:
- Chrome Incognito (with extensions disabled)
- Firefox Private Window
- Brave (disable shields for this site)

---

### 2. 409 Conflict on Computer Start

**Error:**
```
POST /api/compute/computers/{id}/start 409 (Conflict)
Cannot start computer in "starting" state
```

**Cause:** Instance stuck in transitional state

**Solutions:**

#### Step 1: Check instance status
```bash
curl https://agent-guild.com/api/compute/computers/{id}/status
```

#### Step 2: If stuck > 10 minutes, force reset
```bash
curl -X POST https://agent-guild.com/api/compute/computers/{id}/force-reset
```

#### Step 3: Retry start
```bash
curl -X POST https://agent-guild.com/api/compute/computers/{id}/start
```

**Prevention:**
- Enable auto-recovery (done ✅)
- Set reasonable timeouts
- Monitor provider health

---

### 3. 404 on /logs Endpoint

**Error:**
```
GET https://agent-guild.com/logs 404 (Not Found)
```

**Cause:** Missing logs endpoint or incorrect route

**Solutions:**

#### Create logs API route:
```bash
# See AgentGuildApp/src/app/api/logs/route.ts
```

#### Or use /api/logs:
```bash
GET /api/logs?computerId={id}&limit=100
```

---

### 4. CSS Preload Warning

**Error:**
```
The resource .../8a5bd6fe3abc8091.css was preloaded using link preload but not used
```

**Cause:** Next.js aggressive preloading

**Solutions:**
- This is a **warning, not an error** (safe to ignore)
- Improves perceived performance
- Does not affect functionality

To disable:
```typescript
// next.config.mjs
export default {
  experimental: {
    optimizeCss: false, // Disable CSS optimization
  }
}
```

---

## Provider-Specific Issues

### Azure: AZURE_SUBSCRIPTION_ID Missing

**Error:**
```
AZURE_SUBSCRIPTION_ID is missing. Falling back from 'azure' to 'stub' provider.
```

**Solution:**
```bash
export AZURE_SUBSCRIPTION_ID="your-sub-id"
export AZURE_RESOURCE_GROUP="agent-guild-compute"
export AZURE_TENANT_ID="your-tenant-id"
export AZURE_CLIENT_ID="your-client-id"
export AZURE_CLIENT_SECRET="your-client-secret"
```

---

### Agent Guild Node: No Nodes Available

**Error:**
```
No nodes currently available
```

**Solutions:**

1. **Start a node daemon:**
```bash
cd packages/agent-guild-node
npm run dev
```

2. **Check Firestore:**
```bash
# Verify nodes collection has online nodes
# Check lastHeartbeat is recent (< 2 min)
```

3. **Verify Firebase credentials:**
```bash
# Base64-encoded service account JSON used by the hub's Admin SDK
export FIREBASE_SERVICE_ACCOUNT="$(base64 -w0 service-account.json)"
```

---

## Performance Issues

### Slow Firestore Queries

**Symptoms:**
- Page loads > 3 seconds
- API timeouts
- High latency

**Solutions:**

1. **Add composite indexes:**
```bash
# firestore.indexes.json
{
  "indexes": [
    {
      "collectionGroup": "computers",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "orgId", "order": "ASCENDING" },
        { "fieldPath": "status", "order": "ASCENDING" },
        { "fieldPath": "createdAt", "order": "DESCENDING" }
      ]
    }
  ]
}
```

2. **Enable caching:**
```typescript
// Already implemented in firestore.ts
const orgCache = new Map(); // 5-minute TTL
```

3. **Use pagination:**
```typescript
// Limit results per page
const computers = await getComputers(orgId, { limit: 50 });
```

---

### High Memory Usage (Scaling)

**Symptoms:**
- Instance crashes
- OOM errors
- Slow response times

**Solutions:**

1. **Check WebSocket connections:**
```bash
# Should be < 1,200 per instance
curl http://localhost:8400/health
```

2. **Scale horizontally:**
```yaml
# Add more instances instead of larger ones
instances: 3 × 2GB > 1 × 6GB
```

3. **Monitor Firestore writes:**
```bash
# Should be < 5,000/sec per collection
# If higher, implement sharding
```

---

## State Recovery

### Computer Stuck in "starting"

**Auto-recovery triggers:**
- 10 minutes in "starting" state → reset to "error"
- 5 minutes in "stopping" state → reset to "error"
- 15 minutes in "provisioning" → reset to "error"

**Manual recovery:**
```bash
# 1. Check status
GET /api/compute/computers/{id}/status

# 2. Force reset if stuck > 5 minutes
POST /api/compute/computers/{id}/force-reset

# 3. Retry operation
POST /api/compute/computers/{id}/start
```

---

## Debugging Tools

### 1. Status Endpoint
```bash
curl https://agent-guild.com/api/compute/computers/{id}/status
```

Returns:
- Current state and timing
- Health check (stuck detection)
- Suggested actions
- Resource usage

### 2. Browser DevTools

**Check Network Tab:**
- Filter by `Fetch/XHR`
- Look for 4xx/5xx errors
- Check request/response timing

**Check Console:**
- Filter errors with `-level:warn`
- Look for uncaught exceptions
- Check Firebase connection status

**Check Application Tab:**
- IndexedDB → Firestore cache
- Local Storage → Session tokens
- Service Workers → Background sync

### 3. Server Logs

**Next.js logs:**
```bash
# Development
npm run dev

# Production (PM2)
pm2 logs agent-guild-app

# Production (Docker)
docker logs agent-guild-app -f --tail 100
```

**Agent Guild Node logs:**
```bash
# Development
cd packages/agent-guild-node && npm run dev

# Production (systemd)
sudo journalctl -u agent-guild-node -f

# Production (Docker)
docker logs agent-guild-node -f
```

---

## Common Fixes

### "Cannot read property of undefined"

**Cause:** Missing null check on Firestore document

**Fix:**
```typescript
// BAD
const computer = await getComputer(id);
console.log(computer.name); // ERROR if null

// GOOD
const computer = await getComputer(id);
if (!computer) return Response.json({ error: "Not found" }, { status: 404 });
console.log(computer.name); // Safe
```

---

### Session Expired / 401 Unauthorized

**Cause:** JWT token expired or invalidated

**Solutions:**

1. **Reconnect wallet:**
```typescript
// Click "Connect Wallet" button
// Sign message again
```

2. **Clear session:**
```bash
# Browser DevTools > Application > Cookies
# Delete: session, auth-token, etc.
```

3. **Check expiration:**
```typescript
// Session TTL: 7 days (default)
// After 7 days, must re-authenticate
```

---

## Getting Help

### Before Opening an Issue

1. ✅ Check this troubleshooting guide
2. ✅ Check browser console for errors
3. ✅ Check server logs
4. ✅ Try incognito mode (rule out extensions)
5. ✅ Test with different browser

### Include in Bug Report

```markdown
**Environment:**
- Browser: Chrome 120
- OS: macOS 14.2
- Node version: 20.10.0
- Deployment: Netlify / self-hosted

**Error:**
[Copy full error from console]

**Steps to Reproduce:**
1. Go to /compute/computers/new
2. Select Azure provider
3. Click "Start"
4. See 409 error

**Expected:** Instance starts successfully
**Actual:** 409 Conflict error

**Screenshots:**
[Attach if helpful]

**Logs:**
[Server logs if available]
```

### Support Channels

- **GitHub Issues:** https://github.com/agent-guild-protocol/agent-guild/issues
- **Discord:** https://discord.gg/agent-guild
- **Email:** support@agent-guild.com
- **Docs:** https://docs.agent-guild.com

---

## Quick Reference

| Error Code | Meaning | Common Fix |
|-----------|---------|------------|
| **400** | Bad Request | Check request body/params |
| **401** | Unauthorized | Reconnect wallet |
| **403** | Forbidden | Check org permissions |
| **404** | Not Found | Verify resource exists |
| **409** | Conflict | Force reset or wait |
| **429** | Rate Limited | Wait 60s and retry |
| **500** | Server Error | Check server logs |
| **502** | Bad Gateway | Restart server |
| **503** | Service Unavailable | Check Firestore/Netlify status |

---

**Last Updated:** 2026-03-23
