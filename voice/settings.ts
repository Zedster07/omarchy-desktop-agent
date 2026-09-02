// Reading the plugin's settings.
//
// One source of truth: ~/.config/desktop-agent/settings.json, written by the
// panel through bin/desktop-agent-config. The scripts used to dig these out of
// shell.json, which meant the panel and the shell's own settings form were two
// writers over one file -- and the panel would have silently done nothing.

const HOME = process.env.HOME!
const PATH = `${HOME}/.config/desktop-agent/settings.json`

const DEFAULTS: Record<string, unknown> = {
  "voice.sttMode": "local",
  "voice.biasPrompt": true,
  "ai.assist": "route+plan",
  "ai.provider": "auto",
  "ai.localModel": "llama3.2:3b",
  "command.enabled": true,
  "command.confirm": "destructive-only",
  "command.thirdParty": true,
  "command.threshold": 62,
  "policy.recap": true,
}

let cache: any = null

async function load(): Promise<any> {
  if (cache) return cache
  try { cache = await Bun.file(PATH).json() } catch { cache = {} }
  return cache
}

/** Dotted lookup with a default, e.g. setting("ai.assist", "route"). */
export async function setting<T = string>(path: string, fallback?: T): Promise<T> {
  const cfg = await load()
  let node: any = cfg
  for (const part of path.split(".")) {
    if (!node || typeof node !== "object") { node = undefined; break }
    node = node[part]
  }
  if (node === undefined || node === null) {
    return (fallback !== undefined ? fallback : DEFAULTS[path]) as T
  }
  return node as T
}

export async function settingStr(path: string, fallback: string): Promise<string> {
  return String(await setting(path, fallback))
}
