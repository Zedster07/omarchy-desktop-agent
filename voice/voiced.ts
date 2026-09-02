#!/usr/bin/env bun
//
// The voice daemon.
//
// Holds one job open so the expensive parts stay warm: the speech model is
// loaded once by whisper-server and reused, because reloading it per utterance
// costs about a second and push-to-talk dictation lives or dies on latency.
//
// Lifecycle of one utterance:
//
//   desktop-voice start dictate      (Hyprland bind,  key down)
//     -> pw-record streams raw s16le mono 16k into this process
//     -> each chunk updates a running peak and pushes a level to the HUD
//   desktop-voice stop               (Hyprland bindr, key up)
//     -> the buffer is wrapped in a WAV header and POSTed to whisper-server
//     -> the result goes through voice/filter.ts before anything is typed
//     -> survivors are injected with wtype, or pasted if wtype is unavailable
//
// Audio never touches the disk and never leaves the machine.

import { filterTranscript } from "./filter.ts"
import { existsSync, mkdirSync } from "node:fs"
import { unlink } from "node:fs/promises"

const HOME = process.env.HOME!
const RUNTIME = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 1000}`
const SOCK = `${RUNTIME}/desktop-agent-voice.sock`
const STATE = `${HOME}/.local/state/desktop-agent`
const LOG = `${HOME}/.local/share/desktop-agent/voice.log`

const RATE = 16000
const WHISPER_PORT = Number(process.env.DESKTOP_AGENT_WHISPER_PORT || 8178)

type Mode = "dictate" | "command"
type HudState = "idle" | "listening" | "transcribing" | "preview" | "done" | "error"

interface Config {
  engine: string
  model: string
  language: string
  injection: "wtype" | "clipboard-paste"
  preview: boolean
  vocabulary: string
  commandsEnabled: boolean
}

function log(msg: string) {
  const line = `${new Date().toISOString()} ${msg}\n`
  try {
    mkdirSync(`${HOME}/.local/share/desktop-agent`, { recursive: true })
    Bun.write(LOG, line, { createPath: true }).catch(() => {})
  } catch {}
  console.error(line.trimEnd())
}

// ---------------------------------------------------------------- settings
//
// Read from the same shell.json entry the settings form writes, so the panel
// and this daemon can never disagree about what the user picked.
async function loadConfig(): Promise<Config> {
  const defaults: Config = {
    engine: "whisper.cpp",
    model: "small",
    language: "en",
    injection: "wtype",
    preview: false,
    vocabulary: "",
    commandsEnabled: true,
  }
  try {
    const raw = await Bun.file(`${HOME}/.config/omarchy/shell.json`).json()
    const widgets: any[] = []
    const walk = (v: any) => {
      if (Array.isArray(v)) v.forEach(walk)
      else if (v && typeof v === "object") {
        if (typeof v.id === "string" && v.id.includes("desktop-agent")) widgets.push(v)
        Object.values(v).forEach(walk)
      }
    }
    walk(raw)
    const s = widgets.find(w => w.settings)?.settings ?? {}
    return {
      engine: s.voiceEngine ?? defaults.engine,
      model: s.voiceModel ?? defaults.model,
      language: s.voiceLanguage ?? defaults.language,
      injection: s.voiceInjection ?? defaults.injection,
      preview: s.voicePreview ?? defaults.preview,
      vocabulary: s.voiceVocabulary ?? defaults.vocabulary,
      commandsEnabled: s.commandsEnabled ?? defaults.commandsEnabled,
    }
  } catch {
    return defaults
  }
}

// -------------------------------------------------------------------- HUD
//
// Fire-and-forget. A HUD that fails to update must never hold up the audio
// path, so nothing here is awaited on the critical route.
function hud(patch: Record<string, unknown>) {
  Bun.spawn(
    ["qs", "-p", "/usr/share/omarchy/shell", "ipc", "call",
     "io.github.zedster07.desktop-agent", "voice", JSON.stringify(patch)],
    { stdout: "ignore", stderr: "ignore" },
  )
}

// ------------------------------------------------------------------ audio

function wavHeader(bytes: number): Buffer {
  const h = Buffer.alloc(44)
  h.write("RIFF", 0)
  h.writeUInt32LE(36 + bytes, 4)
  h.write("WAVE", 8)
  h.write("fmt ", 12)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)          // PCM
  h.writeUInt16LE(1, 22)          // mono
  h.writeUInt32LE(RATE, 24)
  h.writeUInt32LE(RATE * 2, 28)   // byte rate
  h.writeUInt16LE(2, 32)          // block align
  h.writeUInt16LE(16, 34)         // bits
  h.write("data", 36)
  h.writeUInt32LE(bytes, 40)
  return h
}

/** Peak-normalised RMS of one s16le chunk, 0..1. */
function chunkLevel(buf: Buffer): number {
  const n = Math.floor(buf.length / 2)
  if (n === 0) return 0
  let sum = 0
  for (let i = 0; i < n; i++) {
    const s = buf.readInt16LE(i * 2) / 32768
    sum += s * s
  }
  // sqrt of mean square, then a gentle curve so quiet speech still moves the
  // meter -- a linear RMS bar barely leaves the floor at conversational volume.
  return Math.min(1, Math.pow(Math.sqrt(sum / n), 0.65) * 2.2)
}

// --------------------------------------------------------------- recorder

class Recorder {
  private proc: ReturnType<typeof Bun.spawn> | null = null
  private chunks: Buffer[] = []
  private levels: number[] = []
  peak = 0
  startedAt = 0
  mode: Mode = "dictate"

  get active() { return this.proc !== null }
  get seconds() { return this.startedAt ? (Date.now() - this.startedAt) / 1000 : 0 }

  start(mode: Mode) {
    if (this.proc) return
    this.mode = mode
    this.chunks = []
    this.levels = []
    this.peak = 0
    this.startedAt = Date.now()

    this.proc = Bun.spawn(
      // --raw is not optional. Without it pw-record wraps the stream in a
      // PipeWire container ("dns." magic, length-prefixed) rather than
      // emitting PCM, and every sample read below would be parsing metadata.
      ["pw-record", "--raw", "--rate", String(RATE), "--channels", "1", "--format", "s16", "-"],
      { stdout: "pipe", stderr: "ignore" },
    )

    hud({ state: "listening", mode, transcript: "", errorText: "", levels: [], elapsed: 0 })
    this.pump()
  }

  private async pump() {
    const stream = this.proc?.stdout
    if (!stream || typeof stream === "number") return
    let sincePush = 0
    for await (const raw of stream as ReadableStream<Uint8Array>) {
      if (!this.proc) break
      const buf = Buffer.from(raw)
      this.chunks.push(buf)
      const lvl = chunkLevel(buf)
      if (lvl > this.peak) this.peak = lvl
      this.levels.push(lvl)
      if (this.levels.length > 120) this.levels = this.levels.slice(-120)
      // ~15/s is plenty for a 28-bar meter and keeps the IPC chatter sane.
      if (++sincePush >= 2) {
        sincePush = 0
        hud({ levels: this.levels.slice(-28), elapsed: this.seconds })
      }
    }
  }

  /** Stops recording and returns the captured audio as a WAV buffer. */
  stop(): { wav: Buffer; seconds: number; peak: number } | null {
    if (!this.proc) return null
    try { this.proc.kill() } catch {}
    this.proc = null
    const pcm = Buffer.concat(this.chunks)
    const seconds = pcm.length / (RATE * 2)
    this.chunks = []
    if (pcm.length === 0) return null
    return { wav: Buffer.concat([wavHeader(pcm.length), pcm]), seconds, peak: this.peak }
  }
}

// ------------------------------------------------------------ transcribe

async function transcribe(wav: Buffer, cfg: Config): Promise<{ text: string; noSpeechProb?: number }> {
  const form = new FormData()
  form.append("file", new Blob([wav], { type: "audio/wav" }), "speech.wav")
  form.append("response_format", "json")
  form.append("language", cfg.language)
  form.append("temperature", "0")
  // Steer the decoder away from captioned-video completions, and prime it with
  // the user's own jargon. This is the cheapest accuracy win available.
  const prompt = ["Voice dictation transcript.", cfg.vocabulary].filter(Boolean).join(" ")
  form.append("prompt", prompt)

  const res = await fetch(`http://127.0.0.1:${WHISPER_PORT}/inference`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(30000),
  })
  if (!res.ok) throw new Error(`engine returned ${res.status}`)
  const json: any = await res.json()
  return {
    text: String(json.text ?? "").trim(),
    noSpeechProb: typeof json.no_speech_prob === "number" ? json.no_speech_prob : undefined,
  }
}

// ---------------------------------------------------------------- inject

async function inject(text: string, cfg: Config) {
  if (cfg.injection === "wtype" && Bun.which("wtype")) {
    // --  stops wtype parsing a leading dash in the transcript as a flag.
    const p = Bun.spawn(["wtype", "--", text], { stderr: "pipe" })
    if ((await p.exited) === 0) return
    log("wtype failed, falling back to clipboard paste")
  }

  // Fallback: stash the clipboard, paste, put it back. Restoring matters --
  // silently eating someone's clipboard to type a sentence is a bad trade.
  const prev = await new Response(
    Bun.spawn(["wl-paste", "--no-newline"], { stdout: "pipe", stderr: "ignore" }).stdout,
  ).text().catch(() => "")

  const copy = Bun.spawn(["wl-copy"], { stdin: "pipe" })
  copy.stdin.write(text)
  copy.stdin.end()
  await copy.exited

  if (Bun.which("wtype")) {
    await Bun.spawn(["wtype", "-M", "ctrl", "-k", "v", "-m", "ctrl"]).exited
  } else if (Bun.which("ydotool")) {
    await Bun.spawn(["ydotool", "key", "29:1", "47:1", "47:0", "29:0"]).exited
  }

  if (prev) {
    setTimeout(() => {
      const restore = Bun.spawn(["wl-copy"], { stdin: "pipe" })
      restore.stdin.write(prev)
      restore.stdin.end()
    }, 250)
  }
}

// ------------------------------------------------------------------ main

const recorder = new Recorder()
let pendingText = ""

async function handleStop() {
  if (!recorder.active) return
  const captured = recorder.stop()
  const cfg = await loadConfig()

  if (!captured) {
    hud({ state: "error", errorText: "Nothing was recorded" })
    setTimeout(() => hud({ state: "idle" }), 1600)
    return
  }

  hud({ state: "transcribing", levels: [] })

  let text: string
  let noSpeechProb: number | undefined
  try {
    const out = await transcribe(captured.wav, cfg)
    text = out.text
    noSpeechProb = out.noSpeechProb
  } catch (e) {
    log(`transcription failed: ${e}`)
    hud({ state: "error", errorText: "Speech engine is not responding" })
    setTimeout(() => hud({ state: "idle" }), 2600)
    return
  }

  const verdict = filterTranscript(text, {
    audioSeconds: captured.seconds,
    peakLevel: captured.peak,
    noSpeechProb,
  })

  if (!verdict.ok) {
    log(`rejected (${verdict.rule}): ${JSON.stringify(text)}`)
    hud({ state: "error", errorText: verdict.reason })
    setTimeout(() => hud({ state: "idle" }), 1800)
    return
  }

  if (recorder.mode === "command" && cfg.commandsEnabled) {
    // Command mode resolves through the intent registry and the policy engine,
    // which live in the service half. Never typed, never run from here.
    hud({ state: "transcribing", transcript: verdict.text })
    Bun.spawn(
      ["qs", "-p", "/usr/share/omarchy/shell", "ipc", "call",
       "io.github.zedster07.desktop-agent", "command", verdict.text],
      { stdout: "ignore", stderr: "ignore" },
    )
    return
  }

  if (cfg.preview) {
    pendingText = verdict.text
    hud({ state: "preview", transcript: verdict.text })
    return
  }

  await inject(verdict.text, cfg)
  hud({ state: "done", transcript: verdict.text })
  setTimeout(() => hud({ state: "idle" }), 1200)
}

async function handleCommit() {
  if (!pendingText) return
  const cfg = await loadConfig()
  const text = pendingText
  pendingText = ""
  await inject(text, cfg)
  hud({ state: "done", transcript: text })
  setTimeout(() => hud({ state: "idle" }), 1200)
}

if (!existsSync(STATE)) mkdirSync(STATE, { recursive: true, mode: 0o700 })
if (existsSync(SOCK)) await unlink(SOCK).catch(() => {})

Bun.listen({
  unix: SOCK,
  socket: {
    async data(socket, raw) {
      const cmd = raw.toString().trim()
      const [verb, arg] = cmd.split(/\s+/, 2)
      switch (verb) {
        case "start":
          if (!recorder.active) recorder.start(arg === "command" ? "command" : "dictate")
          break
        case "stop":
          await handleStop()
          break
        case "commit":
          await handleCommit()
          break
        case "discard":
          pendingText = ""
          hud({ state: "idle" })
          break
        case "ping":
          socket.write("ok")
          break
      }
      socket.end()
    },
  },
})

log(`voice daemon listening on ${SOCK}`)
