// One delegated micro-task, in a process of its own.
//
// Not Claude Code's Task tool, and the reason is recorded in
// server/policy.default.jsonc: MCP gives the server no way to tell which
// subagent is calling. Every call from every built-in subagent arrives under
// one identity, so the server could not route five of them to five terminals,
// five scratch directories or five sets of policy rules. Separation would have
// been a promise nothing could keep.
//
// Spawning our own process per task gives each one a real identity, and the
// confinement stops being inherited: every subagent is launched by this code
// with this code's flags, so there is nothing to verify about what a child
// picked up from a parent.

import { mkdirSync, writeFileSync } from "node:fs"
import { DENIED_TOOLS } from "./runners/claude.ts"
import { beat, sinceBeat } from "./heartbeat.ts"
import { killTree } from "./killtree.ts"

const HOME = process.env.HOME!
const STATE = `${HOME}/.local/state/desktop-agent`
const RUNTIME = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? 1000}`

export interface SubagentResult {
  name: string
  ok: boolean
  /** One line, for the master to read at a glance. */
  summary: string
  /** Everything it reported, for the join. */
  report: string
}

function subPrompt(task: string, name: string, workspace: number): string {
  return `You are ${name}, one of several agents working in parallel on separate pieces of a larger job.

Your piece, and only this:

${task}

How to work here:
- Do YOUR piece. You cannot see the others and they cannot see you. Do not
  guess at their work, and do not do anything that was not asked of you here.
- You work headlessly: commands, files, text. You have no browser, no mouse, no
  keyboard, no window or workspace control, and you cannot delegate. All of
  those belong to the master, because there is only one screen and one keyboard
  focus and several of you. If your piece needs any of them, stop and say so in
  your report -- the master will do it. Do not look for a way around it.
- Keep your report SHORT. Long output is truncated before the master sees it,
  so put findings in the report and bulk material -- listings, logs, dumps --
  in a file in your own directory and name the path instead.
- Write nothing outside ${RUNTIME}/desktop-agent/${name}/ unless the task named
  a path. Your findings go back as TEXT, not as files: the master is joining
  several of these, and a file written by two agents at once is the one failure
  none of them can detect.
- Anything you open goes to workspace ${workspace}, automatically. Do not move
  windows or switch workspaces.

Reply with a short markdown report and nothing before it:

# <one line, past tense, what you found or did>

<the findings themselves -- quotes, numbers, paths. Be specific and complete:
this is all the master will see, and it cannot ask you a follow-up question.>

**Problems:** <anything you could not do, and what you needed. "none" if it all
worked.>`
}

/**
 * Run one micro-task to completion.
 *
 * Everything that could be shared is not: its own scratch directory, its own
 * tmux window, its own settings and MCP config, its own heartbeat file, and
 * therefore its own idle watchdog. Two subagents touch no common mutable path.
 */
export async function runSubagent(
  task: string,
  index: number,
  opts: { workspace: number; idleMs: number; maxMs: number },
): Promise<SubagentResult> {
  const name = `sub-${index + 1}`
  const dir = `${RUNTIME}/desktop-agent/${name}`
  const stateDir = `${STATE}/${name}`
  const beatFile = `${dir}/activity`
  const bun = Bun.which("bun")
  const claude = Bun.which("claude")
  if (!bun || !claude) {
    // Deliberately Claude-only, and deliberately a refusal rather than a
    // fallback to whichever runner is configured.
    //
    // Claude Code is the only runner that can be reduced to the desktop tools
    // (see runners/*.ts: `confined`). Gemini, Codex and OpenCode keep their own
    // shells, so delegating to one would spawn FOUR agents that can each step
    // around the policy engine, in parallel, unattended. Falling back to them
    // would turn a missing dependency into a silent security downgrade, which
    // is the worst shape a fallback can take.
    return {
      name, ok: false,
      summary: !bun
        ? "bun is not on PATH"
        : "delegation needs Claude Code — the other runners cannot be confined to the desktop tools, so subagents are not offered to them",
      report: "",
    }
  }

  const settings = `${stateDir}/agent-settings.json`
  const mcp = `${stateDir}/agent-mcp.json`
  const server = new URL("../server/server.ts", import.meta.url).pathname
  try {
    mkdirSync(dir, { recursive: true })
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(settings, JSON.stringify({ permissions: { deny: DENIED_TOOLS } }, null, 2))
    writeFileSync(mcp, JSON.stringify({
      mcpServers: {
        desktop: {
          type: "stdio", command: bun, args: ["run", server],
          env: {
            DESKTOP_AGENT_IDENTITY: name,
            // The server refuses the browser and delegation to anything whose
            // role is not master. A subagent cannot unset this: it never sees
            // its own spawn arguments and cannot rewrite the environment of a
            // process that already exists.
            DESKTOP_AGENT_ROLE: name,
            DESKTOP_AGENT_WORKSPACE: String(opts.workspace),
            DESKTOP_AGENT_TMUX_WINDOW: name,
            DESKTOP_AGENT_BEAT: beatFile,
          },
        },
      },
    }, null, 2))
  } catch (e) {
    return { name, ok: false, summary: `could not set up ${name}: ${e}`, report: "" }
  }

  beat(beatFile)
  const proc = Bun.spawn([
    "claude", "-p", subPrompt(task, name, opts.workspace),
    "--permission-mode", "bypassPermissions",
    "--strict-mcp-config", "--mcp-config", mcp,
    "--settings", settings,
  ], { stdout: "pipe", stderr: "pipe", stdin: "ignore", cwd: dir })

  const startedAt = Date.now()
  let killedBy: "idle" | "max" | null = null
  const watchdog = setInterval(() => {
    if (Date.now() - startedAt > opts.maxMs) killedBy = "max"
    else if (sinceBeat(beatFile) > opts.idleMs) killedBy = "idle"
    else return
    killTree(proc.pid)
  }, 5000)

  try {
    const out = (await new Response(proc.stdout).text()).trim()
    const code = await proc.exited
    if (killedBy) {
      const why = killedBy === "idle"
        ? `went quiet for ${Math.round(opts.idleMs / 1000)}s`
        : `hit the ${Math.round(opts.maxMs / 60000)} min limit`
      return { name, ok: false, summary: `${name} ${why}`, report: out }
    }
    if (code !== 0) {
      const err = (await new Response(proc.stderr).text()).trim()
      return {
        name, ok: false,
        summary: (err || out).split("\n").pop()?.slice(0, 160) || `${name} failed`,
        report: out,
      }
    }
    const lines = out.split("\n").map(l => l.trim())
    const heading = lines.find(l => l.startsWith("# "))
    return {
      name, ok: true,
      summary: (heading ? heading.slice(2) : lines.find(Boolean) ?? "done").slice(0, 200),
      report: out,
    }
  } finally {
    clearInterval(watchdog)
  }
}
