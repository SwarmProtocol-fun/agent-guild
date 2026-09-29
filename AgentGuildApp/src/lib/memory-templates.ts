/**
 * Memory Templates — Structured memory formats
 *
 * WORKING.md - Active task context
 * Daily Notes - Daily activity journal
 * MEMORY.md - Long-term facts and learnings
 * Session Logs - Conversation transcripts
 */

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export type MemorySubtype = "working_md" | "daily_note" | "memory_md" | "session_log";

export interface MemoryTemplate {
  subtype: MemorySubtype;
  content: string;
  metadata?: Record<string, unknown>;
}

// ═══════════════════════════════════════════════════════════════
// WORKING.md Template
// ═══════════════════════════════════════════════════════════════

export function createWorkingMdTemplate(agentName: string): string {
  return `# WORKING.md — ${agentName}

## Current Focus
<!-- What are you working on right now? -->

## Active Tasks
- [ ]

## Context
<!-- Important context for current work -->

## Blockers
<!-- What's blocking progress? -->

## Notes
<!-- Quick notes and observations -->

---
*Last updated: ${new Date().toISOString()}*
`;
}

// ═══════════════════════════════════════════════════════════════
// Daily Note Template
// ═══════════════════════════════════════════════════════════════

export function createDailyNoteTemplate(date: string, agentName: string): string {
  const today = new Date(date);
  const dayName = today.toLocaleDateString("en-US", { weekday: "long" });

  return `# Daily Note — ${dayName}, ${date}
## ${agentName}

### Summary
<!-- What did I accomplish today? -->

### Tasks Completed
-

### Tasks Started
-

### Learnings
<!-- What did I learn today? -->

### Tomorrow's Focus
<!-- What should I prioritize tomorrow? -->

### Notes
<!-- Additional observations -->

---
*Created: ${new Date().toISOString()}*
`;
}

// ═══════════════════════════════════════════════════════════════
// MEMORY.md Template
// ═══════════════════════════════════════════════════════════════

export function createMemoryMdTemplate(agentName: string): string {
  return `# MEMORY.md — ${agentName}
## Long-term Memory & Learnings

### About Me
<!-- Core identity and purpose -->

### Key Facts
<!-- Important facts to remember -->

### Patterns & Preferences
<!-- Observed patterns, user preferences -->

### Learnings
<!-- Important lessons learned -->

### Context
<!-- Relevant background context -->

---
*Last updated: ${new Date().toISOString()}*
`;
}

// ═══════════════════════════════════════════════════════════════
// Session Log Template
// ═══════════════════════════════════════════════════════════════

export function createSessionLogTemplate(
  sessionId: string,
  agentName: string,
  startTime: Date
): string {
  return `# Session Log — ${sessionId}
## ${agentName}

**Started:** ${startTime.toISOString()}

### Conversation
<!-- Session transcript -->

---
`;
}

// ═══════════════════════════════════════════════════════════════
// Template Helpers
// ═══════════════════════════════════════════════════════════════

export function getTemplateForSubtype(
  subtype: MemorySubtype,
  agentName: string,
  metadata?: Record<string, unknown>
): string {
  switch (subtype) {
    case "working_md":
      return createWorkingMdTemplate(agentName);

    case "daily_note": {
      const date = metadata?.date as string || new Date().toISOString().split("T")[0];
      return createDailyNoteTemplate(date, agentName);
    }

    case "memory_md":
      return createMemoryMdTemplate(agentName);

    case "session_log": {
      const sessionId = metadata?.sessionId as string || "unknown";
      const startTime = metadata?.startTime as Date || new Date();
      return createSessionLogTemplate(sessionId, agentName, startTime);
    }

    default:
      return "";
  }
}

// ═══════════════════════════════════════════════════════════════
// Content Formatting
// ═══════════════════════════════════════════════════════════════

export function appendToMemoryMd(
  existingContent: string,
  newEntry: string,
  section?: string
): string {
  const timestamp = new Date().toISOString();
  const entry = `\n#### ${timestamp}\n${newEntry}\n`;

  if (section) {
    // Try to append to specific section
    const sectionRegex = new RegExp(`### ${section}\\n`, "i");
    if (sectionRegex.test(existingContent)) {
      return existingContent.replace(
        sectionRegex,
        `### ${section}\n${entry}`
      );
    }
  }

  // Append to end before footer
  const footerRegex = /---\n\*Last updated:/;
  if (footerRegex.test(existingContent)) {
    return existingContent.replace(
      footerRegex,
      `${entry}\n---\n*Last updated:`
    );
  }

  // Just append to end
  return existingContent + entry;
}

export function updateWorkingMdSection(
  existingContent: string,
  section: "Current Focus" | "Active Tasks" | "Context" | "Blockers" | "Notes",
  newContent: string
): string {
  const sectionRegex = new RegExp(`## ${section}\\n[\\s\\S]*?(?=\\n## |\\n---|$)`, "i");

  if (sectionRegex.test(existingContent)) {
    return existingContent.replace(
      sectionRegex,
      `## ${section}\n${newContent}\n`
    );
  }

  // Section doesn't exist, append it before footer
  const footerRegex = /---\n\*Last updated:/;
  if (footerRegex.test(existingContent)) {
    return existingContent.replace(
      footerRegex,
      `\n## ${section}\n${newContent}\n\n---\n*Last updated:`
    );
  }

  return existingContent + `\n## ${section}\n${newContent}\n`;
}

export function updateTimestamp(content: string): string {
  const timestamp = new Date().toISOString();
  return content.replace(
    /\*Last updated:.*?\*/,
    `*Last updated: ${timestamp}*`
  );
}
