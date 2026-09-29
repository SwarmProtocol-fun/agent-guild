/**
 * SOUL (System Of Understanding & Learning) Files
 *
 * YAML-based personality and behavior configuration for agents.
 * Defines traits, communication style, decision-making patterns, and more.
 */

import { db } from "./firebase";
import { doc, getDoc, updateDoc, serverTimestamp } from "firebase/firestore";
import { logActivity } from "./activity";
import type { Agent } from "./firestore";

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export interface SOULConfig {
  version: string;
  identity: {
    name: string;
    role: string;
    purpose: string;
  };
  personality: {
    traits: string[];
    communicationStyle: "formal" | "casual" | "technical" | "friendly" | "direct";
    emotionalRange: "expressive" | "balanced" | "reserved" | "analytical";
    humor: "none" | "subtle" | "moderate" | "witty";
  };
  behavior: {
    decisionMaking: "data-driven" | "intuitive" | "collaborative" | "autonomous";
    riskTolerance: "conservative" | "moderate" | "aggressive";
    learningStyle: "observational" | "interactive" | "experimental" | "analytical";
    responseSpeed: "instant" | "considered" | "deliberate";
  };
  capabilities: {
    skills: string[];
    languages?: string[];
    domains?: string[];
    limitations?: string[];
  };
  ethics: {
    principles: string[];
    boundaries: string[];
    priorities: string[];
  };
  interactions: {
    greetingStyle: string;
    farewellStyle: string;
    errorHandling: "apologetic" | "explanatory" | "solution-focused" | "direct";
    feedbackPreference: "detailed" | "concise" | "adaptive";
  };
  memory?: {
    retentionStrategy: "comprehensive" | "selective" | "minimal";
    forgettingCurve: "slow" | "moderate" | "fast";
    contextWindow: number;
  };
  customFields?: Record<string, unknown>;
}

export interface ValidationError {
  field: string;
  message: string;
  severity: "error" | "warning";
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationError[];
  parsedConfig?: SOULConfig;
}

// ═══════════════════════════════════════════════════════════════
// YAML Parsing (Simple Implementation)
// ═══════════════════════════════════════════════════════════════

/**
 * Parse YAML content into SOULConfig
 * Note: This is a simplified YAML parser. For production, use a library like js-yaml.
 */
export function parseYAML(yamlContent: string): SOULConfig {
  try {
    // Remove comments
    const withoutComments = yamlContent
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");

    // Simple key-value parsing
    const lines = withoutComments.split("\n");
    const config: Record<string, unknown> = {};
    let currentSection: Record<string, unknown> | null = null;
    let currentKey = "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const indent = line.length - trimmed.length;

      // Top-level key
      if (indent === 0 && trimmed.includes(":")) {
        const [key, value] = trimmed.split(":").map((s) => s.trim());
        currentKey = key;
        if (value) {
          config[key] = parseValue(value);
        } else {
          config[key] = {};
          currentSection = config[key] as Record<string, unknown>;
        }
      }
      // Nested key
      else if (indent === 2 && trimmed.includes(":") && currentSection) {
        const [key, value] = trimmed.split(":").map((s) => s.trim());
        if (value) {
          currentSection[key] = parseValue(value);
        } else {
          currentSection[key] = {};
        }
      }
      // Array item
      else if (trimmed.startsWith("- ") && currentSection) {
        const value = trimmed.substring(2).trim();
        const lastKey = Object.keys(currentSection).pop();
        if (lastKey) {
          if (!Array.isArray(currentSection[lastKey])) {
            currentSection[lastKey] = [];
          }
          (currentSection[lastKey] as unknown[]).push(parseValue(value));
        }
      }
    }

    return config as unknown as SOULConfig;
  } catch (error) {
    throw new Error(
      `YAML parsing failed: ${error instanceof Error ? error.message : "Unknown error"}`
    );
  }
}

function parseValue(value: string): unknown {
  const trimmed = value.trim();

  // Boolean
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;

  // Number
  if (!isNaN(Number(trimmed))) return Number(trimmed);

  // String (remove quotes if present)
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

/**
 * Convert SOULConfig to YAML string
 */
export function toYAML(config: SOULConfig): string {
  const lines: string[] = [];

  lines.push(`version: ${config.version}`);
  lines.push("");

  // Identity
  lines.push("identity:");
  lines.push(`  name: ${config.identity.name}`);
  lines.push(`  role: ${config.identity.role}`);
  lines.push(`  purpose: ${config.identity.purpose}`);
  lines.push("");

  // Personality
  lines.push("personality:");
  lines.push("  traits:");
  config.personality.traits.forEach((trait) => {
    lines.push(`    - ${trait}`);
  });
  lines.push(`  communicationStyle: ${config.personality.communicationStyle}`);
  lines.push(`  emotionalRange: ${config.personality.emotionalRange}`);
  lines.push(`  humor: ${config.personality.humor}`);
  lines.push("");

  // Behavior
  lines.push("behavior:");
  lines.push(`  decisionMaking: ${config.behavior.decisionMaking}`);
  lines.push(`  riskTolerance: ${config.behavior.riskTolerance}`);
  lines.push(`  learningStyle: ${config.behavior.learningStyle}`);
  lines.push(`  responseSpeed: ${config.behavior.responseSpeed}`);
  lines.push("");

  // Capabilities
  lines.push("capabilities:");
  lines.push("  skills:");
  config.capabilities.skills.forEach((skill) => {
    lines.push(`    - ${skill}`);
  });
  if (config.capabilities.languages) {
    lines.push("  languages:");
    config.capabilities.languages.forEach((lang) => {
      lines.push(`    - ${lang}`);
    });
  }
  if (config.capabilities.domains) {
    lines.push("  domains:");
    config.capabilities.domains.forEach((domain) => {
      lines.push(`    - ${domain}`);
    });
  }
  if (config.capabilities.limitations) {
    lines.push("  limitations:");
    config.capabilities.limitations.forEach((limitation) => {
      lines.push(`    - ${limitation}`);
    });
  }
  lines.push("");

  // Ethics
  lines.push("ethics:");
  lines.push("  principles:");
  config.ethics.principles.forEach((principle) => {
    lines.push(`    - ${principle}`);
  });
  lines.push("  boundaries:");
  config.ethics.boundaries.forEach((boundary) => {
    lines.push(`    - ${boundary}`);
  });
  lines.push("  priorities:");
  config.ethics.priorities.forEach((priority) => {
    lines.push(`    - ${priority}`);
  });
  lines.push("");

  // Interactions
  lines.push("interactions:");
  lines.push(`  greetingStyle: ${config.interactions.greetingStyle}`);
  lines.push(`  farewellStyle: ${config.interactions.farewellStyle}`);
  lines.push(`  errorHandling: ${config.interactions.errorHandling}`);
  lines.push(`  feedbackPreference: ${config.interactions.feedbackPreference}`);
  lines.push("");

  // Memory (optional)
  if (config.memory) {
    lines.push("memory:");
    lines.push(`  retentionStrategy: ${config.memory.retentionStrategy}`);
    lines.push(`  forgettingCurve: ${config.memory.forgettingCurve}`);
    lines.push(`  contextWindow: ${config.memory.contextWindow}`);
    lines.push("");
  }

  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════
// Validation
// ═══════════════════════════════════════════════════════════════

export function validateSOUL(yamlContent: string): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationError[] = [];

  try {
    const config = parseYAML(yamlContent);

    // Required fields
    if (!config.version) {
      errors.push({
        field: "version",
        message: "Version is required",
        severity: "error",
      });
    }

    if (!config.identity) {
      errors.push({
        field: "identity",
        message: "Identity section is required",
        severity: "error",
      });
    } else {
      if (!config.identity.name) {
        errors.push({
          field: "identity.name",
          message: "Identity name is required",
          severity: "error",
        });
      }
      if (!config.identity.role) {
        errors.push({
          field: "identity.role",
          message: "Identity role is required",
          severity: "error",
        });
      }
      if (!config.identity.purpose) {
        errors.push({
          field: "identity.purpose",
          message: "Identity purpose is required",
          severity: "error",
        });
      }
    }

    if (!config.personality) {
      errors.push({
        field: "personality",
        message: "Personality section is required",
        severity: "error",
      });
    } else {
      if (!config.personality.traits || config.personality.traits.length === 0) {
        warnings.push({
          field: "personality.traits",
          message: "At least one personality trait is recommended",
          severity: "warning",
        });
      }
    }

    if (!config.capabilities) {
      errors.push({
        field: "capabilities",
        message: "Capabilities section is required",
        severity: "error",
      });
    } else {
      if (!config.capabilities.skills || config.capabilities.skills.length === 0) {
        warnings.push({
          field: "capabilities.skills",
          message: "At least one skill is recommended",
          severity: "warning",
        });
      }
    }

    if (!config.ethics) {
      warnings.push({
        field: "ethics",
        message: "Ethics section is recommended",
        severity: "warning",
      });
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      parsedConfig: config,
    };
  } catch (error) {
    errors.push({
      field: "yaml",
      message: error instanceof Error ? error.message : "Invalid YAML format",
      severity: "error",
    });

    return {
      valid: false,
      errors,
      warnings,
    };
  }
}

// ═══════════════════════════════════════════════════════════════
// Default Templates
// ═══════════════════════════════════════════════════════════════

export function getDefaultSOUL(agentName: string, agentType: string): string {
  return `version: "1.0"

identity:
  name: ${agentName}
  role: ${agentType}
  purpose: Assist with ${agentType.toLowerCase()} tasks and operations

personality:
  traits:
    - helpful
    - professional
    - detail-oriented
  communicationStyle: friendly
  emotionalRange: balanced
  humor: subtle

behavior:
  decisionMaking: data-driven
  riskTolerance: moderate
  learningStyle: analytical
  responseSpeed: considered

capabilities:
  skills:
    - problem-solving
    - communication
    - analysis
  languages:
    - English
  domains:
    - ${agentType.toLowerCase()}

ethics:
  principles:
    - transparency
    - accuracy
    - respect
  boundaries:
    - no harmful content
    - respect privacy
  priorities:
    - user safety
    - task completion
    - continuous improvement

interactions:
  greetingStyle: "Hello! I'm ${agentName}, ready to assist."
  farewellStyle: "Goodbye! Let me know if you need anything."
  errorHandling: solution-focused
  feedbackPreference: detailed

memory:
  retentionStrategy: selective
  forgettingCurve: moderate
  contextWindow: 10000
`;
}

// ═══════════════════════════════════════════════════════════════
// Firestore Operations
// ═══════════════════════════════════════════════════════════════

/**
 * Get SOUL configuration for an agent
 */
export async function getAgentSOUL(agentId: string): Promise<string | null> {
  const agentDoc = await getDoc(doc(db, "agents", agentId));
  if (!agentDoc.exists()) {
    throw new Error("Agent not found");
  }

  const agent = { id: agentDoc.id, ...agentDoc.data() } as Agent;
  return agent.soulConfig || null;
}

/**
 * Update SOUL configuration for an agent
 */
export async function updateAgentSOUL(
  orgId: string,
  agentId: string,
  yamlContent: string
): Promise<void> {
  // Validate first
  const validation = validateSOUL(yamlContent);
  if (!validation.valid) {
    throw new Error(
      `Invalid SOUL configuration: ${validation.errors.map((e) => e.message).join(", ")}`
    );
  }

  const agentDoc = await getDoc(doc(db, "agents", agentId));
  if (!agentDoc.exists()) {
    throw new Error("Agent not found");
  }

  const agent = { id: agentDoc.id, ...agentDoc.data() } as Agent;
  if (agent.orgId !== orgId) {
    throw new Error("Agent does not belong to this organization");
  }

  const version = validation.parsedConfig?.version || "1.0";

  await updateDoc(doc(db, "agents", agentId), {
    soulConfig: yamlContent,
    soulVersion: version,
    soulUpdatedAt: serverTimestamp(),
  });

  // Log activity
  await logActivity({
    orgId,
    eventType: "config.changed",
    actorType: "agent",
    actorId: agentId,
    actorName: agent.name,
    description: `SOUL config updated to version ${version}`,
    metadata: {
      configType: "soul",
      version,
    },
  });
}
