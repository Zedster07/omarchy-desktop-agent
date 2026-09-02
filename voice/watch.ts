#!/usr/bin/env bun
//
// Waits for voxtype to drop a command transcript, then turns it into an action.
//
// Started by desktop-agent-arm at key-down and detached, because the interesting
// part happens after key-up: voxtype records for as long as the key is held and
// then takes a few seconds to transcribe. Nothing here is on the dictation path.

import { resolve } from "./intents.ts"
import { loadIntents } from "./registry.ts"
import { route, plan } from "./plan.ts"
import { existsSync, unlinkSync } from "node:fs"

const RESULT = process.argv[2]
const TARGET = `${process.env.HOME}/.local/state/desktop-agent/command-target.json`
const PLUGIN_DIR = new URL("..", import.meta.url).pathname
const SHELL_IPC = ["qs", "-p", "/usr/share/omarchy/shell", "ipc", "call",
                   "io.github.zedster07.desktop-agent"]

// Long enough for a held key plus transcription on a slow machine, short
// enough that a forgotten recording does not leave a watcher running all day.
const TIMEOUT_MS = 180_000
const POLL_MS = 150

function hud(patch: Record<string, unknown>) {
  Bun.spawn([...SHELL_IPC, "voice", JSON.stringify(patch)],
            { stdout: "ignore", stderr: "ignore" })
}

async function finish(patch: Record<string, unknown>, holdMs = 2000): Promise<never> {
  hud(patch)
  await Bun.sleep(holdMs)
  hud({ state: "idle", transcript: "", errorText: "", matched: "" })
  await Bun.sleep(120)
  process.exit(0)
}

hud({ state: "listening", mode: "command", transcript: "", errorText: "" })

const deadline = Date.now() + TIMEOUT_MS
let phrase = ""

while (Date.now() < deadline) {
  if (existsSync(RESULT)) {
    // Give voxtype a moment to finish the write rather than reading a
    // half-flushed file.
    await Bun.sleep(60)
    try { phrase = (await Bun.file(RESULT).text()).trim() } catch { phrase = "" }
    try { unlinkSync(RESULT) } catch {}
    break
  }
  await Bun.sleep(POLL_MS)
}

if (phrase === "") {
  await finish({ state: "error", mode: "command", errorText: "Didn't catch that" }, 1600)
}

hud({ state: "transcribing", mode: "command", transcript: phrase })

async function setting(key: string, fallback: string): Promise<string> {
  try {
    const raw = await Bun.file(`${process.env.HOME}/.config/omarchy/shell.json`).json()
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

const intents = await loadIntents()

// ---- tier 1: the deterministic matcher. Instant, and the only tier that runs
// for a phrase someone actually declared.
let match = resolve(phrase, intents)
let aiProposal: { argv: string[]; explanation: string; severity: string; provider: string } | null = null
// Set when a MODEL chose this intent rather than the matcher. It is the
// difference between "you said a phrase someone registered" and "a 3B model
// thought you might have meant this", and it is why the second one is never
// executed without a person seeing it first.
let aiRouted: { provider: string } | null = null

const assist = await setting("aiAssist", "route")
const preference = await setting("aiProvider", "auto")

if (!match && assist !== "off") {
  // ---- tier 2: let a model pick from the SAME list. It cannot invent an
  // action here, only recognise one, so the blast radius is the registry.
  hud({ state: "transcribing", mode: "command", transcript: phrase,
        errorText: "" , matched: "thinking…" })
  const routed = await route(phrase, intents, preference)
  if (routed.result) {
    const target = intents.find(i => i.id === routed.result!.id)
    if (target) {
      const argv = target.run.map(part =>
        part.replace(/\{(\w+)\}/g, (whole, k) =>
          Object.prototype.hasOwnProperty.call(routed.result!.slots, k)
            ? routed.result!.slots[k] : whole))
      match = { intent: target, slots: routed.result.slots, score: 1, argv }
      aiRouted = { provider: routed.provider ?? "ai" }
    }
  }
}

if (!match && assist === "route+plan") {
  // ---- tier 3: a genuinely new command. This is the only place an action can
  // originate from a model, so it is always approved by a human and is checked
  // against the denylist before anyone is even asked.
  const planned = await plan(phrase, preference)
  if (planned.refusal) {
    await finish({ state: "error", mode: "command", transcript: phrase,
                   errorText: planned.refusal }, 3600)
  }
  if (planned.result) aiProposal = planned.result
}

if (!match && !aiProposal) {
  // Never guessed at, and never typed. An unrecognised command silently
  // becoming text in whatever window had focus is how "lock screen" ends up
  // in a commit message.
  await finish({ state: "error", mode: "command", transcript: phrase,
                 errorText: "No command matched" }, 2400)
}

// The window that was focused when the phrase was spoken, captured at
// key-down by desktop-agent-arm.
let target: any = null
try { target = await Bun.file(TARGET).json() } catch {}

const effectiveIntent = match ? match.intent : {
  id: "ai.proposed",
  phrases: [],
  run: aiProposal!.argv,
  severity: aiProposal!.severity === "destructive" ? "destructive" : "normal",
  description: aiProposal!.explanation || "Command proposed by AI",
  source: aiProposal!.provider,
} as any

Bun.spawn(["bun", `${PLUGIN_DIR}voice/execute.ts`, JSON.stringify({
  phrase,
  intent: effectiveIntent,
  argv: match ? match.argv : aiProposal!.argv,
  score: match ? match.score : 0,
  aiProposed: aiProposal ? { provider: aiProposal.provider, explanation: aiProposal.explanation } : null,
  aiRouted,
  target: target && target.address ? {
    address: String(target.address),
    cls: String(target.class ?? ""),
    title: String(target.title ?? ""),
  } : null,
})], { stdout: "ignore", stderr: "ignore", stdin: "ignore" })

// execute.ts owns the HUD from here.
process.exit(0)
