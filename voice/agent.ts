// Tier 4: hand the request to an agent that can see and touch the screen.
//
// Tiers 1-3 turn a sentence into commands. Some requests are not commands at
// all -- anything that needs to read what is on screen, click a particular
// thing, or react to what happens next. That is what the MCP half of this
// project already does, so this tier is a hand-off rather than new machinery.
//
// The safety comes from the policy engine, not from the agent runner:
//
//   --allowedTools mcp__desktop__*    the agent gets the desktop tools and
//                                     NOTHING else -- no file edits, no shell,
//                                     no network tools of its own.
//   --permission-mode bypassPermissions
//                                     Claude Code must not stop to ask, because
//                                     the person is talking, not watching a
//                                     terminal. Every gated action still raises
//                                     the desktop policy's own approval overlay,
//                                     which fails closed when the plugin that
//                                     serves it is not loaded.
//
// So "bypass" here means "do not add a SECOND prompt on top of the one the
// policy already shows", not "skip the checks".

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

function taskPrompt(phrase: string): string {
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
  for.

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
  opts: { timeoutMs?: number; onProgress?: (s: string) => void } = {},
): Promise<AgentOutcome> {
  const timeoutMs = opts.timeoutMs ?? 300_000
  if (!Bun.which("claude")) {
    return { ok: false, summary: "No agent CLI installed" }
  }

  const proc = Bun.spawn([
    "claude", "-p", taskPrompt(phrase),
    "--allowedTools", "mcp__desktop__*",
    "--permission-mode", "bypassPermissions",
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
