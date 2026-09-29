/**
 * Tests for Natural Language Cron Parser
 */

import { describe, it, expect } from 'vitest';
import { parseCron, isValidCron, describeCron } from './nlp-cron';

describe('NLP Cron Parser', () => {
  describe('parseCron', () => {
    it('parses "every X minutes"', () => {
      const result = parseCron('every 15 minutes');
      expect(result.success).toBe(true);
      expect(result.cron).toBe('*/15 * * * *');
      expect(result.description).toBe('Every 15 minutes');
    });

    it('parses "every X hours"', () => {
      const result = parseCron('every 2 hours');
      expect(result.success).toBe(true);
      expect(result.cron).toBe('0 */2 * * *');
      expect(result.description).toBe('Every 2 hours');
    });

    it('parses "every day at 9am"', () => {
      const result = parseCron('every day at 9am');
      expect(result.success).toBe(true);
      expect(result.cron).toBe('0 9 * * *');
      expect(result.description).toContain('Every day at');
    });

    it('parses "every day at 2:30pm"', () => {
      const result = parseCron('every day at 2:30pm');
      expect(result.success).toBe(true);
      expect(result.cron).toBe('30 14 * * *');
    });

    it('parses "every monday at 10am"', () => {
      const result = parseCron('every monday at 10am');
      expect(result.success).toBe(true);
      expect(result.cron).toBe('0 10 * * 1');
      expect(result.description).toContain('monday');
    });

    it('parses shorthand weekdays', () => {
      const result = parseCron('every fri at 5pm');
      expect(result.success).toBe(true);
      expect(result.cron).toBe('0 17 * * 5');
    });

    it('parses "hourly"', () => {
      const result = parseCron('hourly');
      expect(result.success).toBe(true);
      expect(result.cron).toBe('0 * * * *');
    });

    it('parses "daily"', () => {
      const result = parseCron('daily');
      expect(result.success).toBe(true);
      expect(result.cron).toBe('0 0 * * *');
    });

    it('parses "weekly"', () => {
      const result = parseCron('weekly');
      expect(result.success).toBe(true);
      expect(result.cron).toBe('0 0 * * 0');
    });

    it('parses "monthly"', () => {
      const result = parseCron('monthly');
      expect(result.success).toBe(true);
      expect(result.cron).toBe('0 0 1 * *');
    });

    it('handles invalid input', () => {
      const result = parseCron('gibberish');
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('validates minute range', () => {
      const result = parseCron('every 60 minutes');
      expect(result.success).toBe(false);
      expect(result.error).toContain('between 1 and 59');
    });

    it('validates hour range', () => {
      const result = parseCron('every 24 hours');
      expect(result.success).toBe(false);
      expect(result.error).toContain('between 1 and 23');
    });

    it('is case-insensitive', () => {
      const result1 = parseCron('EVERY 2 HOURS');
      const result2 = parseCron('every 2 hours');
      expect(result1.cron).toBe(result2.cron);
    });
  });

  describe('isValidCron', () => {
    it('validates correct cron expressions', () => {
      expect(isValidCron('0 * * * *')).toBe(true);
      expect(isValidCron('*/15 * * * *')).toBe(true);
      expect(isValidCron('0 9 * * *')).toBe(true);
      expect(isValidCron('30 14 * * 1')).toBe(true);
    });

    it('rejects invalid cron expressions', () => {
      expect(isValidCron('invalid')).toBe(false);
      expect(isValidCron('* * *')).toBe(false); // Too few parts
      expect(isValidCron('60 * * * *')).toBe(false); // Invalid minute
      expect(isValidCron('* 24 * * *')).toBe(false); // Invalid hour
    });
  });

  describe('describeCron', () => {
    it('describes minute intervals', () => {
      expect(describeCron('*/15 * * * *')).toBe('Every 15 minutes');
      expect(describeCron('*/1 * * * *')).toBe('Every 1 minute');
    });

    it('describes hour intervals', () => {
      expect(describeCron('0 */2 * * *')).toBe('Every 2 hours');
      expect(describeCron('0 */1 * * *')).toBe('Every 1 hour');
    });

    it('describes daily schedules', () => {
      const desc = describeCron('0 9 * * *');
      expect(desc).toContain('Every day at');
      expect(desc).toContain('9:00 AM');
    });

    it('describes weekly schedules', () => {
      const desc = describeCron('0 10 * * 1');
      expect(desc).toContain('Monday');
      expect(desc).toContain('10:00 AM');
    });

    it('handles invalid cron', () => {
      expect(describeCron('invalid')).toBe('Invalid cron expression');
    });
  });
});
