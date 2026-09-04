# Desktop Agent (`io.github.zedster07.desktop-agent`) — Comprehensive Audit, Code Review & Strategic Roadmap

**Date:** September 4, 2026  
**Target Repository:** `/home/dada/Work/omarchy-desktop-agent`  
**Evaluated Revisions:** `master` (commits `37ca148` through `47c290b`)

---

## 1. Executive Summary

**Desktop Agent** is an autonomous desktop automation and voice control system built natively for **Arch Linux**, **Hyprland**, and the **Omarchy Quickshell** desktop environment. It bridges speech/text interactions with system execution across a strict four-tier escalation hierarchy:

```
[Spoken Audio / Text Request]
               │
               ▼
   [Tier 1: Intent Registry] ──(Matched)──> Execute instantly (<1ms, offline)
               │ (Unrecognized)
               ▼
    [Tier 2: AI Routing]     ──(Resolved)─> Execute declared intent
               │ (No Intent Fits)
               ▼
    [Tier 3: AI Planning]    ──(Planned)──> Synthesize validated argv CLI sequence
               │ (Perception Required)
               ▼
    [Tier 4: Agent Hand-Off] ─────────────> Autonomous screen driving (MCP Server)
```

Recent commits authored with Claude Code have significantly matured the codebase, adding conversational memory, visible execution inside dedicated terminal sessions, strict confinement contracts across multiple AI agent runners, and refined window placement.

This report delivers a full 360-degree audit of the latest changes, uncovers critical flaws in the newly introduced execution paths, provides hardening recommendations, and lays out a high-impact feature roadmap.

---

## 2. Deep Audit of Recent Commits (`70e83fd..HEAD`)

Between commit `70e83fd` (merge of multi-agent runner support) and `HEAD` (`47c290b`), 14 commits introduced major architectural additions. Below is an evaluation of each major subsystem introduced:

### 2.1 Confinement as an Explicit Security Contract (`c770a23`)
* **What changed:** Introduced `confined: boolean` to `voice/runners/types.ts`. Decoupled the toolless intent planner (`ai.provider`) from the autonomous executor (`agent.runner`). Added an explicit `agent.allowUnconfined` gate for runners that retain their own native shells (Gemini, Codex, OpenCode).
* **Assessment:** **Exemplary security design.** Unattended execution is safe only because all calls are mediated by the desktop MCP server. Allowing unconfined agents to run unattended with bypass flags would have silently granted them raw host shell access, bypassing the desktop policy engine entirely.

### 2.2 Enforced Window & Browser Workspace Confinement (`25f4218`, `4996f90`)
* **What changed:** Removed prompt-based placement requests in favor of deterministic Hyprland rules:
  - CLI app launches wrap argv via `onWorkspace(argv, ws)` using Hyprland dispatch `hl.dsp.exec_cmd("[workspace N silent] ...")`.
  - Browser launches in `server/browser.ts` are placed via dynamic Hyprland window rule `hl.window_rule({match={class="agent-browser"}, workspace="${ws} silent"})`.
* **Assessment:** **High-value reliability fix.** Prompt text asking an LLM to prepend workspace rules is non-deterministic. Placing windows at the compositor level guarantees background agent tasks never hijack user focus.

### 2.3 Observable Command Execution via Persistent Tmux (`81c0fbc`, `d1e6b7b`)
* **What changed:** In `voice/workspace.ts`, created an interactive `tmux` session (`"desktop-agent"`) attached to a visible terminal window (`foot`, `wezterm`, or `xdg-terminal-exec`) on the agent's workspace. Tool calls from `desktop_run` are typed into the session via `tmux send-keys` using a helper function (`da()`), with completion signaled via exit code files.
* **Assessment:** **Great UX concept, but contains high-severity execution bugs** (see Section 3.1 & 3.2).

### 2.4 Panel IPC Fallback for Bar Widget Wiring (`10ee547`)
* **What changed:** Added `viaIpc`, `ipcCall()`, and `pollState()` in `Panel.qml`.
* **Assessment:** **Critical bugfix.** When `Panel.qml` was instantiated by `BarWidget.qml` as a popout, Quickshell did not inject `service`, leaving `service === null`. This rendered all buttons and status dials inert. The IPC fallback connects directly to the Quickshell IPC socket, ensuring the panel is fully functional regardless of instantiation path.

### 2.5 Media Player Sandboxing & Web Playback Redirection (`7de988b`, `bc60200`, `d04c5b1`)
* **What changed:** In `voice/safety.ts`, media players (`mpv`, `vlc`, etc.) were placed into a `PLAYERS` set. Handing remote URLs (`http://`, `ytdl://`, `ytsearch:`) to headless players is rejected outright. Prompts were updated to enforce browser playback for streaming media.
* **Assessment:** Solves a major real-world nuisance where spoken requests like *"play music"* spawned invisible background processes with no playback controls or UI windows.

### 2.6 Conversational Memory Engine (`d5bd885`)
* **What changed:** Created `voice/history.ts` implementing a rolling 45-minute window of recent turns stored in JSONL (`~/.local/state/desktop-agent/history.jsonl`). Exposed `asContext()` to inject history into Tier 3 and Tier 4 prompts.
* **Assessment:** Solves pronoun resolution (*"pause it"*, *"louder"*, *"close that"*) without conversational pollution.

### 2.7 Isolated Agent Working Directory (`623e97e`)
* **What changed:** Set agent process `cwd` to an isolated empty directory (`~/.local/state/desktop-agent/run`).
* **Assessment:** **Vital isolation fix.** Prevents Claude Code from accidentally loading project-level configuration files (such as `~/.claude/settings.local.json`) from `$HOME`, which previously caused fatal parser crashes during hand-off.

### 2.8 Dynamic App Window Resolution (`47c290b`)
* **What changed:** Added `window.closeApp` intent and `findWindow()` in `voiced.ts` to look up Hyprland window addresses by app name or class before execution.
* **Assessment:** Cleanly bypasses the need for dangerous `pkill` or unrestricted `hyprctl` commands in Tier 3 proposals.

---

## 3. Concrete Problems & Edge Cases Identified

Despite the high quality of the recent commits, our technical audit identified seven concrete issues ranging from high-severity runtime bugs to edge-case oversights:

### 🔴 Problem 1: `desktop_run` Completely Ignores `cwd` in Visible Terminal Mode
* **Location:** `server/server.ts:L2280-L2300` & `voice/workspace.ts:L196-L205`
* **Description:** In `server.ts`, `desktop_run` validates and normalizes `cwd`:
  ```typescript
  const cwd = args.cwd || policy.run.cwd || os.homedir()
  ```
  However, when `visible` is true (default), `sendToAgentTerminal([bin, ...argv], TMP)` is invoked **without passing `cwd`**. Inside `sendToAgentTerminal`, it executes:
  ```typescript
  Bun.spawnSync(["tmux", "send-keys", "-t", SESSION, `da ${argv.map(shq).join(" ")}`, "Enter"])
  ```
* **Impact:** Every command executed in visible mode runs in whatever working directory the tmux session was created in. Project-specific commands (e.g. `git status`, `npm test`) will execute in `$HOME` or fail silently.
* **Remediation:** Pass `cwd` to `sendToAgentTerminal` and prepend `cd` into the tmux session:
  ```typescript
  export function sendToAgentTerminal(argv: string[], dir: string, cwd?: string): { outFile: string; codeFile: string } {
    const outFile = `${dir}/last.out`
    const codeFile = `${dir}/last.code`
    try { require("node:fs").unlinkSync(codeFile) } catch {}
    try { require("node:fs").unlinkSync(outFile) } catch {}
    const cdCmd = cwd ? `cd ${shq(cwd)} && ` : ""
    Bun.spawnSync(["tmux", "send-keys", "-t", SESSION, `${cdCmd}da ${argv.map(shq).join(" ")}`, "Enter"])
    return { outFile, codeFile }
  }
  ```

---

### 🔴 Problem 2: Stalled / Interactive Commands in Tmux Are Never Aborted on Timeout
* **Location:** `server/server.ts:L2290-L2305`
* **Description:** When running commands via standard pipe fallback, timeouts trigger `proc.kill(9)`. In the tmux visible branch, when the timeout deadline passes, the server sets `timedOut = true` and unlinks the marker files, **but sends no abort signal to tmux**.
* **Impact:** If a command prompts for interactive input (e.g. `sudo`, `read`, or unbuffered pagers) or hangs, it remains running in the tmux pane. When the agent issues subsequent commands, `tmux send-keys` types the new command directly into the `stdin` of the stalled process, completely bricking the terminal session.
* **Remediation:** Send `Ctrl+C` (`C-c`) to the tmux session when a timeout occurs or before sending any new command:
  ```typescript
  // In workspace.ts before dispatching a new command:
  Bun.spawnSync(["tmux", "send-keys", "-t", SESSION, "C-c"])
  ```

---

### 🟡 Problem 3: Shared Temporary Directory Collision in `/tmp/desktop-agent`
* **Location:** `server/server.ts:L54`
* **Description:**
  ```typescript
  const TMP = path.join(os.tmpdir(), "desktop-agent")
  ```
* **Impact:** In multi-user Linux environments or shared workstations, `/tmp/desktop-agent` created by User A with mode 0755 prevents User B from creating or writing output files, resulting in `EACCES` crashes.
* **Remediation:** Point to per-user runtime directories:
  ```typescript
  const TMP = process.env.XDG_RUNTIME_DIR
    ? path.join(process.env.XDG_RUNTIME_DIR, "desktop-agent")
    : path.join(os.tmpdir(), `desktop-agent-${process.getuid?.() ?? "user"}`)
  ```

---

### 🟡 Problem 4: Obsolete Setting Key Referenced in Error Message
* **Location:** `voice/agent.ts:L97`
* **Description:**
  ```typescript
  ? `No confinable agent CLI. ${loose} installed but cannot be limited to the desktop tools — set ai.provider and agent.allowUnconfined to use one anyway`
  ```
* **Impact:** Commit `c770a23` renamed the setting from `ai.provider` to `agent.runner` (line 86). A user following this error message will set `ai.provider` and still be rejected.
* **Remediation:** Update the message to state: `set agent.runner and agent.allowUnconfined to use one anyway`.

---

### 🟡 Problem 5: Non-Atomic File Rewrite in History Pruning
* **Location:** `voice/history.ts:L70-L74`
* **Description:** While `remember()` safely appends to `history.jsonl`, `prune()` performs a whole-file read and rewrites the file in place with `writeFileSync(PATH, ...)`.
* **Impact:** Because writes can happen concurrently from `voiced.ts` (Tier 4) and child `execute.ts` processes (Tiers 1–3), an overlapping rewrite can truncate turns or produce corrupted JSONL entries.
* **Remediation:** Use write-to-temp and atomic rename:
  ```typescript
  function prune(): void {
    const all = readAll()
    if (all.length <= KEEP) return
    const tmp = `${PATH}.tmp.${process.pid}`
    try {
      writeFileSync(tmp, all.slice(-KEEP).map(t => JSON.stringify(t)).join("\n") + "\n")
      renameSync(tmp, PATH)
    } catch {
      try { unlinkSync(tmp) } catch {}
    }
  }
  ```

---

### 🟡 Problem 6: Accumulation of Dynamic Window Rules in Hyprland
* **Location:** `server/browser.ts:L145-L148`
* **Description:** Each time `ensure()` launches a browser, it issues:
  ```typescript
  Bun.spawnSync(["hyprctl", "dispatch",
    `hl.window_rule({match={class="agent-browser"}, workspace="${ws} silent"})`])
  ```
* **Impact:** Hyprland keeps dynamic window rules active in memory for the duration of the compositor session. Repeated browser sessions accumulate duplicate window rules, and changes to `agent.workspace` do not clear previously registered rules.
* **Remediation:** Check whether a rule exists before registering, or recommend setting static window rules inside `hyprland.conf`.

---

### 🟢 Problem 7: Edge Case in `policy-yolo` Comment-Stripping Regex
* **Location:** `bin/desktop-agent-config:L289-L291`
* **Description:**
  ```python
  body = re.sub(r"^\s*//.*$", "", raw, flags=re.M)
  m = re.search(r'"yolo"\s*:\s*\{[^}]*?"enabled"\s*:\s*(true|false)', body, re.S)
  ```
* **Impact:** Only strips lines starting with `//`. Inline comments (`"enabled": true // comment`) or block comments (`/* ... */`) are not handled and can cause regex mismatches.

---

## 4. Architectural Hardening Recommendations

1. **Add `tmux` to Health Diagnostics (`doctor`)**:
   `bin/desktop-agent doctor` validates audio packages and agent CLIs, but omits `tmux`. Since observable terminal execution requires `tmux`, adding it to `doctor` ensures users are notified immediately if visible command execution will fall back to pipes.

2. **Fuzzy Intent Matching for Desktop Applications**:
   In `intents/builtin.json`, `window.closeApp` accepts `{app}` as arbitrary text. Adding an `"app"` slot type in `voice/intents.ts` that validates against installed desktop apps (`listApps()`) would enable typo-tolerant and phonetic matching for spoken app names (e.g. mapping *"close code"* to `code.desktop` or *"close discord"* to `vesktop`).

3. **Multi-Monitor Awareness for Window Confinement**:
   Confinement is currently bound to a numeric workspace (`workspace 10`). In multi-monitor Hyprland setups, workspaces may be dynamically bound to specific active monitors. Inspecting `hyprctl monitors -j` to place background tasks on an inactive output provides better isolation.

---

## 5. Strategic Roadmap: Features Lacking in the Project

To evolve **Desktop Agent** into an enterprise-grade, conversational desktop companion, the following six features represent the most valuable additions:

### 5.1 Two-Way Speech Synthesis (Text-to-Speech / Spoken Audio Feedback)
* **The Gap:** The speech pipeline is currently one-way: the user speaks, but the system only responds visually via on-screen HUD text or markdown reports.
* **Solution:** Integrate a fast, local neural TTS engine such as **Piper** (`piper-tts`) or **Kokoro-82M**. When tasks finish or require human attention, the system can speak back a one-line verbal confirmation:
  > *"I've muted the audio."*  
  > *"Found 3 matching invoices and moved them to your Documents folder."*

### 5.2 Real-Time HUD Action Streaming
* **The Gap:** During Tier 4 agent execution, the HUD sits on `"working"` for 30–120 seconds with zero granular feedback until the final markdown report is rendered.
* **Solution:** Have the MCP server emit lightweight IPC status pulses on every tool invocation (`📸 Capturing screen`, `🔍 Analyzing window layout`, `🖱️ Clicking [Confirm]`, `⌨️ Typing search query`). Displaying these live actions in the Quickshell HUD pill transforms a silent wait into an observable, trustworthy experience.

### 5.3 Multimodal Screen Awareness for Fast Tier-3 Planning
* **The Gap:** Tier 2 (intent routing) and Tier 3 (command planning) are strictly text-based. Requests requiring quick visual confirmation (*"click the blue update button"*, *"what is this error popup?"*) cannot be planned with commands and must escalate to the full agent tier.
* **Solution:** Pass a downscaled screen capture to fast multimodal models (e.g. Gemini 2.5 Flash, Claude 3.5 Haiku) during Tier 3 planning, enabling fast visual decisions without spinning up full agent sessions.

### 5.4 Hands-Free Wake Word Activation
* **The Gap:** Initiating voice commands requires holding physical keybindings (`F9`, `F10`) or triggering `SUPER+F1`.
* **Solution:** Integrate an optional local wake-word engine (e.g. **openWakeWord**) listening for *"Hey Desktop"* or *"Computer"*, allowing hands-free voice interaction when working away from the keyboard.

### 5.5 Desktop Action Reversion (Undo Stack)
* **The Gap:** If an agent or voice command moves, closes, or rearranges the wrong window, the user must manually restore their layout.
* **Solution:** Maintain a rolling stack of Hyprland window operations (workspace assignments, focus states, geometry). Commands like *"undo that"* or *"bring that window back"* can instantly reverse recent layout changes.

### 5.6 Visual Wayland Cursor Breadcrumbs
* **The Gap:** When the agent clicks or interacts with elements on screen, there is no visual cue on Wayland indicating where the cursor landed.
* **Solution:** Use Quickshell's layer-shell overlay to render a brief animated ripple effect at the target `(x, y)` coordinate whenever `desktop_mouse` or `desktop_click` fires.

---

## 6. Prioritized Remediation & Implementation Matrix

| Item | Category | Priority | Complexity | Recommended Action |
| :--- | :--- | :---: | :---: | :--- |
| **Fix `cwd` in Tmux visible runs** | Bug | **P0** | Low | Pass `cwd` to `sendToAgentTerminal` and prepend `cd` |
| **Abort hung commands in Tmux** | Bug | **P0** | Low | Send `C-c` to tmux pane on timeout and before new runs |
| **Per-user runtime directory** | Security | **P1** | Low | Switch `/tmp/desktop-agent` to `$XDG_RUNTIME_DIR` |
| **Correct `agent.runner` in error text** | UX Bug | **P1** | Trivial | Fix setting name in `voice/agent.ts:L97` |
| **Atomic history pruning** | Reliability | **P2** | Low | Use atomic file rename pattern in `history.ts` |
| **Add `tmux` check to `doctor`** | Tooling | **P2** | Trivial | Add check in `bin/desktop-agent` |
| **Text-to-Speech (TTS) Feedback** | Feature | **P2** | Medium | Integrate Piper TTS for spoken responses |
| **Live HUD Action Streaming** | Feature | **P2** | Medium | Stream MCP tool call status over Quickshell IPC |
| **Desktop State Undo Stack** | Feature | **P3** | Medium | Implement Hyprland window state rollback |
