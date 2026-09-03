// Interface for Tier 4 autonomous agent runners (Claude Code, Gemini CLI, Codex, OpenCode).

export interface PrepareOptions {
  phrase: string
  workspace: number
  serverScript: string
  bunPath: string
  stateDir: string
}

export interface PreparedExecution {
  argv: string[]
  env?: Record<string, string>
  cwd?: string
  cleanup?: () => Promise<void>
}

export interface AgentRunner {
  readonly id: string
  readonly name: string
  isAvailable(): boolean
  prepare(opts: PrepareOptions): Promise<PreparedExecution | null>
}
