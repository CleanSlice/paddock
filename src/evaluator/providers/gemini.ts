import type { JudgeProvider, JudgePrompt, TokenUsage } from "../../types"

/**
 * Gemini judge provider — supports two auth modes, selected explicitly via
 * the `mode` discriminator passed to the constructor.
 *
 *   Vertex AI mode (preferred for FedRAMP-aligned deployments):
 *     - Caller passes `{ mode: "vertex", projectId, region }` directly.
 *     - Uses `@google/genai` (optional peer dep — install separately) with
 *       `vertexai: true`. Auth is Application Default Credentials locally
 *       and Workload Identity Federation in production via
 *       `google-auth-library`'s default chain.
 *
 *   API-key mode (default for public users):
 *     - Caller passes `{ mode: "api-key", apiKey }` directly.
 *     - Uses raw REST against `generativelanguage.googleapis.com`. Keeps
 *       paddock's "no-mandatory-SDK" surface for users who only need the
 *       direct path.
 *
 * This class is internal to paddock. Environment-based mode detection lives
 * in the entry points (`cli.ts`, `mcp/server.ts`) which build the typed
 * `JudgeProviderConfig` discriminated union; the class takes a fully-resolved
 * mode so library consumers who embed paddock get deterministic behavior
 * independent of process env.
 *
 * Prompt structure: when complete() receives a JudgePrompt, the static
 * system prefix is sent as `systemInstruction` (Gemini's structured
 * separation) and the variable content as `contents`. This positions us
 * to take advantage of Gemini's implicit caching when it stabilizes
 * (currently flaky on gemini-3-pro-preview per a known Google issue).
 *
 * Explicit caching via `cachedContents` is a separate, larger change
 * and is deferred — implicit + structured separation is already a win
 * for any scenario where implicit caching works.
 *
 * Thinking budget: Gemini 2.5+ models (including gemini-3-pro-preview) think
 * by default with a model-determined budget. This makes per-call results
 * non-deterministic and skews judge agreement vs the non-thinking judges.
 * We pin the budget to EVAL_JUDGE_THINKING_BUDGET (default 8000) so all
 * three judges reason at comparable depth. Set to 0 to disable thinking on
 * supported models. Older models (gemini-2.0-*, gemini-1.5-*) ignore this.
 */
function parseBudget(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) {
    console.warn(`[gemini-judge] invalid env value "${raw}", using ${fallback}`)
    return fallback
  }
  return Math.floor(n)
}
const JUDGE_THINKING_BUDGET = parseBudget(process.env.EVAL_JUDGE_THINKING_BUDGET, 8000)
const JUDGE_MAX_OUTPUT_TOKENS = parseBudget(process.env.EVAL_JUDGE_MAX_TOKENS, 16000)

const SUPPORTS_THINKING_BUDGET = (model: string): boolean =>
  /^gemini-(2\.5|3)/.test(model)

type GeminiMode =
  | { kind: "vertex"; projectId: string; region: string; client?: GenAIClient }
  | { kind: "api-key"; apiKey: string }

/** Shape of the @google/genai client we use — just `models.generateContent`. */
interface GenAIClient {
  models: {
    generateContent(args: {
      model: string
      contents: string | Array<{ role?: string; parts: Array<{ text: string }> }>
      config?: Record<string, unknown>
    }): Promise<{
      text?: string
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
      usageMetadata?: {
        promptTokenCount?: number
        candidatesTokenCount?: number
        thoughtsTokenCount?: number
        totalTokenCount?: number
      }
    }>
  }
}

/** Constructor options — a fully-resolved auth mode. Factory.ts converts
 *  the public `JudgeProviderConfig` discriminated union into one of these. */
export type GeminiProviderOpts =
  | { mode: "vertex"; projectId: string; region: string; model?: string }
  | { mode: "api-key"; apiKey: string; model?: string }

export class GeminiJudgeProvider implements JudgeProvider {
  name = "gemini"
  model: string
  usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  private mode: GeminiMode

  constructor(opts: GeminiProviderOpts) {
    this.model = opts.model ?? "gemini-2.5-pro"
    if (opts.mode === "vertex") {
      this.mode = { kind: "vertex", projectId: opts.projectId, region: opts.region }
      return
    }
    if (!opts.apiKey) {
      throw new Error(
        "GeminiJudgeProvider: api-key mode received an empty key. Pass a GEMINI_API_KEY or GOOGLE_API_KEY, or use Vertex mode by setting VERTEX_PROJECT_ID + VERTEX_REGION.",
      )
    }
    this.mode = { kind: "api-key", apiKey: opts.apiKey }
  }

  /** Lazy-load @google/genai so direct-API users don't need the peer dep. */
  private async getVertexClient(): Promise<GenAIClient> {
    if (this.mode.kind !== "vertex") {
      throw new Error("getVertexClient called outside Vertex mode")
    }
    if (this.mode.client) return this.mode.client
    let GoogleGenAICtor: new (opts: {
      vertexai: boolean
      project: string
      location: string
      httpOptions?: { baseUrl?: string }
    }) => GenAIClient
    try {
      const mod = await import("@google/genai")
      GoogleGenAICtor = mod.GoogleGenAI as unknown as typeof GoogleGenAICtor
    } catch {
      throw new Error(
        "Vertex mode requires the optional peer dependency `@google/genai`. Install it with: npm install @google/genai",
      )
    }
    // `@google/genai` builds `${location}-aiplatform.googleapis.com` for any
    // non-`global` location. That's correct for regional endpoints (e.g.
    // `us-east5-aiplatform.googleapis.com`) but wrong for the `us` and `eu`
    // multi-region identifiers — those route through the standard host with
    // the multi-region tag in the URL path (`.../locations/us/...`). Without
    // this override every judge call against a multi-region silently fails
    // (DNS miss on the invalid host) and paddock attributes 0 score to the
    // judge, breaking multi-judge consensus.
    //
    // `global` and any single-region value (`us-central1`, `europe-west4`,
    // etc.) fall through to the SDK's default URL construction, which is
    // already correct for those cases.
    const isMultiRegion =
      this.mode.region === "us" || this.mode.region === "eu"
    this.mode.client = new GoogleGenAICtor({
      vertexai: true,
      project: this.mode.projectId,
      location: this.mode.region,
      ...(isMultiRegion && {
        httpOptions: { baseUrl: "https://aiplatform.googleapis.com/" },
      }),
    } as ConstructorParameters<typeof GoogleGenAICtor>[0])
    return this.mode.client
  }

  private supportsThinking(): boolean {
    return SUPPORTS_THINKING_BUDGET(this.model)
  }

  private buildGenerationConfig(): Record<string, unknown> {
    const supportsThinking = this.supportsThinking()
    const config: Record<string, unknown> = {
      // Older models (gemini-1.5/2.0) get the original 8K cap; thinking-capable
      // models get the wider cap to leave room when JUDGE_MAX_TOKENS is bumped
      // alongside thinking budget. (Gemini's thinkingBudget is separate from
      // maxOutputTokens, so this is generous, not load-bearing.)
      maxOutputTokens: supportsThinking ? JUDGE_MAX_OUTPUT_TOKENS : 8096,
      // JSON mode — Gemini guarantees the response is parseable JSON
      // when this is set.
      responseMimeType: "application/json",
    }
    if (supportsThinking) {
      // 0 disables thinking; positive values pin the budget. Without this
      // the model uses an undocumented dynamic budget per call, which
      // varies the strictness of judging across runs.
      config.thinkingConfig = { thinkingBudget: JUDGE_THINKING_BUDGET }
    }
    return config
  }

  private recordUsage(usage: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    thoughtsTokenCount?: number
  } | undefined): void {
    if (!usage) return
    this.usage.inputTokens += usage.promptTokenCount ?? 0
    this.usage.outputTokens += usage.candidatesTokenCount ?? 0
    // Gemini exposes reasoning ("thoughts") tokens in a separate counter —
    // sum into thinkingTokens so the cost report doesn't drop the entire
    // thinking spend (often 5-10K tokens per judge call at thinking depth).
    this.usage.thinkingTokens = (this.usage.thinkingTokens ?? 0) + (usage.thoughtsTokenCount ?? 0)
    // Recompute total locally — Gemini's totalTokenCount sometimes includes
    // thoughts and sometimes doesn't depending on model version, so derive
    // it deterministically from the parts.
    this.usage.totalTokens =
      this.usage.inputTokens + this.usage.outputTokens + (this.usage.thinkingTokens ?? 0)
  }

  async complete(prompt: string | JudgePrompt): Promise<string> {
    const { system, user } = typeof prompt === "string"
      ? { system: "", user: prompt }
      : prompt

    if (this.mode.kind === "vertex") {
      const client = await this.getVertexClient()
      const config = this.buildGenerationConfig()
      if (system) {
        config.systemInstruction = { parts: [{ text: system }] }
      }
      const response = await client.models.generateContent({
        model: this.model,
        contents: [{ role: "user", parts: [{ text: user }] }],
        config,
      })
      this.recordUsage(response.usageMetadata)
      return response.text ?? response.candidates?.[0]?.content?.parts?.[0]?.text ?? ""
    }

    // Direct API mode — REST against generativelanguage.googleapis.com.
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.mode.apiKey}`

    const body: Record<string, unknown> = {
      contents: [{ parts: [{ text: user }] }],
      generationConfig: this.buildGenerationConfig(),
    }
    if (system) {
      body.systemInstruction = { parts: [{ text: system }] }
    }

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      throw new Error(`Gemini API error: ${res.status} ${await res.text()}`)
    }

    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
      usageMetadata?: {
        promptTokenCount?: number
        candidatesTokenCount?: number
        thoughtsTokenCount?: number
        totalTokenCount?: number
      }
    }
    this.recordUsage(data.usageMetadata)
    return data.candidates?.[0]?.content?.parts?.[0]?.text ?? ""
  }
}
