#!/usr/bin/env bun
//
// Follows one command-mode utterance from key-down to action.
//
// Driven by `voxtype status --follow`, which streams idle -> recording ->
// transcribing -> idle as JSON. The first version instead polled for the
// result file with a 180s deadline and nothing else, which meant:
//
//   * the HUD said "listening" for the entire transcription, and
//   * a clip too short to transcribe wrote no file at all, so the watcher sat
//     there for three minutes with the core still spinning on screen.
//
// Following the daemon's own state removes both: the moment it goes back to
// idle the utterance is over, and if no transcript landed by then there never
// will be one.

import { resolve } from "./intents.ts"
import { loadIntents } from "./registry.ts"
import { route, plan } from "./plan.ts"
import { existsSync, unlinkSync } from "node:fs"

const RESULT = process.argv[2]
const TARGET = `${process.env.HOME}/.local/state/desktop-agent/command-target.json`
const PLUGIN_DIR = new URL("..", import.meta.url).pathname
const SHELL_IPC = ["qs", "-p", "/usr/share/omarchy/shell", "ipc", "call",
                   "io.github.zedster07.desktop-agent"]

// A backstop only. The status stream is the real clock; this catches the case
// where voxtype dies mid-utterance and stops streaming altogether.
const HARD_TIMEOUT_MS = 120_000

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

// ---------------------------------------------------------------- levels
//
// voxtype owns the microphone for transcription and does not publish levels,
// so the waveform needs its own source. PipeWire allows a second reader, and
// this one exists purely to compute an RMS per chunk: nothing is buffered,
// nothing is written to disk, and it is killed the instant recording stops.
//
// Without it the radial waveform draws 72 bars at their floor value, which
// does not read as "quiet" -- it reads as broken.
let meter: ReturnType<typeof Bun.spawn> | null = null

function startMeter() {
  if (meter) return
  try {
    meter = Bun.spawn(
      ["pw-record", "--raw", "--rate", "16000", "--channels", "1", "--format", "s16", "-"],
      { stdout: "pipe", stderr: "ignore", stdin: "ignore" })
  } catch { meter = null; return }

  const levels: number[] = []
  let sincePush = 0
  ;(async () => {
    const stream = meter?.stdout
    if (!stream || typeof stream === "number") return
    for await (const raw of stream as ReadableStream<Uint8Array>) {
      if (!meter) break
      const buf = Buffer.from(raw)
      const n = Math.floor(buf.length / 2)
      if (n === 0) continue
      let sum = 0
      for (let i = 0; i < n; i++) {
        const s = buf.readInt16LE(i * 2) / 32768
        sum += s * s
      }
      // Curved so conversational speech uses most of the range; a linear RMS
      // bar barely leaves the floor at normal talking volume.
      const lvl = Math.min(1, Math.pow(Math.sqrt(sum / n), 0.65) * 2.2)
      levels.push(lvl)
      if (levels.length > 160) levels.splice(0, levels.length - 160)
      if (++sincePush >= 2) {
        sincePush = 0
        hud({ levels: levels.slice(-72) })
      }
    }
  })()
}

function stopMeter() {
  if (!meter) return
  try { meter.kill() } catch {}
  meter = null
}

// ------------------------------------------------------------------ main

hud({ state: "listening", mode: "command", transcript: "", errorText: "", levels: [] })

const follow = Bun.spawn(["voxtype", "status", "--follow", "--format", "json"],
                         { stdout: "pipe", stderr: "ignore", stdin: "ignore" })

const hardStop = setTimeout(() => {
  stopMeter()
  try { follow.kill() } catch {}
}, HARD_TIMEOUT_MS)

let sawActivity = false
let phase = "idle"

const decoder = new TextDecoder()
let carry = ""

outer:
for await (const chunk of follow.stdout as ReadableStream<Uint8Array>) {
  carry += decoder.decode(chunk, { stream: true })
  const lines = carry.split("\n")
  carry = lines.pop() ?? ""

  for (const line of lines) {
    const t = line.trim()
    if (t === "") continue
    let state = ""
    try { state = String(JSON.parse(t).alt ?? "") } catch { continue }
    if (state === phase) continue
    phase = state

    if (state === "recording") {
      sawActivity = true
      startMeter()
      hud({ state: "listening", mode: "command" })
    } else if (state === "transcribing") {
      sawActivity = true
      stopMeter()
      hud({ state: "transcribing", mode: "command", levels: [] })
    } else if (state === "idle" && sawActivity) {
      // The utterance is over. Anything voxtype was going to write is written.
      stopMeter()
      break outer
    }
  }
}

clearTimeout(hardStop)
stopMeter()
try { follow.kill() } catch {}

// Small grace: the file write and the status flip are not ordered.
for (let i = 0; i < 12 && !existsSync(RESULT); i++) await Bun.sleep(100)

let phrase = ""
if (existsSync(RESULT)) {
  try { phrase = (await Bun.file(RESULT).text()).trim() } catch { phrase = "" }
  try { unlinkSync(RESULT) } catch {}
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

// tier 1: the deterministic matcher
let match = resolve(phrase, intents)
let aiProposal: { argv: string[]; explanation: string; severity: string; provider: string } | null = null
let aiRouted: { provider: string } | null = null

const assist = await setting("aiAssist", "route")
const preference = await setting("aiProvider", "auto")

if (!match && assist !== "off") {
  // tier 2: a model picks from the SAME list; it can recognise a wording but
  // cannot invent an action.
  hud({ state: "transcribing", mode: "command", transcript: phrase, matched: "thinking…" })
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
  // tier 3: a genuinely new command, always approved by a person and checked
  // against the denylist before anyone is asked.
  const planned = await plan(phrase, preference)
  if (planned.refusal) {
    await finish({ state: "error", mode: "command", transcript: phrase,
                   errorText: planned.refusal }, 3600)
  }
  if (planned.result) aiProposal = planned.result
}

if (!match && !aiProposal) {
  await finish({ state: "error", mode: "command", transcript: phrase,
                 errorText: "No command matched" }, 2400)
}

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

process.exit(0)
