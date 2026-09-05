import type { AgentRunner, PrepareOptions, PreparedExecution } from "./types.ts"
import { taskPrompt } from "./prompt.ts"

export class CodexRunner implements AgentRunner {
  readonly id = "codex"
  readonly name = "Codex CLI"
  readonly confined = false
  // -s read-only is the strongest sandbox Codex offers here, and it is not
  // enough: it restricts filesystem writes and network, not process spawning.
  // A read-only Codex can still run `hyprctl dispatch` and act on the desktop
  // without the policy engine ever seeing it. There is no documented way to
  // remove its shell tool.
  readonly unconfinedReason =
    "Codex keeps its own shell; its sandbox stops file writes, not desktop actions"

  isAvailable(): boolean {
    return Bun.which("codex") !== null
  }

  async prepare(opts: PrepareOptions): Promise<PreparedExecution | null> {
    if (!this.isAvailable()) return null

    const prompt = taskPrompt(opts.phrase, opts.workspace)

    return {
      argv: [
        "codex",
        "exec",
        "-c",
        `mcp_servers.desktop.command="${opts.mcp.command}"`,
        "-c",
        `mcp_servers.desktop.args=${JSON.stringify(opts.mcp.args)}`,
        // One -c per variable, generated from the same object every other
        // runner spreads. Hand-listing them here is what let the capability
        // ceiling go missing on this runner while Claude had it.
        ...Object.entries(opts.mcpEnv).flatMap(([k, v]) =>
          ["-c", `mcp_servers.desktop.env.${k}="${String(v).replace(/"/g, '\\"')}"`]),
        // Its own help names the condition exactly: "EXTREMELY DANGEROUS.
        // Intended solely for running in environments that are externally
        // sandboxed." Inside bwrap, with no compositor sockets and a read-only
        // filesystem, that condition is met and this is the correct flag --
        // Codex's own sandbox on top would only stop it writing its scratch
        // files. Outside one it is refused before reaching here.
        //
        // (--full-auto was here and does not exist on `codex exec`. It was
        // added when the bypass was removed and never run, because the only
        // test at the time checked that the gate refused Codex -- so the
        // command it would have used was never executed once.)
        ...(opts.externallySandboxed
          ? ["--dangerously-bypass-approvals-and-sandbox"]
          : ["--sandbox", "read-only"]),
        prompt,
      ],
      env: {
        DESKTOP_AGENT_IDENTITY: "codex",
        DESKTOP_AGENT_WORKSPACE: String(opts.workspace),
      },
    }
  }
}
