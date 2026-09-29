/** Agent Map Node Catalog — Defines all draggable node types for the agent-map sidebar palette. */

export interface CatalogNodeItem {
  nodeType: string;
  label: string;
  description: string;
  icon: string;
  defaultData: Record<string, unknown>;
  color: string; // tailwind color fragment: "amber", "purple", "blue", "orange", "red", "yellow"
}

export interface CatalogCategory {
  id: string;
  label: string;
  icon: string;
  items: CatalogNodeItem[];
}

export const NODE_CATALOG: CatalogCategory[] = [
  {
    id: "triggers",
    label: "Triggers",
    icon: "⚡",
    items: [
      {
        nodeType: "mapPrompt",
        label: "Prompt",
        description: "Enter a prompt to start the workflow",
        icon: "💬",
        defaultData: { label: "Prompt", prompt: "" },
        color: "amber",
      },
      {
        nodeType: "mapTriggerManual",
        label: "Manual Start",
        description: "Manually trigger the workflow",
        icon: "▶️",
        defaultData: { label: "Manual Start", triggerType: "manual" },
        color: "amber",
      },
      {
        nodeType: "mapTriggerWebhook",
        label: "Webhook",
        description: "Trigger on incoming HTTP request",
        icon: "🔗",
        defaultData: { label: "Webhook", triggerType: "webhook", url: "" },
        color: "amber",
      },
      {
        nodeType: "mapTriggerSchedule",
        label: "Schedule",
        description: "Cron or interval-based trigger",
        icon: "🕐",
        defaultData: { label: "Schedule", triggerType: "schedule", cron: "0 * * * *" },
        color: "amber",
      },
      {
        nodeType: "mapTriggerJobComplete",
        label: "On Job Complete",
        description: "Fire when a tracked job finishes",
        icon: "✅",
        defaultData: { label: "On Job Complete", triggerType: "jobComplete" },
        color: "amber",
      },
    ],
  },
  {
    id: "logic",
    label: "Logic",
    icon: "🔀",
    items: [
      {
        nodeType: "mapCondition",
        label: "If / Condition",
        description: "Branch based on a boolean expression",
        icon: "❓",
        defaultData: { label: "Condition", condition: "" },
        color: "purple",
      },
      {
        nodeType: "mapSwitch",
        label: "Switch",
        description: "Multi-way branch on a value",
        icon: "🔀",
        defaultData: { label: "Switch", field: "", cases: ["Case 1", "Case 2"] },
        color: "purple",
      },
      {
        nodeType: "mapMerge",
        label: "Merge",
        description: "Join multiple branches into one",
        icon: "🔗",
        defaultData: { label: "Merge", mode: "waitAll", inputCount: 2 },
        color: "purple",
      },
    ],
  },
  {
    id: "actions",
    label: "Actions",
    icon: "🚀",
    items: [
      {
        nodeType: "mapHttpRequest",
        label: "HTTP Request",
        description: "Make an outbound HTTP call",
        icon: "🌐",
        defaultData: { label: "HTTP Request", method: "GET", url: "" },
        color: "blue",
      },
      {
        nodeType: "mapCodeScript",
        label: "Code / Script",
        description: "Run a custom code snippet",
        icon: "💻",
        defaultData: { label: "Code", language: "javascript", code: "" },
        color: "blue",
      },
      {
        nodeType: "mapDispatchJob",
        label: "Dispatch Job",
        description: "Create and assign a new job to agents",
        icon: "📤",
        defaultData: { label: "Dispatch Job", prompt: "", priority: "medium" },
        color: "blue",
      },
      {
        nodeType: "mapSendMessage",
        label: "Send Message",
        description: "Post a message to a channel or agent",
        icon: "💬",
        defaultData: { label: "Send Message", target: "", message: "" },
        color: "blue",
      },
    ],
  },
  {
    id: "flow",
    label: "Flow Control",
    icon: "⏳",
    items: [
      {
        nodeType: "mapDelay",
        label: "Delay / Wait",
        description: "Pause execution for a duration",
        icon: "⏳",
        defaultData: { label: "Delay", durationMs: 5000 },
        color: "orange",
      },
      {
        nodeType: "mapLoop",
        label: "Loop",
        description: "Repeat over a collection or count",
        icon: "🔄",
        defaultData: { label: "Loop", mode: "count", count: 3 },
        color: "orange",
      },
      {
        nodeType: "mapErrorHandler",
        label: "Error Handler",
        description: "Catch and handle errors in the flow",
        icon: "🛑",
        defaultData: { label: "Error Handler", action: "retry", retries: 3 },
        color: "red",
      },
    ],
  },
  {
    id: "ai",
    label: "AI",
    icon: "🧠",
    items: [
      {
        nodeType: "mapLlmCall",
        label: "LLM Call",
        description: "Send a prompt to an LLM and get a response",
        icon: "🧠",
        defaultData: { label: "LLM Call", model: "claude-sonnet", prompt: "" },
        color: "purple",
      },
      {
        nodeType: "mapSummarizer",
        label: "Summarizer",
        description: "Summarize text or data with AI",
        icon: "📋",
        defaultData: { label: "Summarizer", inputField: "", maxLength: 500 },
        color: "purple",
      },
      {
        nodeType: "mapClassifier",
        label: "Classifier",
        description: "Classify input into categories with AI",
        icon: "🏷️",
        defaultData: { label: "Classifier", categories: ["positive", "negative", "neutral"] },
        color: "purple",
      },
    ],
  },
  {
    id: "annotations",
    label: "Annotations",
    icon: "📝",
    items: [
      {
        nodeType: "mapSticky",
        label: "Sticky Note",
        description: "Add a note or comment to the canvas",
        icon: "📝",
        defaultData: { label: "Note", content: "", color: "yellow", width: 200, height: 120 },
        color: "yellow",
      },
    ],
  },
];

/** Flat map of all catalog items keyed by nodeType for quick lookup */
export const NODE_CATALOG_MAP: Record<string, CatalogNodeItem> = {};
for (const cat of NODE_CATALOG) {
  for (const item of cat.items) {
    NODE_CATALOG_MAP[item.nodeType] = item;
  }
}
