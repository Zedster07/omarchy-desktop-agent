// Talking to whatever AI CLI the user already has.
//
// This is the third tier of command resolution and it only ever runs when the
// deterministic matcher found nothing. Tiers, in order:
//
//   1. registry match   instant, deterministic, no AI at all
//   2. AI routing       map an unrecognised phrase onto an EXISTING intent
//   3. AI planning      propose a new command for a genuinely novel request
//
// Nothing here executes anything. Every tier-2 and tier-3 result is a
// PROPOSAL that goes through the approval overlay with the exact argv on
// display. The AI widens what you can ask for; it does not widen what can
// happen without you seeing it.

export interface Provider {
  id: string
  /** "local" never leaves the machine. "agent" may call a hosted model. */
  kind: "local" | "agent"
  argv(prompt: string): string[]
  /** Rough budget; agents are slower and are only used for tier 3. */
  timeoutMs: number
}

function configuredModel(): string {
  if (process.env.DESKTOP_AGENT_OLLAMA_MODEL) return process.env.DESKTOP_AGENT_OLLAMA_MODEL
  try {
    const raw = JSON.parse(
      require("node:fs").readFileSync(`${process.env.HOME}/.config/omarchy/shell.json`, "utf8"))
    let found: any
    const walk = (v: any) => {
      if (Array.isArray(v)) v.forEach(walk)
      else if (v && typeof v === "object") {
        if (typeof v.id === "string" && v.id.includes("desktop-agent") && v.settings) found = v.settings
        Object.values(v).forEach(walk)
      }
    }
    walk(raw)
    if (found?.aiModel) return String(found.aiModel)
  } catch {}
  return "llama3.2:3b"
}
const OLLAMA_MODEL = configuredModel()

const CANDIDATES: Provider[] = [
  {
    id: "ollama",
    kind: "local",
    // --format json constrains decoding to valid JSON, which matters far more
    // than model size for this job: we need a parseable answer, not prose.
    argv: p => ["ollama", "run", OLLAMA_MODEL, "--format", "json", p],
    timeoutMs: 45_000,
  },
  { id: "claude",   kind: "agent", argv: p => ["claude", "-p", p],      timeoutMs: 90_000 },
  { id: "opencode", kind: "agent", argv: p => ["opencode", "run", p],   timeoutMs: 90_000 },
  { id: "gemini",   kind: "agent", argv: p => ["gemini", "-p", p],      timeoutMs: 90_000 },
  { id: "codex",    kind: "agent", argv: p => ["codex", "exec", p],     timeoutMs: 90_000 },
]

export function detectProviders(): Provider[] {
  return CANDIDATES.filter(p => Bun.which(p.argv("x")[0]) !== null)
}

export function pickProvider(preference: string, want: "local" | "any"): Provider | null {
  const available = detectProviders()
  if (preference && preference !== "auto") {
    return available.find(p => p.id === preference) ?? null
  }
  // Routing prefers a local model: it is faster, free, and the job is small
  // enough that a 3B model does it well. Planning may need the better one.
  if (want === "local") {
    return available.find(p => p.kind === "local") ?? available[0] ?? null
  }
  return available.find(p => p.kind === "agent") ?? available[0] ?? null
}

export async function ask(provider: Provider, prompt: string): Promise<string> {
  const proc = Bun.spawn(provider.argv(prompt), {
    stdout: "pipe", stderr: "pipe", stdin: "ignore",
  })
  const timer = setTimeout(() => { try { proc.kill() } catch {} }, provider.timeoutMs)
  try {
    const out = await new Response(proc.stdout).text()
    await proc.exited
    return out
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Pull the first JSON object out of a model's reply.
 *
 * Every one of these CLIs decorates its output differently -- fenced blocks,
 * a preamble, reasoning traces from thinking models. Rather than fight each
 * one, find the first balanced {...} and parse that. A model that cannot
 * produce one is treated as having produced nothing, which is the safe
 * reading.
 */
export function extractJson(text: string): any | null {
  const s = String(text ?? "")
  const start = s.indexOf("{")
  if (start < 0) return null
  let depth = 0, inStr = false, esc = false
  for (let i = start; i < s.length; i++) {
    const c = s[i]
    if (esc) { esc = false; continue }
    if (c === "\\") { esc = true; continue }
    if (c === '"') { inStr = !inStr; continue }
    if (inStr) continue
    if (c === "{") depth++
    else if (c === "}") {
      depth--
      if (depth === 0) {
        try { return JSON.parse(s.slice(start, i + 1)) } catch { return null }
      }
    }
  }
  return null
}
