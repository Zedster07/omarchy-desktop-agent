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
 *
 * "auto" only ever picks a CONFINED runner. The order used to be
 * Claude -> Gemini -> Codex -> OpenCode with no distinction between them,
 * which meant a machine without Claude Code silently got an agent holding its
 * own shell -- the desktop policy bypassed, no warning, nothing in the audit
 * log. Falling back from a confined runner to an unconfined one is not a
 * fallback, it is a different feature with the safety removed.
 *
 * An unconfined runner therefore has to be asked for BY NAME, and the caller
 * still has to opt in (see handOff). Naming it is not the same as consenting
 * to it.
 */
export function getRunner(preference?: string): AgentRunner | null {
  const normalized = (preference || "auto").trim().toLowerCase()

  if (normalized && normalized !== "auto") {
    const match = ALL_RUNNERS.find((r) => r.id === normalized)
    if (match && match.isAvailable()) return match
    return null
  }

  return ALL_RUNNERS.find((r) => r.isAvailable() && r.confined) ?? null
}

/** Available runners that cannot be reduced to the desktop tools. */
export function unconfinedRunners(): AgentRunner[] {
  return ALL_RUNNERS.filter((r) => r.isAvailable() && !r.confined)
}
