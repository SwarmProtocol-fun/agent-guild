/**
 * Environment Variable Validation
 *
 * Validates required environment variables at server startup.
 * Prevents runtime failures due to misconfiguration.
 *
 * Usage:
 *   import { validateEnv } from '@/lib/env-validation';
 *   validateEnv(); // Call in layout.tsx or middleware
 */

interface EnvValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

interface EnvRequirement {
  key: string;
  required: boolean;
  validate?: (value: string) => boolean;
  description: string;
  example?: string;
}

const ENV_REQUIREMENTS: EnvRequirement[] = [
  // Critical - Session Management
  {
    key: "SESSION_SECRET",
    required: true,
    validate: (val) => val.length >= 32,
    description: "JWT signing secret (min 32 chars)",
    example: "openssl rand -hex 32",
  },

  // Firebase (Server-side) — falls back to NEXT_PUBLIC_ equivalents
  {
    key: "FIREBASE_API_KEY",
    required: false,
    description: "Firebase API key (server-side, falls back to NEXT_PUBLIC_FIREBASE_API_KEY)",
  },
  {
    key: "FIREBASE_AUTH_DOMAIN",
    required: false,
    description: "Firebase auth domain (server-side, falls back to NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN)",
  },
  {
    key: "FIREBASE_PROJECT_ID",
    required: false,
    description: "Firebase project ID (server-side, falls back to NEXT_PUBLIC_FIREBASE_PROJECT_ID)",
  },
  {
    key: "FIREBASE_APP_ID",
    required: false,
    description: "Firebase app ID (server-side, falls back to NEXT_PUBLIC_FIREBASE_APP_ID)",
  },
  {
    key: "FIREBASE_STORAGE_BUCKET",
    required: false,
    description: "Firebase storage bucket (server-side, optional)",
  },
  {
    key: "FIREBASE_MESSAGING_SENDER_ID",
    required: false,
    description: "Firebase messaging sender ID (server-side, optional)",
  },

  // Critical - Firebase (Client-side / Public)
  {
    key: "NEXT_PUBLIC_FIREBASE_API_KEY",
    required: true,
    description: "Firebase API key (client-side)",
  },
  {
    key: "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN",
    required: true,
    validate: (val) => val.includes("firebaseapp.com"),
    description: "Firebase auth domain (client-side)",
  },
  {
    key: "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
    required: true,
    description: "Firebase project ID (client-side)",
  },
  {
    key: "NEXT_PUBLIC_FIREBASE_APP_ID",
    required: true,
    validate: (val) => val.includes(":web:"),
    description: "Firebase app ID (client-side)",
  },

  // Optional - Firebase (Client-side)
  {
    key: "NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET",
    required: false,
    description: "Firebase storage bucket (client-side, optional)",
  },
  {
    key: "NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID",
    required: false,
    description: "Firebase messaging sender ID (client-side, optional)",
  },
  {
    key: "NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID",
    required: false,
    description: "Firebase measurement ID for analytics (client-side, optional)",
  },

  // Critical - Wallet connection (WalletConnect / Reown AppKit)
  {
    key: "NEXT_PUBLIC_REOWN_PROJECT_ID",
    required: true,
    description: "Reown (WalletConnect) project ID for wallet connection — https://cloud.reown.com",
  },
  {
    key: "NEXT_PUBLIC_WALLET_PROVIDER",
    required: false,
    description: "Wallet adapter id (default: walletconnect)",
  },

  // Optional - Platform Admin
  {
    key: "PLATFORM_ADMIN_WALLETS",
    required: false,
    validate: (val) => {
      const wallets = val.split(",");
      return wallets.every((w) => w.trim().startsWith("0x"));
    },
    description: "Comma-separated admin wallet addresses",
    example: "0x1234...abcd,0x5678...efgh",
  },

  // Optional - PostHog (click/event tracking + admin analytics)
  {
    key: "NEXT_PUBLIC_POSTHOG_KEY",
    required: false,
    description: "PostHog project API key — enables client-side click/pageview capture (unset = no tracking)",
    example: "phc_...",
  },
  {
    key: "NEXT_PUBLIC_POSTHOG_HOST",
    required: false,
    description: "PostHog ingestion host (default: https://us.i.posthog.com)",
  },
  {
    key: "POSTHOG_PERSONAL_API_KEY",
    required: false,
    description: "PostHog personal API key — lets /admin/analytics/events and /pages read data back from PostHog",
  },
  {
    key: "POSTHOG_PROJECT_ID",
    required: false,
    description: "PostHog numeric project ID, used alongside POSTHOG_PERSONAL_API_KEY",
  },

  // Optional - Rate Limiting
  {
    key: "RATE_LIMIT_WINDOW_MS",
    required: false,
    validate: (val) => !isNaN(Number(val)) && Number(val) > 0,
    description: "Rate limit window in milliseconds",
    example: "60000",
  },
  {
    key: "RATE_LIMIT_MAX",
    required: false,
    validate: (val) => !isNaN(Number(val)) && Number(val) > 0,
    description: "Max requests per rate limit window",
    example: "10",
  },
];

/**
 * Validate all required environment variables.
 * Throws error if critical vars missing.
 */
export function validateEnv(): EnvValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const req of ENV_REQUIREMENTS) {
    const value = process.env[req.key];

    // Check if required var is missing
    if (req.required && !value) {
      errors.push(
        `Missing required env var: ${req.key} - ${req.description}${
          req.example ? ` (example: ${req.example})` : ""
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
        `Invalid value for ${req.key}: ${req.description}${
          req.example ? ` (example: ${req.example})` : ""
        }`
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validate environment and throw if invalid.
 * Use at application startup.
 */
export function requireValidEnv(): void {
  const result = validateEnv();

  // Log warnings
  if (result.warnings.length > 0) {
    console.warn("⚠️  Environment warnings:");
    result.warnings.forEach((w) => console.warn(`  - ${w}`));
  }

  // Throw on errors
  if (!result.valid) {
    console.error("❌ Environment validation failed:");
    result.errors.forEach((e) => console.error(`  - ${e}`));
    throw new Error(
      `Environment validation failed with ${result.errors.length} error(s). See logs above.`
    );
  }

  console.log("✅ Environment validation passed");
}

/**
 * Get environment variable with fallback.
 * Logs warning if using fallback in production.
 */
export function getEnv(
  key: string,
  fallback?: string,
  required: boolean = false
): string {
  const value = process.env[key];

  if (!value) {
    if (required) {
      throw new Error(`Missing required environment variable: ${key}`);
    }

    if (fallback !== undefined) {
      if (process.env.NODE_ENV === "production") {
        console.warn(
          `⚠️  Using fallback for ${key} in production. Set explicit value.`
        );
      }
      return fallback;
    }

    throw new Error(
      `Environment variable ${key} not set and no fallback provided`
    );
  }

  return value;
}

/**
 * Get boolean environment variable.
 */
export function getEnvBool(key: string, fallback: boolean = false): boolean {
  const value = process.env[key];
  if (!value) return fallback;
  return value.toLowerCase() === "true" || value === "1";
}

/**
 * Get number environment variable.
 */
export function getEnvNumber(key: string, fallback?: number): number {
  const value = process.env[key];
  if (!value) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Environment variable ${key} not set`);
  }

  const num = Number(value);
  if (isNaN(num)) {
    throw new Error(`Environment variable ${key} is not a valid number: ${value}`);
  }

  return num;
}

/**
 * Print environment configuration summary (safe for logs).
 * Redacts sensitive values.
 */
export function printEnvSummary(): void {
  console.log("📋 Environment Configuration:");
  console.log(`  NODE_ENV: ${process.env.NODE_ENV || "development"}`);
  console.log(
    `  SESSION_SECRET: ${process.env.SESSION_SECRET ? "✅ Set" : "❌ Missing"}`
  );
  console.log(
    `  FIREBASE_PROJECT_ID: ${process.env.FIREBASE_PROJECT_ID || "❌ Missing"}`
  );
  console.log(
    `  REOWN_PROJECT_ID: ${
      process.env.NEXT_PUBLIC_REOWN_PROJECT_ID ? "✅ Set" : "❌ Missing"
    }`
  );
  console.log(
    `  PLATFORM_ADMIN_WALLETS: ${
      process.env.PLATFORM_ADMIN_WALLETS ? "✅ Set" : "Not set"
    }`
  );

  const warnings = validateEnv().warnings.length;
  const errors = validateEnv().errors.length;

  if (errors > 0) {
    console.error(`  ❌ Errors: ${errors}`);
  }
  if (warnings > 0) {
    console.warn(`  ⚠️  Warnings: ${warnings}`);
  }
  if (errors === 0 && warnings === 0) {
    console.log("  ✅ All validations passed");
  }
}
