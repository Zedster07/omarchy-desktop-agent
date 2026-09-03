import type { AgentRunner, PrepareOptions, PreparedExecution } from "./types.ts"
import { taskPrompt } from "./prompt.ts"

export class CodexRunner implements AgentRunner {
  readonly id = "codex"
  readonly name = "Codex CLI"

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
        "--dangerously-bypass-approvals-and-sandbox",
        prompt,
      ],
      env: {
        DESKTOP_AGENT_IDENTITY: "codex",
      },
    }
  }
}
