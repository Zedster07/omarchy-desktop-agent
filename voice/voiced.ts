#!/usr/bin/env bun
//
// The voice daemon. Owns one utterance from key-down to action.
//
//   desktop-agent-listen dictate|command   (Hyprland bind,  key down)
//     -> pw-record streams s16le mono 16k in
//     -> each chunk updates the HUD's radial waveform
//   desktop-agent-listen stop              (Hyprland bindr, key up)
//     -> the buffer is wrapped in a WAV header and POSTed to stt/server.py
//     -> the result goes through voice/filter.ts before anything happens
//     -> dictate: typed with wtype;  command: matched, gated, executed
//
// Push-to-talk, not VAD-triggered listening: a held key makes the utterance
// boundary KNOWN rather than guessed, which removes the phantom-transcript
// class of bug entirely instead of filtering it afterwards.
//
// Audio never touches the disk on our side and never leaves the machine unless
// the user has explicitly chosen a remote engine.

import { filterTranscript } from "./filter.ts"
import { resolve } from "./intents.ts"
import { loadIntents } from "./registry.ts"
import { resolveRequest } from "./plan.ts"
import { handOff, overlayReady } from "./agent.ts"
import { setting, settingStr } from "./settings.ts"
import { resolveTarget, listApps } from "./apps.ts"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { unlink } from "node:fs/promises"

const HOME = process.env.HOME!
const RUNTIME = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 1000}`
const SOCK = `${RUNTIME}/desktop-agent-voice.sock`
const STATE = `${HOME}/.local/state/desktop-agent`
const LOG = `${HOME}/.local/share/desktop-agent/voice.log`
const STT = `http://127.0.0.1:${process.env.DA_STT_PORT || 8791}`
const PLUGIN_DIR = new URL("..", import.meta.url).pathname
const SHELL_IPC = ["qs", "-p", "/usr/share/omarchy/shell", "ipc", "call",
                   "io.github.zedster07.desktop-agent"]

const RATE = 16000
type Mode = "dictate" | "command"

function log(msg: string) {
  try {
    mkdirSync(`${HOME}/.local/share/desktop-agent`, { recursive: true })
    Bun.write(LOG, `${new Date().toISOString()} ${msg}\n`).catch(() => {})
  } catch {}
  console.error(msg)
}

function audit(line: string) {
  try {
    mkdirSync(`${HOME}/.local/share/desktop-agent`, { recursive: true })
    require("node:fs").appendFileSync(
      `${HOME}/.local/share/desktop-agent/desktop.log`,
      `${new Date().toISOString()} voice ${line}\n`)
  } catch {}
}

function hud(patch: Record<string, unknown>) {
  Bun.spawn([...SHELL_IPC, "voice", JSON.stringify(patch)],
            { stdout: "ignore", stderr: "ignore" })
}

async function clearHud(patch: Record<string, unknown>, holdMs = 1800) {
  hud(patch)
  await Bun.sleep(holdMs)
  hud({ state: "idle", transcript: "", errorText: "", matched: "" })
}

// ------------------------------------------------------------------- audio

function wavHeader(bytes: number): Buffer {
  const h = Buffer.alloc(44)
  h.write("RIFF", 0); h.writeUInt32LE(36 + bytes, 4); h.write("WAVE", 8)
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22); h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28)
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34)
  h.write("data", 36); h.writeUInt32LE(bytes, 40)
  return h
}

/** Curved RMS: a linear meter barely leaves the floor at conversational volume. */
function chunkLevel(buf: Buffer): number {
  const n = Math.floor(buf.length / 2)
  if (n === 0) return 0
  let sum = 0
  for (let i = 0; i < n; i++) {
    const s = buf.readInt16LE(i * 2) / 32768
    sum += s * s
  }
  return Math.min(1, Math.pow(Math.sqrt(sum / n), 0.65) * 2.2)
}

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
    this.chunks = []; this.levels = []; this.peak = 0
    this.startedAt = Date.now()
    // --raw is not optional: without it pw-record emits a PipeWire container
    // rather than PCM and every sample read below parses metadata.
    this.proc = Bun.spawn(
      ["pw-record", "--raw", "--rate", String(RATE), "--channels", "1",
       "--format", "s16", "-"],
      { stdout: "pipe", stderr: "ignore", stdin: "ignore" })
    hud({ state: "listening", mode, transcript: "", errorText: "", levels: [], elapsed: 0 })
    this.pump()
  }

  private async pump() {
    const stream = this.proc?.stdout
    if (!stream || typeof stream === "number") return
    let since = 0
    for await (const raw of stream as ReadableStream<Uint8Array>) {
      if (!this.proc) break
      const buf = Buffer.from(raw)
      this.chunks.push(buf)
      const lvl = chunkLevel(buf)
      if (lvl > this.peak) this.peak = lvl
      this.levels.push(lvl)
      if (this.levels.length > 160) this.levels.splice(0, this.levels.length - 160)
      if (++since >= 2) {
        since = 0
        hud({ levels: this.levels.slice(-72), elapsed: this.seconds })
      }
    }
  }

  stop(): { wav: Buffer; seconds: number; peak: number } | null {
    if (!this.proc) return null
    try { this.proc.kill() } catch {}
    this.proc = null
    const pcm = Buffer.concat(this.chunks)
    this.chunks = []
    if (pcm.length === 0) return null
    return { wav: Buffer.concat([wavHeader(pcm.length), pcm]),
             seconds: pcm.length / (RATE * 2), peak: this.peak }
  }

  cancel() {
    if (!this.proc) return
    try { this.proc.kill() } catch {}
    this.proc = null
    this.chunks = []
  }
}

// -------------------------------------------------------------- transcribe

const BIAS = ("Commands: open, close, launch, workspace, volume, mute, unmute, "
  + "lock screen, fullscreen, screenshot, theme, brightness, play, YouTube, "
  + "Chrome, Firefox, terminal, browser, editor, files.")

/** The remote key lives with the STT config, never in settings.json. */
function remoteKey(): string {
  try {
    const t = readFileSync(`${HOME}/.config/desktop-agent/stt.key`, "utf8").trim()
    return t
  } catch { return "" }
}

/**
 * Remote transcription, done here rather than through the Python service.
 *
 * The remote path needs an HTTP POST and nothing else -- no model, no
 * faster-whisper, no virtualenv. Routing it through stt/server.py would have
 * meant a 430 MB install and an 835 MB model download to make a network call,
 * which is exactly the kind of dependency nobody notices they are paying for.
 * Cloud users install the plugin and bun. That is all.
 */
async function transcribeRemote(wav: Buffer, prompt: string): Promise<string> {
  const key = remoteKey()
  if (!key) throw new Error("no API key set")
  const endpoint = await settingStr(
    "voice.remoteEndpoint", "https://api.groq.com/openai/v1/audio/transcriptions")
  const model = await settingStr("voice.remoteModel", "whisper-large-v3-turbo")

  const form = new FormData()
  form.append("file", new Blob([wav], { type: "audio/wav" }), "speech.wav")
  form.append("model", model)
  form.append("response_format", "verbose_json")
  form.append("temperature", "0")
  form.append("language", "en")
  if (prompt) form.append("prompt", prompt)

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
    signal: AbortSignal.timeout(40000),
  })
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 120)}`)
  const j: any = await res.json()

  // Same confidence thresholds as the local path: drop segments the model
  // itself flags as probably-not-speech rather than trusting the joined text.
  const segs: any[] = Array.isArray(j.segments) ? j.segments : []
  if (segs.length) {
    return segs
      .filter(s => (s.no_speech_prob ?? 0) <= 0.6 && (s.avg_logprob ?? 0) >= -1.0)
      .map(s => s.text ?? "")
      .join("")
      .trim()
  }
  return String(j.text ?? "").trim()
}

async function transcribeLocal(wav: Buffer, prompt: string): Promise<string> {
  const res = await fetch(`${STT}/transcribe`, {
    method: "POST",
    body: wav,
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Mode": "local",
      "X-Prompt": prompt,
    },
    signal: AbortSignal.timeout(40000),
  })
  if (!res.ok) throw new Error(`stt ${res.status}`)
  const j: any = await res.json()
  if (j.error) throw new Error(String(j.error))
  return String(j.text ?? "").trim()
}

async function transcribe(wav: Buffer, mode: Mode): Promise<string> {
  const sttMode = await settingStr("voice.sttMode", "local")
  const bias = (await setting<boolean>("voice.biasPrompt", true)) && mode === "command"
    ? BIAS : ""
  return sttMode === "remote"
    ? transcribeRemote(wav, bias)
    : transcribeLocal(wav, bias)
}

// ------------------------------------------------------------------ inject

async function inject(text: string) {
  if (Bun.which("wtype")) {
    // -- stops a leading dash in the transcript being read as a flag.
    const p = Bun.spawn(["wtype", "--", text], { stderr: "pipe" })
    if ((await p.exited) === 0) return
    log("wtype failed, falling back to clipboard paste")
  }
  const prev = await new Response(
    Bun.spawn(["wl-paste", "--no-newline"], { stdout: "pipe", stderr: "ignore" }).stdout,
  ).text().catch(() => "")
  const copy = Bun.spawn(["wl-copy"], { stdin: "pipe" })
  copy.stdin.write(text); copy.stdin.end(); await copy.exited
  if (Bun.which("wtype")) await Bun.spawn(["wtype", "-M", "ctrl", "-k", "v", "-m", "ctrl"]).exited
  else if (Bun.which("ydotool")) await Bun.spawn(["ydotool", "key", "29:1", "47:1", "47:0", "29:0"]).exited
  if (prev) setTimeout(() => {
    const r = Bun.spawn(["wl-copy"], { stdin: "pipe" }); r.stdin.write(prev); r.stdin.end()
  }, 250)
}

// -------------------------------------------------------------------- main

const recorder = new Recorder()

async function handleStop() {
  if (!recorder.active) return
  const mode = recorder.mode
  const captured = recorder.stop()
  if (!captured) { await clearHud({ state: "error", errorText: "Nothing was recorded" }, 1500); return }

  hud({ state: "transcribing", mode, levels: [] })

  let text = ""
  try {
    text = await transcribe(captured.wav, mode)
  } catch (e) {
    log(`transcription failed: ${e}`)
    await clearHud({ state: "error", mode, errorText: "Speech service is not responding" }, 2600)
    return
  }

  const verdict = filterTranscript(text, {
    audioSeconds: captured.seconds, peakLevel: captured.peak,
  })
  if (!verdict.ok) {
    log(`rejected (${verdict.rule}): ${JSON.stringify(text)}`)
    await clearHud({ state: "error", mode, errorText: verdict.reason }, 1800)
    return
  }

  if (mode === "dictate") {
    await inject(verdict.text)
    await clearHud({ state: "done", mode, transcript: verdict.text }, 1100)
    return
  }

  await runCommand(verdict.text)
}

async function runCommand(phrase: string) {
  hud({ state: "transcribing", mode: "command", transcript: phrase })
  const intents = await loadIntents()
  const threshold = Number(await settingStr("command.threshold", "62")) / 100
  let match = resolve(phrase, intents, isFinite(threshold) ? threshold : 0.62)
  let aiRouted: { provider: string } | null = null
  let aiProposal: { steps: string[][]; explanation: string; severity: string; provider: string } | null = null

  // __launch__ is a placeholder the registry cannot fill: which argv opens an
  // app depends on what is installed, so it is resolved here.
  //
  // If it does not resolve, the intent does not APPLY -- "open the discussion
  // about workspaces" is not a launch request just because it starts with
  // "open". Clearing the match lets the later tiers see the phrase instead of
  // answering it with "no app called that", which was both wrong and a dead
  // end.
  if (match && match.argv[0] === "__launch__") {
    const spoken = match.argv.slice(1).join(" ")
    const t = resolveTarget(spoken)
    if (t) {
      match = { ...match, argv: t.argv,
                intent: { ...match.intent, description: `Open ${t.name}` } }
    } else {
      match = null
    }
  }

  const assist = await settingStr("ai.assist", "route+plan")
  const preference = await settingStr("ai.provider", "auto")

  // ---- tier 2/3, in one call.
  //
  // The deterministic matcher is a fast path, not the product: it answers a
  // registered phrase in under a millisecond and otherwise gets out of the
  // way. Everything it does not recognise goes to the model, which either
  // picks a registered command or writes new ones -- one round trip rather
  // than asking two overlapping questions in sequence.
  if (!match && assist !== "off") {
    hud({ state: "transcribing", mode: "command", transcript: phrase, matched: "thinking…" })
    const r = await resolveRequest(phrase, intents, preference)
    if (r.refusal) {
      await clearHud({ state: "error", mode: "command", transcript: phrase,
                       errorText: r.refusal }, 3600)
      return
    }
    if (r.result?.kind === "intent") {
      const target = intents.find(i => i.id === r.result!.id)
      if (target) {
        const slots = r.result.slots ?? {}
        let argv = target.run.map(part => part.replace(/\{(\w+)\}/g, (whole, k) =>
          Object.prototype.hasOwnProperty.call(slots, k) ? slots[k] : whole))
        // A routed launch still has to resolve to something installed.
        if (argv[0] === "__launch__") {
          const t = resolveTarget(argv.slice(1).join(" "))
          if (t) argv = t.argv
          else argv = []
        }
        if (argv.length) {
          match = { intent: target, slots, score: 1, argv }
          aiRouted = { provider: r.provider ?? "ai" }
        }
      }
    } else if (r.result?.kind === "steps") {
      aiProposal = {
        steps: r.result.steps!, explanation: r.result.explanation,
        severity: r.result.severity, provider: r.result.provider,
      }
    }
  }

  if (!match && !aiProposal) {
    await clearHud({ state: "error", mode: "command", transcript: phrase, errorText: "No command matched" }, 2400)
    return
  }

  let target: any = null
  try { target = await Bun.file(`${STATE}/command-target.json`).json() } catch {}

  const intent = match ? match.intent : {
    id: "ai.proposed", phrases: [], run: aiProposal.steps[0],
    severity: aiProposal.severity === "destructive" ? "destructive" : "normal",
    description: aiProposal.explanation || "Command proposed by AI",
    source: aiProposal.provider,
  }

  Bun.spawn(["bun", `${PLUGIN_DIR}voice/execute.ts`, JSON.stringify({
    phrase, intent,
    argv: match ? match.argv : aiProposal.steps[0],
    steps: match ? null : aiProposal.steps,
    score: match ? match.score : 0,
    aiProposed: aiProposal ? { provider: aiProposal.provider, explanation: aiProposal.explanation } : null,
    aiRouted,
    target: target && target.address
      ? { address: String(target.address), cls: String(target.class ?? ""), title: String(target.title ?? "") }
      : null,
  })], { stdout: "ignore", stderr: "ignore", stdin: "ignore" })
}

if (!existsSync(STATE)) mkdirSync(STATE, { recursive: true, mode: 0o700 })
if (existsSync(SOCK)) await unlink(SOCK).catch(() => {})

Bun.listen({
  unix: SOCK,
  socket: {
    async data(socket, raw) {
      const [verb, arg] = raw.toString().trim().split(/\s+/, 2)
      switch (verb) {
        case "start":
          if (!recorder.active) {
            // Capture the focused window at key-DOWN, while the user is still
            // looking at whatever they are about to talk about.
            Bun.spawn(["bash", "-c",
              `hyprctl activewindow -j > '${STATE}/command-target.json' 2>/dev/null || true`],
              { stdout: "ignore", stderr: "ignore" })
            recorder.start(arg === "command" ? "command" : "dictate")
          }
          break
        case "stop": await handleStop(); break
        case "text": {
          // A typed request takes exactly the path a spoken one does after
          // transcription -- same tiers, same policy, same approval. The only
          // difference is that it skipped the microphone.
          const phrase = raw.toString().trim().slice(5).trim()
          if (phrase) {
            log(`text: ${phrase}`)
            await runCommand(phrase)
          }
          break
        }
        case "cancel":
          // Cancel means "stop whatever you are doing": abandon a recording
          // AND close the text prompt. Two surfaces, one gesture -- the user
          // should not have to know which one is listening.
          log("cancel")
          recorder.cancel()
          Bun.spawn([...SHELL_IPC, "promptClose"], { stdout: "ignore", stderr: "ignore" })
          await clearHud({ state: "idle" }, 0)
          break
        case "ping": socket.write("ok"); break
      }
      socket.end()
    },
  },
})

log(`voice daemon listening on ${SOCK} (stt ${STT})`)
