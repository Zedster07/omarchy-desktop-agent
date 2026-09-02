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
import { loadOsCommands, relevantCommands, availableTools, installedApps } from "./osmap.ts"
import { checkProposedCommand } from "./safety.ts"

export interface RouteResult { id: string; slots: Record<string, string> }
export interface PlanResult {
  /**
   * The commands to run, in order. Usually one.
   *
   * A single argv could not express "play this song": the best one-shot answer
   * is a search URL, which opens a page and stops -- the request half-done and
   * looking like a failure. Some intents genuinely take a sequence, so the
   * plan is a list and the approval prompt shows all of it.
   */
  steps: string[][]
  explanation: string
  severity: "normal" | "destructive"
  provider: string
}

/** How many commands one spoken sentence may turn into. */
const MAX_STEPS = 5

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

  const prompt = `You turn a spoken request into the commands to run on an Omarchy Linux desktop (Arch Linux, Hyprland, Wayland).

Omarchy CLI routes available:
${catalogue}

Other programs installed: ${availableTools().join(", ")}

Apps that can be opened by name (use: uwsm-app -- "<Name>.desktop"):
${installedApps().join(", ")}

Rules:
- Commands are executed directly as argv arrays. There is NO shell, so pipes, redirects, globs, $(...) and ; do not work. Do not use them.
- Never use sudo, a shell (sh/bash), a package manager, or anything that deletes, moves or overwrites files.
- Prefer an "omarchy ..." route when one fits. To open an installed app use uwsm-app with its Desktop Entry ID. Do NOT use "omarchy launch <app>": that route exists only for a fixed handful of names.
- FINISH THE REQUEST. Do not stop at a step that merely gets close to it. Opening a search page for something the user asked you to play is not playing it.
- Use at most ${MAX_STEPS} steps, and only more than one when a single command genuinely cannot do the job.

Worked examples of finishing rather than approaching:
- "play <song> on youtube" -> [["mpv", "--ytdl-format=bestaudio", "ytdl://ytsearch1:<song>"]]
  (ytsearch1 resolves and plays the first hit; a youtube.com/results URL only opens a search)
- "watch <video> on youtube" -> [["mpv", "ytdl://ytsearch1:<video>"]]
- "open <app>" -> [["uwsm-app", "--", "<Name>.desktop"]]
- "look up <thing>" -> [["xdg-open", "https://duckduckgo.com/?q=<thing>"]]

Request: "${phrase}"

Reply with JSON only, no prose and no code fence:
{"steps": [["program","arg"], ["program","arg"]], "explanation": "<one short sentence a user will read before approving>", "severity": "normal"}
Use "severity": "destructive" if anything in it closes, deletes, or interrupts something.
If you cannot do it safely, reply {"steps": null, "reason": "<why>"}.`

  const raw = await ask(provider, prompt)
  const json = extractJson(raw)

  // Accept a bare `argv` too: models fall back to the older single-command
  // shape often enough that rejecting it would look like a random failure.
  const rawSteps: unknown[] =
    Array.isArray(json?.steps) ? json.steps
    : Array.isArray(json?.argv) ? [json.argv]
    : []
  if (rawSteps.length === 0) return { result: null, provider: provider.id }

  const steps: string[][] = []
  for (const s of rawSteps.slice(0, MAX_STEPS)) {
    if (!Array.isArray(s) || s.length === 0) continue
    steps.push(s.map((a: unknown) => String(a)))
  }
  if (steps.length === 0) return { result: null, provider: provider.id }

  // EVERY step is checked, not just the first. A plan is only as safe as its
  // worst command, and a denied one must stop the whole thing before a person
  // is asked -- an approval prompt for something the rules already forbid is
  // not a safeguard, it is a trap with a button.
  for (const step of steps) {
    const verdict = checkProposedCommand(step)
    if (!verdict.ok) return { result: null, provider: provider.id, refusal: verdict.reason }
  }

  return {
    result: {
      steps,
      explanation: String(json.explanation ?? "").slice(0, 200),
      severity: json.severity === "destructive" ? "destructive" : "normal",
      provider: provider.id,
    },
    provider: provider.id,
  }
}
