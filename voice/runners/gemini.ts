import type { AgentRunner, PrepareOptions, PreparedExecution } from "./types.ts"
import { taskPrompt } from "./prompt.ts"
import { mkdirSync, writeFileSync } from "node:fs"

export class GeminiRunner implements AgentRunner {
  readonly id = "gemini"
  readonly name = "Gemini CLI"
  readonly confined = false
  // --allowed-mcp-server-names restricts MCP SERVERS, not built-in tools, so
  // run_shell_command survives and --approval-mode yolo auto-approves it.
  readonly unconfinedReason =
    "Gemini keeps run_shell_command; --allowed-mcp-server-names only filters MCP servers"

  isAvailable(): boolean {
    return Bun.which("gemini") !== null
  }

  async prepare(opts: PrepareOptions): Promise<PreparedExecution | null> {
    if (!this.isAvailable()) return null

    const runDir = `${opts.stateDir}/gemini-run`
    const geminiDir = `${runDir}/.gemini`

    try {
      mkdirSync(geminiDir, { recursive: true })
      writeFileSync(
        `${geminiDir}/settings.json`,
        JSON.stringify(
          {
            mcpServers: {
              desktop: {
                command: opts.mcp.command,
                args: opts.mcp.args,
                env: { ...opts.mcpEnv },
              },
            },
          },
          null,
          2
        )
      )
    } catch {
      return null
    }

    const prompt = taskPrompt(opts.phrase, opts.workspace)

    return {
      argv: [
        "gemini",
        "-p",
        prompt,
        "--skip-trust",
        "--approval-mode",
        "yolo",
        "--allowed-mcp-server-names",
        "desktop",
      ],
      cwd: runDir,
      env: {
        DESKTOP_AGENT_IDENTITY: "gemini",
        DESKTOP_AGENT_WORKSPACE: String(opts.workspace),
      },
    }
  }
}
