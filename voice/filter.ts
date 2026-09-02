// Everything that stands between a speech model's output and your keyboard.
//
// Whisper's decoder is an autoregressive language model. That is why it gives
// you punctuation and casing for free, and it is the same reason it can keep
// generating text when the audio stops supporting it. You cannot remove that
// -- it is the architecture -- so the job here is to fence it: refuse the
// output shapes that are known to be generation rather than transcription, and
// make the survivors cheap to undo.
//
// Every rule below is here because it catches a failure that actually happens,
// and each one is independently switchable so a user chasing a false rejection
// can find out which rule ate their sentence.

import { gzipSync } from "node:zlib"

export type Verdict =
  | { ok: true; text: string }
  | { ok: false; reason: string; rule: string }

export interface FilterOptions {
  /** Seconds of audio that produced this text. Used for the rate sanity check. */
  audioSeconds: number
  /** Mean per-token log probability, when the engine reports one. */
  avgLogprob?: number
  /** The engine's own "this probably wasn't speech" estimate, 0..1. */
  noSpeechProb?: number
  /** Peak RMS seen while recording, 0..1. Below the floor means nothing was said. */
  peakLevel?: number
}

// Artifacts of training on captioned web video. These are not transcription
// errors -- the model is completing a pattern it saw thousands of times when
// the audio gave it nothing to go on. The list is finite and well known, which
// is exactly what makes matching it safe: we only reject when one of these is
// the ENTIRE output, so a person who genuinely says "thanks for watching" mid
// sentence keeps their words.
const ARTIFACTS = [
  "thank you", "thanks for watching", "thank you for watching",
  "thanks for watching!", "thank you for watching!",
  "subscribe", "please subscribe", "like and subscribe",
  "subscribe to my channel", "don't forget to subscribe",
  "see you next time", "see you in the next video",
  "bye", "bye bye", "goodbye",
  "you", "the", "so", "okay", "ok",
  "music", "applause", "laughter", "silence", "blank_audio",
]

const PUNCT = /[.,!?¿¡;:"'`´—–\-_*()\[\]{}…♪♫\s]/g

function normalize(s: string): string {
  return s.toLowerCase().replace(PUNCT, " ").replace(/\s+/g, " ").trim()
}

/**
 * Repetition detector. A decoder stuck in a loop emits text that compresses
 * far better than language does, because it is literally the same bytes over
 * and over. Natural prose sits around 1.2-2.0; a loop runs well past 3.
 * Short strings compress badly regardless, so this only applies above a length
 * where the ratio means anything.
 */
export function compressionRatio(text: string): number {
  const raw = Buffer.from(text, "utf8")
  if (raw.length < 48) return 1
  return raw.length / gzipSync(raw).length
}

/**
 * Catches the other loop shape, where one phrase repeats but gzip does not get
 * a long enough run to notice -- "open the door open the door open the door".
 */
function maxPhraseRepeat(text: string): number {
  const words = normalize(text).split(" ").filter(Boolean)
  if (words.length < 6) return 1
  let worst = 1
  for (let n = 1; n <= 4; n++) {
    for (let i = 0; i + n * 2 <= words.length; i++) {
      const phrase = words.slice(i, i + n).join(" ")
      let reps = 1
      let j = i + n
      while (j + n <= words.length && words.slice(j, j + n).join(" ") === phrase) {
        reps++
        j += n
      }
      if (reps > worst) worst = reps
    }
  }
  return worst
}

export function filterTranscript(raw: string, opts: FilterOptions): Verdict {
  const text = String(raw ?? "").trim()

  if (text === "") {
    return { ok: false, reason: "nothing was transcribed", rule: "empty" }
  }

  // The microphone never got loud enough for anything to have been said. This
  // is the single most effective rule in the file: it rejects the silence case
  // before the model's output is even consulted.
  if (opts.peakLevel !== undefined && opts.peakLevel < 0.012) {
    return { ok: false, reason: "no speech detected", rule: "vad-floor" }
  }

  if (opts.noSpeechProb !== undefined && opts.noSpeechProb > 0.6) {
    return { ok: false, reason: "no speech detected", rule: "no-speech-prob" }
  }

  // Low mean token probability means the decoder was guessing. -1.0 is the
  // threshold the Whisper project itself uses for discarding a segment.
  if (opts.avgLogprob !== undefined && opts.avgLogprob < -1.0) {
    return { ok: false, reason: "transcription confidence too low", rule: "logprob" }
  }

  const norm = normalize(text)

  // Bracketed non-speech tags first: [MUSIC], (applause), ♪...♪. These
  // normalize down to bare words that also appear in ARTIFACTS, so checking
  // them in this order is what makes the reported reason the accurate one.
  if (/^[\[\(♪].*[\]\)♪]$/.test(text.trim())) {
    return { ok: false, reason: "discarded a non-speech tag", rule: "non-speech-tag" }
  }

  // Only when the artifact is the whole utterance.
  if (ARTIFACTS.includes(norm)) {
    return { ok: false, reason: "discarded a known filler phrase", rule: "artifact" }
  }

  if (compressionRatio(text) > 2.4) {
    return { ok: false, reason: "the model got stuck repeating itself", rule: "compression" }
  }

  if (maxPhraseRepeat(text) >= 4) {
    return { ok: false, reason: "the model got stuck repeating itself", rule: "phrase-repeat" }
  }

  // Nobody speaks 25 words a second. A big result from a short clip means the
  // decoder ran away from the audio.
  if (opts.audioSeconds > 0) {
    const words = norm.split(" ").filter(Boolean).length
    if (words / opts.audioSeconds > 12) {
      return { ok: false, reason: "more text than the audio could contain", rule: "rate" }
    }
  }

  return { ok: true, text }
}
