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

interface Payload { phrase: string; intent: Intent; argv: string[]; score: number }

const payload: Payload = JSON.parse(process.argv[2] ?? "{}")
const { intent, argv, phrase } = payload

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

const destructive = intent.severity === "destructive"
const confirm = await setting("commandConfirm", "destructive-only")
const needsApproval =
  confirm === "always" || (confirm === "destructive-only" && destructive)

if (needsApproval) {
  const id = await ipc("request", JSON.stringify({
    tool: `voice: ${intent.description || intent.id}`,
    capability: "voice-command",
    target: argv.join(" "),
    principal: "voice",
    severity: destructive ? "destructive" : "normal",
    reasons: [
      `heard "${phrase}"`,
      `matched intent ${intent.id}${intent.source && intent.source !== "builtin" ? ` from ${intent.source}` : ""}`,
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

if (code === 0) {
  audit(`${intent.id} cmd:${argv.join(" ")} -> ok`)
  await finish({ state: "done", mode: "command", transcript: phrase,
                 matched: intent.description || intent.id })
} else {
  const err = (await new Response(proc.stderr).text()).trim().split("\n")[0] ?? ""
  audit(`${intent.id} cmd:${argv.join(" ")} -> failed (${code}) ${err}`)
  await finish({ state: "error", mode: "command",
                 errorText: err || `Command failed (${code})` }, 2600)
}
