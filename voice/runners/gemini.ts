import type { AgentRunner, PrepareOptions, PreparedExecution } from "./types.ts"
import { taskPrompt } from "./prompt.ts"
import { mkdirSync, writeFileSync } from "node:fs"

export class GeminiRunner implements AgentRunner {
  readonly id = "gemini"
  readonly name = "Gemini CLI"

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
                command: opts.bunPath,
                args: ["run", opts.serverScript],
                env: { DESKTOP_AGENT_IDENTITY: "gemini" },
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
      },
    }
  }
}
