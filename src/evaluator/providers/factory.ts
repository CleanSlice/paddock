import type { JudgeProvider, JudgeProviderConfig } from "../../types"
import { ClaudeJudgeProvider } from "./claude"
import { GeminiJudgeProvider } from "./gemini"
import { OpenAIJudgeProvider } from "./openai"

/**
 * Build a judge provider from a typed `JudgeProviderConfig`.
 *
 * The factory has no awareness of environment variables — the caller (one of
 * paddock's entry points) is responsible for choosing the right discriminated
 * variant. This keeps provider construction deterministic: passing the same
 * config always produces the same provider, regardless of process.env at
 * the moment of construction.
 */
export function createJudgeProvider(config: JudgeProviderConfig): JudgeProvider {
  switch (config.type) {
    case "claude":
      return new ClaudeJudgeProvider({
        mode: "api-key",
        apiKeyOrTokens: config.apiKey,
        model: config.model,
      })
    case "claude-vertex":
      return new ClaudeJudgeProvider({
        mode: "vertex",
        projectId: config.projectId,
        region: config.region,
        model: config.model,
      })
    case "gemini":
      return new GeminiJudgeProvider({
        mode: "api-key",
        apiKey: config.apiKey,
        model: config.model,
      })
    case "gemini-vertex":
      return new GeminiJudgeProvider({
        mode: "vertex",
        projectId: config.projectId,
        region: config.region,
        model: config.model,
      })
    case "openai":
      return new OpenAIJudgeProvider(config.apiKey, config.model)
    default: {
      // Exhaustive check — TypeScript errors here if a new variant is
      // added to JudgeProviderConfig without a matching case.
      const _exhaustive: never = config
      throw new Error(
        `Unknown judge provider type: ${JSON.stringify(_exhaustive)}`,
      )
    }
  }
}
