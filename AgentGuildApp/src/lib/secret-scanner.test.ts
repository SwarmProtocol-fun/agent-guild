/**
 * Tests for Secret Scanner
 */

import { describe, it, expect } from 'vitest';
import { scanForSecrets, sanitizeText, hasCriticalSecrets } from './secret-scanner';

// Test tokens with correct lengths for their patterns (obfuscated via concatenation)
// OpenAI: sk-[a-zA-Z0-9]{48} => 48 chars after sk-
const FAKE_OPENAI = 'sk-' + 'abcdefghijklmnopqrstuvwxyz1234567890ABCDEFGHIJKL';
// GitHub: ghp_[a-zA-Z0-9]{36} => 36 chars after ghp_
const FAKE_GITHUB = 'ghp_' + 'abcdefghijklmnopqrstuvwxyz1234567890';
// Telegram: \d{8,10}:[a-zA-Z0-9_-]{35} => 35 chars after colon
const FAKE_TELEGRAM = '123456789:ABCdefGHIjklMNOpqrsTUVwxyz1234567890';

describe('Secret Scanner', () => {
  describe('scanForSecrets', () => {
    it('detects OpenAI API keys', () => {
      const text = 'My key is ' + FAKE_OPENAI;
      const result = scanForSecrets(text);

      expect(result.clean).toBe(false);
      expect(result.secrets).toHaveLength(1);
      expect(result.secrets[0].type).toBe('OpenAI API Key');
      expect(result.secrets[0].severity).toBe('critical');
    });

    it('detects Anthropic API keys', () => {
      // Obfuscated test value to avoid Netlify secret scanning
      const text =
        'sk-ant-' + 'api03-abcdefghijklmnopqrstuvwxyz1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGHIJKLMNOPQRS';
      const result = scanForSecrets(text);

      expect(result.clean).toBe(false);
      expect(result.secrets[0].type).toBe('Anthropic API Key');
    });

    it('detects AWS Access Keys', () => {
      const text = 'export AWS_KEY=AKIAIOSFODNN7EXAMPLE';
      const result = scanForSecrets(text);

      expect(result.clean).toBe(false);
      expect(result.secrets[0].type).toBe('AWS Access Key');
      expect(result.secrets[0].severity).toBe('critical');
    });

    it('detects GitHub tokens', () => {
      const text = FAKE_GITHUB;
      const result = scanForSecrets(text);

      expect(result.clean).toBe(false);
      expect(result.secrets[0].type).toBe('GitHub Token');
    });

    it('detects JWT tokens', () => {
      const text =
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
      const result = scanForSecrets(text);

      expect(result.clean).toBe(false);
      expect(result.secrets[0].type).toBe('JWT Token');
      expect(result.secrets[0].severity).toBe('high');
    });

    it('detects database connection strings', () => {
      const text = 'postgres://user:password@localhost:5432/mydb';
      const result = scanForSecrets(text);

      expect(result.clean).toBe(false);
      expect(result.secrets[0].type).toBe('Database Connection String');
      expect(result.secrets[0].severity).toBe('critical');
    });

    it('detects Slack tokens', () => {
      // xox[baprs]-[a-zA-Z0-9-]{10,}
      const text = 'xo' + 'xb-1234567890-1234567890123456';
      const result = scanForSecrets(text);

      expect(result.clean).toBe(false);
      expect(result.secrets[0].type).toBe('Slack Token');
    });

    it('detects Telegram bot tokens', () => {
      const text = FAKE_TELEGRAM;
      const result = scanForSecrets(text);

      expect(result.clean).toBe(false);
      expect(result.secrets[0].type).toBe('Telegram Bot Token');
    });

    it('returns clean for safe text', () => {
      const text = 'This is just normal text with no secrets.';
      const result = scanForSecrets(text);

      expect(result.clean).toBe(true);
      expect(result.secrets).toHaveLength(0);
    });

    it('detects multiple secrets in one text', () => {
      const text = `
        OpenAI: ${FAKE_OPENAI}
        GitHub: ${FAKE_GITHUB}
      `;
      const result = scanForSecrets(text);

      expect(result.clean).toBe(false);
      expect(result.secrets).toHaveLength(2);
    });

    it('provides redacted versions', () => {
      const result = scanForSecrets(FAKE_OPENAI);

      expect(result.secrets[0].redacted).toContain('***');
    });
  });

  describe('sanitizeText', () => {
    it('redacts secrets from text', () => {
      const text = 'My key is ' + FAKE_OPENAI + ' here';
      const sanitized = sanitizeText(text);

      expect(sanitized).not.toContain('sk-abc');
      expect(sanitized).toContain('[REDACTED OpenAI API Key]');
    });

    it('returns original text if clean', () => {
      const text = 'Just normal text';
      const sanitized = sanitizeText(text);

      expect(sanitized).toBe(text);
    });

    it('redacts multiple secrets', () => {
      const text = `Key1: ${FAKE_OPENAI} Key2: ${FAKE_GITHUB}`;
      const sanitized = sanitizeText(text);

      expect(sanitized).toContain('[REDACTED');
      expect(sanitized).not.toContain('sk-abc');
      expect(sanitized).not.toContain('ghp_abc');
    });
  });

  describe('hasCriticalSecrets', () => {
    it('returns true for critical secrets', () => {
      const text = 'AKIAIOSFODNN7EXAMPLE';
      expect(hasCriticalSecrets(text)).toBe(true);
    });

    it('returns false for medium/low secrets', () => {
      const text = 'AIzaSyDddddddddddddddddddddddddddddddd'; // Firebase (medium)
      // Note: This might not trigger if pattern is too strict
      expect(hasCriticalSecrets(text)).toBe(false);
    });

    it('returns false for clean text', () => {
      const text = 'No secrets here';
      expect(hasCriticalSecrets(text)).toBe(false);
    });
  });
});
