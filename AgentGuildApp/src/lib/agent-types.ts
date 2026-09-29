/**
 * Central Agent Type Registry
 *
 * Single source of truth for all agent types, categories, colors, and helpers.
 * Replaces the previously-hardcoded TYPE_COLORS / TYPE_DESCRIPTIONS / AGENT_TYPES
 * scattered across 40+ files.
 *
 * Based on https://github.com/VoltAgent/awesome-codex-subagents
 */

// ═══════════════════════════════════════════════════════════════
// Type Definitions
// ═══════════════════════════════════════════════════════════════

export type AgentTypeCategory =
  | "core-development"
  | "language-specialists"
  | "infrastructure"
  | "quality-security"
  | "data-ai"
  | "developer-experience"
  | "specialized-domains"
  | "business-product"
  | "meta-orchestration"
  | "research-analysis";

export interface AgentTypeInfo {
  id: string;
  label: string;
  category: AgentTypeCategory;
  description: string;
  tags?: string[];
  isLegacy?: boolean;
}

export interface AgentTypeCategoryInfo {
  label: string;
  description: string;
  colorClasses: string;
  icon: string;
}

// ═══════════════════════════════════════════════════════════════
// Category Configuration
// ═══════════════════════════════════════════════════════════════

export const AGENT_TYPE_CATEGORIES: Record<AgentTypeCategory, AgentTypeCategoryInfo> = {
  "core-development": {
    label: "Core Development",
    description: "Full-stack, backend, frontend, mobile, and API development",
    colorClasses: "bg-blue-100 text-blue-700 border-blue-200",
    icon: "💻",
  },
  "language-specialists": {
    label: "Language Specialists",
    description: "Framework and language experts",
    colorClasses: "bg-violet-100 text-violet-700 border-violet-200",
    icon: "🔤",
  },
  "infrastructure": {
    label: "Infrastructure",
    description: "DevOps, cloud, containers, and platform engineering",
    colorClasses: "bg-orange-100 text-orange-700 border-orange-200",
    icon: "🏗️",
  },
  "quality-security": {
    label: "Quality & Security",
    description: "Testing, auditing, debugging, and security hardening",
    colorClasses: "bg-red-100 text-red-700 border-red-200",
    icon: "🛡️",
  },
  "data-ai": {
    label: "Data & AI",
    description: "Data engineering, ML/AI, analytics, and prompt engineering",
    colorClasses: "bg-emerald-100 text-emerald-700 border-emerald-200",
    icon: "🧠",
  },
  "developer-experience": {
    label: "Developer Experience",
    description: "Tooling, build systems, documentation, and DX optimization",
    colorClasses: "bg-cyan-100 text-cyan-700 border-cyan-200",
    icon: "🔧",
  },
  "specialized-domains": {
    label: "Specialized Domains",
    description: "Blockchain, fintech, gaming, IoT, and domain-specific experts",
    colorClasses: "bg-pink-100 text-pink-700 border-pink-200",
    icon: "🎯",
  },
  "business-product": {
    label: "Business & Product",
    description: "Product management, marketing, legal, and business analysis",
    colorClasses: "bg-amber-100 text-amber-700 border-amber-200",
    icon: "📊",
  },
  "meta-orchestration": {
    label: "Meta & Orchestration",
    description: "Multi-agent coordination, workflows, and task distribution",
    colorClasses: "bg-indigo-100 text-indigo-700 border-indigo-200",
    icon: "🎛️",
  },
  "research-analysis": {
    label: "Research & Analysis",
    description: "Market research, competitive analysis, and trend tracking",
    colorClasses: "bg-teal-100 text-teal-700 border-teal-200",
    icon: "🔬",
  },
};

// ═══════════════════════════════════════════════════════════════
// Legacy Type Mapping (original 16 types → new slugs)
// ═══════════════════════════════════════════════════════════════

export const LEGACY_TYPE_MAP: Record<string, string> = {
  Research: "research-analyst",
  Trading: "fintech-engineer",
  Operations: "workflow-orchestrator",
  Support: "customer-success-manager",
  Analytics: "data-analyst",
  Scout: "search-specialist",
  Security: "security-auditor",
  Creative: "content-marketer",
  Engineering: "fullstack-developer",
  DevOps: "devops-engineer",
  Marketing: "content-marketer",
  Finance: "quant-analyst",
  Data: "data-engineer",
  Coordinator: "multi-agent-coordinator",
  Legal: "legal-advisor",
  Communication: "customer-success-manager",
};

// ═══════════════════════════════════════════════════════════════
// Agent Type Registry — 139 types across 10 categories
// ═══════════════════════════════════════════════════════════════

export const AGENT_TYPE_REGISTRY: AgentTypeInfo[] = [
  // ── Core Development (12) ─────────────────────────────────
  {
    id: "api-designer",
    label: "API Designer",
    category: "core-development",
    description: "RESTful and GraphQL API architecture and documentation",
    tags: ["api", "rest", "graphql", "openapi"],
  },
  {
    id: "backend-developer",
    label: "Backend Developer",
    category: "core-development",
    description: "Server-side logic, databases, and API implementation",
    tags: ["backend", "server", "database"],
  },
  {
    id: "code-mapper",
    label: "Code Mapper",
    category: "core-development",
    description: "Codebase analysis, dependency mapping, and architecture visualization",
    tags: ["architecture", "analysis", "mapping"],
  },
  {
    id: "electron-pro",
    label: "Electron Pro",
    category: "core-development",
    description: "Cross-platform desktop app development with Electron",
    tags: ["electron", "desktop", "cross-platform"],
  },
  {
    id: "frontend-developer",
    label: "Frontend Developer",
    category: "core-development",
    description: "UI implementation, responsive design, and browser APIs",
    tags: ["frontend", "ui", "css", "html"],
  },
  {
    id: "fullstack-developer",
    label: "Fullstack Developer",
    category: "core-development",
    description: "End-to-end application development across all layers",
    tags: ["fullstack", "frontend", "backend"],
    isLegacy: true,
  },
  {
    id: "graphql-architect",
    label: "GraphQL Architect",
    category: "core-development",
    description: "GraphQL schema design, resolvers, and federation",
    tags: ["graphql", "schema", "federation"],
  },
  {
    id: "microservices-architect",
    label: "Microservices Architect",
    category: "core-development",
    description: "Distributed systems design and service decomposition",
    tags: ["microservices", "distributed", "architecture"],
  },
  {
    id: "mobile-developer",
    label: "Mobile Developer",
    category: "core-development",
    description: "Native and cross-platform mobile app development",
    tags: ["mobile", "ios", "android", "react-native"],
  },
  {
    id: "ui-designer",
    label: "UI Designer",
    category: "core-development",
    description: "User interface design, component libraries, and design systems",
    tags: ["ui", "design", "components", "figma"],
  },
  {
    id: "ui-fixer",
    label: "UI Fixer",
    category: "core-development",
    description: "CSS debugging, layout fixes, and visual regression repair",
    tags: ["css", "layout", "debugging", "visual"],
  },
  {
    id: "websocket-engineer",
    label: "WebSocket Engineer",
    category: "core-development",
    description: "Real-time communication, WebSocket servers, and event streaming",
    tags: ["websocket", "realtime", "streaming"],
  },

  // ── Language Specialists (28) ─────────────────────────────
  {
    id: "angular-architect",
    label: "Angular Architect",
    category: "language-specialists",
    description: "Angular application architecture and module design",
    tags: ["angular", "typescript", "rxjs"],
  },
  {
    id: "cpp-pro",
    label: "C++ Pro",
    category: "language-specialists",
    description: "Systems programming, memory management, and performance optimization in C++",
    tags: ["cpp", "c++", "systems", "performance"],
  },
  {
    id: "csharp-developer",
    label: "C# Developer",
    category: "language-specialists",
    description: "C# application development and .NET ecosystem",
    tags: ["csharp", "dotnet", ".net"],
  },
  {
    id: "django-developer",
    label: "Django Developer",
    category: "language-specialists",
    description: "Python web development with Django framework",
    tags: ["django", "python", "web"],
  },
  {
    id: "dotnet-core-expert",
    label: ".NET Core Expert",
    category: "language-specialists",
    description: "Modern .NET Core application development and migration",
    tags: ["dotnet", ".net", "core", "csharp"],
  },
  {
    id: "dotnet-framework-expert",
    label: ".NET Framework Expert",
    category: "language-specialists",
    description: "Legacy .NET Framework maintenance and modernization",
    tags: ["dotnet", ".net", "framework", "legacy"],
  },
  {
    id: "elixir-expert",
    label: "Elixir Expert",
    category: "language-specialists",
    description: "Elixir/OTP applications, Phoenix framework, and BEAM VM",
    tags: ["elixir", "phoenix", "otp", "beam"],
  },
  {
    id: "erlang-expert",
    label: "Erlang Expert",
    category: "language-specialists",
    description: "Erlang/OTP distributed systems and fault-tolerant applications",
    tags: ["erlang", "otp", "distributed", "beam"],
  },
  {
    id: "flutter-expert",
    label: "Flutter Expert",
    category: "language-specialists",
    description: "Cross-platform mobile and desktop development with Flutter/Dart",
    tags: ["flutter", "dart", "mobile", "cross-platform"],
  },
  {
    id: "golang-pro",
    label: "Go Pro",
    category: "language-specialists",
    description: "Go application development, concurrency patterns, and microservices",
    tags: ["go", "golang", "concurrency"],
  },
  {
    id: "java-architect",
    label: "Java Architect",
    category: "language-specialists",
    description: "Enterprise Java architecture, Spring ecosystem, and JVM optimization",
    tags: ["java", "spring", "jvm", "enterprise"],
  },
  {
    id: "javascript-pro",
    label: "JavaScript Pro",
    category: "language-specialists",
    description: "Advanced JavaScript patterns, ES modules, and runtime optimization",
    tags: ["javascript", "js", "node", "browser"],
  },
  {
    id: "kotlin-specialist",
    label: "Kotlin Specialist",
    category: "language-specialists",
    description: "Kotlin for Android, server-side, and multiplatform development",
    tags: ["kotlin", "android", "jvm", "multiplatform"],
  },
  {
    id: "laravel-specialist",
    label: "Laravel Specialist",
    category: "language-specialists",
    description: "PHP web development with the Laravel framework",
    tags: ["laravel", "php", "web"],
  },
  {
    id: "nextjs-developer",
    label: "Next.js Developer",
    category: "language-specialists",
    description: "Next.js SSR/SSG, App Router, and full-stack React applications",
    tags: ["nextjs", "react", "ssr", "netlify"],
  },
  {
    id: "php-pro",
    label: "PHP Pro",
    category: "language-specialists",
    description: "Modern PHP development, Composer, and framework ecosystems",
    tags: ["php", "composer", "web"],
  },
  {
    id: "powershell-51-expert",
    label: "PowerShell 5.1 Expert",
    category: "language-specialists",
    description: "Windows PowerShell 5.1 scripting and automation",
    tags: ["powershell", "windows", "scripting"],
  },
  {
    id: "powershell-7-expert",
    label: "PowerShell 7 Expert",
    category: "language-specialists",
    description: "Cross-platform PowerShell 7+ scripting and automation",
    tags: ["powershell", "cross-platform", "scripting"],
  },
  {
    id: "python-pro",
    label: "Python Pro",
    category: "language-specialists",
    description: "Python development, packaging, async patterns, and ecosystem tools",
    tags: ["python", "pip", "async"],
  },
  {
    id: "rails-expert",
    label: "Rails Expert",
    category: "language-specialists",
    description: "Ruby on Rails application development and conventions",
    tags: ["rails", "ruby", "web"],
  },
  {
    id: "react-specialist",
    label: "React Specialist",
    category: "language-specialists",
    description: "React component architecture, hooks, state management, and performance",
    tags: ["react", "hooks", "jsx", "state"],
  },
  {
    id: "rust-engineer",
    label: "Rust Engineer",
    category: "language-specialists",
    description: "Systems programming in Rust with memory safety and concurrency",
    tags: ["rust", "systems", "memory-safety"],
  },
  {
    id: "spring-boot-engineer",
    label: "Spring Boot Engineer",
    category: "language-specialists",
    description: "Spring Boot microservices, auto-configuration, and cloud-native Java",
    tags: ["spring", "java", "boot", "microservices"],
  },
  {
    id: "sql-pro",
    label: "SQL Pro",
    category: "language-specialists",
    description: "Advanced SQL queries, schema design, and database optimization",
    tags: ["sql", "database", "queries"],
  },
  {
    id: "swift-expert",
    label: "Swift Expert",
    category: "language-specialists",
    description: "iOS/macOS development with Swift and SwiftUI",
    tags: ["swift", "ios", "macos", "swiftui"],
  },
  {
    id: "typescript-pro",
    label: "TypeScript Pro",
    category: "language-specialists",
    description: "Advanced TypeScript type systems, generics, and tooling",
    tags: ["typescript", "types", "generics"],
  },
  {
    id: "vue-expert",
    label: "Vue Expert",
    category: "language-specialists",
    description: "Vue.js application development, Composition API, and Nuxt",
    tags: ["vue", "nuxt", "composition-api"],
  },

  // ── Infrastructure (16) ───────────────────────────────────
  {
    id: "azure-infra-engineer",
    label: "Azure Infra Engineer",
    category: "infrastructure",
    description: "Azure cloud infrastructure, ARM templates, and managed services",
    tags: ["azure", "cloud", "arm", "microsoft"],
  },
  {
    id: "cloud-architect",
    label: "Cloud Architect",
    category: "infrastructure",
    description: "Multi-cloud architecture, cost optimization, and migration strategy",
    tags: ["cloud", "aws", "gcp", "azure", "multi-cloud"],
  },
  {
    id: "database-administrator",
    label: "Database Administrator",
    category: "infrastructure",
    description: "Database provisioning, replication, backups, and high availability",
    tags: ["database", "dba", "replication", "ha"],
  },
  {
    id: "deployment-engineer",
    label: "Deployment Engineer",
    category: "infrastructure",
    description: "Release management, blue-green deployments, and rollback strategies",
    tags: ["deployment", "release", "rollback"],
  },
  {
    id: "devops-engineer",
    label: "DevOps Engineer",
    category: "infrastructure",
    description: "CI/CD pipelines, infrastructure automation, and site reliability",
    tags: ["devops", "ci", "cd", "automation"],
    isLegacy: true,
  },
  {
    id: "devops-incident-responder",
    label: "DevOps Incident Responder",
    category: "infrastructure",
    description: "Incident response, root cause analysis, and post-mortem facilitation",
    tags: ["incident", "rca", "postmortem", "on-call"],
  },
  {
    id: "docker-expert",
    label: "Docker Expert",
    category: "infrastructure",
    description: "Container building, multi-stage builds, and Docker Compose orchestration",
    tags: ["docker", "containers", "compose"],
  },
  {
    id: "incident-responder",
    label: "Incident Responder",
    category: "infrastructure",
    description: "Production incident triage, escalation, and resolution coordination",
    tags: ["incident", "triage", "escalation"],
  },
  {
    id: "kubernetes-specialist",
    label: "Kubernetes Specialist",
    category: "infrastructure",
    description: "Kubernetes cluster management, Helm charts, and service mesh",
    tags: ["kubernetes", "k8s", "helm", "service-mesh"],
  },
  {
    id: "network-engineer",
    label: "Network Engineer",
    category: "infrastructure",
    description: "Network architecture, DNS, load balancing, and VPN configuration",
    tags: ["network", "dns", "load-balancer", "vpn"],
  },
  {
    id: "platform-engineer",
    label: "Platform Engineer",
    category: "infrastructure",
    description: "Internal developer platforms, self-service infrastructure, and golden paths",
    tags: ["platform", "idp", "self-service"],
  },
  {
    id: "security-engineer",
    label: "Security Engineer",
    category: "infrastructure",
    description: "Infrastructure security, network hardening, and compliance automation",
    tags: ["security", "hardening", "compliance"],
  },
  {
    id: "sre-engineer",
    label: "SRE Engineer",
    category: "infrastructure",
    description: "Site reliability engineering, SLOs, error budgets, and observability",
    tags: ["sre", "reliability", "slo", "observability"],
  },
  {
    id: "terraform-engineer",
    label: "Terraform Engineer",
    category: "infrastructure",
    description: "Infrastructure as code with Terraform, modules, and state management",
    tags: ["terraform", "iac", "hcl"],
  },
  {
    id: "terragrunt-expert",
    label: "Terragrunt Expert",
    category: "infrastructure",
    description: "Terragrunt wrapper for Terraform with DRY configurations",
    tags: ["terragrunt", "terraform", "iac"],
  },
  {
    id: "windows-infra-admin",
    label: "Windows Infra Admin",
    category: "infrastructure",
    description: "Windows Server, Active Directory, and enterprise infrastructure management",
    tags: ["windows", "active-directory", "server"],
  },

  // ── Quality & Security (16) ───────────────────────────────
  {
    id: "accessibility-tester",
    label: "Accessibility Tester",
    category: "quality-security",
    description: "WCAG compliance testing, screen reader validation, and a11y audits",
    tags: ["accessibility", "a11y", "wcag", "aria"],
  },
  {
    id: "ad-security-reviewer",
    label: "AD Security Reviewer",
    category: "quality-security",
    description: "Active Directory security assessment and privilege escalation detection",
    tags: ["active-directory", "security", "privilege"],
  },
  {
    id: "architect-reviewer",
    label: "Architect Reviewer",
    category: "quality-security",
    description: "Architecture design reviews, pattern validation, and tech debt assessment",
    tags: ["architecture", "review", "patterns"],
  },
  {
    id: "browser-debugger",
    label: "Browser Debugger",
    category: "quality-security",
    description: "Browser DevTools expertise, performance profiling, and network debugging",
    tags: ["browser", "devtools", "debugging"],
  },
  {
    id: "chaos-engineer",
    label: "Chaos Engineer",
    category: "quality-security",
    description: "Chaos testing, failure injection, and resilience validation",
    tags: ["chaos", "resilience", "failure-injection"],
  },
  {
    id: "code-reviewer",
    label: "Code Reviewer",
    category: "quality-security",
    description: "Code review automation, style enforcement, and best practice checks",
    tags: ["code-review", "style", "best-practices"],
  },
  {
    id: "compliance-auditor",
    label: "Compliance Auditor",
    category: "quality-security",
    description: "Regulatory compliance auditing, SOC2, GDPR, and HIPAA validation",
    tags: ["compliance", "audit", "soc2", "gdpr"],
  },
  {
    id: "debugger",
    label: "Debugger",
    category: "quality-security",
    description: "Advanced debugging across languages, memory leaks, and race conditions",
    tags: ["debugging", "memory", "race-condition"],
  },
  {
    id: "error-detective",
    label: "Error Detective",
    category: "quality-security",
    description: "Error tracking, stack trace analysis, and root cause investigation",
    tags: ["errors", "stack-trace", "rca"],
  },
  {
    id: "penetration-tester",
    label: "Penetration Tester",
    category: "quality-security",
    description: "Ethical hacking, vulnerability exploitation, and security assessment",
    tags: ["pentest", "hacking", "vulnerability"],
  },
  {
    id: "performance-engineer",
    label: "Performance Engineer",
    category: "quality-security",
    description: "Load testing, profiling, bottleneck analysis, and optimization",
    tags: ["performance", "load-testing", "profiling"],
  },
  {
    id: "powershell-security-hardening",
    label: "PowerShell Security Hardening",
    category: "quality-security",
    description: "PowerShell execution policy, constrained language mode, and script signing",
    tags: ["powershell", "security", "hardening"],
  },
  {
    id: "qa-expert",
    label: "QA Expert",
    category: "quality-security",
    description: "Quality assurance strategy, test planning, and defect management",
    tags: ["qa", "testing", "quality"],
  },
  {
    id: "reviewer",
    label: "Reviewer",
    category: "quality-security",
    description: "General code and documentation review with actionable feedback",
    tags: ["review", "feedback", "documentation"],
  },
  {
    id: "security-auditor",
    label: "Security Auditor",
    category: "quality-security",
    description: "Security audit, OWASP Top 10, and vulnerability assessment",
    tags: ["security", "audit", "owasp"],
    isLegacy: true,
  },
  {
    id: "test-automator",
    label: "Test Automator",
    category: "quality-security",
    description: "Test framework setup, E2E automation, and CI test integration",
    tags: ["testing", "automation", "e2e", "ci"],
  },

  // ── Data & AI (12) ────────────────────────────────────────
  {
    id: "ai-engineer",
    label: "AI Engineer",
    category: "data-ai",
    description: "AI system design, model integration, and inference pipelines",
    tags: ["ai", "inference", "models"],
  },
  {
    id: "data-analyst",
    label: "Data Analyst",
    category: "data-ai",
    description: "Data analysis, visualization, SQL queries, and business intelligence",
    tags: ["data", "analysis", "bi", "visualization"],
    isLegacy: true,
  },
  {
    id: "data-engineer",
    label: "Data Engineer",
    category: "data-ai",
    description: "Data pipelines, ETL/ELT, warehousing, and streaming architectures",
    tags: ["data", "etl", "pipelines", "streaming"],
    isLegacy: true,
  },
  {
    id: "data-scientist",
    label: "Data Scientist",
    category: "data-ai",
    description: "Statistical modeling, hypothesis testing, and experimental design",
    tags: ["data-science", "statistics", "modeling"],
  },
  {
    id: "database-optimizer",
    label: "Database Optimizer",
    category: "data-ai",
    description: "Query optimization, indexing strategy, and database performance tuning",
    tags: ["database", "optimization", "indexing"],
  },
  {
    id: "llm-architect",
    label: "LLM Architect",
    category: "data-ai",
    description: "Large language model deployment, fine-tuning, and RAG architectures",
    tags: ["llm", "rag", "fine-tuning", "gpt"],
  },
  {
    id: "machine-learning-engineer",
    label: "Machine Learning Engineer",
    category: "data-ai",
    description: "ML model training, feature engineering, and production deployment",
    tags: ["ml", "training", "features"],
  },
  {
    id: "ml-engineer",
    label: "ML Engineer",
    category: "data-ai",
    description: "End-to-end ML pipelines, model serving, and A/B testing",
    tags: ["ml", "pipeline", "serving"],
  },
  {
    id: "mlops-engineer",
    label: "MLOps Engineer",
    category: "data-ai",
    description: "ML operations, model versioning, monitoring, and drift detection",
    tags: ["mlops", "monitoring", "drift"],
  },
  {
    id: "nlp-engineer",
    label: "NLP Engineer",
    category: "data-ai",
    description: "Natural language processing, text classification, and entity extraction",
    tags: ["nlp", "text", "classification", "ner"],
  },
  {
    id: "postgres-pro",
    label: "Postgres Pro",
    category: "data-ai",
    description: "PostgreSQL advanced features, extensions, and performance tuning",
    tags: ["postgres", "postgresql", "database"],
  },
  {
    id: "prompt-engineer",
    label: "Prompt Engineer",
    category: "data-ai",
    description: "LLM prompt design, chain-of-thought, and evaluation frameworks",
    tags: ["prompt", "llm", "cot", "evaluation"],
  },

  // ── Developer Experience (13) ─────────────────────────────
  {
    id: "build-engineer",
    label: "Build Engineer",
    category: "developer-experience",
    description: "Build systems, bundlers, compilation pipelines, and artifact management",
    tags: ["build", "bundler", "webpack", "artifacts"],
  },
  {
    id: "cli-developer",
    label: "CLI Developer",
    category: "developer-experience",
    description: "Command-line tool development, argument parsing, and shell integration",
    tags: ["cli", "terminal", "shell"],
  },
  {
    id: "dependency-manager",
    label: "Dependency Manager",
    category: "developer-experience",
    description: "Dependency auditing, version resolution, and supply chain security",
    tags: ["dependencies", "npm", "supply-chain"],
  },
  {
    id: "documentation-engineer",
    label: "Documentation Engineer",
    category: "developer-experience",
    description: "API docs, developer guides, and documentation-as-code systems",
    tags: ["docs", "api-docs", "guides"],
  },
  {
    id: "dx-optimizer",
    label: "DX Optimizer",
    category: "developer-experience",
    description: "Developer experience improvement, tooling selection, and workflow design",
    tags: ["dx", "developer-experience", "tooling"],
  },
  {
    id: "git-workflow-manager",
    label: "Git Workflow Manager",
    category: "developer-experience",
    description: "Git branching strategies, merge policies, and repository management",
    tags: ["git", "branching", "merge", "repo"],
  },
  {
    id: "legacy-modernizer",
    label: "Legacy Modernizer",
    category: "developer-experience",
    description: "Legacy code migration, framework upgrades, and incremental modernization",
    tags: ["legacy", "migration", "modernization"],
  },
  {
    id: "mcp-developer",
    label: "MCP Developer",
    category: "developer-experience",
    description: "Model Context Protocol server/client development and tool integration",
    tags: ["mcp", "protocol", "tools"],
  },
  {
    id: "powershell-module-architect",
    label: "PowerShell Module Architect",
    category: "developer-experience",
    description: "PowerShell module design, packaging, and gallery publishing",
    tags: ["powershell", "module", "gallery"],
  },
  {
    id: "powershell-ui-architect",
    label: "PowerShell UI Architect",
    category: "developer-experience",
    description: "PowerShell GUI development with WPF, WinForms, and Terminal.Gui",
    tags: ["powershell", "gui", "wpf"],
  },
  {
    id: "refactoring-specialist",
    label: "Refactoring Specialist",
    category: "developer-experience",
    description: "Safe code refactoring, pattern extraction, and technical debt reduction",
    tags: ["refactoring", "patterns", "tech-debt"],
  },
  {
    id: "slack-expert",
    label: "Slack Expert",
    category: "developer-experience",
    description: "Slack app development, bot frameworks, and workflow automation",
    tags: ["slack", "bot", "automation"],
  },
  {
    id: "tooling-engineer",
    label: "Tooling Engineer",
    category: "developer-experience",
    description: "Internal tooling development, linters, formatters, and code generators",
    tags: ["tooling", "linters", "generators"],
  },

  // ── Specialized Domains (12) ──────────────────────────────
  {
    id: "api-documenter",
    label: "API Documenter",
    category: "specialized-domains",
    description: "API documentation generation, OpenAPI specs, and developer portals",
    tags: ["api", "docs", "openapi", "swagger"],
  },
  {
    id: "blockchain-developer",
    label: "Blockchain Developer",
    category: "specialized-domains",
    description: "Smart contracts, DApps, and blockchain protocol development",
    tags: ["blockchain", "smart-contracts", "web3"],
  },
  {
    id: "embedded-systems",
    label: "Embedded Systems",
    category: "specialized-domains",
    description: "Firmware, RTOS, hardware interfaces, and embedded C/C++",
    tags: ["embedded", "firmware", "rtos", "hardware"],
  },
  {
    id: "fintech-engineer",
    label: "Fintech Engineer",
    category: "specialized-domains",
    description: "Financial systems, payment processing, and regulatory compliance",
    tags: ["fintech", "payments", "trading", "finance"],
    isLegacy: true,
  },
  {
    id: "game-developer",
    label: "Game Developer",
    category: "specialized-domains",
    description: "Game engines, physics, rendering, and gameplay programming",
    tags: ["game", "unity", "unreal", "rendering"],
  },
  {
    id: "iot-engineer",
    label: "IoT Engineer",
    category: "specialized-domains",
    description: "IoT protocols, edge computing, and device fleet management",
    tags: ["iot", "mqtt", "edge", "devices"],
  },
  {
    id: "m365-admin",
    label: "M365 Admin",
    category: "specialized-domains",
    description: "Microsoft 365 administration, Exchange, SharePoint, and Teams",
    tags: ["microsoft", "m365", "exchange", "sharepoint"],
  },
  {
    id: "mobile-app-developer",
    label: "Mobile App Developer",
    category: "specialized-domains",
    description: "Production mobile apps with app store optimization and push notifications",
    tags: ["mobile", "app-store", "push"],
  },
  {
    id: "payment-integration",
    label: "Payment Integration",
    category: "specialized-domains",
    description: "Payment gateway integration, Stripe, PayPal, and PCI compliance",
    tags: ["payments", "stripe", "pci"],
  },
  {
    id: "quant-analyst",
    label: "Quant Analyst",
    category: "specialized-domains",
    description: "Quantitative analysis, algorithmic trading, and financial modeling",
    tags: ["quant", "trading", "modeling", "finance"],
    isLegacy: true,
  },
  {
    id: "risk-manager",
    label: "Risk Manager",
    category: "specialized-domains",
    description: "Risk assessment frameworks, mitigation strategies, and compliance",
    tags: ["risk", "compliance", "assessment"],
  },
  {
    id: "seo-specialist",
    label: "SEO Specialist",
    category: "specialized-domains",
    description: "Search engine optimization, technical SEO, and content strategy",
    tags: ["seo", "search", "content", "rankings"],
  },

  // ── Business & Product (11) ───────────────────────────────
  {
    id: "business-analyst",
    label: "Business Analyst",
    category: "business-product",
    description: "Requirements gathering, process mapping, and stakeholder management",
    tags: ["business", "requirements", "process"],
  },
  {
    id: "content-marketer",
    label: "Content Marketer",
    category: "business-product",
    description: "Content strategy, copywriting, and multi-channel marketing campaigns",
    tags: ["content", "marketing", "copywriting"],
    isLegacy: true,
  },
  {
    id: "customer-success-manager",
    label: "Customer Success Manager",
    category: "business-product",
    description: "Customer onboarding, retention, and support escalation management",
    tags: ["customer", "success", "support", "onboarding"],
    isLegacy: true,
  },
  {
    id: "legal-advisor",
    label: "Legal Advisor",
    category: "business-product",
    description: "Legal compliance, contract review, and regulatory guidance",
    tags: ["legal", "compliance", "contracts"],
    isLegacy: true,
  },
  {
    id: "product-manager",
    label: "Product Manager",
    category: "business-product",
    description: "Product roadmap, feature prioritization, and user story creation",
    tags: ["product", "roadmap", "features"],
  },
  {
    id: "project-manager",
    label: "Project Manager",
    category: "business-product",
    description: "Project planning, timeline management, and resource allocation",
    tags: ["project", "planning", "timeline"],
  },
  {
    id: "sales-engineer",
    label: "Sales Engineer",
    category: "business-product",
    description: "Technical sales support, demos, and proof-of-concept development",
    tags: ["sales", "demos", "poc"],
  },
  {
    id: "scrum-master",
    label: "Scrum Master",
    category: "business-product",
    description: "Agile facilitation, sprint planning, and team velocity optimization",
    tags: ["scrum", "agile", "sprint"],
  },
  {
    id: "technical-writer",
    label: "Technical Writer",
    category: "business-product",
    description: "Technical documentation, user guides, and knowledge base management",
    tags: ["writing", "docs", "knowledge-base"],
  },
  {
    id: "ux-researcher",
    label: "UX Researcher",
    category: "business-product",
    description: "User research, usability testing, and experience metrics analysis",
    tags: ["ux", "research", "usability"],
  },
  {
    id: "wordpress-master",
    label: "WordPress Master",
    category: "business-product",
    description: "WordPress development, theme customization, and plugin architecture",
    tags: ["wordpress", "cms", "php"],
  },

  // ── Meta & Orchestration (12) ─────────────────────────────
  {
    id: "agent-installer",
    label: "Agent Installer",
    category: "meta-orchestration",
    description: "Agent deployment, configuration management, and environment setup",
    tags: ["agent", "install", "deployment"],
  },
  {
    id: "agent-organizer",
    label: "Agent Organizer",
    category: "meta-orchestration",
    description: "Agent inventory management, categorization, and capability mapping",
    tags: ["agent", "inventory", "organization"],
  },
  {
    id: "context-manager",
    label: "Context Manager",
    category: "meta-orchestration",
    description: "Context window optimization, memory management, and information routing",
    tags: ["context", "memory", "routing"],
  },
  {
    id: "error-coordinator",
    label: "Error Coordinator",
    category: "meta-orchestration",
    description: "Error aggregation, deduplication, and coordinated resolution workflows",
    tags: ["errors", "coordination", "resolution"],
  },
  {
    id: "it-ops-orchestrator",
    label: "IT Ops Orchestrator",
    category: "meta-orchestration",
    description: "IT operations orchestration, runbook automation, and change management",
    tags: ["it-ops", "runbook", "change-management"],
  },
  {
    id: "knowledge-synthesizer",
    label: "Knowledge Synthesizer",
    category: "meta-orchestration",
    description: "Information synthesis across multiple sources and knowledge graph building",
    tags: ["knowledge", "synthesis", "graph"],
  },
  {
    id: "multi-agent-coordinator",
    label: "Multi-Agent Coordinator",
    category: "meta-orchestration",
    description: "Multi-agent orchestration, task delegation, and result aggregation",
    tags: ["multi-agent", "orchestration", "delegation"],
    isLegacy: true,
  },
  {
    id: "performance-monitor",
    label: "Performance Monitor",
    category: "meta-orchestration",
    description: "System performance monitoring, alerting, and capacity planning",
    tags: ["monitoring", "alerting", "capacity"],
  },
  {
    id: "pied-piper",
    label: "Pied Piper",
    category: "meta-orchestration",
    description: "Agent recruitment, onboarding, and swarm formation coordination",
    tags: ["recruitment", "onboarding", "swarm"],
  },
  {
    id: "task-distributor",
    label: "Task Distributor",
    category: "meta-orchestration",
    description: "Intelligent task routing, load balancing, and priority scheduling",
    tags: ["tasks", "routing", "scheduling"],
  },
  {
    id: "workflow-orchestrator",
    label: "Workflow Orchestrator",
    category: "meta-orchestration",
    description: "End-to-end workflow design, execution, and monitoring",
    tags: ["workflow", "orchestration", "execution"],
    isLegacy: true,
  },

  // ── Research & Analysis (7) ───────────────────────────────
  {
    id: "competitive-analyst",
    label: "Competitive Analyst",
    category: "research-analysis",
    description: "Competitive landscape analysis, benchmarking, and market positioning",
    tags: ["competitive", "benchmarking", "market"],
  },
  {
    id: "data-researcher",
    label: "Data Researcher",
    category: "research-analysis",
    description: "Data collection, dataset curation, and research methodology",
    tags: ["data", "research", "methodology"],
  },
  {
    id: "docs-researcher",
    label: "Docs Researcher",
    category: "research-analysis",
    description: "Documentation discovery, API reference analysis, and changelog tracking",
    tags: ["docs", "api", "changelog"],
  },
  {
    id: "market-researcher",
    label: "Market Researcher",
    category: "research-analysis",
    description: "Market sizing, consumer insights, and industry trend analysis",
    tags: ["market", "consumer", "trends"],
  },
  {
    id: "research-analyst",
    label: "Research Analyst",
    category: "research-analysis",
    description: "Deep research, literature review, and evidence synthesis",
    tags: ["research", "analysis", "literature"],
    isLegacy: true,
  },
  {
    id: "search-specialist",
    label: "Search Specialist",
    category: "research-analysis",
    description: "Advanced search techniques, OSINT, and information retrieval",
    tags: ["search", "osint", "retrieval"],
    isLegacy: true,
  },
  {
    id: "trend-analyst",
    label: "Trend Analyst",
    category: "research-analysis",
    description: "Trend identification, forecasting, and emerging technology tracking",
    tags: ["trends", "forecasting", "technology"],
  },
];

// ═══════════════════════════════════════════════════════════════
// Lookup index (built once at import time)
// ═══════════════════════════════════════════════════════════════

const _byId = new Map<string, AgentTypeInfo>();
for (const t of AGENT_TYPE_REGISTRY) _byId.set(t.id, t);

// ═══════════════════════════════════════════════════════════════
// Helper Functions
// ═══════════════════════════════════════════════════════════════

/** Normalize a type value — resolves legacy names to new slugs. */
export function normalizeAgentType(type: string): string {
  return LEGACY_TYPE_MAP[type] ?? type;
}

/** Get type metadata by ID (supports legacy type names). */
export function getAgentType(typeId: string): AgentTypeInfo | undefined {
  return _byId.get(normalizeAgentType(typeId));
}

/** Display label for a type (fallback to the raw ID). */
export function getTypeLabel(typeId: string): string {
  return getAgentType(typeId)?.label ?? typeId;
}

/** Tailwind color classes for a type's badge. */
export function getTypeColor(typeId: string): string {
  const t = getAgentType(typeId);
  if (!t) return "bg-slate-100 text-slate-700 border-slate-200";
  return AGENT_TYPE_CATEGORIES[t.category].colorClasses;
}

/** Short description for a type. */
export function getTypeDescription(typeId: string): string {
  return getAgentType(typeId)?.description ?? "";
}

/** All types belonging to a category. */
export function getTypesByCategory(category: AgentTypeCategory): AgentTypeInfo[] {
  return AGENT_TYPE_REGISTRY.filter((t) => t.category === category);
}

/** All categories with their types, for grouped dropdowns. */
export function getGroupedTypes(): { category: AgentTypeCategory; info: AgentTypeCategoryInfo; types: AgentTypeInfo[] }[] {
  return (Object.keys(AGENT_TYPE_CATEGORIES) as AgentTypeCategory[]).map((cat) => ({
    category: cat,
    info: AGENT_TYPE_CATEGORIES[cat],
    types: getTypesByCategory(cat),
  }));
}

/** Search types by query (matches label, description, and tags). */
export function searchAgentTypes(q: string): AgentTypeInfo[] {
  const lower = q.toLowerCase();
  return AGENT_TYPE_REGISTRY.filter(
    (t) =>
      t.label.toLowerCase().includes(lower) ||
      t.description.toLowerCase().includes(lower) ||
      t.tags?.some((tag) => tag.includes(lower)),
  );
}

/** Check if a type ID (or legacy name) is valid. */
export function isValidAgentType(typeId: string): boolean {
  return getAgentType(typeId) !== undefined;
}

/** Flat list of all type IDs (for dropdowns without grouping). */
export const ALL_AGENT_TYPE_IDS: string[] = AGENT_TYPE_REGISTRY.map((t) => t.id);
