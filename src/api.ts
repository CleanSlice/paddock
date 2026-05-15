import { EvalOrchestrator } from "./loop/orchestrator"
import type { EvalOrchestratorDeps } from "./loop/orchestrator"
import { buildReport } from "./report/writer"
import type {
  EvalConfig,
  JudgeProviderConfig,
  LoopState,
  Scenario,
  LastReportData,
  ScenarioCategory,
  Difficulty,
} from "./types"
import { DEFAULT_BLOCKED_TOOLS } from "./types"
import type { IAgentRunner } from "./runner/types"
import type { ReportPayload } from "./report/writer"

/**
 * Options for embedding paddock as a library.
 *
 * Either:
 * - provide `repoRoot` + `agentDir` → uses default FilesystemAgentRunner and
 *   loads scenarios from `.paddock/scenarios/`
 *
 * Or for ranch / custom hosts:
 * - provide `runner` (e.g. HttpAgentRunner) AND `scenarios` + `lastReport`
 *   directly. `repoRoot` becomes a label only — no filesystem reads happen.
 */
export interface RunEvaluationOptions {
  /** Required label / repo root. With a custom runner this is purely informational. */
  repoRoot?: string
  /** Path to .agent dir for FilesystemAgentRunner. Ignored when `runner` is provided. */
  agentDir?: string
  /** Judge LLM credentials. At least one is required. */
  judges: JudgeProviderConfig[]

  /** Custom agent runner. If omitted, defaults to in-process FilesystemAgentRunner. */
  runner?: IAgentRunner
  /** Pre-prepared scenarios. If provided, bypasses filesystem load + filtering + LLM gen. */
  scenarios?: Scenario[]
  /** Previous-run summary. Pass null to disable rerun-skip. Pass undefined to load from disk. */
  lastReport?: LastReportData | null
  /** Override agent personality string passed to judges (default: read SOUL.md from agentDir). */
  personality?: string

  // Filtering — only applied when scenarios are loaded from disk
  categories?: ScenarioCategory[]
  difficulties?: Difficulty[]
  scenarioIds?: string[]
  scenarioCount?: number

  // Pass criteria + budget
  passThreshold?: number
  maxTimeMs?: number
  maxLlmCalls?: number
  blockedTools?: string[]
  fullRun?: boolean
  /** Max concurrent scenarios (default: 1 = sequential). Only meaningful for the default FilesystemAgentRunner. */
  concurrency?: number
}

export interface RunEvaluationResult {
  state: LoopState
  report: ReportPayload
}

/**
 * Run a full evaluation cycle. Programmatic entry point for embedding paddock.
 * Returns the final state plus a structured report payload (JSON object + markdown).
 *
 * No filesystem writes happen here — callers persist the report wherever they want
 * (DB, S3, disk).
 */
export async function runEvaluation(opts: RunEvaluationOptions): Promise<RunEvaluationResult> {
  if (!opts.judges || opts.judges.length === 0) {
    throw new Error("runEvaluation: at least one judge is required")
  }

  const repoRoot = opts.repoRoot ?? process.cwd()
  const agentDir = opts.agentDir ?? `${repoRoot}/.agent`

  const config: EvalConfig = {
    repoRoot,
    agentDir,
    categories: opts.categories,
    difficulties: opts.difficulties,
    scenarioIds: opts.scenarioIds,
    scenarioCount: opts.scenarioCount ?? 10,
    passThreshold: opts.passThreshold ?? 0.8,
    judges: opts.judges,
    maxTimeMs: opts.maxTimeMs ?? 30 * 60 * 1000,
    maxLlmCalls: opts.maxLlmCalls ?? 100,
    blockedTools: opts.blockedTools ?? DEFAULT_BLOCKED_TOOLS,
    fullRun: opts.fullRun ?? false,
    concurrency: opts.concurrency ?? 1,
  }

  const deps: EvalOrchestratorDeps = {
    runner: opts.runner,
    scenarios: opts.scenarios,
    lastReport: opts.lastReport,
    personality: opts.personality,
  }

  const orchestrator = new EvalOrchestrator(config, deps)
  const state = await orchestrator.run()
  const report = buildReport(state)

  return { state, report }
}

// Re-exports for library consumers
export { EvalOrchestrator } from "./loop/orchestrator"
export { AgentRunner } from "./runner/agent-runner"
export { buildReport } from "./report/writer"
export type {
  EvalConfig,
  JudgeProviderConfig,
  // Individual variants of the discriminated config union — exposed so
  // library consumers can type narrower helper functions / mappers without
  // re-deriving via `Extract<...>` at every use site.
  ClaudeJudgeConfig,
  ClaudeVertexJudgeConfig,
  GeminiJudgeConfig,
  GeminiVertexJudgeConfig,
  OpenAIJudgeConfig,
  LoopState,
  Scenario,
  ScenarioCategory,
  Difficulty,
  ConsensusResult,
  ExecutionTrace,
  LastReportData,
  JudgeProvider,
  TokenUsage,
} from "./types"
export type { IAgentRunner } from "./runner/types"
export type { ReportPayload } from "./report/writer"
export type { EvalOrchestratorDeps } from "./loop/orchestrator"
