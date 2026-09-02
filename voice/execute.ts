#!/usr/bin/env bun
//
// Runs a matched intent, after asking if the rules say to ask.
//
// Detached from the voxtype hook on purpose: this can block for as long as a
// human takes to answer an approval prompt, and the hook cannot.

import type { Intent } from "./intents.ts"
import { appendFileSync, mkdirSync } from "node:fs"

const HOME = process.env.HOME!
const AUDIT = `${HOME}/.local/share/desktop-agent/desktop.log`
const SHELL_IPC = ["qs", "-p", "/usr/share/omarchy/shell", "ipc", "call",
                   "io.github.zedster07.desktop-agent"]

interface Target { address: string; cls: string; title: string }
interface Payload {
  phrase: string; intent: Intent; argv: string[]; score: number
  target: Target | null
}

const payload: Payload = JSON.parse(process.argv[2] ?? "{}")
const { intent, phrase, target } = payload
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

async function setting(key: string, fallback: string): Promise<string> {
  try {
    const raw = await Bun.file(`${HOME}/.config/omarchy/shell.json`).json()
    let found: any
    const walk = (v: any) => {
      if (Array.isArray(v)) v.forEach(walk)
      else if (v && typeof v === "object") {
        if (typeof v.id === "string" && v.id.includes("desktop-agent") && v.settings) found = v.settings
        Object.values(v).forEach(walk)
      }
    }
    walk(raw)
    const v = found?.[key]
    return v === undefined || v === null ? fallback : String(v)
  } catch { return fallback }
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
}

// Matches only a real placeholder -- {window}, {n}, {app} -- and deliberately
// NOT Lua table syntax like `{ window = "address:0x..." }`, which is what a
// naive check for "{" flagged, refusing every window-scoped command.
const LEFTOVER = /\{[A-Za-z_][A-Za-z0-9_]*\}/
if (argv.some(a => LEFTOVER.test(a))) {
  audit(`${intent.id} -> refused, unsubstituted placeholder in ${argv.join(" ")}`)
  await finish({ state: "error", mode: "command", errorText: "Command was incomplete" }, 2600)
}

const destructive = intent.severity === "destructive"
const confirm = await setting("commandConfirm", "destructive-only")
const needsApproval =
  confirm === "always" || (confirm === "destructive-only" && destructive)

if (needsApproval) {
  const id = await ipc("request", JSON.stringify({
    tool: `voice: ${intent.description || intent.id}`,
    capability: "voice-command",
    target: needsWindow && target
      ? `${target.cls}${target.title ? " — " + target.title : ""}`
      : argv.join(" "),
    principal: "voice",
    severity: destructive ? "destructive" : "normal",
    reasons: [
      `heard "${phrase}"`,
      `matched intent ${intent.id}${intent.source && intent.source !== "builtin" ? ` from ${intent.source}` : ""}`,
      ...(needsWindow && target ? [`this acts on the window you were looking at, not the focused one`] : []),
      ...(needsWindow ? [`command: ${argv.join(" ")}`] : []),
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

const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" })
const code = await proc.exited
const stdout = (await new Response(proc.stdout).text()).trim()
const stderr = (await new Response(proc.stderr).text()).trim()

// Exit code alone is not enough. hyprctl in particular prints a Lua parse
// error and still exits 0 in some paths, which would report a command as
// having succeeded while nothing happened -- the exact way `hyprctl dispatch
// workspace 10` failed silently. Treat an "error:" in either stream as a
// failure regardless of what the process claimed.
const complained = /(^|\n)\s*error:/i.test(stdout) || /(^|\n)\s*error:/i.test(stderr)
const failed = code !== 0 || complained

if (!failed) {
  audit(`${intent.id} cmd:${argv.join(" ")} -> ok`)
  await finish({ state: "done", mode: "command", transcript: phrase,
                 matched: intent.description || intent.id })
} else {
  const detail = (stderr || stdout).split("\n")[0]?.replace(/^\s*error:\s*/i, "") ?? ""
  audit(`${intent.id} cmd:${argv.join(" ")} -> failed (${code}${complained ? ", reported an error" : ""}) ${detail}`)
  await finish({ state: "error", mode: "command",
                 errorText: detail || `Command failed (${code})` }, 2800)
}
