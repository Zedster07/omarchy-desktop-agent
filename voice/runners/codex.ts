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
        `mcp_servers.desktop.command="${opts.bunPath}"`,
        "-c",
        `mcp_servers.desktop.args=["run", "${opts.serverScript}"]`,
        "-c",
        'mcp_servers.desktop.env.DESKTOP_AGENT_IDENTITY="codex"',
        // NOT --dangerously-bypass-approvals-and-sandbox, whose own help says
        // "EXTREMELY DANGEROUS. Intended solely for running in environments
        // that are externally sandboxed." This is not such an environment.
        "--sandbox",
        "read-only",
        "--full-auto",
        prompt,
      ],
      env: {
        DESKTOP_AGENT_IDENTITY: "codex",
      },
    }
  }
}
