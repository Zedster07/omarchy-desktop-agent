// Asking an AI what a phrase meant, when the matcher had no idea.
//
// Two jobs, deliberately kept apart because they carry very different risk:
//
//   route()  maps the phrase onto an intent that ALREADY EXISTS. The output is
//            an id from a list -- the model cannot invent an action, only pick
//            one. Cheap, local, and the answer is as safe as the registry.
//
//   plan()   lets the model propose a NEW command for something the registry
//            does not cover. This is the only place in the plugin where an
//            action can come from a model rather than a person, so its output
//            is checked against voice/safety.ts and then always shown for
//            approval with the exact argv on display. It is never eligible for
//            the unattended lease.

import type { Intent } from "./intents.ts"
import { ask, pickProvider, extractJson, type Provider } from "./ai.ts"
import { loadOsCommands, relevantCommands, availableTools } from "./osmap.ts"
import { checkProposedCommand } from "./safety.ts"

export interface RouteResult { id: string; slots: Record<string, string> }
export interface PlanResult {
  argv: string[]
  explanation: string
  severity: "normal" | "destructive"
  provider: string
}

// ------------------------------------------------------------------ tier 2

export async function route(
  phrase: string, intents: Intent[], preference = "auto",
): Promise<{ result: RouteResult | null; provider: string | null }> {
  const provider = pickProvider(preference, "local")
  if (!provider) return { result: null, provider: null }

  const catalogue = intents.map(i => {
    const slots = i.slots ? ` slots:${Object.keys(i.slots).join(",")}` : ""
    return `${i.id} — ${i.description ?? i.id}. examples: ${i.phrases.slice(0, 3).join("; ")}${slots}`
  }).join("\n")

  const prompt = `You match a spoken phrase to one desktop command from a fixed list.

Commands:
${catalogue}

Phrase: "${phrase}"

Reply with JSON only, no prose:
{"id": "<exact command id from the list>", "slots": {"<slot>": "<value>"}}
If nothing in the list fits, reply {"id": null}.
Do not invent an id. Only ids from the list above are valid.`

  const raw = await ask(provider, prompt)
  const json = extractJson(raw)
  if (!json || !json.id || typeof json.id !== "string") return { result: null, provider: provider.id }

  // The model is not trusted to stay inside the list; verify.
  if (!intents.some(i => i.id === json.id)) return { result: null, provider: provider.id }

  const slots: Record<string, string> = {}
  if (json.slots && typeof json.slots === "object") {
    for (const [k, v] of Object.entries(json.slots)) {
      if (typeof v === "string" || typeof v === "number") slots[k] = String(v)
    }
  }
  return { result: { id: json.id, slots }, provider: provider.id }
}

// ------------------------------------------------------------------ tier 3

export async function plan(
  phrase: string, preference = "auto",
): Promise<{ result: PlanResult | null; provider: string | null; refusal?: string }> {
  const provider: Provider | null = pickProvider(preference, "any")
  if (!provider) return { result: null, provider: null }

  const all = await loadOsCommands()
  // A hosted agent gets the whole surface; a local model gets the relevant
  // slice, because 6.5k tokens of prompt through a 3B model on a laptop CPU
  // is slower than the request is worth.
  const routes = provider.kind === "agent" ? all : relevantCommands(phrase, all, 45)
  const catalogue = routes
    .map(c => `${c.route}${c.args ? " " + c.args : ""} — ${c.summary}`)
    .join("\n")

  const prompt = `You turn a spoken request into ONE command to run on an Omarchy Linux desktop (Arch Linux, Hyprland, Wayland).

Omarchy CLI routes available:
${catalogue}

Other programs installed: ${availableTools().join(", ")}

Rules:
- The command is executed directly as an argv array. There is NO shell, so pipes, redirects, globs, $(...) and ; do not work. Do not use them.
- Never use sudo, a shell (sh/bash), a package manager, or anything that deletes, moves or overwrites files.
- Prefer an "omarchy ..." route when one fits. Otherwise use one of the installed programs.
- To open a web page or play something online, use xdg-open with a full URL.

Request: "${phrase}"

Reply with JSON only, no prose and no code fence:
{"argv": ["program", "arg1", "arg2"], "explanation": "<one short sentence a user will read before approving>", "severity": "normal"}
Use "severity": "destructive" if it closes, deletes, or interrupts something.
If you cannot do it safely with one command, reply {"argv": null, "reason": "<why>"}.`

  const raw = await ask(provider, prompt)
  const json = extractJson(raw)
  if (!json || !Array.isArray(json.argv) || json.argv.length === 0) {
    return { result: null, provider: provider.id }
  }

  const argv = json.argv.map((a: unknown) => String(a))
  const verdict = checkProposedCommand(argv)
  if (!verdict.ok) {
    // Refused before a human is asked. An approval prompt for something the
    // rules already forbid is not a safeguard, it is a trap with a button.
    return { result: null, provider: provider.id, refusal: verdict.reason }
  }

  return {
    result: {
      argv,
      explanation: String(json.explanation ?? "").slice(0, 200),
      severity: json.severity === "destructive" ? "destructive" : "normal",
      provider: provider.id,
    },
    provider: provider.id,
  }
}
