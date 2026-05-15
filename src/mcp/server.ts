import { z } from "zod"
import { EvalOrchestrator } from "../loop/orchestrator"
import type { EvalConfig, JudgeProviderConfig, LoopState, ScenarioCategory, Difficulty } from "../types"
import { DEFAULT_BLOCKED_TOOLS } from "../types"
import { loadScenarios, loadPaddockConfig } from "../scenario/loader"
import { resolve } from "path"
import { detectVertexMode, parseVertexJudges } from "../evaluator/providers/vertex-env"

// Active orchestrator instance (one at a time)
let activeOrchestrator: EvalOrchestrator | null = null
let lastState: LoopState | null = null

function buildJudgeConfigs(): JudgeProviderConfig[] {
  const configs: JudgeProviderConfig[] = []
  // Mirrors cli.ts buildJudgeConfigs — env-to-typed-config translation.
  // Provider classes themselves don't read env; this is the only place
  // in the MCP entry path that does.
  const vertex = detectVertexMode()
  if (vertex) {
    const explicitPanel = process.env.VERTEX_JUDGES?.trim()
    if (explicitPanel) {
      configs.push(...parseVertexJudges(explicitPanel, vertex))
    } else {
      configs.push({
        type: "claude-vertex",
        model: "claude-sonnet-4-6",
        projectId: vertex.projectId,
        region: vertex.region,
      })
      configs.push({
        type: "gemini-vertex",
        model: "gemini-2.5-pro",
        projectId: vertex.projectId,
        region: vertex.region,
      })
    }
  } else {
    const claudeKey = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY
    if (claudeKey) {
      configs.push({ type: "claude", model: "claude-sonnet-4-6", apiKey: claudeKey })
    }
    const geminiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY
    if (geminiKey) {
      configs.push({ type: "gemini", model: "gemini-2.5-pro", apiKey: geminiKey })
    }
  }
  if (process.env.OPENAI_API_KEY) {
    configs.push({ type: "openai", model: "gpt-4o", apiKey: process.env.OPENAI_API_KEY })
  }
  return configs
}

// ─── Tool Definitions ────────────────────────────────────────

export const TOOL_DEFINITIONS = [
  {
    name: "eval_run",
    description: "Run an eval cycle: generate scenarios, run agent, evaluate with multi-model consensus",
    inputSchema: {
      type: "object" as const,
      properties: {
        repoRoot: { type: "string", description: "Path to agent runtime repo" },
        agentDir: { type: "string", description: "Path to .agent directory (default: repoRoot/.agent)" },
        categories: {
          type: "array", items: { type: "string" },
          description: "Scenario categories: tool_use, memory, conversation, edge_case, multi_turn, error_recovery",
        },
        difficulties: {
          type: "array", items: { type: "string" },
          description: "Difficulty levels: easy, medium, hard, adversarial",
        },
        scenarioCount: { type: "number", description: "Number of scenarios (default: 10)" },
        passThreshold: { type: "number", description: "Pass rate threshold 0-1 (default: 0.8)" },
        fullRun: { type: "boolean", description: "Run all scenarios fresh, ignore last report (default: false — rerun failed/partial/new only)" },
      },
      required: ["repoRoot"],
    },
  },
  {
    name: "eval_status",
    description: "Check progress of a running or completed eval run",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "eval_report",
    description: "Get detailed results including per-scenario scores, consensus results, and improvement history",
    inputSchema: {
      type: "object" as const,
      properties: {
        format: {
          type: "string",
          enum: ["summary", "detailed", "json"],
          description: "Output format (default: summary)",
        },
      },
    },
  },
  {
    name: "eval_scenarios",
    description: "Preview available test scenarios without running them",
    inputSchema: {
      type: "object" as const,
      properties: {
        categories: {
          type: "array", items: { type: "string" },
          description: "Filter by categories",
        },
        count: { type: "number", description: "Number to show (default: 10)" },
      },
    },
  },
  {
    name: "eval_abort",
    description: "Abort a running eval loop",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
]

// ─── Tool Handlers ───────────────────────────────────────────

export async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  switch (name) {
    case "eval_run":
      return handleEvalRun(args)
    case "eval_status":
      return handleEvalStatus()
    case "eval_report":
      return handleEvalReport(args)
    case "eval_scenarios":
      return handleEvalScenarios(args)
    case "eval_abort":
      return handleEvalAbort()
    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` })
  }
}

async function handleEvalRun(args: Record<string, unknown>): Promise<string> {
  if (activeOrchestrator) {
    const state = activeOrchestrator.getState()
    if (state.phase !== "done" && state.phase !== "failed") {
      return JSON.stringify({ error: "An eval run is already in progress", currentPhase: state.phase })
    }
  }

  const repoRoot = resolve(String(args.repoRoot))
  const agentDir = args.agentDir ? resolve(String(args.agentDir)) : resolve(repoRoot, ".agent")

  const judges = buildJudgeConfigs()
  if (judges.length === 0) {
    return JSON.stringify({ error: "No API keys configured. Set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY." })
  }

  // Load .paddock/config.json as defaults — MCP args override
  const fileConfig = loadPaddockConfig(repoRoot)

  const config: EvalConfig = {
    repoRoot,
    agentDir,
    categories: (args.categories as ScenarioCategory[] | undefined) ?? (fileConfig.categories as ScenarioCategory[] | undefined),
    difficulties: (args.difficulties as Difficulty[] | undefined) ?? (fileConfig.difficulties as Difficulty[] | undefined),
    scenarioCount: (args.scenarioCount as number) ?? (typeof fileConfig.scenarioCount === "number" ? fileConfig.scenarioCount : 10),
    passThreshold: (args.passThreshold as number) ?? (typeof fileConfig.passThreshold === "number" ? fileConfig.passThreshold : 0.8),
    judges,
    maxTimeMs: (typeof fileConfig.maxTimeMs === "number" ? fileConfig.maxTimeMs : 30 * 60 * 1000),
    maxLlmCalls: (typeof fileConfig.maxLlmCalls === "number" ? fileConfig.maxLlmCalls : 100),
    blockedTools: (Array.isArray(fileConfig.blockedTools) ? fileConfig.blockedTools as string[] : DEFAULT_BLOCKED_TOOLS),
    fullRun: (args.fullRun as boolean) ?? false,
    concurrency: (args.concurrency as number) ?? (typeof fileConfig.concurrency === "number" ? fileConfig.concurrency : 1),
  }

  activeOrchestrator = new EvalOrchestrator(config)

  // Run async — don't block
  const orchestrator = activeOrchestrator
  orchestrator.run().then(state => {
    lastState = state
  }).catch(err => {
    console.error("[mcp] eval run error:", err)
  })

  return JSON.stringify({
    status: "started",
    id: activeOrchestrator.getState().id,
    config: {
      repoRoot,
      agentDir,
      judges: judges.map(j => j.type),
      scenarioCount: config.scenarioCount,
      passThreshold: config.passThreshold,
    },
  })
}

function handleEvalStatus(): string {
  const state = activeOrchestrator?.getState() ?? lastState
  if (!state) {
    return JSON.stringify({ status: "no eval runs yet" })
  }

  return JSON.stringify({
    id: state.id,
    phase: state.phase,
    passRate: `${(state.passRate * 100).toFixed(0)}%`,
    scenarios: state.scenarios.length,
    evaluations: state.evaluations.length,
    error: state.error ?? null,
    budget: state.budget,
  })
}

function handleEvalReport(args: Record<string, unknown>): string {
  const state = activeOrchestrator?.getState() ?? lastState
  if (!state) {
    return JSON.stringify({ error: "No eval results available" })
  }

  const format = (args.format as string) ?? "summary"

  if (format === "json") {
    return JSON.stringify(state)
  }

  // Summary format
  const lines: string[] = [
    `# Paddock Eval Report`,
    ``,
    `Phase: ${state.phase}`,
    `Pass rate: ${(state.passRate * 100).toFixed(0)}%`,
    ``,
  ]

  if (state.evaluations.length > 0) {
    lines.push(`## Scenario Results`)
    lines.push(``)
    for (const e of state.evaluations) {
      const icon = e.finalVerdict === "pass" ? "PASS" : e.finalVerdict === "partial" ? "PARTIAL" : e.finalVerdict === "skipped" ? "SKIPPED" : "FAIL"
      const detail = e.finalVerdict === "skipped"
        ? `- [${icon}] ${e.scenarioId} — last score: ${e.finalScore.toFixed(1)}/10`
        : `- [${icon}] ${e.scenarioId} — score: ${e.finalScore.toFixed(1)}/10, agreement: ${(e.agreement * 100).toFixed(0)}%`
      lines.push(detail)
      if (format === "detailed" && e.failureReasons.length > 0) {
        for (const r of e.failureReasons.slice(0, 3)) {
          lines.push(`  - ${typeof r === "string" ? r.slice(0, 120) : JSON.stringify(r).slice(0, 120)}`)
        }
      }
    }
  }

  if (state.error) {
    lines.push(``)
    lines.push(`## Error`)
    lines.push(state.error)
  }

  return lines.join("\n")
}

function handleEvalScenarios(args: Record<string, unknown>): string {
  const repoRoot = args.repoRoot ? resolve(String(args.repoRoot)) : process.env.EVAL_REPO_ROOT ?? process.cwd()
  let scenarios = loadScenarios(String(repoRoot))

  if (args.categories) {
    const cats = args.categories as string[]
    scenarios = scenarios.filter(s => cats.includes(s.category))
  }

  const count = (args.count as number) ?? 10
  scenarios = scenarios.slice(0, count)

  return JSON.stringify(scenarios.map(s => ({
    id: s.id,
    category: s.category,
    difficulty: s.difficulty,
    name: s.name,
    messages: s.messages.length,
    criteria: s.successCriteria.map(c => c.dimension),
  })))
}

function handleEvalAbort(): string {
  if (!activeOrchestrator) {
    return JSON.stringify({ error: "No active eval run" })
  }

  activeOrchestrator.abort()
  return JSON.stringify({ status: "abort requested" })
}
