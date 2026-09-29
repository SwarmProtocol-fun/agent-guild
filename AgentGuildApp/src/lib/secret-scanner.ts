/**
 * Secret Scanner
 *
 * Detects potentially exposed secrets in text, messages, and code.
 * Inspired by Mission Control's security scanning system.
 *
 * Scans for:
 * - API keys (OpenAI, Anthropic, AWS, etc.)
 * - Private keys (Ed25519, RSA, etc.)
 * - OAuth tokens
 * - Database credentials
 * - JWT tokens
 */

export interface SecretMatch {
  type: string;
  value: string;
  redacted: string;
  startIndex: number;
  endIndex: number;
  severity: 'critical' | 'high' | 'medium' | 'low';
  recommendation: string;
}

export interface ScanResult {
  clean: boolean;
  secrets: SecretMatch[];
  scannedAt: number;
}

// Secret patterns (regex)
const PATTERNS: Array<{
  type: string;
  pattern: RegExp;
  severity: 'critical' | 'high' | 'medium' | 'low';
  recommendation: string;
}> = [
  // OpenAI API Keys
  {
    type: 'OpenAI API Key',
    pattern: /sk-[a-zA-Z0-9]{48}/g,
    severity: 'critical',
    recommendation: 'Revoke immediately at platform.openai.com/api-keys',
  },

  // Anthropic API Keys
  {
    type: 'Anthropic API Key',
    pattern: /sk-ant-[a-zA-Z0-9-]{95,}/g,
    severity: 'critical',
    recommendation: 'Revoke immediately at console.anthropic.com/settings/keys',
  },

  // AWS Access Keys
  {
    type: 'AWS Access Key',
    pattern: /AKIA[0-9A-Z]{16}/g,
    severity: 'critical',
    recommendation: 'Rotate immediately via AWS IAM Console',
  },

  // AWS Secret Keys
  {
    type: 'AWS Secret Key',
    pattern: /aws_secret_access_key\s*[=:]\s*[A-Za-z0-9/+=]{40}/gi,
    severity: 'critical',
    recommendation: 'Rotate immediately via AWS IAM Console',
  },

  // GitHub Personal Access Tokens
  {
    type: 'GitHub Token',
    pattern: /ghp_[a-zA-Z0-9]{36}/g,
    severity: 'critical',
    recommendation: 'Revoke at github.com/settings/tokens',
  },

  // Private Keys (PEM format)
  {
    type: 'Private Key (PEM)',
    pattern: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
    severity: 'critical',
    recommendation: 'Never expose private keys. Rotate immediately and use secrets vault.',
  },

  // Ed25519 Private Keys (base64, 64 chars)
  {
    type: 'Ed25519 Private Key',
    pattern: /ed25519[_-]?private[_-]?key[:\s=]+([A-Za-z0-9+/]{64}={0,2})/gi,
    severity: 'critical',
    recommendation: 'Rotate keypair immediately. Never hardcode private keys.',
  },

  // JWT Tokens
  {
    type: 'JWT Token',
    pattern: /eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g,
    severity: 'high',
    recommendation: 'JWT tokens should be short-lived and never committed to code',
  },

  // Stripe API Keys
  {
    type: 'Stripe Secret Key',
    pattern: /sk_live_[a-zA-Z0-9]{24,}/g,
    severity: 'critical',
    recommendation: 'Revoke at dashboard.stripe.com/apikeys',
  },

  // Firebase API Keys (looser pattern - many false positives)
  {
    type: 'Firebase API Key',
    pattern: /AIza[0-9A-Za-z_-]{35}/g,
    severity: 'medium',
    recommendation: 'Firebase API keys are public but restrict via Firebase Console',
  },

  // Generic API Key Pattern (high entropy strings)
  {
    type: 'Generic API Key',
    pattern: /api[_-]?key[:\s=]+['"]*([a-zA-Z0-9_-]{32,})['"]/gi,
    severity: 'high',
    recommendation: 'Store in secrets vault, never hardcode',
  },

  // Database Connection Strings
  {
    type: 'Database Connection String',
    pattern: /(postgres|mysql|mongodb):\/\/[^:]+:[^@]+@[^/\s]+/gi,
    severity: 'critical',
    recommendation: 'Use environment variables for connection strings',
  },

  // Slack Tokens
  {
    type: 'Slack Token',
    pattern: /xox[baprs]-[a-zA-Z0-9-]{10,}/g,
    severity: 'critical',
    recommendation: 'Revoke at api.slack.com/apps',
  },

  // Discord Bot Tokens
  {
    type: 'Discord Bot Token',
    pattern: /[MN][a-zA-Z0-9_-]{23,25}\.[a-zA-Z0-9_-]{6}\.[a-zA-Z0-9_-]{27,}/g,
    severity: 'critical',
    recommendation: 'Regenerate token at discord.com/developers/applications',
  },

  // Telegram Bot Tokens
  {
    type: 'Telegram Bot Token',
    pattern: /\d{8,10}:[a-zA-Z0-9_-]{35}/g,
    severity: 'critical',
    recommendation: 'Revoke via BotFather and generate new token',
  },

  // Twilio Auth Tokens
  {
    type: 'Twilio Auth Token',
    pattern: /SK[a-zA-Z0-9]{32}/g,
    severity: 'critical',
    recommendation: 'Rotate at console.twilio.com',
  },
];

/**
 * Scan text for exposed secrets
 */
export function scanForSecrets(text: string): ScanResult {
  const secrets: SecretMatch[] = [];

  for (const { type, pattern, severity, recommendation } of PATTERNS) {
    // Reset regex lastIndex
    pattern.lastIndex = 0;

    let match;
    while ((match = pattern.exec(text)) !== null) {
      const value = match[0];
      const redacted = redactSecret(value);

      secrets.push({
        type,
        value,
        redacted,
        startIndex: match.index,
        endIndex: match.index + value.length,
        severity,
        recommendation,
      });
    }
  }

  return {
    clean: secrets.length === 0,
    secrets,
    scannedAt: Date.now(),
  };
}

/**
 * Redact a secret value (show first 4 and last 4 chars)
 */
function redactSecret(value: string): string {
  if (value.length <= 8) return '***';

  const firstFour = value.substring(0, 4);
  const lastFour = value.substring(value.length - 4);
  const stars = '*'.repeat(Math.min(value.length - 8, 20));

  return `${firstFour}${stars}${lastFour}`;
}

/**
 * Sanitize text by redacting all detected secrets
 */
export function sanitizeText(text: string): string {
  const result = scanForSecrets(text);

  if (result.clean) return text;

  let sanitized = text;
  // Sort by startIndex descending to avoid index shifting
  const sortedSecrets = [...result.secrets].sort((a, b) => b.startIndex - a.startIndex);

  for (const secret of sortedSecrets) {
    sanitized =
      sanitized.substring(0, secret.startIndex) +
      `[REDACTED ${secret.type}]` +
      sanitized.substring(secret.endIndex);
  }

  return sanitized;
}

/**
 * Check if text contains critical secrets
 */
export function hasCriticalSecrets(text: string): boolean {
  const result = scanForSecrets(text);
  return result.secrets.some((s) => s.severity === 'critical');
}

/**
 * Get severity color for UI
 */
export function getSeverityColor(severity: SecretMatch['severity']): string {
  switch (severity) {
    case 'critical':
      return 'text-red-500';
    case 'high':
      return 'text-orange-500';
    case 'medium':
      return 'text-yellow-500';
    case 'low':
      return 'text-blue-500';
  }
}

/**
 * Generate security report for an org
 */
export interface SecurityReport {
  totalScans: number;
  secretsDetected: number;
  criticalSecrets: number;
  highSecrets: number;
  mediumSecrets: number;
  lowSecrets: number;
  secretTypes: Record<string, number>;
  scannedAt: number;
}

export function generateSecurityReport(scanResults: ScanResult[]): SecurityReport {
  const secretTypes: Record<string, number> = {};
  let criticalCount = 0;
  let highCount = 0;
  let mediumCount = 0;
  let lowCount = 0;

  for (const result of scanResults) {
    for (const secret of result.secrets) {
      secretTypes[secret.type] = (secretTypes[secret.type] || 0) + 1;

      switch (secret.severity) {
        case 'critical':
          criticalCount++;
          break;
        case 'high':
          highCount++;
          break;
        case 'medium':
          mediumCount++;
          break;
        case 'low':
          lowCount++;
          break;
      }
    }
  }

  return {
    totalScans: scanResults.length,
    secretsDetected: scanResults.reduce((sum, r) => sum + r.secrets.length, 0),
    criticalSecrets: criticalCount,
    highSecrets: highCount,
    mediumSecrets: mediumCount,
    lowSecrets: lowCount,
    secretTypes,
    scannedAt: Date.now(),
  };
}
