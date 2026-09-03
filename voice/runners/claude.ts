import type { AgentRunner, PrepareOptions, PreparedExecution } from "./types.ts"
import { taskPrompt } from "./prompt.ts"
import { mkdirSync, writeFileSync } from "node:fs"

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

export class ClaudeRunner implements AgentRunner {
  readonly id = "claude"
  readonly name = "Claude Code"
  // Verified by `desktop-agent agent-check`: the deny list plus
  // --strict-mcp-config leave exactly the 17 mcp__desktop__* tools.
  readonly confined = true

  isAvailable(): boolean {
    return Bun.which("claude") !== null
  }

  async prepare(opts: PrepareOptions): Promise<PreparedExecution | null> {
    if (!this.isAvailable()) return null

    const settings = `${opts.stateDir}/agent-settings.json`
    const mcp = `${opts.stateDir}/agent-mcp.json`

    try {
      mkdirSync(opts.stateDir, { recursive: true })
      writeFileSync(
        settings,
        JSON.stringify({ permissions: { deny: DENIED_TOOLS } }, null, 2)
      )
      writeFileSync(
        mcp,
        JSON.stringify(
          {
            mcpServers: {
              desktop: {
                type: "stdio",
                command: opts.bunPath,
                args: ["run", opts.serverScript],
                env: { DESKTOP_AGENT_IDENTITY: "claude" },
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
        "claude",
        "-p",
        prompt,
        "--permission-mode",
        "bypassPermissions",
        "--strict-mcp-config",
        "--mcp-config",
        mcp,
        "--settings",
        settings,
      ],
      env: {
        DESKTOP_AGENT_IDENTITY: "claude",
      },
    }
  }
}
