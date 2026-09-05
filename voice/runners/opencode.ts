import type { AgentRunner, PrepareOptions, PreparedExecution } from "./types.ts"
import { taskPrompt } from "./prompt.ts"
import { mkdirSync, writeFileSync } from "node:fs"

export class OpenCodeRunner implements AgentRunner {
  readonly id = "opencode"
  readonly name = "OpenCode CLI"
  readonly confined = false
  // --auto approves "permissions that are not explicitly denied", so a deny
  // list in opencode.json may well be able to remove the built-in tools. That
  // is worth doing, but it has to be VERIFIED before it can be claimed --
  // a confinement that is silently ignored is worse than none, because it
  // reads as safe.
  readonly unconfinedReason =
    "OpenCode keeps its built-in shell and edit tools under --auto"

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
                command: [opts.mcp.command, ...opts.mcp.args],
                environment: { ...opts.mcpEnv },
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
        DESKTOP_AGENT_WORKSPACE: String(opts.workspace),
      },
    }
  }
}
