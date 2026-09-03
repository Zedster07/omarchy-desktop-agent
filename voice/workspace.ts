// Keeping the agent out of your way.
//
// Anything the agent opens lands on one workspace of its own, so a background
// task cannot drop a window into the middle of what you are doing. Hyprland's
// `silent` rule is what makes this bearable: the window is placed there and
// your focus does not move.
//
// This is placement, not permission. What the agent is ALLOWED to touch is the
// policy's `workspaces` dimension, and the two are deliberately separate --
// confining new windows is a courtesy, and a courtesy is not a boundary.

const DEFAULT_WORKSPACE = 10

/** Quote one argv element for a shell command line. */
export function shq(a: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`
}

/**
 * Escape a string for embedding in a Lua double-quoted literal.
 *
 * Newlines matter as much as quotes: Lua has no multi-line double-quoted
 * string, so one raw \n inside makes the whole dispatch fail to parse and
 * hyprctl answers "unfinished string near ..." with exit 7. Escaping only
 * backslashes and quotes was enough for every command tried until one carried
 * a newline, and then it failed with nothing on screen to explain why.
 */
function lua(s: string): string {
  return `"${s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")}"`
}

/**
 * Wrap a launch so the window it creates appears on `ws`.
 *
 * Returns the argv unchanged when `ws` is 0 or negative, which is how a user
 * turns confinement off without a second code path.
 */
export function onWorkspace(argv: string[], ws: number): string[] {
  if (!Number.isFinite(ws) || ws <= 0) return argv
  const cmd = argv.map(shq).join(" ")
  return ["hyprctl", "dispatch", `hl.dsp.exec_cmd(${lua(`[workspace ${ws} silent] ${cmd}`)})`]
}

/**
 * Does this command open a window?
 *
 * Only launches are relocated. "close this window", "volume 40" and
 * "workspace three" are about where the user already is, and moving them to
 * the agent's workspace would be actively wrong.
 */
export function isLaunch(argv: string[]): boolean {
  const prog = (argv[0] ?? "").split("/").pop() ?? ""
  if (prog === "uwsm-app" || prog === "gtk-launch" || prog === "xdg-open") return true
  if (prog === "omarchy" && (argv[1] === "launch" || argv[1] === "webapp")) return true
  // mpv, browsers and the like open a window; hyprctl and wpctl do not.
  return ["mpv", "vlc", "chromium", "firefox", "brave", "nautilus", "foot", "wezterm"]
    .includes(prog)
}

/**
 * The workspace the agent's windows are placed on, or 0 for "do not confine".
 *
 * Per-run via DESKTOP_AGENT_WORKSPACE (set by whichever runner started the
 * hand-off), falling back to the saved setting so it applies equally to a
 * plain Claude Code session talking to this MCP server. One resolver, so the
 * MCP server, the browser and the voice executor cannot disagree about where
 * the agent's windows go.
 */
export function confinementWorkspace(): number {
  const fromEnv = Number(process.env.DESKTOP_AGENT_WORKSPACE)
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv
  try {
    const raw = require("node:fs").readFileSync(
      `${process.env.HOME}/.config/desktop-agent/settings.json`, "utf8")
    const n = Number(JSON.parse(raw)?.agent?.workspace)
    return Number.isFinite(n) && n > 0 ? n : 0
  } catch { return 0 }
}

/**
 * Wrap a command so it runs in a terminal the person can actually watch.
 *
 * The agent used to run everything through a pipe: output captured, nothing on
 * screen, a desktop that changed by itself with no visible cause. Watching a
 * terminal scroll is how you can tell what a thing is doing while it does it,
 * and it is the difference between an assistant and a poltergeist.
 *
 * Output still has to come back to the agent, so the command redirects into a
 * file and writes its exit code to a second file as a completion marker. The
 * caller polls for that marker rather than waiting on the terminal process,
 * which may outlive the command or be reparented by the compositor.
 *
 * Returns null when no terminal is available, so the caller can fall back to a
 * plain pipe rather than failing.
 */
export function inTerminal(
  argv: string[], dir: string, title: string, lingerSec = 3,
): { argv: string[]; outFile: string; codeFile: string } | null {
  const id = crypto.randomUUID().slice(0, 8)
  const outFile = `${dir}/run-${id}.out`
  const codeFile = `${dir}/run-${id}.code`
  const inner = argv.map(shq).join(" ")
  // The redirect and the marker are OUTSIDE the command, so a command that
  // fails, writes to stderr or is killed still leaves both files behind.
  const script =
    // No OSC title escape: -T already sets the title, and a raw ESC/BEL
    // byte has to survive shell quoting, a Lua literal and a hyprctl
    // command line. It did not -- the window silently never appeared.
    `echo ${shq("$ " + argv.join(" "))}; echo; ` +
    `{ ${inner}; } > ${shq(outFile)} 2>&1; echo $? > ${shq(codeFile)}; ` +
    `cat ${shq(outFile)}; ` +
    `printf '\n[done — closing in %ss]\n' ${lingerSec}; sleep ${lingerSec}`

  const term =
    Bun.which("foot") ? ["foot", "-T", title, "sh", "-c", script]
    : Bun.which("xdg-terminal-exec") ? ["xdg-terminal-exec", "--", "sh", "-c", script]
    : Bun.which("wezterm") ? ["wezterm", "start", "--", "sh", "-c", script]
    : Bun.which("alacritty") ? ["alacritty", "-T", title, "-e", "sh", "-c", script]
    : Bun.which("kitty") ? ["kitty", "-T", title, "sh", "-c", script]
    : null
  return term ? { argv: term, outFile, codeFile } : null
}

// ---------------------------------------------------------------- terminal
//
// ONE terminal for the whole run, not one per command.
//
// The first version opened a fresh window per command and closed it three
// seconds later. A window existed, which is not the same as a person being
// able to watch it: `date` runs in five milliseconds, so it was a flicker on a
// workspace you were not looking at. What you want to see is a session -- the
// commands in order, their output, still there when you switch over.
//
// tmux is what makes that possible: the window holds a session, and each
// command is typed INTO it the way a person would type into a terminal they
// already had open.

const SESSION = "desktop-agent"
const TITLE = "Desktop Agent"

/** Is the agent's terminal session alive? */
export function agentTerminalUp(): boolean {
  try {
    const p = Bun.spawnSync(["tmux", "has-session", "-t", SESSION])
    return p.exitCode === 0
  } catch { return false }
}

/**
 * Make sure the agent's terminal exists on `ws`, creating it if not.
 *
 * The `da` helper defined at session start is what lets the pane show a
 * readable command while still capturing output and a real exit code: running
 * the command bare would show it perfectly and tell us nothing, and inlining
 * the redirects would tell us everything and show a wall of plumbing.
 */
export async function ensureAgentTerminal(ws: number, dir: string): Promise<boolean> {
  if (!Bun.which("tmux")) return false
  if (!agentTerminalUp()) {
    // No id argument in the visible command. Tool calls are serialised by the
    // server, so one pair of "last" files is unambiguous, and the pane gets to
    // read `da uname -r` instead of `da 3c6b38a7 uname -r`. The wrapper itself
    // stays visible on purpose -- it is really there, and hiding it would make
    // the pane a nicer lie.
    const helper =
      `da() { ` +
      `"$@" > ${dir}/last.out 2>&1; rc=$?; ` +
      `cat ${dir}/last.out; ` +
      `echo $rc > ${dir}/last.code; ` +
      `return $rc; }`
    const boot = `tmux new-session -d -s ${SESSION} && tmux send-keys -t ${SESSION} ${shq(helper)} Enter && tmux send-keys -t ${SESSION} clear Enter`
    Bun.spawnSync(["sh", "-c", boot])
  }
  // Attach a window to it if one is not already on screen.
  const term = Bun.which("foot")
    ? ["foot", "-T", TITLE, "tmux", "attach", "-t", SESSION]
    : Bun.which("wezterm")
      ? ["wezterm", "start", "--", "tmux", "attach", "-t", SESSION]
      : Bun.which("xdg-terminal-exec")
        ? ["xdg-terminal-exec", "--", "tmux", "attach", "-t", SESSION]
        : null
  if (!term) return false

  const clients = Bun.spawnSync(["sh", "-c", `tmux list-clients -t ${SESSION} 2>/dev/null | wc -l`])
  const attached = Number(new TextDecoder().decode(clients.stdout).trim()) > 0
  if (!attached) {
    Bun.spawn(onWorkspace(term, ws), { stdout: "ignore", stderr: "ignore", stdin: "ignore" }).unref()
    await new Promise(r => setTimeout(r, 600))
  }
  return true
}

/**
 * Type a command into the agent's terminal. Returns the marker file paths.
 *
 * The stale marker is removed FIRST: the caller polls for the code file to
 * appear, so leaving the previous one in place would make every command look
 * like it finished instantly with the last command's result.
 */
export function sendToAgentTerminal(argv: string[], dir: string): { outFile: string; codeFile: string } {
  const outFile = `${dir}/last.out`
  const codeFile = `${dir}/last.code`
  try { require("node:fs").unlinkSync(codeFile) } catch {}
  try { require("node:fs").unlinkSync(outFile) } catch {}
  Bun.spawnSync(["tmux", "send-keys", "-t", SESSION, `da ${argv.map(shq).join(" ")}`, "Enter"])
  return { outFile, codeFile }
}

export { DEFAULT_WORKSPACE }
