// Loading the intent registry.
//
// Three sources, later ones overriding earlier by intent id:
//
//   1. intents/builtin.json           shipped here
//   2. ~/.config/desktop-agent/intents.json   the user's own
//   3. voice-intents.json in any other installed Omarchy plugin
//
// (3) is the point of the whole exercise. There are two thousand plugins on
// the marketplace and none of them can be spoken to. A plugin that drops a
// voice-intents.json beside its manifest becomes voice-controllable without
// knowing anything about this one.
//
// Third-party intents are NOT trusted on sight: a plugin declaring an intent
// is a plugin asking to be given a voice, and each new source has to be
// approved once. Otherwise installing any plugin would silently extend what
// your microphone can do to your machine.

import type { Intent } from "./intents.ts"
import { readdirSync, existsSync } from "node:fs"

const HOME = process.env.HOME!
const PLUGIN_DIR = new URL("..", import.meta.url).pathname
const USER_INTENTS = `${HOME}/.config/desktop-agent/intents.json`
const PLUGINS_DIR = `${HOME}/.config/omarchy/plugins`
const APPROVED = `${HOME}/.config/desktop-agent/approved-intent-sources.json`

async function readIntents(path: string, source: string): Promise<Intent[]> {
  try {
    const raw = await Bun.file(path).json()
    const list: Intent[] = Array.isArray(raw) ? raw : (raw.intents ?? [])
    return list
      .filter(i => i && typeof i.id === "string" && Array.isArray(i.phrases) && Array.isArray(i.run))
      .map(i => ({ ...i, source }))
  } catch {
    return []
  }
}

export async function approvedSources(): Promise<Set<string>> {
  try {
    const raw = await Bun.file(APPROVED).json()
    return new Set<string>(Array.isArray(raw) ? raw : (raw.approved ?? []))
  } catch {
    return new Set()
  }
}

export async function approveSource(id: string) {
  const set = await approvedSources()
  set.add(id)
  await Bun.write(APPROVED, JSON.stringify({ approved: [...set] }, null, 2))
}

/** Plugins that declare intents but have not been approved yet. */
export async function pendingSources(): Promise<string[]> {
  const approved = await approvedSources()
  const out: string[] = []
  if (!existsSync(PLUGINS_DIR)) return out
  for (const entry of readdirSync(PLUGINS_DIR)) {
    if (entry.startsWith("io.github.zedster07.desktop-agent")) continue
    const f = `${PLUGINS_DIR}/${entry}/voice-intents.json`
    if (!existsSync(f)) continue
    if (!approved.has(entry)) out.push(entry)
  }
  return out
}

export async function loadIntents(includeThirdParty = true): Promise<Intent[]> {
  const byId = new Map<string, Intent>()
  const add = (list: Intent[]) => { for (const i of list) byId.set(i.id, i) }

  add(await readIntents(`${PLUGIN_DIR}intents/builtin.json`, "builtin"))
  add(await readIntents(USER_INTENTS, "user"))

  if (includeThirdParty && existsSync(PLUGINS_DIR)) {
    const approved = await approvedSources()
    for (const entry of readdirSync(PLUGINS_DIR)) {
      if (!approved.has(entry)) continue
      add(await readIntents(`${PLUGINS_DIR}/${entry}/voice-intents.json`, entry))
    }
  }

  return [...byId.values()]
}
