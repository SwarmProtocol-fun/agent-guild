# Creating Mods for Agent Guild Protocol

> **Two things are called "mods".** This page covers *marketplace* mods — behavioral listings (prompt/config). To write **code** that adds panels, API routes and event handlers, see [`mod-sdk.md`](mod-sdk.md).

Mods are behavioral modifiers that change how agents communicate, reason, and operate. Unlike plugins (which add external service integrations) or skills (which add new capabilities), mods shape the agent's existing behavior.

---

## What is a Mod?

A mod modifies an agent's behavior without adding new tools or external dependencies. Examples:

- **Communication style** — enforce tone, verbosity, formality
- **Reasoning patterns** — require step-by-step thinking, structured output
- **Safety constraints** — add approval gates, prevent destructive actions
- **Workflow rules** — enforce naming conventions, documentation requirements
- **Personality** — define agent persona, character traits, response style
- **Compliance** — industry regulations, standards enforcement

Mods have no `requiredKeys` (no API keys needed) and work purely through prompt engineering and behavioral configuration.

---

## Mod Structure

Every mod in the Agent Guild marketplace follows the `Skill` interface:

```typescript
interface Mod {
  id: string;            // unique kebab-case identifier
  name: string;          // human-readable display name
  description: string;   // what this mod does (1-2 sentences)
  type: "mod";           // always "mod" for mods
  source: "community";   // "community" for submissions, "verified" for Agent Guild Core
  category: string;      // grouping category (see below)
  icon: string;          // single emoji representing the mod
  version: string;       // semver (e.g. "1.0.0")
  author: string;        // your name or org
  tags: string[];        // search keywords (4-8 tags)
  pricing: {
    model: "free" | "subscription";
    tiers?: {            // only if subscription
      plan: "monthly" | "yearly" | "lifetime";
      price: number;
      currency: string;  // "USD" or "SOL"
    }[];
  };
  manifest?: ModManifest; // optional: structured capability declaration
}
```

### Categories

Choose the category that best fits your mod:

| Category | Use for |
|----------|---------|
| Communication Style | Tone, verbosity, language, formality |
| Safety | Guardrails, approval gates, constraints |
| Reasoning | Thinking patterns, structured output |
| Workflow | Process rules, naming, documentation |
| Personality | Agent persona, character traits |
| Compliance | Industry regulations, standards |

If none of these fit, you can propose a new category in your submission.

---

## The ModManifest Specification

A `ModManifest` is a structured declaration of everything a mod provides. It tells agents and operators exactly what capabilities come with the mod. When a user clicks on your mod in the marketplace, the manifest data is rendered as an interactive detail page with expandable sections.

```typescript
interface ModManifest {
  tools: ModTool[];           // discrete capabilities the mod provides
  workflows: ModWorkflow[];   // multi-step processes and automations
  examples: ModExample[];     // runnable code snippets demonstrating usage
  agentSkills: ModAgentSkill[]; // invocable skills agents can use
}
```

### Tools

Tools are discrete capabilities that the mod adds. Each tool has a category, status, and optional usage example.

```typescript
interface ModTool {
  id: string;              // unique kebab-case identifier
  name: string;            // display name
  description: string;     // what this tool does
  icon: string;            // single emoji
  category: string;        // grouping (e.g. "Data Feeds", "Verification", "Automation")
  status: "active" | "coming_soon";  // availability
  usageExample?: string;   // code snippet showing how to use it
}
```

**Example:**

```typescript
{
  id: "price-feed",
  name: "Price Feed",
  description: "Real-time price data from decentralized oracle networks",
  icon: "📊",
  category: "Data Feeds",
  status: "active",
  usageExample: "const price = await priceFeed.getLatestPrice('ETH/USD');"
}
```

### Workflows

Workflows are multi-step processes that the mod enables. Each workflow has ordered steps and an optional time estimate.

```typescript
interface ModWorkflow {
  id: string;              // unique kebab-case identifier
  name: string;            // display name
  description: string;     // what this workflow accomplishes
  icon: string;            // single emoji
  tags: string[];          // categorization tags
  steps: string[];         // ordered list of steps
  estimatedTime?: string;  // human-readable time estimate (e.g. "2-5 minutes")
}
```

**Example:**

```typescript
{
  id: "data-validation-pipeline",
  name: "Data Validation Pipeline",
  description: "Verify data integrity through multi-source cross-referencing",
  icon: "🔄",
  tags: ["validation", "data-integrity"],
  steps: [
    "Fetch data from primary source",
    "Cross-reference with secondary sources",
    "Flag discrepancies above threshold",
    "Generate validation report"
  ],
  estimatedTime: "1-3 minutes"
}
```

### Agent Skills

Agent skills are invocable capabilities with defined input/output patterns. These tell agents exactly how to use the mod's features.

```typescript
interface ModAgentSkill {
  id: string;              // unique kebab-case identifier
  name: string;            // display name
  description: string;     // what this skill does
  type: "skill";           // always "skill"
  invocation: string;      // how an agent invokes this skill (command syntax)
  exampleInput?: string;   // sample input the agent would provide
  exampleOutput?: string;  // expected output format
}
```

**Example:**

```typescript
{
  id: "verify-data",
  name: "Verify Data",
  description: "Cross-reference data points against trusted sources",
  type: "skill",
  invocation: "verify --source <url> --confidence <threshold>",
  exampleInput: "verify --source https://api.example.com/data --confidence 0.95",
  exampleOutput: "✅ Verified: 98.2% confidence (3/3 sources agree)"
}
```

### Code Examples

Code examples are runnable snippets that demonstrate the mod's capabilities. Each example has a language tag for syntax highlighting.

```typescript
interface ModExample {
  id: string;              // unique kebab-case identifier
  name: string;            // display name
  description: string;     // what this example demonstrates
  icon: string;            // single emoji
  tags: string[];          // categorization tags
  codeSnippet?: string;    // the actual code
  language?: string;       // language for syntax highlighting (e.g. "typescript", "python")
}
```

**Example:**

```typescript
{
  id: "basic-setup",
  name: "Basic Setup",
  description: "Initialize the mod and configure primary data source",
  icon: "🚀",
  tags: ["setup", "quickstart"],
  codeSnippet: `import { MyMod } from '@agent-guild/my-mod';

const mod = new MyMod({
  source: 'https://api.example.com',
  refreshInterval: 60000
});

await mod.initialize();`,
  language: "typescript"
}
```

---

## Complete Manifest Example

Here's a full mod with a complete manifest:

```typescript
{
  id: "data-guardian",
  name: "Data Guardian",
  description: "Ensures data integrity and validation across all agent operations.",
  type: "mod",
  source: "community",
  category: "Safety",
  icon: "🛡️",
  version: "1.0.0",
  author: "YourName",
  tags: ["data", "validation", "integrity", "safety", "verification"],
  pricing: { model: "free" },
  manifest: {
    tools: [
      {
        id: "integrity-checker",
        name: "Integrity Checker",
        description: "Validates data consistency across sources",
        icon: "✅",
        category: "Verification",
        status: "active",
        usageExample: "await integrityChecker.validate(dataset);"
      }
    ],
    workflows: [
      {
        id: "full-audit",
        name: "Full Data Audit",
        description: "Complete audit of all data sources and outputs",
        icon: "📋",
        tags: ["audit", "compliance"],
        steps: [
          "Inventory all active data sources",
          "Run consistency checks on each source",
          "Cross-reference outputs against inputs",
          "Generate audit report with findings"
        ],
        estimatedTime: "5-10 minutes"
      }
    ],
    agentSkills: [
      {
        id: "quick-validate",
        name: "Quick Validate",
        description: "Fast validation check on a single data point",
        type: "skill",
        invocation: "validate <data-url>",
        exampleInput: "validate https://api.example.com/metrics",
        exampleOutput: "✅ Valid: all 12 fields pass schema check"
      }
    ],
    examples: [
      {
        id: "setup-example",
        name: "Getting Started",
        description: "Initialize Data Guardian for your org",
        icon: "🚀",
        tags: ["setup"],
        codeSnippet: "// Data Guardian activates automatically once installed\n// No configuration needed — it monitors all agent data operations",
        language: "typescript"
      }
    ]
  }
}
```

---

## How the Manifest is Displayed

When a user clicks on your mod in the **Market** detail page, the manifest renders as:

1. **Stats Row** — Four cards showing counts: Tools, Workflows, Agent Skills, Code Examples
2. **Tools Section** — Expandable cards with category badges, status indicators, and copyable usage examples
3. **Workflows Section** — Expandable cards with numbered step lists and time estimates
4. **Agent Skills Section** — Expandable cards with invocation commands and example input/output
5. **Code Examples Section** — Expandable cards with syntax-highlighted code and copy-to-clipboard

Mods without a manifest still display normally with their description, tags, and install button — the manifest just adds a richer detail view.

---

## Sidebar Display

When a mod is installed, it appears in the **Modifications** section of the sidebar. This section uses a distinct accent color (cyan) to visually separate mods from other navigation items. The section is only visible when at least one mod is installed.

---

## Submission Process

### 1. Prepare Your Mod

- Choose a unique `id` (kebab-case, descriptive)
- Write a clear `description` that explains the behavioral change
- Pick an appropriate `category` and `icon`
- Add relevant `tags` for discoverability
- Optionally create a `ModManifest` to showcase your mod's full capabilities

### 2. Submit via the Marketplace

1. Go to the **Market** page in AgentGuildApp
2. Click the **Submit** tab
3. Fill out the submission form:
   - Select type: **Mod**
   - Enter your mod's name, description, category, icon, and tags
   - Set pricing (free or subscription tiers)
4. Click **Submit for Review**

### 3. Review Process

All submissions go through review before appearing in the marketplace:

- **Status: Pending** — Your mod is in the review queue
- **Status: Approved** — Your mod is live in the marketplace
- **Status: Rejected** — Didn't meet guidelines (you can revise and resubmit)

You can track your submissions in the **Submit** tab under "Your Submissions."

---

## Guidelines

### Do

- **Be specific** — "Enforce APA citation format in research outputs" is better than "Better formatting"
- **Test behavior** — Verify your mod actually changes agent behavior in meaningful ways
- **Write clear descriptions** — Users should understand exactly what installing your mod does
- **Use descriptive tags** — Help users find your mod through search
- **Version properly** — Start at `1.0.0`, bump for updates
- **Include a manifest** — A rich manifest helps users understand your mod before installing

### Don't

- **Don't duplicate existing mods** — Check the marketplace first
- **Don't bundle unrelated behaviors** — One mod = one behavioral change
- **Don't require API keys** — Mods should not need external services (use plugins for that)
- **Don't create destructive mods** — Mods that intentionally degrade agent performance will be rejected
- **Don't misrepresent pricing** — If your mod requires a subscription, be transparent about what's free vs paid

---

## Pricing Your Mod

Mods can be free or subscription-based:

**Free** — Available to all orgs at no cost. Great for building reputation and adoption.

**Subscription** — Recurring revenue. Available plans:
- **Monthly** — Recurring monthly charge
- **Yearly** — Annual billing (typically discounted vs monthly)
- **Lifetime** — One-time payment for permanent access

Set pricing in your submission. Currency can be USD or SOL.

---

## Questions?

Join the Agent Guild community to discuss mod development, get feedback on your ideas, and collaborate with other builders.
