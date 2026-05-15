#!/usr/bin/env bun
import { parseArgs } from "util"
import { resolve } from "path"
import { loadScenarios, loadPaddockConfig } from "./scenario/loader"
import { EvalOrchestrator } from "./loop/orchestrator"
import { saveReport } from "./report/writer"
import { formatTokenUsage } from "./report/formatter"
import type { EvalConfig, JudgeProviderConfig, ScenarioCategory, Difficulty } from "./types"
import { DEFAULT_BLOCKED_TOOLS } from "./types"
import { detectVertexMode, parseVertexJudges } from "./evaluator/providers/vertex-env"

// ─── Helpers ─────────────────────────────────────────────────

function color(code: number, text: string): string {
  return `\x1b[${code}m${text}\x1b[0m`
}
const green = (t: string) => color(32, t)
const red = (t: string) => color(31, t)
const yellow = (t: string) => color(33, t)
const cyan = (t: string) => color(36, t)
const bold = (t: string) => color(1, t)
const dim = (t: string) => color(2, t)

function printHeader() {
  console.log()
  console.log(bold("  Paddock") + dim(" — Agent Eval Loop"))
  console.log()
}

function printUsage() {
  printHeader()
  console.log(`${bold("Usage:")} bun run src/cli.ts <command> [options]

${bold("Commands:")}
  ${cyan("run")}          Run full eval cycle
  ${cyan("scenarios")}    Generate and preview scenarios
  ${cyan("report")}       Show results of last run (TODO)

${bold("Options for 'run':")}
  --repo           Path to agent runtime repo (default: auto-detect)
  --agent-dir      Path to .agent directory
  --categories     Comma-separated: tool_use,memory,conversation,edge_case,...
  --difficulties   Comma-separated: easy,medium,hard,adversarial
  --scenarios      Comma-separated scenario IDs to run (e.g. error-tool-error-loop,memory-recall)
  --count          Number of scenarios (default: 10)
  --threshold      Pass rate 0-1 (default: 0.8)
  --full           Run all scenarios fresh, ignore last report (default: rerun failed/partial/new only)
  --no-generate    Use only built-in templates, skip LLM generation
  --concurrency N  Max concurrent scenarios (default: 1 = sequential)

${bold("Options for 'scenarios':")}
  --categories     Comma-separated categories
  --count          Number to generate (default: 5)

${bold("Environment:")}
  Direct-API mode (default for public users):
    CLAUDE_CODE_OAUTH_TOKEN    Claude tokens, comma-separated for rotation
    ANTHROPIC_API_KEY          Claude API key (used if no OAuth token)
    GEMINI_API_KEY             Gemini judge
    OPENAI_API_KEY             GPT judge

  Vertex AI mode (for compliance-aligned / GCP-aligned deployments —
  Claude + Gemini judges run via Vertex; OpenAI judge keeps requiring
  OPENAI_API_KEY since OpenAI is not on Vertex). Auth uses Application
  Default Credentials.
    VERTEX_PROJECT_ID          GCP project where Vertex AI is enabled
    VERTEX_REGION              GCP region — e.g. us-east5
    VERTEX_JUDGES              Optional. Comma-separated model IDs (max 3)
                               that declare the full Vertex judge panel —
                               e.g. "claude-sonnet-4-6,claude-opus-4-7,gemini-2.5-pro"
                               for 3-judge consensus without OpenAI. Unset →
                               defaults to 1 Claude + 1 Gemini.

  Other:
    EVAL_REPO_ROOT             Override repo root
    EVAL_AGENT_DIR             Override .agent dir
    EVAL_LLM_MODEL             Agent LLM model (default: claude-sonnet-4-6)
    EVAL_CLAUDE_JUDGE_MODEL    Claude judge model (default: claude-sonnet-4-6)
    EVAL_GEMINI_JUDGE_MODEL    Gemini judge model (default: gemini-2.5-pro)
    EVAL_OPENAI_JUDGE_MODEL    OpenAI judge model (default: gpt-4o)

  Judge tuning (applies uniformly to every judge — direct or Vertex):
    EVAL_JUDGE_THINKING_BUDGET Reasoning tokens per judge call (default: 8000).
                               Set 0 to disable thinking on Claude / Gemini;
                               OpenAI reasoning models clamp to "medium".
    EVAL_JUDGE_MAX_TOKENS      Max output tokens per judge call (default: 16000).
                               Generous on purpose — leaves room for thinking
                               blocks + final scored output on hard scenarios.
`)
}

function detectRepoRoot(): string {
  // Try EVAL_REPO_ROOT env
  if (process.env.EVAL_REPO_ROOT) return resolve(process.env.EVAL_REPO_ROOT)
  // Try common locations
  const candidates = [
    resolve(process.cwd(), ".."),
    resolve(import.meta.dir, "../.."),
  ]
  for (const p of candidates) {
    try {
      const pkg = Bun.file(resolve(p, "package.json"))
      // Sync check not available, just return first candidate
      return p
    } catch {}
  }
  throw new Error("Cannot detect repo root. Use --repo or EVAL_REPO_ROOT env var.")
}

function buildJudgeConfigs(): JudgeProviderConfig[] {
  const configs: JudgeProviderConfig[] = []

  // Auth-mode selection: if Vertex env is set, register the Vertex variants
  // for Claude + Gemini; otherwise register the direct-API variants when
  // their keys are present. OpenAI has no Vertex equivalent and follows its
  // own path. This is the only place in paddock that reads env vars to
  // decide on auth mode — the provider classes downstream get fully-resolved
  // typed configs and stay deterministic.
  const vertex = detectVertexMode()
  const claudeModel = process.env.EVAL_CLAUDE_JUDGE_MODEL ?? "claude-sonnet-4-6"
  const geminiModel = process.env.EVAL_GEMINI_JUDGE_MODEL ?? "gemini-2.5-pro"

  if (vertex) {
    // VERTEX_JUDGES, when set, is a comma-separated list of model IDs that
    // explicitly declares the Vertex-routed judge panel (e.g. Sonnet + Opus
    // + Gemini for 3-judge consensus without OpenAI). When unset, paddock
    // defaults to one Claude + one Gemini using EVAL_*_JUDGE_MODEL.
    const explicitPanel = process.env.VERTEX_JUDGES?.trim()
    if (explicitPanel) {
      configs.push(...parseVertexJudges(explicitPanel, vertex))
    } else {
      configs.push({
        type: "claude-vertex",
        model: claudeModel,
        projectId: vertex.projectId,
        region: vertex.region,
      })
      configs.push({
        type: "gemini-vertex",
        model: geminiModel,
        projectId: vertex.projectId,
        region: vertex.region,
      })
    }
  } else {
    // Direct-API mode. Prefer CLAUDE_CODE_OAUTH_TOKEN (supports
    // comma-separated rotation), fall back to ANTHROPIC_API_KEY.
    const claudeKey = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY
    if (claudeKey) {
      configs.push({ type: "claude", model: claudeModel, apiKey: claudeKey })
    }
    const geminiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY
    if (geminiKey) {
      configs.push({ type: "gemini", model: geminiModel, apiKey: geminiKey })
    }
  }

  // OpenAI is always direct-API — Vertex has no OpenAI offering. Adding it
  // alongside Vertex Claude+Gemini is a valid hybrid for deployments that
  // accept the OpenAI direct path. FedRAMP-strict deployments simply omit
  // OPENAI_API_KEY.
  if (process.env.OPENAI_API_KEY) {
    configs.push({
      type: "openai",
      model: process.env.EVAL_OPENAI_JUDGE_MODEL ?? "gpt-4o",
      apiKey: process.env.OPENAI_API_KEY,
    })
  }

  return configs
}

// ─── Commands ────────────────────────────────────────────────

async function cmdRun(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      repo: { type: "string" },
      "agent-dir": { type: "string" },
      categories: { type: "string" },
      difficulties: { type: "string" },
      scenarios: { type: "string" },
      count: { type: "string", default: "10" },
      threshold: { type: "string", default: "0.8" },
      "full": { type: "boolean", default: false },
      "no-generate": { type: "boolean", default: false },
      concurrency: { type: "string", default: "1" },
    },
    strict: false,
  })

  printHeader()

  const repoRoot = values.repo && typeof values.repo === "string" ? resolve(values.repo) : detectRepoRoot()
  const agentDir = values["agent-dir"] && typeof values["agent-dir"] === "string"
    ? resolve(values["agent-dir"])
    : resolve(repoRoot, ".agent")

  const judgeConfigs = buildJudgeConfigs()
  if (judgeConfigs.length === 0) {
    console.error(red(
      "Error: No judges configured. Set CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY / GEMINI_API_KEY / OPENAI_API_KEY for direct mode, or VERTEX_PROJECT_ID + VERTEX_REGION for Vertex mode.",
    ))
    process.exit(1)
  }

  // Load .paddock/config.json as defaults — CLI flags override
  const fileConfig = loadPaddockConfig(repoRoot)

  const categories = typeof values.categories === "string"
    ? values.categories.split(",") as ScenarioCategory[]
    : (fileConfig.categories as ScenarioCategory[] | undefined)

  const difficulties = typeof values.difficulties === "string"
    ? values.difficulties.split(",") as Difficulty[]
    : (fileConfig.difficulties as Difficulty[] | undefined)

  // CLI --count overrides config.json scenarioCount (parseArgs sets default "10" only when flag absent)
  const cliCountExplicit = args.includes("--count")
  const scenarioCount = cliCountExplicit
    ? parseInt(String(values.count))
    : (typeof fileConfig.scenarioCount === "number" ? fileConfig.scenarioCount : 10)

  const cliThresholdExplicit = args.includes("--threshold")
  const passThreshold = cliThresholdExplicit
    ? parseFloat(String(values.threshold))
    : (typeof fileConfig.passThreshold === "number" ? fileConfig.passThreshold : 0.8)

  const config: EvalConfig = {
    repoRoot,
    agentDir,
    categories,
    difficulties,
    scenarioIds: typeof values.scenarios === "string" ? values.scenarios.split(",") : undefined,
    scenarioCount,
    passThreshold,
    judges: judgeConfigs,
    maxTimeMs: (typeof fileConfig.maxTimeMs === "number" ? fileConfig.maxTimeMs : 30 * 60 * 1000),
    maxLlmCalls: (typeof fileConfig.maxLlmCalls === "number" ? fileConfig.maxLlmCalls : 100),
    blockedTools: (Array.isArray(fileConfig.blockedTools) ? fileConfig.blockedTools as string[] : DEFAULT_BLOCKED_TOOLS),
    fullRun: !!values["full"],
    concurrency: parseInt(String(values.concurrency)) || (typeof fileConfig.concurrency === "number" ? fileConfig.concurrency : 1),
  }

  console.log(`  ${dim("Repo:")}       ${repoRoot}`)
  console.log(`  ${dim("Agent dir:")}  ${agentDir}`)
  console.log(`  ${dim("Judges:")}     ${judgeConfigs.map(j => j.model).join(", ")}`)
  console.log(`  ${dim("Categories:")} ${categories?.join(", ") ?? "all"}`)
  console.log(`  ${dim("Scenarios:")}  ${config.scenarioCount}`)
  console.log(`  ${dim("Threshold:")}  ${(config.passThreshold * 100).toFixed(0)}%`)
  console.log(`  ${dim("Mode:")}       ${config.fullRun ? "full (all scenarios)" : "rerun (failed/partial/new only)"}`)
  if (config.concurrency > 1) {
    console.log(`  ${dim("Concurrency:")} ${config.concurrency}`)
  }
  console.log()

  const orchestrator = new EvalOrchestrator(config)
  const state = await orchestrator.run()

  // Print results
  console.log()
  console.log(bold("  Results"))
  console.log()
  console.log(`  ${dim("Phase:")}     ${state.phase}`)
  const rateColor = state.passRate >= config.passThreshold ? green : red
  console.log(`  ${dim("Pass rate:")} ${rateColor((state.passRate * 100).toFixed(0) + "%")}`)

  // Token usage per judge. With cache + thinking breakdown enabled, each
  // line shows: <input> in [+ <cache_read>r/<cache_write>w cached] / <output> out
  // [+ <thinking> think] (<total> total). Cache and thinking suffixes only
  // render when the provider exposed those buckets — non-cached / non-thinking
  // judges stay terse.
  const { lines: usageLines, grandTotal } = formatTokenUsage(state.tokenUsage)
  if (usageLines.length > 0) {
    console.log()
    console.log(bold("  Token Usage"))
    console.log()
    const renderLine = (u: { provider: string; input: string; cache: string; output: string; total: string }) => {
      const cacheSuffix = u.cache === "—" ? "" : ` [+ ${u.cache} cache r/w]`
      const outParts = u.output.split(" / ")
      const outSuffix = outParts.length > 1 ? ` [+ ${outParts[1]} think]` : ""
      const outVisible = outParts[0]
      return `  ${dim(u.provider + ":")} ${u.input} in${cacheSuffix} / ${outVisible} out${outSuffix} (${u.total} total)`
    }
    for (const u of usageLines) console.log(renderLine(u))
    if (grandTotal) console.log(renderLine(grandTotal))
  }

  if (state.error) {
    console.log(`  ${red("Error:")}     ${state.error}`)
  }

  // Per-scenario results
  if (state.evaluations.length > 0) {
    console.log()
    console.log(bold("  Scenario Results"))
    console.log()
    for (const eval_ of state.evaluations) {
      const icon = eval_.finalVerdict === "pass" ? green("PASS")
        : eval_.finalVerdict === "partial" ? yellow("PARTIAL")
        : eval_.finalVerdict === "skipped" ? dim("SKIPPED")
        : red("FAIL")
      const detail = eval_.finalVerdict === "skipped"
        ? `${eval_.scenarioId} — last score: ${eval_.finalScore.toFixed(1)}/10`
        : `${eval_.scenarioId} — score: ${eval_.finalScore.toFixed(1)}/10 — agreement: ${(eval_.agreement * 100).toFixed(0)}%`
      console.log(`  ${icon} ${detail}`)
      if (eval_.failureReasons.length > 0) {
        for (const reason of eval_.failureReasons.slice(0, 2)) {
          console.log(`       ${dim(typeof reason === "string" ? reason.slice(0, 100) : JSON.stringify(reason).slice(0, 100))}`)
        }
      }
    }
  }

  // Diagnostic report — show runtime errors from traces
  if (state.traces.length > 0) {
    const allErrors = state.traces.flatMap(t => t.errors)
    if (allErrors.length > 0) {
      console.log()
      console.log(bold("  Diagnostic Report"))
      console.log()

      // Group errors by message to find patterns
      const errorCounts = new Map<string, { count: number; phase: string; full: string }>()
      for (const err of allErrors) {
        const key = err.message.slice(0, 150)
        const existing = errorCounts.get(key)
        if (existing) {
          existing.count++
        } else {
          errorCounts.set(key, { count: 1, phase: err.phase, full: err.message })
        }
      }

      for (const [msg, info] of [...errorCounts.entries()].sort((a, b) => b[1].count - a[1].count)) {
        console.log(`  ${red(`[${info.phase}]`)} ${yellow(`x${info.count}`)} ${msg}`)
        if (info.full.length > 150) {
          console.log(`  ${dim(info.full.slice(150, 400))}`)
        }
      }

      // Recommendations
      console.log()
      console.log(bold("  Recommendations"))
      console.log()

      const hasRuntimeErrors = allErrors.some(e => e.phase === "runtime")
      const hasChannelErrors = allErrors.some(e => e.phase === "channel")
      const hasLlmErrors = allErrors.some(e => e.message.includes("400") || e.message.includes("401") || e.message.includes("API"))
      const hasAccessErrors = allErrors.some(e => e.message.includes("access") || e.message.includes("allowed") || e.message.includes("pending"))
      const hasImportErrors = allErrors.some(e => e.message.includes("import") || e.message.includes("module") || e.message.includes("Cannot find"))
      const noResponses = state.traces.every(t => t.responses.length === 0)
      const veryFast = state.traces.every(t => t.timing.totalMs < 100)

      if (veryFast && noResponses) {
        console.log(`  ${yellow("!")} All scenarios complete in <100ms with no responses.`)
        console.log(`    This usually means the runtime crashes at startup, not during LLM calls.`)
        console.log()
      }

      if (hasLlmErrors) {
        console.log(`  ${yellow("!")} LLM API errors detected. Check:`)
        console.log(`    - Is CLAUDE_CODE_OAUTH_TOKEN valid and not expired?`)
        console.log(`    - Try: curl -H "Authorization: Bearer $CLAUDE_CODE_OAUTH_TOKEN" https://api.anthropic.com/v1/messages`)
        console.log(`    - Try setting ANTHROPIC_API_KEY as fallback`)
        console.log(`    - Model "claude-sonnet-4-6" may not be available for your tokens`)
        console.log()
      }

      if (hasAccessErrors) {
        console.log(`  ${yellow("!")} Access control blocking eval user. Check:`)
        console.log(`    - Set accessStrategy to "open" in .agent/agent.config.json`)
        console.log(`    - Or add "eval-user" to the allowlist`)
        console.log()
      }

      if (hasImportErrors) {
        console.log(`  ${yellow("!")} Module import errors. Check:`)
        console.log(`    - Run "bun install" in the runtime repo`)
        console.log(`    - Verify --repo path is correct`)
        console.log()
      }

      if (hasRuntimeErrors && !hasLlmErrors && !hasAccessErrors && !hasImportErrors) {
        console.log(`  ${yellow("!")} Runtime errors detected. Debug steps:`)
        console.log(`    1. Run the runtime directly: cd ${config.repoRoot} && bun run dev`)
        console.log(`    2. Send a test message via Telegram to verify it works`)
        console.log(`    3. Check .agent/agent.config.json is valid JSON`)
        console.log(`    4. Run with --count 1 for a single scenario to isolate`)
        console.log()
      }

      if (hasChannelErrors && !hasRuntimeErrors) {
        console.log(`  ${yellow("!")} Channel timeout — agent didn't respond within timeout.`)
        console.log(`    - Increase timeout: --response-timeout 120000`)
        console.log(`    - The LLM might be slow or the agent is stuck in a tool loop`)
        console.log()
      }
    }
  }

  // Save report to .paddock/reports/
  if (state.evaluations.length > 0) {
    const { mdPath } = saveReport(repoRoot, state)
    console.log(`  ${dim("Report:")} ${mdPath}`)
  }

  console.log()
  process.exit(state.phase === "done" ? 0 : 1)
}

async function cmdScenarios(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      repo: { type: "string" },
      categories: { type: "string" },
      count: { type: "string", default: "5" },
    },
    strict: false,
  })

  printHeader()

  const repoRoot = values.repo && typeof values.repo === "string" ? resolve(values.repo) : detectRepoRoot()
  const categories = typeof values.categories === "string"
    ? values.categories.split(",") as ScenarioCategory[]
    : undefined

  const count = parseInt(String(values.count ?? "5"))

  let scenarios = loadScenarios(repoRoot)

  if (categories) {
    scenarios = scenarios.filter(s => categories.includes(s.category))
  }

  scenarios = scenarios.slice(0, count)

  console.log(bold(`  ${scenarios.length} Scenarios`))
  console.log()

  for (const s of scenarios) {
    console.log(`  ${cyan(s.id)}`)
    console.log(`  ${dim("Category:")} ${s.category} | ${dim("Difficulty:")} ${s.difficulty}`)
    console.log(`  ${dim("Messages:")} ${s.messages.length}`)
    console.log(`  ${dim("Expected:")} ${s.expectedBehavior.slice(0, 80)}`)
    console.log()
  }
}

// ─── Main ────────────────────────────────────────────────────

const [command, ...args] = process.argv.slice(2)

switch (command) {
  case "run":
    await cmdRun(args)
    break
  case "scenarios":
    await cmdScenarios(args)
    break
  case "help":
  case "--help":
  case "-h":
  case undefined:
    printUsage()
    break
  default:
    console.error(red(`Unknown command: ${command}`))
    printUsage()
    process.exit(1)
}
