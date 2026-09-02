#!/usr/bin/env bun
//
// Voxtype's post-processing hook. Text arrives on stdin; whatever we print on
// stdout gets typed.
//
// The contract shapes the design: voxtype falls back to typing the ORIGINAL
// transcription on any error or timeout. So this must be fast and must not
// fail. Everything here is string work -- matching finishes in well under a
// millisecond -- and the moment an intent matches, execution is handed to a
// detached process so a human taking twenty seconds over an approval prompt
// cannot cause the phrase to be typed out instead.
//
//   dictation mode  -> print the text unchanged, voxtype types it
//   command mode    -> print nothing, dispatch the action out of band
//
// Mode is a flag file written by the keybinding just before recording starts,
// and consumed here. Not an argument, because voxtype owns the invocation.

import { resolve } from "./intents.ts"
import { loadIntents } from "./registry.ts"
import { existsSync, unlinkSync, statSync } from "node:fs"

const HOME = process.env.HOME!
const FLAG = `${HOME}/.local/state/desktop-agent/command-mode`
const PLUGIN_DIR = new URL("..", import.meta.url).pathname

function hud(patch: Record<string, unknown>) {
  Bun.spawn(
    ["qs", "-p", "/usr/share/omarchy/shell", "ipc", "call",
     "io.github.zedster07.desktop-agent", "voice", JSON.stringify(patch)],
    { stdout: "ignore", stderr: "ignore" },
  ).unref?.()
}

/** Command mode is armed, and recently — a stale flag must not hijack dictation. */
function commandModeArmed(): boolean {
  if (!existsSync(FLAG)) return false
  let fresh = false
  try {
    fresh = Date.now() - statSync(FLAG).mtimeMs < 120_000
  } catch {}
  try { unlinkSync(FLAG) } catch {}
  return fresh
}

const text = await Bun.stdin.text()
const phrase = text.trim()

if (!commandModeArmed()) {
  // Plain dictation. Pass through untouched -- this path must stay invisible.
  process.stdout.write(text)
  process.exit(0)
}

if (phrase === "") {
  hud({ state: "error", mode: "command", errorText: "Nothing was said" })
  process.exit(0)
}

const intents = await loadIntents()
const match = resolve(phrase, intents)

if (!match) {
  // Deliberately not a guess and deliberately not typed. An unrecognised
  // command that silently becomes text in whatever window had focus is how
  // you end up with "lock screen" in a commit message.
  hud({ state: "error", mode: "command", transcript: phrase, errorText: "No command matched" })
  process.exit(0)
}

hud({ state: "transcribing", mode: "command", transcript: phrase })

// Hand off and get out of voxtype's way.
Bun.spawn(["bun", `${PLUGIN_DIR}voice/execute.ts`, JSON.stringify({
  phrase,
  intent: match.intent,
  argv: match.argv,
  score: match.score,
})], { stdout: "ignore", stderr: "ignore", stdin: "ignore" }).unref?.()

// Nothing typed.
process.exit(0)
