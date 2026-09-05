// Is the agent doing something, or has it stopped?
//
// A total-time ceiling cannot tell those apart. It killed a run that had made
// thirty successful tool calls and was still going, for the crime of being
// slow, while a genuinely wedged agent would have sat there just as long.
//
// The honest signal is "a tool call is IN FLIGHT", not "a tool call finished".
// Watching completions would count a three-minute download, a slow page load,
// or a compile as idle -- they are the quietest moments in a log and the
// busiest on the machine. So the server touches this file when a call starts,
// keeps touching it while the call runs, and touches it once more when the
// call ends. A long command holds the clock open for exactly as long as it
// takes.
//
// What this does NOT cover is the model thinking between calls: that is a
// network wait inside the agent CLI, invisible from out here and consuming no
// CPU worth measuring. The idle window is therefore sized to swallow a slow
// model turn rather than to catch one, which is the right way round -- killing
// a thinking agent is worse than waiting another minute for a stuck one.

import { mkdirSync, statSync, utimesSync, writeFileSync } from "node:fs"

const RUNTIME = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 1000}`

/**
 * Where THIS process reports its activity.
 *
 * One shared file was right while one agent ran at a time. With delegation it
 * would be actively harmful: five subagents beating into one path means the
 * busiest one keeps the other four alive, and a subagent wedged for an hour
 * looks healthy for as long as any sibling is working. Idle detection would
 * quietly stop detecting anything.
 *
 * Set per subagent at spawn, so a process beats where its environment says and
 * is judged on its own activity alone.
 */
export const BEAT_PATH = process.env.DESKTOP_AGENT_BEAT?.trim()
  || `${RUNTIME}/desktop-agent/activity`

/** Mark the agent as busy, now. Cheap enough to call on a timer. */
export function beat(file: string = BEAT_PATH): void {
  try {
    mkdirSync(file.slice(0, file.lastIndexOf("/")), { recursive: true })
    // utimes on an existing file avoids rewriting contents every few seconds;
    // the write is the fallback for the first beat.
    try { utimesSync(file, new Date(), new Date()) }
    catch { writeFileSync(file, "") }
  } catch {}
}

/**
 * Milliseconds since the last beat, or Infinity if there has never been one.
 *
 * Takes a path so the daemon can watch a subagent it spawned rather than its
 * own: the watcher and the watched are different processes with different
 * environments, and defaulting to "mine" would have each subagent's watchdog
 * reading the master's file.
 */
export function sinceBeat(file: string = BEAT_PATH): number {
  try { return Date.now() - statSync(file).mtimeMs } catch { return Infinity }
}

/** Forget any previous run's beats, so a new run starts from a clean slate. */
export function resetBeat(file: string = BEAT_PATH): void {
  beat(file)
}
