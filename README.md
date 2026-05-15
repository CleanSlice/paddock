<p align="center">
  <img src="docs/cleanslice-paddock-background.png" alt="Paddock" />
</p>

# Paddock

Automated eval & improvement loop for AI agents. Generates test scenarios, runs the agent, scores with multi-model consensus (Claude + Gemini + GPT), and iteratively patches code until quality targets are met.

Judges run in one of two auth modes, picked per-deployment:

- **Direct API** (default for public users) — Claude / Gemini / GPT via their respective vendor APIs.
- **Vertex AI** (for compliance-aligned / GCP-aligned deployments) — Claude + Gemini via Google Cloud Vertex AI with Application Default Credentials. The GPT judge stays direct (OpenAI has no Vertex offering).

## How It Works

```
Scenarios (.yml) → Agent Runtime (mock channel) → 3 LLM Judges → Consensus
                                                                     │
                                                              pass ≥ 80%?
                                                             /           \
                                                           YES            NO
                                                            │              │
                                                       git push      Analyze + Patch
                                                                          │
                                                                    Sandbox OK?
                                                                   /          \
                                                                 YES          NO
                                                                  │            │
                                                              Commit        Revert
                                                                  │
                                                              ← repeat
```

1. **Load scenarios** from `.paddock/scenarios/` in the target project (YAML files organized by category)
2. **Run each scenario** against the agent via a mock channel — captures responses, tool calls, errors, timing
3. **Up to 3 LLM judges** (Claude, Gemini, GPT) — registered based on which auth paths are configured — independently score each run on correctness, tool usage, SOUL compliance, response quality, error handling. Vertex-mode deployments typically run 2 (Claude + Gemini via Vertex); direct-mode users typically run all 3
4. **Consensus**: median scores + majority vote → pass/fail/partial
5. **If failing**: analyzer finds patterns, patcher generates code fixes, sandbox validates (type-check + build)
6. **Repeat** until pass rate ≥ threshold or budget exhausted
7. **Git**: all work on `eval/*` branches, push on success

## Install

```bash
git clone https://github.com/cleanslice/paddock.git
cd paddock
bun install
cp .env.example .env
# Add your API keys to .env
```

### Requirements

- [Bun](https://bun.sh/) runtime
- At least one judge configured — either:
  - **Direct API**: an LLM API key (Claude preferred, Gemini / GPT optional for multi-judge consensus), or
  - **Vertex AI**: `VERTEX_PROJECT_ID` + `VERTEX_REGION` plus the optional peer deps `@anthropic-ai/vertex-sdk` + `@google/genai`

### Environment Variables

Paddock's Claude and Gemini judges run in one of two modes, auto-detected
from environment. Pick whichever fits your deployment:

#### Direct API mode (default for public users)

```bash
# Required (at least one)
CLAUDE_CODE_OAUTH_TOKEN=token1,token2,token3   # Comma-separated, auto-rotation on rate limit
ANTHROPIC_API_KEY=sk-ant-...                    # Fallback

# Optional (for 3-judge consensus)
GEMINI_API_KEY=AIza...
OPENAI_API_KEY=sk-...
```

#### Vertex AI mode (for compliance-aligned / GCP-aligned deployments)

When Vertex env is set, the Claude and Gemini judges skip API-key auth and
authenticate via Google Cloud Application Default Credentials (`gcloud auth
application-default login` locally, Workload Identity Federation in
production). API keys are still required for the OpenAI judge — OpenAI has
no Vertex offering.

```bash
# Required — both must be set to activate Vertex mode
VERTEX_PROJECT_ID=your-gcp-project
VERTEX_REGION=us-east5

# Optional — declare the full Vertex judge panel as a comma-separated list
# of model IDs (max 3 entries). Lets you run multiple Claude judges (e.g.
# Sonnet + Opus) for 3-judge consensus without needing OpenAI. When unset,
# paddock defaults to 1 Claude (EVAL_CLAUDE_JUDGE_MODEL) + 1 Gemini
# (EVAL_GEMINI_JUDGE_MODEL).
VERTEX_JUDGES=claude-sonnet-4-6,claude-opus-4-7,gemini-2.5-pro

# Optional — adds an OpenAI judge alongside the Vertex ones (always direct).
# Omit for FedRAMP-strict deployments that can't call api.openai.com.
OPENAI_API_KEY=sk-...
```

The env-var names are deliberately platform-named (`VERTEX_*`) rather
than vendor-named: in this mode Vertex hosts **both** judge providers
(Claude via `@anthropic-ai/vertex-sdk`, Gemini via `@google/genai`), so a
single platform-named env namespace gates both judges symmetrically.

Provider for each entry in `VERTEX_JUDGES` is inferred from the model-name
prefix: `claude-*` → Anthropic-on-Vertex, `gemini-*` → Google-on-Vertex.
Putting a `gpt-*` model in the list errors fast at startup — OpenAI is
not on Vertex; use `OPENAI_API_KEY` to add an OpenAI judge.

Vertex mode requires installing two optional peer dependencies (paddock
declares them as optional so direct-API users don't pay the install cost):

```bash
npm install @anthropic-ai/vertex-sdk @google/genai
```

#### Other overrides

```bash
EVAL_REPO_ROOT=/path/to/agent-repo
EVAL_AGENT_DIR=/path/to/agent-repo/.agent
EVAL_LLM_MODEL=claude-sonnet-4-6
EVAL_CLAUDE_JUDGE_MODEL=claude-sonnet-4-6
EVAL_GEMINI_JUDGE_MODEL=gemini-2.5-pro
EVAL_OPENAI_JUDGE_MODEL=gpt-4o

# Judge tuning — applies to every judge (direct + Vertex)
EVAL_JUDGE_THINKING_BUDGET=8000   # Reasoning tokens per call. 0 disables
                                  # thinking on Claude/Gemini (OpenAI reasoning
                                  # models clamp to "medium").
EVAL_JUDGE_MAX_TOKENS=16000       # Max output tokens per judge call. Generous
                                  # on purpose so thinking + final scored
                                  # output fit on hard scenarios.
```

## Usage

### CLI

```bash
# Full eval loop (10 scenarios, auto-improve, git branch + push)
bun run eval --repo /path/to/agent-repo

# Quick smoke test (3 scenarios, no improvement)
bun run eval:quick --repo /path/to/agent-repo

# Evaluate only, no code changes
bun run eval:no-improve --repo /path/to/agent-repo

# Test specific category
bun run eval:category tool_use --repo /path/to/agent-repo

# Preview loaded scenarios
bun run scenarios --repo /path/to/agent-repo
```

### All CLI Flags

```
--repo           Path to agent runtime repo (required or set EVAL_REPO_ROOT)
--agent-dir      Path to .agent directory
--categories     Comma-separated: tool_use,memory,conversation,edge_case,multi_turn,error_recovery
--difficulties   Comma-separated: easy,medium,hard,adversarial
--count          Number of scenarios (default: 10)
--threshold      Pass rate 0-1 (default: 0.8)
--max-iter       Max improvement iterations (default: 5)
--no-improve     Evaluate only, skip auto-improvement
--no-push        Don't push to git
```

### MCP Server

Paddock runs as an MCP server so your agent can call it directly:

```bash
bun run mcp
```

Available MCP tools:

| Tool | Description |
|------|-------------|
| `eval_run` | Run full eval cycle |
| `eval_status` | Check progress |
| `eval_report` | Get detailed results |
| `eval_scenarios` | Preview scenarios |
| `eval_abort` | Stop running eval |

## Scenarios

Scenarios live in `.paddock/scenarios/` inside the **target project** (the agent being tested).

### Setup

```bash
# In your agent project:
cp -r /path/to/paddock/.paddock.example .paddock
```

Or paddock will auto-copy `.paddock.example` on first run if `.paddock/` doesn't exist.

### Directory Structure

```
your-agent-project/
└── .paddock/
    ├── config.json              # Eval settings (optional)
    └── scenarios/
        ├── tool_use/
        │   ├── web-search.yml
        │   └── file-ops.yml
        ├── conversation/
        ├── memory/
        ├── multi_turn/
        ├── edge_case/
        └── error_recovery/
```

### Scenario Format

```yaml
id: tool-web-search-basic
category: tool_use
difficulty: easy
name: Basic web search
description: User asks to search the web
expectedBehavior: Agent calls web_search immediately, summarizes results
messages:
  - text: "What's the weather in London?"
    from: eval-user
  - text: "And in Tokyo?"
    from: eval-user
    delayMs: 2000
successCriteria:
  - dimension: correctness
    description: Used search tool and returned results
    weight: 0.4
  - dimension: tool_usage
    description: Chose web_search tool
    weight: 0.3
  - dimension: response_quality
    description: Concise summary
    weight: 0.3
```

### Fields

| Field | Required | Description |
|-------|----------|-------------|
| `id` | yes | Unique kebab-case identifier |
| `category` | yes | `tool_use`, `memory`, `conversation`, `multi_turn`, `edge_case`, `error_recovery` |
| `difficulty` | yes | `easy`, `medium`, `hard`, `adversarial` |
| `name` | yes | Short human-readable name |
| `description` | yes | What this scenario tests |
| `expectedBehavior` | yes | What the agent should do |
| `messages` | yes | Array of `{text, from, delayMs?}` — the "user" messages |
| `successCriteria` | yes | Array of `{dimension, description, weight}` — weights sum to 1.0 |

### Dimensions

| Dimension | What It Measures |
|-----------|-----------------|
| `correctness` | Did the agent produce the right result? |
| `tool_usage` | Did it pick the right tools with correct params? |
| `soul_compliance` | Does the response match SOUL.md personality? |
| `response_quality` | Is the response clear, well-structured? |
| `error_handling` | How did it handle errors or edge cases? |

## Development

### Project Structure

```
paddock/
├── src/
│   ├── index.ts              # MCP server entry (stdio)
│   ├── cli.ts                # CLI entry
│   ├── types.ts              # All shared types
│   ├── runner/
│   │   ├── mock-channel.ts   # In-memory channel for testing
│   │   └── agent-runner.ts   # Boots agent, sends scenarios, captures traces
│   ├── scenario/
│   │   ├── loader.ts         # YAML file loader from .paddock/
│   │   └── generator.ts      # LLM-based scenario generation
│   ├── evaluator/
│   │   ├── judge.ts          # Single-model judge
│   │   ├── consensus.ts      # Multi-model consensus (median + majority vote)
│   │   ├── criteria.ts       # Scoring prompt template
│   │   └── providers/        # Claude, Gemini, OpenAI judge implementations
│   ├── improver/
│   │   ├── analyzer.ts       # Failure pattern detection
│   │   ├── patcher.ts        # LLM-generated code patches
│   │   └── sandbox.ts        # Type-check + build validation
│   ├── git/
│   │   └── branch-manager.ts # Git branch operations
│   ├── loop/
│   │   ├── orchestrator.ts   # Main eval loop state machine
│   │   └── budget.ts         # Iteration/time/cost limits
│   └── mcp/
│       └── server.ts         # MCP tool definitions
├── .paddock.example/         # Default scenarios (copied to target projects)
├── package.json
└── tsconfig.json
```

### Key Concepts

**Mock Channel** — Implements `IChannelGateway` from the agent runtime. Captures all outbound messages. Provides `simulateIncoming()` and `waitForAllResponses()` for programmatic testing.

**Tracing Proxy** — Wraps each agent tool to record params, results, timing, errors. Dangerous tools (exec, shutdown, etc.) are blocked and return stubs.

**Consensus Engine** — Runs N judges in parallel. Per-dimension score = median (robust to outliers). Verdict = majority vote. Agreement < 50% → "partial" (flagged for human review).

**Patcher Safety** — Can only modify files matching allowlist (`.agent/SOUL.md`, `src/slices/**/*.ts`, etc.). Max 200 lines per patch. Type-check gate after every patch. Auto-revert on failure.

### Commands

```bash
bun run eval          # Full eval loop
bun run eval:quick    # 3 scenarios, no improve
bun run eval:full     # 10 scenarios with improve
bun run scenarios     # Preview scenarios
bun run mcp           # Start MCP server
bun run typecheck     # Type-check
```

### Adding a Judge Provider

Three steps:

**1.** Create `src/evaluator/providers/your-provider.ts` implementing `JudgeProvider`:

```typescript
import type { JudgeProvider, JudgePrompt, TokenUsage } from "../../types"

export class YourJudgeProvider implements JudgeProvider {
  name = "your-model"
  model: string
  usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }

  constructor(apiKey: string, model = "your-model-id") {
    this.model = model
  }

  async complete(prompt: string | JudgePrompt): Promise<string> {
    // Call your LLM API, return raw text. Populate this.usage along the way.
  }
}
```

**2.** Add a variant to the `JudgeProviderConfig` discriminated union in `src/types.ts`:

```typescript
export interface YourJudgeConfig {
  type: "your-provider"
  model: string
  apiKey: string
}

export type JudgeProviderConfig =
  | ClaudeJudgeConfig
  | ClaudeVertexJudgeConfig
  | GeminiJudgeConfig
  | GeminiVertexJudgeConfig
  | OpenAIJudgeConfig
  | YourJudgeConfig   // ← add here
```

**3.** Add a `case` to the factory's `switch` in `src/evaluator/providers/factory.ts`:

```typescript
case "your-provider":
  return new YourJudgeProvider(config.apiKey, config.model)
```

TypeScript's exhaustive `never` check in the factory's `default` branch will flag any new variant that lacks a case at build time.

To register the new judge from CLI / MCP based on env vars, mirror the
`buildJudgeConfigs` pattern in `src/cli.ts` and `src/mcp/server.ts`.

### Runtime Integration

Paddock requires a small change in the target agent's channel system — adding a `mock` channel type:

```typescript
// In channel.types.ts:
export type ChannelConfig =
  | { type: "telegram"; token: string }
  | { type: "slack"; botToken: string; appToken: string }
  | { type: "mock"; instance: IChannelGateway }  // ← for Paddock

// In channel.gateway.ts:
case "mock":
  return config.instance
```

## License

MIT
