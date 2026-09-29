/**
 * Environment Variable Validation for WebSocket Hub
 *
 * Validates required environment variables at hub startup.
 * Exits process if critical variables are missing or invalid.
 *
 * Usage:
 *   import { validateHubEnv } from './env-validation.mjs';
 *   validateHubEnv(); // Call at start of index.mjs
 */

const ENV_REQUIREMENTS = [
  // Optional - Firebase Admin (falls back to applicationDefault() if unset)
  {
    key: "FIREBASE_SERVICE_ACCOUNT",
    required: false,
    validate: (val) => {
      try {
        JSON.parse(Buffer.from(val, "base64").toString());
        return true;
      } catch {
        return false;
      }
    },
    description:
      "Base64-encoded Firebase service account JSON (falls back to Application Default Credentials if unset)",
    example: "base64 -w0 service-account.json",
  },

  // Required - state shared across instances
  {
    key: "REDIS_URL",
    required: true,
    description: "Redis connection URL for connection/presence tracking",
    example: "redis://localhost:6379",
  },

  // Optional - Server Configuration
  {
    key: "PORT",
    required: false,
    validate: (val) => !isNaN(Number(val)) && Number(val) > 0 && Number(val) < 65536,
    description: "Server port (default: 8400)",
    example: "8400",
  },

  // Optional - CORS (has a built-in default)
  {
    key: "ALLOWED_ORIGINS",
    required: false,
    validate: (val) => {
      const origins = val.split(",");
      return origins.every((o) => o.trim().startsWith("http"));
    },
    description: "Comma-separated allowed origins for CORS (default: agent-guild.com + localhost)",
    example: "https://agent-guild.com,http://localhost:3000",
  },

  // Optional - Instance Identity
  {
    key: "INSTANCE_ID",
    required: false,
    description: "Unique identifier for this hub instance",
    example: "hub-us-east-1a",
  },
  {
    key: "HUB_REGION",
    required: false,
    description: "Geographic region of this hub instance",
    example: "us-east",
  },

  // Optional - Pub/Sub (for multi-instance)
  {
    key: "GCP_PROJECT_ID",
    required: false,
    description: "Google Cloud project ID (required for multi-instance)",
  },
  {
    key: "PUBSUB_TOPIC",
    required: false,
    description: "Pub/Sub topic name (default: agent-guild-broadcast)",
    example: "agent-guild-broadcast",
  },
  {
    key: "PUBSUB_SUBSCRIPTION",
    required: false,
    description: "Pub/Sub subscription name (unique per instance)",
    example: "agent-guild-broadcast-hub-1",
  },
  {
    key: "GOOGLE_APPLICATION_CREDENTIALS",
    required: false,
    validate: (val) => val.endsWith(".json"),
    description: "Path to GCP service account JSON (required if using Pub/Sub)",
    example: "/app/service-account.json",
  },

  // Optional - Rate Limiting
  {
    key: "RATE_LIMIT_WINDOW_MS",
    required: false,
    validate: (val) => !isNaN(Number(val)) && Number(val) > 0,
    description: "Rate limit window in milliseconds (default: 60000)",
    example: "60000",
  },
  {
    key: "RATE_LIMIT_MAX",
    required: false,
    validate: (val) => !isNaN(Number(val)) && Number(val) > 0,
    description: "Max requests per rate limit window (default: 60)",
    example: "60",
  },
  {
    key: "MAX_CONNECTIONS_PER_AGENT",
    required: false,
    validate: (val) => !isNaN(Number(val)) && Number(val) > 0,
    description: "Max WebSocket connections per agent (default: 5)",
    example: "5",
  },
];

/**
 * Validate all required environment variables.
 */
export function validateHubEnv() {
  const errors = [];
  const warnings = [];

  for (const req of ENV_REQUIREMENTS) {
    const value = process.env[req.key];

    // Check if required var is missing
    if (req.required && !value) {
      errors.push(
        `Missing required env var: ${req.key} - ${req.description}${req.example ? ` (example: ${req.example})` : ""
        }`
      );
      continue;
    }

    // Skip optional vars if not set
    if (!value) {
      if (req.required === false) {
        warnings.push(
          `Optional env var not set: ${req.key} - ${req.description}`
        );
      }
      continue;
    }

    // Validate value if validator provided
    if (req.validate && !req.validate(value)) {
      errors.push(
        `Invalid value for ${req.key}: ${req.description}${req.example ? ` (example: ${req.example})` : ""
        }`
      );
    }
  }

  // Check Pub/Sub consistency
  const gcpProjectId = process.env.GCP_PROJECT_ID;
  const googleCreds = process.env.GOOGLE_APPLICATION_CREDENTIALS;

  if (gcpProjectId && !googleCreds) {
    warnings.push(
      "GCP_PROJECT_ID set but GOOGLE_APPLICATION_CREDENTIALS missing - Pub/Sub will not work"
    );
  }

  if (googleCreds && !gcpProjectId) {
    warnings.push(
      "GOOGLE_APPLICATION_CREDENTIALS set but GCP_PROJECT_ID missing - Pub/Sub will not work"
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validate environment and exit if invalid.
 * Use at hub startup (beginning of index.mjs).
 */
export function requireValidHubEnv() {
  console.log("🔍 Validating hub environment...");

  const result = validateHubEnv();

  // Log warnings
  if (result.warnings.length > 0) {
    console.warn("⚠️  Environment warnings:");
    result.warnings.forEach((w) => console.warn(`  - ${w}`));
  }

  // Exit on errors
  if (!result.valid) {
    console.error("❌ Environment validation failed:");
    result.errors.forEach((e) => console.error(`  - ${e}`));
    console.error(
      `\nHub cannot start with ${result.errors.length} configuration error(s).`
    );
    process.exit(1);
  }

  console.log("✅ Environment validation passed");
}

/**
 * Print hub configuration summary (safe for logs).
 * Redacts sensitive values.
 */
export function printHubEnvSummary() {
  console.log("📋 Hub Configuration:");
  console.log(`  NODE_ENV: ${process.env.NODE_ENV || "development"}`);
  console.log(`  PORT: ${process.env.PORT || "8400"}`);
  console.log(
    `  FIREBASE_SERVICE_ACCOUNT: ${process.env.FIREBASE_SERVICE_ACCOUNT ? "✅ Set" : "⚠️  Unset (using Application Default Credentials)"
    }`
  );
  console.log(
    `  ALLOWED_ORIGINS: ${process.env.ALLOWED_ORIGINS ? "✅ Set" : "❌ Missing"
    }`
  );
  console.log(
    `  INSTANCE_ID: ${process.env.INSTANCE_ID || `hub-${process.pid} (auto)`}`
  );
  console.log(`  HUB_REGION: ${process.env.HUB_REGION || "us-east (default)"}`);

  const isPubSubConfigured =
    process.env.GCP_PROJECT_ID && process.env.GOOGLE_APPLICATION_CREDENTIALS;
  console.log(
    `  Pub/Sub: ${isPubSubConfigured ? "✅ Enabled" : "❌ Disabled (single instance)"}`
  );

  const result = validateHubEnv();
  if (result.errors.length > 0) {
    console.error(`  ❌ Errors: ${result.errors.length}`);
  }
  if (result.warnings.length > 0) {
    console.warn(`  ⚠️  Warnings: ${result.warnings.length}`);
  }
  if (result.errors.length === 0 && result.warnings.length === 0) {
    console.log("  ✅ All validations passed");
  }
}

/**
 * Helper: Get env var with fallback and type conversion.
 */
export function getEnv(key, fallback, required = false) {
  const value = process.env[key];

  if (!value) {
    if (required) {
      console.error(`[FATAL] Missing required environment variable: ${key}`);
      process.exit(1);
    }
    return fallback;
  }

  return value;
}

export function getEnvNumber(key, fallback) {
  const value = process.env[key];
  if (!value) return fallback;

  const num = Number(value);
  if (isNaN(num)) {
    console.error(`[FATAL] Invalid number for ${key}: ${value}`);
    process.exit(1);
  }

  return num;
}
