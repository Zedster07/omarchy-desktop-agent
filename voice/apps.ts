// What is actually launchable on this machine.
//
// Read from .desktop entries rather than from a hand-written list or from
// `omarchy launch`'s routes. Two reasons, both learned the hard way:
//
//   * `omarchy launch` accepts a FIXED set of names (1password, signal,
//     spotify, browser, terminal...). It is not a general launcher. An intent
//     built on it produced `omarchy launch whatsapp` -- command not found --
//     because the pattern looked general and was not.
//   * Omarchy installs webapps AS desktop entries. WhatsApp, Gmail, Discord,
//     Google Maps and the rest are all there with an Exec of
//     `omarchy-launch-webapp <url>`. Reading the entries gets webapps for
//     free; anything else has to special-case them.
//
// Launching goes through `uwsm-app`, which takes a Desktop Entry ID and is what
// Omarchy's own launchers use, so an app started by voice lands in the same
// systemd slice as one started from the menu.

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs"

const HOME = process.env.HOME!
const DIRS = [
  `${HOME}/.local/share/applications`,
  `${HOME}/.nix-profile/share/applications`,
  "/usr/local/share/applications",
  "/usr/share/applications",
]

export interface App {
  /** Desktop Entry ID, e.g. "WhatsApp.desktop" — what uwsm-app wants. */
  id: string
  /** Display name, e.g. "WhatsApp" — what a person says. */
  name: string
  /** True when the entry only exists to handle a URL scheme, not to be opened. */
  handlerOnly: boolean
}

// The list is read from the filesystem, so every machine gets its own without
// anything being configured. The cache exists because scanning ~100 files on
// every utterance is wasteful -- but it is invalidated by directory mtime,
// which changes whenever an entry is added or removed.
//
// Caching it for the life of the process was a real bug: this runs as a
// long-lived service, so an app installed after the daemon started would not
// have been found until the next restart. Nobody would have connected those.
let cache: App[] | null = null
let cacheStamp = ""

function stamp(): string {
  return DIRS.map(d => {
    try { return `${d}:${statSync(d).mtimeMs}` } catch { return `${d}:0` }
  }).join("|")
}

function parse(path: string, file: string): App | null {
  let text: string
  try { text = readFileSync(path, "utf8") } catch { return null }

  // Only the [Desktop Entry] group; actions below it have their own Name= keys
  // and would otherwise overwrite the real one.
  const head = text.split(/^\[/m)[0] + text.slice(text.indexOf("[Desktop Entry]"))
  const body = head.split(/^\[(?!Desktop Entry)/m)[0]

  const get = (k: string) => {
    const m = body.match(new RegExp(`^${k}=(.*)$`, "m"))
    return m ? m[1].trim() : ""
  }

  if (get("NoDisplay").toLowerCase() === "true") return null
  if (get("Hidden").toLowerCase() === "true") return null
  if (get("Type") && get("Type") !== "Application") return null

  const name = get("Name")
  const exec = get("Exec")
  if (!name || !exec) return null

  // Entries whose Exec only makes sense with a URL argument (%u/%U and nothing
  // else meaningful) are protocol handlers, not things to open on request.
  const handlerOnly = /%[uU]/.test(exec) && /handler|url handler/i.test(name)

  return { id: file, name, handlerOnly }
}

export function listApps(): App[] {
  const now = stamp()
  if (cache && now === cacheStamp) return cache
  cacheStamp = now
  const seen = new Map<string, App>()
  for (const dir of DIRS) {
    if (!existsSync(dir)) continue
    let files: string[]
    try { files = readdirSync(dir) } catch { continue }
    for (const f of files) {
      if (!f.endsWith(".desktop")) continue
      // Earlier directories win: a user entry shadows the system one, which is
      // how XDG resolution works and how a customised launcher stays customised.
      if (seen.has(f)) continue
      const app = parse(`${dir}/${f}`, f)
      if (app && !app.handlerOnly) seen.set(f, app)
    }
  }
  cache = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
  return cache
}

// Generic roles, which are NOT desktop entries -- "browser" should open
// whatever the user set as their browser, not an app that happens to have
// "Browser" in its name. These four routes do exist in `omarchy launch`
// (unlike `omarchy launch whatsapp`, which is what started all this).
export const ROLES: Record<string, string[]> = {
  browser: ["omarchy", "launch", "browser"],
  terminal: ["omarchy", "launch", "terminal"],
  editor: ["omarchy", "launch", "editor"],
  files: ["omarchy", "launch", "nautilus"],
  filemanager: ["omarchy", "launch", "nautilus"],
}

// Words that carry no identity. Without this, "the browser" matches
// "Avahi Zeroconf Browser" on the strength of one shared noun.
const NOISE = new Set(["the", "a", "an", "my", "app", "application", "please", "open", "up"])

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
}

function words(s: string): string[] {
  return norm(s).split(" ").filter(w => w && !NOISE.has(w))
}

/**
 * Spoken name -> entry. Tolerant of case, punctuation and word splits.
 *
 * The de-spaced comparison matters more than it looks: speech recognition
 * splits compound product names unpredictably, so "whats app", "what's app"
 * and "whatsapp" all have to reach WhatsApp.desktop.
 */
export function findApp(spoken: string): App | null {
  const qw = words(spoken)
  if (qw.length === 0) return null
  const q = qw.join(" ")
  const qTight = qw.join("")

  let best: { app: App; score: number } | null = null
  for (const app of listApps()) {
    const nw = words(app.name)
    if (nw.length === 0) continue
    const n = nw.join(" ")
    const nTight = nw.join("")

    let score = 0
    if (n === q || nTight === qTight) score = 100
    else if (nTight.startsWith(qTight) || qTight.startsWith(nTight)) score = 82
    else if (nTight.includes(qTight) && qTight.length >= 4) score = 64
    else {
      const set = new Set(nw)
      const hit = qw.filter(w => set.has(w)).length
      // Every spoken word must land, otherwise "the browser" claims any app
      // with "browser" in its name. A partial overlap is not a request.
      if (hit > 0 && hit === qw.length) score = 40 + hit * 8
    }

    if (score > 0 && (!best || score > best.score ||
        (score === best.score && app.name.length < best.app.name.length))) {
      best = { app, score }
    }
  }
  return best && best.score >= 40 ? best.app : null
}

/** argv that launches this entry the way Omarchy's own launchers do. */
export function launchArgv(app: App): string[] {
  return ["uwsm-app", "--", app.id]
}

export type Target =
  | { kind: "role"; name: string; argv: string[] }
  | { kind: "app"; name: string; argv: string[] }

/**
 * Resolve what the user asked to open.
 *
 * Roles are checked BEFORE the entry list, and that ordering is the whole
 * point: "browser" legitimately substring-matches "Avahi Zeroconf Browser",
 * and no amount of scoring can tell those apart, because by name it really is
 * a browser. A generic word means the user's configured default, so it must
 * never reach the app search at all.
 */
export function resolveTarget(spoken: string): Target | null {
  const key = norm(spoken).replace(/\b(the|my|a|an|app|application)\b/g, "").replace(/\s+/g, "")
  if (ROLES[key]) return { kind: "role", name: key, argv: ROLES[key] }

  const app = findApp(spoken)
  return app ? { kind: "app", name: app.name, argv: launchArgv(app) } : null
}
