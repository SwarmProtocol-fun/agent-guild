/**
 * Natural Language Cron Parser
 *
 * Converts human-friendly time expressions to cron syntax.
 * Inspired by Mission Control's NLP scheduler.
 *
/**
 * Natural Language Cron Parser
 *
 * Converts human-friendly time expressions to cron syntax.
 * Inspired by Mission Control's NLP scheduler.
 *
 * Examples:
 * - "every 2 hours"
 * - "every day at 9am"
 * - "every monday at 10am"
 * - "every 30 minutes"
 */

interface CronParseResult {
  success: boolean;
  cron?: string;
  error?: string;
  description?: string;
}

const WEEKDAY_MAP: Record<string, string> = {
  sunday: '0',
  monday: '1',
  tuesday: '2',
  wednesday: '3',
  thursday: '4',
  friday: '5',
  saturday: '6',
  sun: '0',
  mon: '1',
  tue: '2',
  wed: '3',
  thu: '4',
  fri: '5',
  sat: '6',
};

/**
 * Parse natural language time expression to cron syntax
 */
export function parseCron(input: string): CronParseResult {
  const normalized = input.toLowerCase().trim();

  // Pattern: "every X minutes"
  const minutesMatch = normalized.match(/every\s+(\d+)\s+minutes?/);
  if (minutesMatch) {
    const interval = parseInt(minutesMatch[1]);
    if (interval < 1 || interval > 59) {
      return { success: false, error: 'Minutes must be between 1 and 59' };
    }
    return {
      success: true,
      cron: `*/${interval} * * * *`,
      description: `Every ${interval} minute${interval > 1 ? 's' : ''}`,
    };
  }

  // Pattern: "every X hours"
  const hoursMatch = normalized.match(/every\s+(\d+)\s+hours?/);
  if (hoursMatch) {
    const interval = parseInt(hoursMatch[1]);
    if (interval < 1 || interval > 23) {
      return { success: false, error: 'Hours must be between 1 and 23' };
    }
    return {
      success: true,
      cron: `0 */${interval} * * *`,
      description: `Every ${interval} hour${interval > 1 ? 's' : ''}`,
    };
  }

  // Pattern: "every day at Xam/pm"
  const dailyMatch = normalized.match(/every\s+day\s+at\s+(\d+)(?::(\d+))?\s*(am|pm)?/);
  if (dailyMatch) {
    let hour = parseInt(dailyMatch[1]);
    const minute = dailyMatch[2] ? parseInt(dailyMatch[2]) : 0;
    const meridiem = dailyMatch[3];

    if (meridiem === 'pm' && hour !== 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;

    if (hour > 23 || minute > 59) {
      return { success: false, error: 'Invalid time format' };
    }

    return {
      success: true,
      cron: `${minute} ${hour} * * *`,
      description: `Every day at ${formatTime(hour, minute)}`,
    };
  }

  // Pattern: "every [weekday] at Xam/pm"
  const weekdayMatch = normalized.match(/every\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\s+at\s+(\d+)(?::(\d+))?\s*(am|pm)?/);
  if (weekdayMatch) {
    const weekday = WEEKDAY_MAP[weekdayMatch[1]];
    let hour = parseInt(weekdayMatch[2]);
    const minute = weekdayMatch[3] ? parseInt(weekdayMatch[3]) : 0;
    const meridiem = weekdayMatch[4];

    if (meridiem === 'pm' && hour !== 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;

    if (hour > 23 || minute > 59) {
      return { success: false, error: 'Invalid time format' };
    }

    return {
      success: true,
      cron: `${minute} ${hour} * * ${weekday}`,
      description: `Every ${weekdayMatch[1]} at ${formatTime(hour, minute)}`,
    };
  }

  // Pattern: "hourly" or "every hour"
  if (normalized === 'hourly' || normalized === 'every hour') {
    return {
      success: true,
      cron: '0 * * * *',
      description: 'Every hour',
    };
  }

  // Pattern: "daily" or "every day"
  if (normalized === 'daily' || normalized === 'every day') {
    return {
      success: true,
      cron: '0 0 * * *',
      description: 'Every day at midnight',
    };
  }

  // Pattern: "weekly"
  if (normalized === 'weekly') {
    return {
      success: true,
      cron: '0 0 * * 0',
      description: 'Every Sunday at midnight',
    };
  }

  // Pattern: "monthly"
  if (normalized === 'monthly') {
    return {
      success: true,
      cron: '0 0 1 * *',
      description: 'First day of every month at midnight',
    };
  }

  // If no pattern matches, return error
  return {
    success: false,
    error: 'Unrecognized time format. Try: "every 2 hours", "every day at 9am", "every monday at 10am"',
  };
}

/**
 * Validate cron expression (basic validation)
 */
export function isValidCron(cron: string): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return false;

  // Basic validation - check each part is valid
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

  const isValidPart = (part: string, min: number, max: number) => {
    if (part === '*') return true;
    if (part.startsWith('*/')) {
      const interval = parseInt(part.substring(2));
      return !isNaN(interval) && interval >= 1 && interval <= max;
    }
    const num = parseInt(part);
    return !isNaN(num) && num >= min && num <= max;
  };

  return (
    isValidPart(minute, 0, 59) &&
    isValidPart(hour, 0, 23) &&
    isValidPart(dayOfMonth, 1, 31) &&
    isValidPart(month, 1, 12) &&
    isValidPart(dayOfWeek, 0, 6)
  );
}

/**
 * Convert cron to human-readable description
 */
export function describeCron(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return 'Invalid cron expression';

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

  // Every X minutes
  if (minute.startsWith('*/') && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    const interval = minute.substring(2);
    return `Every ${interval} minute${interval !== '1' ? 's' : ''}`;
  }

  // Every X hours
  if (minute === '0' && hour.startsWith('*/') && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    const interval = hour.substring(2);
    return `Every ${interval} hour${interval !== '1' ? 's' : ''}`;
  }

  // Specific time every day
  if (!minute.includes('*') && !hour.includes('*') && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return `Every day at ${formatTime(parseInt(hour), parseInt(minute))}`;
  }

  // Specific weekday and time
  if (!minute.includes('*') && !hour.includes('*') && dayOfMonth === '*' && month === '*' && !dayOfWeek.includes('*')) {
    const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const day = weekdays[parseInt(dayOfWeek)] || dayOfWeek;
    return `Every ${day} at ${formatTime(parseInt(hour), parseInt(minute))}`;
  }

  // Fallback to raw cron
  return `Cron: ${cron}`;
}

/**
 * Format time as 12-hour with AM/PM
 */
function formatTime(hour: number, minute: number): string {
  const h = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  const m = minute.toString().padStart(2, '0');
  const period = hour >= 12 ? 'PM' : 'AM';
  return `${h}:${m} ${period}`;
}

/**
 * Get next execution time for a cron expression
 * (Simplified - doesn't handle all cron features)
 */
export function getNextExecution(cron: string): Date | null {
  if (!isValidCron(cron)) return null;

  const now = new Date();
  const parts = cron.split(/\s+/);
  const [minuteStr, hourStr] = parts;

  // Handle simple cases only (*/X patterns and specific times)
  if (minuteStr.startsWith('*/')) {
    const interval = parseInt(minuteStr.substring(2));
    const nextMinute = Math.ceil(now.getMinutes() / interval) * interval;
    const next = new Date(now);
    next.setMinutes(nextMinute);
    next.setSeconds(0);
    next.setMilliseconds(0);
    if (next <= now) next.setHours(next.getHours() + 1);
    return next;
  }

  // For more complex cron, would need a full cron parser library
  return null;
}
