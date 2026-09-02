// Turning a spoken phrase into a specific action.
//
// The rule that shapes everything here: the action space is a REGISTRY, not a
// prompt. A phrase is matched against a declared list of templates, and if
// nothing matches well enough the answer is "I didn't catch a command" -- never
// a guess, and never a model inventing a shell line. That is what makes voice
// control safe enough to wire to a policy engine, and it is also what makes it
// fast: matching is string work, so it finishes in under a millisecond and
// cannot trip voxtype's post-process timeout.

export interface Slot {
  type: "number" | "text" | "enum"
  min?: number
  max?: number
  options?: string[]
}

export interface Intent {
  id: string
  /** Templates like "workspace {n}". Slots are {name}. */
  phrases: string[]
  slots?: Record<string, Slot>
  /** argv, with {slot} placeholders substituted before execution. */
  run: string[]
  /** normal | destructive — destructive always asks, whatever the settings say. */
  severity?: "normal" | "destructive"
  /**
   * "window" means the action targets a specific window and its argv contains
   * {window}. Such an intent is only ever run against the window that was
   * focused when the phrase was SPOKEN, never against whatever is focused when
   * it eventually executes.
   */
  scope?: "global" | "window"
  description?: string
  /** Set by the loader for intents contributed by another plugin. */
  source?: string
}

export interface Match {
  intent: Intent
  slots: Record<string, string>
  score: number
  argv: string[]
}

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90, hundred: 100,
}
// Homophone mappings ("to" -> 2, "for" -> 4) are deliberately absent. They
// look helpful and are actively dangerous: "set volume to seventy" matched
// `volume {n}` with "to" as the number and silently set the volume to 2%.
// A preposition is a far more common word than the digit it sounds like, so
// the trade is badly one-sided -- and a wrong action is much worse than an
// unmatched one, which at least says so.

// Words people say that carry no meaning for matching. Dropping them lets
// "could you please open the browser" hit the same template as "open browser"
// without needing a template for every phrasing.
const FILLER = new Set([
  "please", "could", "would", "you", "can", "the", "a", "an", "my",
  "just", "now", "uh", "um", "hey", "ok", "okay", "and", "then",
])

export function normalize(s: string): string {
  return String(s ?? "")
    .toLowerCase()
    // Braces are deliberately NOT stripped: they carry the {slot} markers in
    // phrase templates, and this same function normalises both templates and
    // spoken text. Speech transcripts never contain braces, so keeping them
    // costs nothing on the input side.
    .replace(/[.,!?;:"'`´()\[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function tokens(s: string): string[] {
  return normalize(s).split(" ").filter(Boolean)
}

function meaningful(ts: string[]): string[] {
  const kept = ts.filter(t => !FILLER.has(t))
  // Never strip a phrase down to nothing; if it was all filler, keep it as-is.
  return kept.length > 0 ? kept : ts
}

function asNumber(tok: string): number | null {
  if (/^\d+$/.test(tok)) return parseInt(tok, 10)
  if (tok in NUMBER_WORDS) return NUMBER_WORDS[tok]
  return null
}

function slotValue(tok: string, spec: Slot | undefined): string | null {
  if (!spec || spec.type === "text") return tok
  if (spec.type === "number") {
    const n = asNumber(tok)
    if (n === null) return null
    if (spec.min !== undefined && n < spec.min) return null
    if (spec.max !== undefined && n > spec.max) return null
    return String(n)
  }
  if (spec.type === "enum") {
    const opts = spec.options ?? []
    const hit = opts.find(o => normalize(o) === tok)
    return hit ?? null
  }
  return null
}

/**
 * Match one template against the spoken tokens.
 * Returns null when the template does not apply at all.
 */
function matchTemplate(
  template: string,
  spoken: string[],
  slots: Record<string, Slot> | undefined,
): { slots: Record<string, string>; score: number } | null {
  const pattern = meaningful(tokens(template))
  const words = spoken

  const bound: Record<string, string> = {}
  let pi = 0
  let wi = 0
  let matched = 0

  while (pi < pattern.length && wi < words.length) {
    const p = pattern[pi]
    const slotName = p.startsWith("{") && p.endsWith("}") ? p.slice(1, -1) : null

    if (slotName) {
      // A text slot is greedy to the end; typed slots consume one token.
      const spec = slots?.[slotName]
      if (spec?.type === "text") {
        const rest = words.slice(wi).join(" ")
        if (rest === "") return null
        bound[slotName] = rest
        matched += words.length - wi
        wi = words.length
        pi++
        continue
      }
      const v = slotValue(words[wi], spec)
      if (v === null) return null
      bound[slotName] = v
      matched++
      wi++
      pi++
      continue
    }

    if (p === words[wi]) { matched++; pi++; wi++; continue }

    // Allow a stray extra spoken word between template words, which is what
    // "open up chrome" against "open {app}" looks like.
    wi++
    if (wi - matched > 3) return null
  }

  // Every non-slot template word has to have been consumed.
  if (pi < pattern.length) return null

  const leftover = words.length - wi
  // Score rewards covering the template and penalises words we ignored, so a
  // long phrase that happens to contain "lock" does not become "lock screen".
  const score = matched / (pattern.length + leftover + (words.length - matched) * 0.5)
  return { slots: bound, score: Math.max(0, Math.min(1, score)) }
}

export function resolve(phrase: string, intents: Intent[], threshold = 0.62): Match | null {
  const spoken = meaningful(tokens(phrase))
  if (spoken.length === 0) return null

  let best: Match | null = null

  for (const intent of intents) {
    for (const template of intent.phrases) {
      const m = matchTemplate(template, spoken, intent.slots)
      if (!m) continue
      if (best && m.score <= best.score) continue
      // Substitute ONLY placeholders that this match actually bound. Anything
      // else is left standing for a later stage to fill -- {window} is filled
      // by execute.ts from the window captured at key-down, and is not a
      // spoken slot.
      //
      // Blanking unknown placeholders instead (`m.slots[k] ?? ""`) is what
      // turned `address:{window}` into `address:` and dispatched a window
      // close with an empty selector. It also defeated the guard downstream,
      // which was watching for a SURVIVING placeholder that had already been
      // silently erased.
      const argv = intent.run.map(part =>
        part.replace(/\{(\w+)\}/g, (whole, k) =>
          Object.prototype.hasOwnProperty.call(m.slots, k) ? m.slots[k] : whole))
      best = { intent, slots: m.slots, score: m.score, argv }
    }
  }

  return best && best.score >= threshold ? best : null
}
