import type { AgentRunner } from "./types.ts"
import { ClaudeRunner } from "./claude.ts"
import { GeminiRunner } from "./gemini.ts"
import { CodexRunner } from "./codex.ts"
import { OpenCodeRunner } from "./opencode.ts"

export * from "./types.ts"
export * from "./prompt.ts"

export const ALL_RUNNERS: AgentRunner[] = [
  new ClaudeRunner(),
  new GeminiRunner(),
  new CodexRunner(),
  new OpenCodeRunner(),
]

export function listAvailableRunners(): AgentRunner[] {
  return ALL_RUNNERS.filter((r) => r.isAvailable())
}

/**
 * Find the runner to use.
 * - If preference is explicitly specified (e.g. "gemini", "codex"), returns it if available.
 * - If preference is "auto" (or not found), returns the first available runner in priority order:
 *   Claude -> Gemini -> Codex -> OpenCode.
 */
export function getRunner(preference?: string): AgentRunner | null {
  const normalized = (preference || "auto").trim().toLowerCase()

  if (normalized && normalized !== "auto") {
    const match = ALL_RUNNERS.find((r) => r.id === normalized)
    if (match && match.isAvailable()) return match
  }

  // Auto fallback
  return ALL_RUNNERS.find((r) => r.isAvailable()) ?? null
}
