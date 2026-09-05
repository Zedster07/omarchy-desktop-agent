// Interface for Tier 4 autonomous agent runners (Claude Code, Gemini CLI, Codex, OpenCode).

export interface PrepareOptions {
  phrase: string
  workspace: number
  serverScript: string
  bunPath: string
  stateDir: string

  /**
   * How this agent reaches the desktop MCP server.
   *
   * Normally the server itself, spawned as a stdio child. Under a sandbox it
   * is a socat connection to a socket bound in from outside, because the
   * server must stay OUT of the sandbox -- it is the thing that still holds
   * the compositor sockets. Every runner writes its own config format, so the
   * endpoint has to be a parameter rather than something each one hardcodes.
   */
  mcp: { command: string; args: string[] }

  /**
   * Is this launch already inside a sandbox with no compositor sockets?
   *
   * It changes what the safest flags ARE. Codex's bypass says of itself
   * "EXTREMELY DANGEROUS. Intended solely for running in environments that are
   * externally sandboxed" -- so outside one it is the wrong flag and inside
   * one it is the right one. Its own sandbox is redundant there and only gets
   * in the way of the agent writing its own scratch files.
   */
  externallySandboxed?: boolean
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

  /**
   * Whether this runner can be reduced to the desktop tools and NOTHING else.
   *
   * Not a quality rating -- a security fact, and the reason tier 4 is allowed
   * to run unattended at all. The desktop policy only sees calls that go
   * through the desktop MCP server, so an agent holding its own shell steps
   * around the policy completely: it can run hyprctl directly and the audit
   * log will never know. That is not hypothetical, it is what happened here
   * before the Claude runner was confined.
   *
   * Only claim `true` where it has been checked by asking the agent to
   * enumerate its own tools -- `desktop-agent agent-check` does exactly that.
   */
  readonly confined: boolean

  /** Why it cannot be confined, shown when someone opts in anyway. */
  readonly unconfinedReason?: string

  isAvailable(): boolean
  prepare(opts: PrepareOptions): Promise<PreparedExecution | null>
}
