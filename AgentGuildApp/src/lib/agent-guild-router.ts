/**
 * SwarmRouter — Meta-router that auto-selects the optimal orchestration pattern
 * for a given task based on its characteristics.
 *
 * This is the "brain" that sits above the existing workflow executor, agent hierarchy,
 * and message router. Instead of a human choosing "sequential" or "parallel" in the
 * visual builder, SwarmRouter analyzes the task and picks the right pattern.
 *
 * Patterns:
 *   - sequential:    Linear chain — each agent's output feeds the next
 *   - concurrent:    Fan-out/fan-in — all agents work in parallel, results merged
 *   - hierarchical:  Director delegates to workers, aggregates results
 *   - debate:        Multiple agents propose, then critique, then synthesize
 *   - router:        Single classifier agent routes to the best specialist
 *
 * Pattern selection uses a scoring heuristic based on:
 *   - Task complexity (token count, subtask count)
 *   - Required skills (breadth vs depth)
 *   - Time constraints
 *   - Quality requirements (need for consensus/review)
 *   - Agent availability
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type SwarmPattern =
  | "sequential"
  | "concurrent"
  | "hierarchical"
  | "debate"
  | "router";

export interface SwarmTask {
  /** Task description */
  description: string;
  /** Required skills/capabilities */
  requiredSkills: string[];
  /** Subtasks if pre-decomposed */
  subtasks?: string[];
  /** Time budget in ms (0 = unlimited) */
  timeBudgetMs?: number;
  /** Quality level — higher values favor consensus patterns */
  qualityLevel?: "draft" | "standard" | "high" | "critical";
  /** Explicit pattern override (bypass auto-selection) */
  forcePattern?: SwarmPattern;
  /** Additional context for the task */
  context?: Record<string, unknown>;
}

export interface SwarmAgent {
  id: string;
  name: string;
  skills: string[];
  /** Current load (0-1, where 1 is fully loaded) */
  load: number;
  /** Average response time in ms */
  avgResponseMs: number;
  /** Quality score from reputation (0-1) */
  qualityScore: number;
  /** Whether this agent can act as a coordinator */
  canCoordinate: boolean;
}

export interface PatternScore {
  pattern: SwarmPattern;
  score: number;
  reasons: string[];
}

export interface SwarmPlan {
  /** Selected orchestration pattern */
  pattern: SwarmPattern;
  /** Why this pattern was selected */
  reasoning: string[];
  /** Agents assigned to this task, in execution order */
  agents: Array<{
    agentId: string;
    role: string;
    subtask?: string;
  }>;
  /** Estimated execution time in ms */
  estimatedTimeMs: number;
  /** Pattern-specific configuration */
  config: PatternConfig;
}

export type PatternConfig =
  | SequentialConfig
  | ConcurrentConfig
  | HierarchicalConfig
  | DebateConfig
  | RouterConfig;

export interface SequentialConfig {
  type: "sequential";
  /** Ordered list of agent IDs forming the chain */
  chain: string[];
  /** Pass full context or only previous output */
  passMode: "full_context" | "output_only";
}

export interface ConcurrentConfig {
  type: "concurrent";
  /** Agents working in parallel */
  workers: string[];
  /** How to merge results */
  mergeStrategy: "concatenate" | "best_score" | "synthesize";
  /** Agent that merges results (only for synthesize strategy) */
  synthesizerId?: string;
}

export interface HierarchicalConfig {
  type: "hierarchical";
  /** Director agent */
  directorId: string;
  /** Worker agents */
  workerIds: string[];
  /** Max delegation depth */
  maxDepth: number;
}

export interface DebateConfig {
  type: "debate";
  /** Agents that propose initial solutions */
  proposerIds: string[];
  /** Agents that critique proposals */
  reviewerIds: string[];
  /** Agent that synthesizes final answer */
  synthesizerId: string;
  /** Number of debate rounds */
  rounds: number;
}

export interface RouterConfig {
  type: "router";
  /** Classifier agent that routes */
  classifierId: string;
  /** Specialist agents and their domains */
  specialists: Array<{ agentId: string; domain: string }>;
}

// ── Pattern Scoring ──────────────────────────────────────────────────────────

function scoreSequential(task: SwarmTask, agents: SwarmAgent[]): PatternScore {
  const reasons: string[] = [];
  let score = 50; // Base score

  // Favored when subtasks form a natural pipeline
  if (task.subtasks && task.subtasks.length >= 2) {
    score += 15;
    reasons.push("Multiple subtasks suggest a pipeline");
  }

  // Favored when skills are diverse (each step needs different expertise)
  if (task.requiredSkills.length >= 3) {
    score += 10;
    reasons.push("Diverse skills map to pipeline stages");
  }

  // Penalized under time pressure (sequential is slowest)
  if (task.timeBudgetMs && task.timeBudgetMs < 30000) {
    score -= 20;
    reasons.push("Time constraint penalizes sequential execution");
  }

  // Penalized if few agents available (can't form meaningful chain)
  const available = agents.filter(a => a.load < 0.9);
  if (available.length < 2) {
    score -= 30;
    reasons.push("Not enough available agents for a chain");
  }

  return { pattern: "sequential", score: Math.max(0, score), reasons };
}

function scoreConcurrent(task: SwarmTask, agents: SwarmAgent[]): PatternScore {
  const reasons: string[] = [];
  let score = 50;

  // Favored under time pressure
  if (task.timeBudgetMs && task.timeBudgetMs < 30000) {
    score += 20;
    reasons.push("Time pressure favors parallel execution");
  }

  // Favored when subtasks are independent
  if (task.subtasks && task.subtasks.length >= 3) {
    score += 15;
    reasons.push("Multiple subtasks can run in parallel");
  }

  // Favored when many agents available
  const available = agents.filter(a => a.load < 0.8);
  if (available.length >= 3) {
    score += 10;
    reasons.push("Multiple agents available for parallel work");
  }

  // Penalized for critical quality (no review step)
  if (task.qualityLevel === "critical") {
    score -= 15;
    reasons.push("Critical quality needs review, not just parallel merge");
  }

  return { pattern: "concurrent", score: Math.max(0, score), reasons };
}

function scoreHierarchical(task: SwarmTask, agents: SwarmAgent[]): PatternScore {
  const reasons: string[] = [];
  let score = 45;

  // Favored for complex tasks with many subtasks
  if (task.subtasks && task.subtasks.length >= 4) {
    score += 20;
    reasons.push("Complex task benefits from director oversight");
  }

  // Needs a coordinator agent
  const coordinators = agents.filter(a => a.canCoordinate && a.load < 0.7);
  if (coordinators.length === 0) {
    score -= 40;
    reasons.push("No coordinator agent available");
  } else {
    score += 10;
    reasons.push("Coordinator available for director role");
  }

  // Favored for high quality requirements
  if (task.qualityLevel === "high" || task.qualityLevel === "critical") {
    score += 10;
    reasons.push("Director can enforce quality standards");
  }

  return { pattern: "hierarchical", score: Math.max(0, score), reasons };
}

function scoreDebate(task: SwarmTask, agents: SwarmAgent[]): PatternScore {
  const reasons: string[] = [];
  let score = 30; // Lower base — debate is expensive

  // Strongly favored for critical quality
  if (task.qualityLevel === "critical") {
    score += 30;
    reasons.push("Critical quality demands multi-agent review");
  } else if (task.qualityLevel === "high") {
    score += 15;
    reasons.push("High quality benefits from debate");
  }

  // Needs multiple capable agents
  const highQuality = agents.filter(a => a.qualityScore > 0.7 && a.load < 0.8);
  if (highQuality.length >= 3) {
    score += 15;
    reasons.push("Enough high-quality agents for meaningful debate");
  } else if (highQuality.length < 2) {
    score -= 30;
    reasons.push("Not enough high-quality agents for debate");
  }

  // Penalized heavily under time pressure
  if (task.timeBudgetMs && task.timeBudgetMs < 60000) {
    score -= 25;
    reasons.push("Debate is too slow for this time budget");
  }

  // Favored for tasks with "review", "evaluate", "decide" keywords
  const reviewKeywords = /review|evaluat|decide|compli|approv|audit|assess/i;
  if (reviewKeywords.test(task.description)) {
    score += 15;
    reasons.push("Task involves review/evaluation — debate adds rigor");
  }

  return { pattern: "debate", score: Math.max(0, score), reasons };
}

function scoreRouter(task: SwarmTask, agents: SwarmAgent[]): PatternScore {
  const reasons: string[] = [];
  let score = 40;

  // Favored when task is simple (single subtask or no decomposition)
  if (!task.subtasks || task.subtasks.length <= 1) {
    score += 20;
    reasons.push("Simple task just needs the right specialist");
  }

  // Favored when skills are narrow (one domain)
  if (task.requiredSkills.length === 1) {
    score += 15;
    reasons.push("Single skill maps to specialist routing");
  }

  // Favored when agents have distinct specializations
  const uniqueSkills = new Set(agents.flatMap(a => a.skills));
  if (uniqueSkills.size >= agents.length * 2) {
    score += 10;
    reasons.push("Agents have distinct specializations");
  }

  // Penalized for critical quality (no review)
  if (task.qualityLevel === "critical" || task.qualityLevel === "high") {
    score -= 10;
    reasons.push("High-stakes tasks benefit from more than routing");
  }

  return { pattern: "router", score: Math.max(0, score), reasons };
}

// ── Agent Selection ──────────────────────────────────────────────────────────

function selectAgentsForSkills(
  agents: SwarmAgent[],
  skills: string[],
  count: number,
): SwarmAgent[] {
  // Score each agent by skill match, quality, and availability
  const scored = agents
    .filter(a => a.load < 0.95)
    .map(a => {
      const skillMatch = skills.filter(s => a.skills.includes(s)).length / Math.max(skills.length, 1);
      const availabilityScore = 1 - a.load;
      const composite = skillMatch * 0.5 + a.qualityScore * 0.3 + availabilityScore * 0.2;
      return { agent: a, score: composite };
    })
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, count).map(s => s.agent);
}

function selectCoordinator(agents: SwarmAgent[]): SwarmAgent | null {
  const candidates = agents
    .filter(a => a.canCoordinate && a.load < 0.8)
    .sort((a, b) => b.qualityScore - a.qualityScore);
  return candidates[0] || null;
}

// ── SwarmRouter ──────────────────────────────────────────────────────────────

export class SwarmRouter {
  /**
   * Analyze a task and available agents, then produce an execution plan
   * with the optimal orchestration pattern.
   */
  route(task: SwarmTask, agents: SwarmAgent[]): SwarmPlan {
    // Guard: need at least one agent
    if (agents.length === 0) {
      throw new Error("SwarmRouter requires at least one agent");
    }

    // Force pattern if specified
    if (task.forcePattern) {
      return this.buildPlan(task, agents, task.forcePattern, [
        `Pattern forced to ${task.forcePattern} by caller`,
      ]);
    }

    // With only 1 agent, only "router" (single specialist) makes sense
    if (agents.length === 1) {
      return this.buildPlan(task, agents, "router", [
        "Only 1 agent available — routing directly to it",
      ]);
    }

    // Score all patterns
    const scores: PatternScore[] = [
      scoreSequential(task, agents),
      scoreConcurrent(task, agents),
      scoreHierarchical(task, agents),
      scoreDebate(task, agents),
      scoreRouter(task, agents),
    ];

    // Pick highest score
    scores.sort((a, b) => b.score - a.score);
    const winner = scores[0];

    return this.buildPlan(task, agents, winner.pattern, winner.reasons);
  }

  /**
   * Score all patterns and return the full breakdown (for debugging/UI).
   */
  scoreAll(task: SwarmTask, agents: SwarmAgent[]): PatternScore[] {
    return [
      scoreSequential(task, agents),
      scoreConcurrent(task, agents),
      scoreHierarchical(task, agents),
      scoreDebate(task, agents),
      scoreRouter(task, agents),
    ].sort((a, b) => b.score - a.score);
  }

  private buildPlan(
    task: SwarmTask,
    agents: SwarmAgent[],
    pattern: SwarmPattern,
    reasoning: string[],
  ): SwarmPlan {
    switch (pattern) {
      case "sequential":
        return this.planSequential(task, agents, reasoning);
      case "concurrent":
        return this.planConcurrent(task, agents, reasoning);
      case "hierarchical":
        return this.planHierarchical(task, agents, reasoning);
      case "debate":
        return this.planDebate(task, agents, reasoning);
      case "router":
        return this.planRouter(task, agents, reasoning);
    }
  }

  private planSequential(task: SwarmTask, agents: SwarmAgent[], reasoning: string[]): SwarmPlan {
    const subtasks = task.subtasks || [task.description];
    const selected = selectAgentsForSkills(agents, task.requiredSkills, subtasks.length);

    return {
      pattern: "sequential",
      reasoning,
      agents: selected.map((a, i) => ({
        agentId: a.id,
        role: "worker" as const,
        subtask: subtasks[i] || subtasks[subtasks.length - 1],
      })),
      estimatedTimeMs: selected.reduce((sum, a) => sum + a.avgResponseMs, 0),
      config: {
        type: "sequential",
        chain: selected.map(a => a.id),
        passMode: "full_context",
      },
    };
  }

  private planConcurrent(task: SwarmTask, agents: SwarmAgent[], reasoning: string[]): SwarmPlan {
    const subtasks = task.subtasks || [task.description];
    const workers = selectAgentsForSkills(agents, task.requiredSkills, subtasks.length);
    const synthesizer = selectCoordinator(agents);

    const mergeStrategy = synthesizer ? "synthesize" as const : "concatenate" as const;

    const agentAssignments: SwarmPlan["agents"] = workers.map((a, i) => ({
      agentId: a.id,
      role: "worker",
      subtask: subtasks[i] || subtasks[subtasks.length - 1],
    }));

    if (synthesizer) {
      agentAssignments.push({
        agentId: synthesizer.id,
        role: "synthesizer",
        subtask: "Merge and synthesize worker outputs",
      });
    }

    const maxWorkerTime = Math.max(...workers.map(a => a.avgResponseMs), 0);
    const synthTime = synthesizer?.avgResponseMs || 0;

    return {
      pattern: "concurrent",
      reasoning,
      agents: agentAssignments,
      estimatedTimeMs: maxWorkerTime + synthTime,
      config: {
        type: "concurrent",
        workers: workers.map(a => a.id),
        mergeStrategy,
        synthesizerId: synthesizer?.id,
      },
    };
  }

  private planHierarchical(task: SwarmTask, agents: SwarmAgent[], reasoning: string[]): SwarmPlan {
    const director = selectCoordinator(agents);
    const workerPool = agents.filter(a => a.id !== director?.id);
    const workers = selectAgentsForSkills(workerPool, task.requiredSkills, 4);

    const agentAssignments: SwarmPlan["agents"] = [];

    if (director) {
      agentAssignments.push({
        agentId: director.id,
        role: "coordinator",
        subtask: "Decompose task, delegate to workers, aggregate results",
      });
    }

    const subtasks = task.subtasks || [task.description];
    for (let i = 0; i < workers.length; i++) {
      agentAssignments.push({
        agentId: workers[i].id,
        role: "worker",
        subtask: subtasks[i] || subtasks[subtasks.length - 1],
      });
    }

    const maxWorkerTime = workers.length > 0 ? Math.max(...workers.map(a => a.avgResponseMs)) : 5000;
    const directorId = director?.id || workers[0]?.id;
    const directorTime = (director?.avgResponseMs || 5000) * 2;

    if (!directorId) {
      throw new Error("Hierarchical plan requires at least one available agent");
    }

    return {
      pattern: "hierarchical",
      reasoning,
      agents: agentAssignments,
      estimatedTimeMs: directorTime + maxWorkerTime,
      config: {
        type: "hierarchical",
        directorId,
        workerIds: workers.map(a => a.id),
        maxDepth: 2,
      },
    };
  }

  private planDebate(task: SwarmTask, agents: SwarmAgent[], reasoning: string[]): SwarmPlan {
    // Fall back to all agents if none pass quality filter
    const highQuality = agents
      .filter(a => a.qualityScore > 0.5)
      .sort((a, b) => b.qualityScore - a.qualityScore);
    const pool = highQuality.length >= 2 ? highQuality : [...agents].sort((a, b) => b.qualityScore - a.qualityScore);

    // Reserve at least 1 for synthesizer
    const proposerCount = Math.min(pool.length - 1, 3);
    const proposers = pool.slice(0, Math.max(1, proposerCount));
    const synthesizer = pool.find(a => !proposers.includes(a)) || proposers[0];
    const reviewers = proposers; // In debate, proposers also review

    const agentAssignments: SwarmPlan["agents"] = [
      ...proposers.map(a => ({
        agentId: a.id,
        role: "worker",
        subtask: `Propose solution for: ${task.description}`,
      })),
      {
        agentId: synthesizer.id,
        role: "synthesizer",
        subtask: "Synthesize best answer from proposals and critiques",
      },
    ];

    const rounds = task.qualityLevel === "critical" ? 3 : 2;
    const roundTime = proposers.length > 0 ? Math.max(...proposers.map(a => a.avgResponseMs)) : 5000;

    return {
      pattern: "debate",
      reasoning,
      agents: agentAssignments,
      estimatedTimeMs: roundTime * rounds + (synthesizer?.avgResponseMs || 5000),
      config: {
        type: "debate",
        proposerIds: proposers.map(a => a.id),
        reviewerIds: reviewers.map(a => a.id),
        synthesizerId: synthesizer.id,
        rounds,
      },
    };
  }

  private planRouter(task: SwarmTask, agents: SwarmAgent[], reasoning: string[]): SwarmPlan {
    const classifier = selectCoordinator(agents) || agents[0];
    const specialists = agents
      .filter(a => a.id !== classifier.id)
      .map(a => ({
        agentId: a.id,
        domain: a.skills.join(", ") || "general",
      }));

    // If only 1 agent, it acts as both classifier and specialist
    if (specialists.length === 0) {
      return {
        pattern: "router",
        reasoning: [...reasoning, "Single agent acts as both router and specialist"],
        agents: [{
          agentId: classifier.id,
          role: "worker",
          subtask: task.description,
        }],
        estimatedTimeMs: classifier.avgResponseMs || 5000,
        config: {
          type: "router",
          classifierId: classifier.id,
          specialists: [{ agentId: classifier.id, domain: classifier.skills.join(", ") || "general" }],
        },
      };
    }

    return {
      pattern: "router",
      reasoning,
      agents: [
        {
          agentId: classifier.id,
          role: "coordinator",
          subtask: "Classify task and route to best specialist",
        },
        ...specialists.map(s => ({
          agentId: s.agentId,
          role: "worker",
          subtask: `Handle tasks in domain: ${s.domain}`,
        })),
      ],
      estimatedTimeMs: (classifier.avgResponseMs || 2000) +
        Math.max(...agents.map(a => a.avgResponseMs), 0),
      config: {
        type: "router",
        classifierId: classifier.id,
        specialists,
      },
    };
  }
}
