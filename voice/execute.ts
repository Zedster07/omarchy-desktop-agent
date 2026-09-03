#!/usr/bin/env bun
//
// Runs a matched intent, after asking if the rules say to ask.
//
// Detached from the voxtype hook on purpose: this can block for as long as a
// human takes to answer an approval prompt, and the hook cannot.

import { settingStr } from "./settings.ts"
import type { Intent } from "./intents.ts"
import { appendFileSync, mkdirSync, readFileSync} from "node:fs"
import { onWorkspace, isLaunch, DEFAULT_WORKSPACE } from "./workspace.ts"

const HOME = process.env.HOME!
const AUDIT = `${HOME}/.local/share/desktop-agent/desktop.log`
const SHELL_IPC = ["qs", "-p", "/usr/share/omarchy/shell", "ipc", "call",
                   "io.github.zedster07.desktop-agent"]

interface Target { address: string; cls: string; title: string }
interface Payload {
  phrase: string; intent: Intent; argv: string[]; score: number
  target: Target | null
  /** Set when the command came from a model rather than the registry. */
  aiProposed: { provider: string; explanation: string } | null
  /** Extra commands to run after argv, in order. AI plans only. */
  steps: string[][] | null
  /** Set when a model CHOSE a registered intent the matcher did not find. */
  aiRouted: { provider: string } | null
}

const payload: Payload = JSON.parse(process.argv[2] ?? "{}")
const { intent, phrase, target, aiProposed, aiRouted } = payload
// One code path for both shapes: a registry command is a plan of length one.
const plan: string[][] = payload.steps && payload.steps.length
  ? payload.steps
  : [payload.argv]
let argv = payload.argv

function audit(line: string) {
  try {
    mkdirSync(`${HOME}/.local/share/desktop-agent`, { recursive: true })
    appendFileSync(AUDIT, `${new Date().toISOString()} voice ${line}\n`)
  } catch {}
}

function hud(patch: Record<string, unknown>) {
  Bun.spawn([...SHELL_IPC, "voice", JSON.stringify(patch)],
            { stdout: "ignore", stderr: "ignore" })
}

// Every exit from this process goes through here.
//
// process.exit() kills pending timers, so an earlier version that did
//   hud({ state: "error" }); process.exit(0)
// left the card on screen permanently -- there was no longer a process alive
// to clear it. Showing the outcome and then clearing it has to be one
// operation, and it has to be awaited.
async function finish(patch: Record<string, unknown>, holdMs = 1600): Promise<never> {
  hud(patch)
  await Bun.sleep(holdMs)
  hud({ state: "idle", transcript: "", errorText: "", matched: "" })
  await Bun.sleep(120)
  process.exit(0)
}

async function ipc(fn: string, arg: string): Promise<string> {
  const p = Bun.spawn([...SHELL_IPC, fn, arg], { stdout: "pipe", stderr: "ignore" })
  return (await new Response(p.stdout).text()).trim()
}


// ---------------------------------------------------------------- targeting
//
// A window-scoped intent acts on the window that was focused when the phrase
// was SPOKEN. Two guards, and both are load-bearing:
//
//   1. The target must still exist. hl.dsp.window.close falls back to the
//      FOCUSED window when its selector does not resolve -- a bogus address
//      does not error, it closes whatever is in front of you. So a stale
//      address is not a harmless no-op, it is a wrong window closed.
//   2. Nothing is substituted blind. If {window} survives into the argv the
//      command is refused rather than dispatched with a literal placeholder.

async function windowExists(address: string): Promise<boolean> {
  try {
    const p = Bun.spawn(["hyprctl", "clients", "-j"], { stdout: "pipe", stderr: "ignore" })
    const clients = JSON.parse(await new Response(p.stdout).text())
    return Array.isArray(clients) && clients.some((c: any) => String(c.address) === address)
  } catch {
    return false
  }
}

const needsWindow = intent.scope === "window" || argv.some(a => a.includes("{window}"))

if (needsWindow) {
  if (!target || !target.address) {
    audit(`${intent.id} -> refused, no window was captured when the phrase was spoken`)
    await finish({ state: "error", mode: "command",
                   errorText: "Could not tell which window you meant" }, 2600)
  }
  if (!(await windowExists(target!.address))) {
    audit(`${intent.id} -> refused, target window ${target!.address} (${target!.cls}) is gone`)
    await finish({ state: "error", mode: "command",
                   errorText: "That window is gone — refusing rather than guessing" }, 3000)
  }
  argv = argv.map(a => a.replaceAll("{window}", target!.address))
  for (let i = 0; i < plan.length; i++) {
    plan[i] = plan[i].map(a => a.replaceAll("{window}", target!.address))
  }
}

// Matches only a real placeholder -- {window}, {n}, {app} -- and deliberately
// NOT Lua table syntax like `{ window = "address:0x..." }`, which is what a
// naive check for "{" flagged, refusing every window-scoped command.
const LEFTOVER = /\{[A-Za-z_][A-Za-z0-9_]*\}/
if (plan.some(c => c.some(a => LEFTOVER.test(a)))) {
  audit(`${intent.id} -> refused, unsubstituted placeholder in ${argv.join(" ")}`)
  await finish({ state: "error", mode: "command", errorText: "Command was incomplete" }, 2600)
}

// Anything a MODEL decided is always confirmed by a person, whatever the
// confirmation setting says. Two different failures make this non-negotiable:
//
//   * a planned command is invented text, and
//   * a routed intent is a small model being asked "which of these twelve?" --
//     a question such models answer badly, because saying "none" is the one
//     option they are worst at. Asked to route "play Despacito on YouTube" one
//     picked audio.mute, which was not destructive, so under a
//     "destructive-only" setting it muted the speakers with nobody consulted.
//
// A deterministic match is a phrase someone registered on purpose and still
// runs immediately. A model's opinion costs one keystroke.
const destructive = intent.severity === "destructive"
// "command.confirm", not "commandConfirm". The panel writes the dotted key and
// this read the flat one, so the setting had never once changed anything --
// every value silently behaved as "destructive-only".
const confirm = await settingStr("command.confirm", "destructive-only")
const fromModel = aiProposed !== null || aiRouted !== null

/**
 * Is the unattended lease running?
 *
 * Full access says "skip approvals for a while" on the panel and then asked
 * anyway for anything a model wrote, which is most of what people actually
 * say. A switch that does not do what its own description says is worse than
 * not having it: you stop trusting the description.
 *
 * Destructive commands still stop, lease or not -- the panel promises that
 * too, and it is the half worth keeping.
 */
function leaseActive(): boolean {
  try {
    const j = JSON.parse(readFileSync(`${HOME}/.local/state/desktop-agent/yolo.json`, "utf8"))
    return Number(j.until) > Date.now()
  } catch { return false }
}

const lease = leaseActive()
const needsApproval = destructive
  || confirm === "always"
  || (fromModel && !lease)

if (needsApproval) {
  const id = await ipc("request", JSON.stringify({
    tool: aiProposed
      ? `AI suggests: ${aiProposed.explanation || argv.join(" ")}`
      : aiRouted
        ? `AI thinks you meant: ${intent.description || intent.id}`
        : `voice: ${intent.description || intent.id}`,
    capability: "voice-command",
    target: needsWindow && target
      ? `${target.cls}${target.title ? " — " + target.title : ""}`
      // With a multi-step plan the steps are listed individually below, so
      // repeating a placeholder argv here says nothing.
      : plan.length > 1 ? `${plan.length} commands`
      : argv.join(" "),
    principal: "voice",
    severity: destructive ? "destructive" : "normal",
    reasons: [
      `heard "${phrase}"`,
      `matched intent ${intent.id}${intent.source && intent.source !== "builtin" ? ` from ${intent.source}` : ""}`,
      ...(aiRouted ? [
        `no registered phrase matched "${phrase}"`,
        `${aiRouted.provider} picked this command from the list — it was not recognised outright`,
      ] : []),
      ...(aiProposed ? [
        `this command was written by ${aiProposed.provider}, not taken from the command list`,
        `nothing like it is registered, so it has not been reviewed by anyone but you`,
      ] : []),
      ...(needsWindow && target ? [`this acts on the window you were looking at, not the focused one`] : []),
      ...(plan.length > 1
        ? plan.map((c, i) => `step ${i + 1} of ${plan.length}: ${c.join(" ")}`)
        : (needsWindow || fromModel ? [`command: ${argv.join(" ")}`] : [])),
      destructive ? "this intent is marked destructive, so it always asks" : `confirmation setting is "${confirm}"`,
    ],
  }))

  if (!id) {
    audit(`${intent.id} -> could not raise an approval, refusing`)
    await finish({ state: "error", errorText: "Could not ask for approval" }, 2400)
  }

  // Poll until answered. Two minutes of silence is a denial, matching the
  // overlay's own countdown.
  let verdict = ""
  for (let i = 0; i < 240 && verdict === ""; i++) {
    await Bun.sleep(500)
    verdict = await ipc("verdict", id)
    if (verdict === "gone") break
  }
  await ipc("cancel", id)

  if (verdict !== "allow" && verdict !== "always") {
    audit(`${intent.id} cmd:${argv.join(" ")} -> denied (${verdict || "timeout"})`)
    await finish({ state: "error", errorText: verdict === "gone" ? "Cancelled" : "Denied" }, 1400)
  }
}

// Anything that opens a window goes to the agent's own workspace, so a task
// running in the background cannot drop a window into the middle of what the
// user is doing. `silent` places it without moving their focus.
//
// Only launches are moved: "close this window" and "volume 40" are about where
// the user already is, and relocating those would be actively wrong.
const agentWs = Number(await settingStr("agent.workspace", String(DEFAULT_WORKSPACE)))
for (let i = 0; i < plan.length; i++) {
  if (isLaunch(plan[i])) plan[i] = onWorkspace(plan[i], agentWs)
}

// Run the plan in order, stopping at the first failure.
//
// Continuing past a failed step is how a half-finished plan does something
// nobody asked for: step 2 assumes step 1 worked. The report names the step
// that broke, because "command failed" on a five-step plan is not a report.
let failedAt = -1
let detail = ""

for (let i = 0; i < plan.length; i++) {
  const step = plan[i]
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn(step, { stdout: "pipe", stderr: "pipe" })
  } catch (e: any) {
    failedAt = i
    detail = (e?.message || "failed to spawn command").split("\n")[0]
    break
  }
  const code = await proc.exited
  const out = (await new Response(proc.stdout).text()).trim()
  const err = (await new Response(proc.stderr).text()).trim()

  // Exit code alone is not enough: hyprctl prints a Lua parse error and still
  // exits 0, which would report a command as having succeeded while nothing
  // happened.
  const complained = /(^|\n)\s*error:/i.test(out) || /(^|\n)\s*error:/i.test(err)
  if (code !== 0 || complained) {
    failedAt = i
    detail = (err || out).split("\n")[0]?.replace(/^\s*error:\s*/i, "") ?? ""
    break
  }

  // A step that launches something needs a moment before the next one assumes
  // it is there. Only between steps, never after the last.
  if (i < plan.length - 1) await Bun.sleep(400)
}

const label = `${intent.id}${aiProposed ? `(plan:${aiProposed.provider})` : aiRouted ? `(route:${aiRouted.provider})` : ""}`

if (failedAt < 0) {
  audit(`${label} cmd:${plan.map(c => c.join(" ")).join(" && ")} -> ok`)
  await finish({ state: "done", mode: "command", transcript: phrase,
                 matched: intent.description || intent.id })
} else {
  const which = plan.length > 1 ? ` (step ${failedAt + 1} of ${plan.length})` : ""
  audit(`${label} cmd:${plan[failedAt].join(" ")} -> failed${which} ${detail}`)
  await finish({ state: "error", mode: "command",
                 errorText: (detail || "Command failed") + which }, 2800)
}
