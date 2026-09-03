// Tier 4: hand the request to an agent that can see and touch the screen.
//
// Tiers 1-3 turn a sentence into commands. Some requests are not commands at
// all -- anything that needs to read what is on screen, click a particular
// thing, or react to what happens next. That is what the MCP half of this
// project already does, so this tier is a hand-off rather than new machinery.
//
// The safety comes from the policy engine, and the agent must be unable to
// step around it. That takes three flags, and the obvious one does not work:
//
//   --allowedTools mcp__desktop__*    DOES NOT RESTRICT ANYTHING under
//                                     bypassPermissions. It marks tools as
//                                     pre-approved; it is not an allowlist.
//                                     This was the original approach and it
//                                     left the agent holding Bash, Read, Write,
//                                     Edit, WebFetch, WebSearch, Agent, Cron*
//                                     and every other MCP server on the
//                                     machine. It could -- and did -- run
//                                     hyprctl through Bash, so the desktop
//                                     policy never saw the call. The policy was
//                                     set to "enabled": false at the time and
//                                     the task still ran.
//
//   --settings <deny list>            what actually removes the built-ins. Every
//                                     tool that can read a file, write one, run
//                                     a command, reach the network or spawn
//                                     another agent is denied by name, so the
//                                     only way to touch this machine is through
//                                     a desktop_* tool -- which is exactly the
//                                     surface the policy engine guards.
//
//   --strict-mcp-config --mcp-config  loads ONLY the desktop server. Without
//                                     it the agent inherits whatever else the
//                                     user has configured (figma, atlassian,
//                                     gmail...), none of which the policy knows
//                                     anything about.
//
//   --permission-mode bypassPermissions
//                                     Claude Code must not stop to ask, because
//                                     the person is talking, not watching a
//                                     terminal. Every gated action still raises
//                                     the desktop policy's own approval overlay,
//                                     which fails closed when the plugin that
//                                     serves it is not loaded.
//
// So "bypass" means "do not add a SECOND prompt on top of the one the policy
// already shows". It does NOT mean the agent is unconstrained -- the deny list
// and the strict MCP config are what make that true, and they are verified by
// asking the agent to enumerate its own tools: `desktop-agent agent-check`.

const HOME = process.env.HOME!
const STATE = `${HOME}/.local/state/desktop-agent`

// Denied by name. An allowlist would be safer in principle, but Claude Code
// has no "only these" switch that survives bypassPermissions, so this has to
// enumerate. Anything new that ships in a future release lands OUTSIDE this
// list, which is the failure direction to keep in mind: re-run the doctor
// check after upgrading Claude Code.
const DENIED_TOOLS = [
  "Bash", "Read", "Write", "Edit", "NotebookEdit", "Glob", "Grep",
  "WebFetch", "WebSearch", "Agent", "Task", "Skill", "Workflow",
  "CronCreate", "CronDelete", "CronList", "Monitor", "SendMessage",
  "RemoteTrigger", "PushNotification", "DesignSync", "SendUserFile",
  "EnterWorktree", "ExitWorktree", "ToolSearch", "TaskOutput", "TaskStop",
  "ScheduleWakeup", "ListAgents", "ReportFindings", "Artifact",
  "ListMcpResourcesTool", "ReadMcpResourceTool", "ReadMcpResourceDirTool",
  "EndConversation", "AskUserQuestion", "ExitPlanMode", "EnterPlanMode",
]

/**
 * Write the two config files the hand-off runs under, and return their paths.
 * Generated rather than shipped because the MCP command line depends on where
 * the plugin is installed and which bun is on PATH.
 */
function confine(): { settings: string; mcp: string } | null {
  const bun = Bun.which("bun")
  const server = new URL("../server/server.ts", import.meta.url).pathname
  if (!bun) return null
  const settings = `${STATE}/agent-settings.json`
  const mcp = `${STATE}/agent-mcp.json`
  try {
    require("node:fs").mkdirSync(STATE, { recursive: true })
    require("node:fs").writeFileSync(settings,
      JSON.stringify({ permissions: { deny: DENIED_TOOLS } }, null, 2))
    require("node:fs").writeFileSync(mcp, JSON.stringify({
      mcpServers: { desktop: { type: "stdio", command: bun, args: ["run", server], env: {} } },
    }, null, 2))
  } catch { return null }
  return { settings, mcp }
}

const SHELL_IPC = ["qs", "-p", "/usr/share/omarchy/shell", "ipc", "call"]

export interface AgentOutcome {
  ok: boolean
  summary: string
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

function taskPrompt(phrase: string, workspace: number): string {
  const placement = workspace > 0
    ? `\n- Anything you OPEN must go to workspace ${workspace}, so it does not land in the middle of what the person is doing. Launch with:\n    hyprctl dispatch 'hl.dsp.exec_cmd("[workspace ${workspace} silent] <command>")'\n  "silent" places the window there without moving their focus. Do not switch workspaces yourself.`
    : ""
  return `You are driving a Linux desktop on behalf of someone who spoke this request out loud:

"${phrase}"

You have desktop tools: screenshot, click, type, key, run, window and workspace
control. Use them to carry the request out.

How to work here:
- The person is speaking, not watching a terminal. They will see a short summary
  at the end and nothing in between, so do not ask questions -- make the
  sensible choice and say what you chose.
- Prefer a command over driving the GUI when one exists. A screenshot plus five
  clicks to do what one command does is slower and more fragile.
- Some actions will raise an approval prompt on their screen. That is expected.
  If one is denied, stop and report it rather than looking for another way
  around: a refusal is an answer.
- Stop when the request is done. Do not continue into related work nobody asked
  for.${placement}

Reply with ONE short sentence describing what you actually did, in the past
tense. No preamble, no markdown.`
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
  if (!Bun.which("claude")) {
    return { ok: false, summary: "No agent CLI installed" }
  }

  // No confinement, no hand-off. Running unconfined would hand a model Bash on
  // the user's machine with no prompt, which is not a degraded mode of this
  // feature -- it is a different and much worse feature.
  const conf = confine()
  if (!conf) return { ok: false, summary: "Could not confine the agent — refusing to run" }

  const proc = Bun.spawn([
    "claude", "-p", taskPrompt(phrase, workspace),
    "--permission-mode", "bypassPermissions",
    "--strict-mcp-config", "--mcp-config", conf.mcp,
    "--settings", conf.settings,
  ], { stdout: "pipe", stderr: "pipe", stdin: "ignore" })

  const killer = setTimeout(() => { try { proc.kill() } catch {} }, timeoutMs)
  const ticker = setInterval(() => opts.onProgress?.("working"), 4000)

  try {
    const out = (await new Response(proc.stdout).text()).trim()
    const code = await proc.exited
    if (code !== 0) {
      const err = (await new Response(proc.stderr).text()).trim()
      return { ok: false, summary: (err || out).split("\n").pop()?.slice(0, 160) || "Agent failed" }
    }
    // The agent was asked for one sentence; take the last non-empty line in
    // case it added anything before it.
    const summary = out.split("\n").map(l => l.trim()).filter(Boolean).pop() ?? ""
    return { ok: true, summary: summary.slice(0, 200) || "Done" }
  } finally {
    clearTimeout(killer)
    clearInterval(ticker)
  }
}
