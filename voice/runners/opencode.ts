import type { AgentRunner, PrepareOptions, PreparedExecution } from "./types.ts"
import { taskPrompt } from "./prompt.ts"
import { mkdirSync, writeFileSync } from "node:fs"

export class OpenCodeRunner implements AgentRunner {
  readonly id = "opencode"
  readonly name = "OpenCode CLI"

  isAvailable(): boolean {
    return Bun.which("opencode") !== null
  }

  async prepare(opts: PrepareOptions): Promise<PreparedExecution | null> {
    if (!this.isAvailable()) return null

    const runDir = `${opts.stateDir}/opencode-run`

    try {
      mkdirSync(runDir, { recursive: true })
      writeFileSync(
        `${runDir}/opencode.json`,
        JSON.stringify(
          {
            $schema: "https://opencode.ai/config.json",
            mcp: {
              desktop: {
                type: "local",
                command: [opts.bunPath, "run", opts.serverScript],
                environment: { DESKTOP_AGENT_IDENTITY: "opencode" },
                enabled: true,
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
      argv: ["opencode", "run", "--pure", "--auto", prompt],
      cwd: runDir,
      env: {
        DESKTOP_AGENT_IDENTITY: "opencode",
      },
    }
  }
}
