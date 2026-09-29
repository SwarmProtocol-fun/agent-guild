# Swarm Configuration Guide

Complete guide to configuring environment variables for production deployment.

## Table of Contents
1. [Next.js Application Configuration](#nextjs-application-configuration)
2. [WebSocket Hub Configuration](#websocket-hub-configuration)
3. [Firebase Setup](#firebase-setup)
4. [Cloud Pub/Sub Setup](#cloud-pubsub-setup)
5. [Security Best Practices](#security-best-practices)
6. [Environment Validation](#environment-validation)

---

## Next.js Application Configuration

### `.env.local` File

Create `/home/god/Desktop/Swarm/Swarm/SwarmApp/.env.local`:

```bash
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# CRITICAL - Session Management
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# JWT signing secret - MUST be 32+ characters
# Generate with: openssl rand -hex 32
SESSION_SECRET=your-64-char-hex-secret-here

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# CRITICAL - Firebase Configuration
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

FIREBASE_API_KEY=your-firebase-api-key
FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_APP_ID=1:123456789:web:abc123def456

# Optional Firebase settings
FIREBASE_STORAGE_BUCKET=your-project.appspot.com
FIREBASE_MESSAGING_SENDER_ID=123456789

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# CRITICAL - WalletConnect / Reown (Wallet Connection)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

NEXT_PUBLIC_REOWN_PROJECT_ID=your-reown-project-id  # https://cloud.reown.com

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# OPTIONAL - Platform Administration
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# Comma-separated wallet addresses with platform admin access
PLATFORM_ADMIN_WALLETS=0x1234567890abcdef1234567890abcdef12345678,0xabcdef1234567890abcdef1234567890abcdef12

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# OPTIONAL - Rate Limiting
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# Rate limit window in milliseconds (default: 60000 = 1 minute)
RATE_LIMIT_WINDOW_MS=60000

# Max requests per window (default: 10)
RATE_LIMIT_MAX=10

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# OPTIONAL - Application Settings
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

NODE_ENV=production
```

### Generating SESSION_SECRET

**Using OpenSSL** (Recommended):
```bash
openssl rand -hex 32
```

**Using Node.js**:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**Using Python**:
```bash
python3 -c "import secrets; print(secrets.token_hex(32))"
```

**Example Output**:
```
886b5cf51814b3e00524e93724c2192a2dd86598d5b46f18992478e915ae0706
```

---

## WebSocket Hub Configuration

### `.env` File

Create `/home/god/Desktop/Swarm/Swarm/hub/.env`:

```bash
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# CRITICAL - Server Configuration
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

PORT=8400
NODE_ENV=production

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# CRITICAL - Instance Identity
# MUST BE UNIQUE PER INSTANCE in multi-instance deployments
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

INSTANCE_ID=hub-us-east-1a
HUB_REGION=us-east
HUB_GATEWAY_ID=gateway-prod-1

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# CRITICAL - Firebase Configuration
# Must match Next.js app configuration
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

FIREBASE_API_KEY=your-firebase-api-key
FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_APP_ID=1:123456789:web:abc123def456

# Optional Firebase settings
FIREBASE_STORAGE_BUCKET=your-project.appspot.com
FIREBASE_MESSAGING_SENDER_ID=123456789

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# CRITICAL - CORS Security
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# Comma-separated list of allowed origins (NO WILDCARDS)
ALLOWED_ORIGINS=https://swarmprotocol.ai,https://app.swarmprotocol.ai,http://localhost:3000

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# OPTIONAL - Cloud Pub/Sub (Multi-Instance Only)
# Required for cross-instance broadcasting
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# Google Cloud project ID
GCP_PROJECT_ID=your-gcp-project-id

# Pub/Sub topic (same for all instances)
PUBSUB_TOPIC=swarm-broadcast

# Pub/Sub subscription (UNIQUE per instance)
PUBSUB_SUBSCRIPTION=swarm-broadcast-hub-us-east-1a

# Path to service account JSON key
GOOGLE_APPLICATION_CREDENTIALS=/app/service-account.json

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# OPTIONAL - Rate Limiting & Security
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# Rate limit window in milliseconds (default: 60000 = 1 minute)
RATE_LIMIT_WINDOW_MS=60000

# Max requests per window per IP (default: 60)
RATE_LIMIT_MAX=60

# Max WebSocket connections per agent (default: 5)
MAX_CONNECTIONS_PER_AGENT=5

# Auth signature validity window in milliseconds (default: 5 minutes)
AUTH_WINDOW_MS=300000

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# OPTIONAL - Gateway Heartbeat
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

GATEWAY_HEARTBEAT_INTERVAL_MS=60000

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# OPTIONAL - Logging
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

LOG_LEVEL=info
ENABLE_METRICS=true
```

### Multi-Instance Configuration

For **each hub instance**, you MUST set unique values:

**Instance 1**:
```bash
INSTANCE_ID=hub-us-east-1a
PUBSUB_SUBSCRIPTION=swarm-broadcast-hub-us-east-1a
```

**Instance 2**:
```bash
INSTANCE_ID=hub-us-east-1b
PUBSUB_SUBSCRIPTION=swarm-broadcast-hub-us-east-1b
```

**Instance 3**:
```bash
INSTANCE_ID=hub-us-west-1a
PUBSUB_SUBSCRIPTION=swarm-broadcast-hub-us-west-1a
```

---

## Firebase Setup

### 1. Create Firebase Project

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Click "Add project"
3. Enter project name (e.g., "swarm-production")
4. Disable Google Analytics (optional)
5. Click "Create project"

### 2. Get Firebase Configuration

1. In Firebase Console, click gear icon → "Project settings"
2. Scroll to "Your apps" section
3. Click "Web" icon (</>) to add web app
4. Register app with nickname (e.g., "Swarm App")
5. Copy the configuration values:

```javascript
const firebaseConfig = {
  apiKey: "AIzaSyXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  authDomain: "your-project.firebaseapp.com",
  projectId: "your-project-id",
  storageBucket: "your-project.appspot.com",
  messagingSenderId: "123456789012",
  appId: "1:123456789012:web:abcdef123456"
};
```

6. Use these values in both `.env.local` (Next.js) and `.env` (Hub)

### 3. Enable Firestore

1. In Firebase Console, go to "Firestore Database"
2. Click "Create database"
3. Choose production mode
4. Select region (use same region as your app servers)
5. Click "Enable"

### 4. Configure Firestore Security Rules

Deploy these rules to Firebase:

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Rate limits - server-only
    match /rateLimits/{document=**} {
      allow read, write: if false;
    }

    // Auth nonces - server-only
    match /authNonces/{document=**} {
      allow read, write: if false;
    }

    // Sessions - server-only
    match /sessions/{document=**} {
      allow read, write: if false;
    }

    // System health check
    match /system/{document=**} {
      allow read: if true;
      allow write: if false;
    }

    // Organizations - authenticated users
    match /organizations/{orgId} {
      allow read: if request.auth != null;
      allow write: if request.auth != null &&
                   (request.auth.uid == resource.data.ownerAddress ||
                    request.auth.uid in resource.data.adminAddresses);
    }

    // Agents - authenticated users in org
    match /agents/{agentId} {
      allow read: if request.auth != null;
      allow write: if request.auth != null &&
                   request.auth.uid == resource.data.ownerAddress;
    }
  }
}
```

### 5. Enable Firestore TTL

Configure automatic cleanup of expired documents:

```bash
# Enable TTL on rateLimits collection
gcloud firestore fields ttls update expiresAt \
  --collection-group=rateLimits \
  --enable-ttl \
  --project=your-project-id

# Enable TTL on authNonces collection
gcloud firestore fields ttls update expiresAt \
  --collection-group=authNonces \
  --enable-ttl \
  --project=your-project-id
```

---

## Cloud Pub/Sub Setup

### 1. Create Service Account

```bash
# Create service account
gcloud iam service-accounts create swarm-hub \
  --display-name="Swarm Hub Service Account" \
  --project=your-project-id

# Grant Pub/Sub permissions
gcloud projects add-iam-policy-binding your-project-id \
  --member="serviceAccount:swarm-hub@your-project-id.iam.gserviceaccount.com" \
  --role="roles/pubsub.publisher"

gcloud projects add-iam-policy-binding your-project-id \
  --member="serviceAccount:swarm-hub@your-project-id.iam.gserviceaccount.com" \
  --role="roles/pubsub.subscriber"

# Download service account key
gcloud iam service-accounts keys create swarm-hub-key.json \
  --iam-account=swarm-hub@your-project-id.iam.gserviceaccount.com
```

### 2. Create Pub/Sub Topic

```bash
gcloud pubsub topics create swarm-broadcast \
  --project=your-project-id
```

### 3. Create Subscriptions (One Per Instance)

```bash
# Instance 1
gcloud pubsub subscriptions create swarm-broadcast-hub-us-east-1a \
  --topic=swarm-broadcast \
  --ack-deadline=60 \
  --message-retention-duration=10m \
  --project=your-project-id

# Instance 2
gcloud pubsub subscriptions create swarm-broadcast-hub-us-east-1b \
  --topic=swarm-broadcast \
  --ack-deadline=60 \
  --message-retention-duration=10m \
  --project=your-project-id
```

### 4. Deploy Service Account Key

Store `swarm-hub-key.json` securely:

```bash
# Copy to server (use secrets manager in production)
scp swarm-hub-key.json server:/app/service-account.json
chmod 600 /app/service-account.json
```

**Production**: Use Google Secret Manager instead of file storage.

---

## Security Best Practices

### 1. Never Commit Secrets to Git

Add to `.gitignore`:
```
.env
.env.local
.env.production
*.json
service-account*.json
```

### 2. Use Strong SESSION_SECRET

✅ **Good** (64 hex characters):
```
886b5cf51814b3e00524e93724c2192a2dd86598d5b46f18992478e915ae0706
```

❌ **Bad** (short, predictable):
```
my-secret-key
12345678
```

### 3. Rotate Secrets Regularly

- **SESSION_SECRET**: Every 90 days
- **Firebase API Key**: When compromised (immediately)
- **Service Account Keys**: Every 180 days

### 4. Restrict CORS Origins

✅ **Good** (specific domains):
```
ALLOWED_ORIGINS=https://swarmprotocol.ai,https://app.swarmprotocol.ai
```

❌ **Bad** (wildcard):
```
ALLOWED_ORIGINS=*
```

### 5. Use Environment-Specific Configs

Don't use production keys in development:

**Development**:
```bash
FIREBASE_PROJECT_ID=swarm-dev
SESSION_SECRET=dev-secret-not-secure
```

**Production**:
```bash
FIREBASE_PROJECT_ID=swarm-production
SESSION_SECRET=$(openssl rand -hex 32)
```

---

## Environment Validation

### Next.js App

Validate configuration at startup:

```typescript
// In app/layout.tsx or middleware.ts
import { requireValidEnv, printEnvSummary } from '@/lib/env-validation';

// At server startup
if (typeof window === 'undefined') {
  requireValidEnv();
  printEnvSummary();
}
```

### WebSocket Hub

Validate configuration in `index.mjs`:

```javascript
import { requireValidHubEnv, printHubEnvSummary } from './env-validation.mjs';

// At the top of index.mjs, before any other code
requireValidHubEnv();
printHubEnvSummary();
```

### Example Output

```
🔍 Validating hub environment...
⚠️  Environment warnings:
  - Optional env var not set: INSTANCE_ID - Unique identifier for this hub instance
  - GCP_PROJECT_ID set but GOOGLE_APPLICATION_CREDENTIALS missing - Pub/Sub will not work
✅ Environment validation passed

📋 Hub Configuration:
  NODE_ENV: production
  PORT: 8400
  FIREBASE_PROJECT_ID: swarm-production
  ALLOWED_ORIGINS: ✅ Set
  INSTANCE_ID: hub-12345 (auto)
  HUB_REGION: us-east (default)
  Pub/Sub: ❌ Disabled (single instance)
  ⚠️  Warnings: 2
  ✅ All validations passed
```

---

## Configuration Checklist

Before deploying to production:

### Next.js App
- [ ] `SESSION_SECRET` is 64 hex characters
- [ ] All Firebase env vars set (6 total)
- [ ] `NEXT_PUBLIC_REOWN_PROJECT_ID` configured
- [ ] `PLATFORM_ADMIN_WALLETS` set (if using admin features)
- [ ] `.env.local` file in `.gitignore`
- [ ] Run `requireValidEnv()` passes

### WebSocket Hub
- [ ] `FIREBASE_*` vars match Next.js app
- [ ] `ALLOWED_ORIGINS` includes production domain
- [ ] `INSTANCE_ID` unique per instance
- [ ] Pub/Sub configured if multi-instance
- [ ] Service account key deployed securely
- [ ] `.env` file in `.gitignore`
- [ ] Run `requireValidHubEnv()` passes

### Firebase
- [ ] Firestore database created
- [ ] Security rules deployed
- [ ] TTL policies enabled (`rateLimits`, `authNonces`)
- [ ] System health document created

### Cloud Pub/Sub (if multi-instance)
- [ ] Service account created with permissions
- [ ] Topic created (`swarm-broadcast`)
- [ ] Subscriptions created (one per instance)
- [ ] Service account key deployed

---

## Troubleshooting

### "Missing required env var: SESSION_SECRET"

**Cause**: SESSION_SECRET not set or too short

**Solution**:
```bash
echo "SESSION_SECRET=$(openssl rand -hex 32)" >> .env.local
```

### "Firebase API key not valid"

**Cause**: Wrong Firebase project or API key

**Solution**:
1. Verify project ID matches in Firebase Console
2. Check that API key is for web app (not server key)
3. Regenerate API key in Firebase Console if needed

### "CORS blocked origin"

**Cause**: Request origin not in ALLOWED_ORIGINS

**Solution**:
```bash
# Add missing origin to hub .env
ALLOWED_ORIGINS=https://swarmprotocol.ai,https://your-new-domain.com
```

### "Pub/Sub not initialized"

**Cause**: Missing GCP_PROJECT_ID or service account credentials

**Solution**:
1. Verify `GCP_PROJECT_ID` is set
2. Verify `GOOGLE_APPLICATION_CREDENTIALS` points to valid JSON file
3. Check service account has `pubsub.publisher` and `pubsub.subscriber` roles

---

## Next Steps

After configuration:
1. Run environment validation: `requireValidEnv()`
2. Start development server: `npm run dev`
3. Check health endpoint: `curl http://localhost:3000/api/health`
4. Review logs for warnings
5. Proceed to deployment following [DEPLOYMENT_GUIDE.md](./DEPLOYMENT_GUIDE.md)
