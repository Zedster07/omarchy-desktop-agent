#!/usr/bin/env bun
//
// Waits for voxtype to drop a command transcript, then turns it into an action.
//
// Started by desktop-agent-arm at key-down and detached, because the interesting
// part happens after key-up: voxtype records for as long as the key is held and
// then takes a few seconds to transcribe. Nothing here is on the dictation path.

import { resolve } from "./intents.ts"
import { loadIntents } from "./registry.ts"
import { existsSync, unlinkSync } from "node:fs"

const RESULT = process.argv[2]
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

const intents = await loadIntents()
const match = resolve(phrase, intents)

if (!match) {
  // Never guessed at, and never typed. An unrecognised command silently
  // becoming text in whatever window had focus is how "lock screen" ends up
  // in a commit message.
  await finish({ state: "error", mode: "command", transcript: phrase,
                 errorText: "No command matched" }, 2400)
}

Bun.spawn(["bun", `${PLUGIN_DIR}voice/execute.ts`, JSON.stringify({
  phrase,
  intent: match!.intent,
  argv: match!.argv,
  score: match!.score,
})], { stdout: "ignore", stderr: "ignore", stdin: "ignore" })

// execute.ts owns the HUD from here.
process.exit(0)
