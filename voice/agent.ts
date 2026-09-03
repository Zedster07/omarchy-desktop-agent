// Tier 4: hand the request to an agent that can see and touch the screen.
//
// Tiers 1-3 turn a sentence into commands. Some requests are not commands at
// all -- anything that needs to read what is on screen, click a particular
// thing, or react to what happens next. That is what the MCP half of this
// project already does, so this tier is a hand-off rather than new machinery.
//
// The safety comes from the policy engine, and the agent must be unable to
// step around it. We support multiple agent CLIs (Claude Code, Gemini CLI,
// Codex, OpenCode) through the runner abstraction in ./runners.
//
// Every gated action still raises the desktop policy's own approval overlay,
// which fails closed when the plugin that serves it is not loaded.

import { settingStr } from "./settings.ts"
import { getRunner, listAvailableRunners, unconfinedRunners, taskPrompt } from "./runners/index.ts"

export { taskPrompt }

const HOME = process.env.HOME!
const STATE = `${HOME}/.local/state/desktop-agent`

const SHELL_IPC = ["qs", "-p", "/usr/share/omarchy/shell", "ipc", "call"]

export interface AgentOutcome {
  ok: boolean
  /** First line of the report: what the HUD shows. */
  summary: string
  /** The whole markdown report, for the file the person can open. */
  report: string
}

/** The policy overlay must be live, or every gated action fails closed. */
export async function overlayReady(target: string): Promise<boolean> {
  try {
    const p = Bun.spawn([...SHELL_IPC, target, "status"],
                        { stdout: "pipe", stderr: "ignore" })
    const out = await new Response(p.stdout).text()
    await p.exited
    return out.includes("enabled")
  } catch { return false }
}

// The one running hand-off, so it can be stopped.
//
// Only one runs at a time by construction -- runCommand awaits it -- so a
// single slot is honest rather than a limitation. Without this there was no
// stop at all: "cancel" cleared the HUD and closed the prompt while the agent
// kept driving the desktop, which is worse than having no cancel, because it
// looked stopped.
let running: { kill: (sig?: number) => void } | null = null
let stopped = false

/** Stop the hand-off in flight. Returns whether there was one. */
export function stopAgent(): boolean {
  if (!running) return false
  stopped = true
  try { running.kill() } catch {}
  // SIGKILL shortly after, in case it is wedged in a tool call and ignores the
  // polite one. Nothing here is worth waiting on.
  const p = running
  setTimeout(() => { try { p.kill(9) } catch {} }, 1500)
  return true
}

/**
 * Run the hand-off. Resolves when the agent finishes or the deadline passes.
 * `onProgress` is called with coarse status only -- the HUD is a readout, not
 * a transcript.
 */
export async function handOff(
  phrase: string,
  opts: { timeoutMs?: number; workspace?: number; onProgress?: (s: string) => void } = {},
): Promise<AgentOutcome> {
  const timeoutMs = opts.timeoutMs ?? 300_000
  const workspace = opts.workspace ?? 10

  // agent.runner, NOT ai.provider.
  //
  // They are different jobs that happened to share a setting: ai.provider
  // picks the model that turns a sentence into commands (one small call,
  // cheap, no tools), while this picks the CLI that drives your desktop for
  // minutes with tools in its hands. Sharing one key meant choosing a planner
  // silently changed who was allowed to act -- and choosing an agent silently
  // changed who did the planning.
  const preferred = (await settingStr("agent.runner", "auto")).trim().toLowerCase()
  const runner = getRunner(preferred)

  if (!runner) {
    const loose = unconfinedRunners().map(r => r.name).join(", ")
    const available = listAvailableRunners().map(r => r.name).join(", ")
    return {
      ok: false,
      summary: loose
        // Naming the ones that exist but were not chosen, because otherwise
        // "no agent CLI" is a lie to someone who has three installed.
        ? `No confinable agent CLI. ${loose} installed but cannot be limited to the desktop tools — set ai.provider and agent.allowUnconfined to use one anyway`
        : available
          ? `No compatible agent CLI for "${preferred}" (installed: ${available})`
          : "No agent CLI installed (install Claude, Gemini, Codex, or OpenCode)",
      report: "",
    }
  }

  // An unconfined runner has to be asked for by name AND opted into. Naming it
  // is choosing a tool; this is consenting to what it gives up. The whole
  // premise of running an agent unattended is that the policy engine sees
  // every action, and it does not see anything an agent does through its own
  // shell.
  if (!runner.confined) {
    const allow = (await settingStr("agent.allowUnconfined", "false")) === "true"
    if (!allow) {
      return {
        ok: false,
        summary: `${runner.name} cannot be confined to the desktop tools — ${runner.unconfinedReason ?? "it keeps its own shell"}. Set agent.allowUnconfined to run it anyway.`,
        report: "",
      }
    }
  }

  const bun = Bun.which("bun")
  if (!bun) {
    return { ok: false, summary: "bun is not installed on PATH", report: "" }
  }

  const serverScript = new URL("../server/server.ts", import.meta.url).pathname

  const prepared = await runner.prepare({
    phrase,
    workspace,
    serverScript,
    bunPath: bun,
    stateDir: STATE,
  })

  if (!prepared) {
    // Not "could not confine" any more: prepare() failing means its config
    // files could not be written, which is a different fault and was
    // misleading for the three runners that never confine anything.
    return { ok: false, summary: `Could not set up ${runner.name} — refusing to run`, report: "" }
  }

  // Run from a directory of its own.
  //
  // The daemon's cwd is the home directory, so `claude -p` treated
  // ~/.claude/settings.local.json as PROJECT settings and loaded it. Two rules
  // in there -- saved by an "always allow" click in some other session, with a
  // regex containing a * that the permission parser rejects -- made every
  // hand-off fail with an error about a grep on a file nobody had mentioned.
  //
  // It is also a hole in the confinement. Project settings can ADD permissions,
  // and inheriting whatever happens to sit at the daemon's cwd is not a
  // decision anyone made. An empty directory has no .claude/ to inherit.
  const runDir = `${STATE}/run`
  try { require("node:fs").mkdirSync(runDir, { recursive: true }) } catch {}

  const proc = Bun.spawn(prepared.argv, {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    cwd: prepared.cwd ?? runDir,
    env: { ...process.env, ...prepared.env },
  })

  running = proc
  stopped = false
  const killer = setTimeout(() => { try { proc.kill() } catch {} }, timeoutMs)
  const ticker = setInterval(() => opts.onProgress?.("working"), 4000)

  try {
    const out = (await new Response(proc.stdout).text()).trim()
    const code = await proc.exited
    if (stopped) {
      return { ok: false, summary: "Stopped", report: out }
    }
    if (code !== 0) {
      const err = (await new Response(proc.stderr).text()).trim()
      return {
        ok: false,
        summary: (err || out).split("\n").pop()?.slice(0, 160) || `${runner.name} failed`,
        report: out,
      }
    }
    // The report's first heading is the summary. Falling back to the first
    // non-empty line covers a model that skipped the "#".
    const lines = out.split("\n").map(l => l.trim())
    const heading = lines.find(l => l.startsWith("# "))
    const summary = (heading ? heading.slice(2) : lines.find(Boolean) ?? "").trim()
    return { ok: true, summary: summary.slice(0, 200) || "Done", report: out }
  } finally {
    running = null
    clearTimeout(killer)
    clearInterval(ticker)
    if (prepared.cleanup) {
      try { await prepared.cleanup() } catch {}
    }
  }
}
