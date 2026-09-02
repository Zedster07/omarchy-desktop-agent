// Desktop Agent service -- the single source of truth.
//
// Everything with state lives here: the approval queue, the lease, the voice
// HUD state, the kill switch. The panel reads this object directly (the shell
// injects it) rather than shelling out to probe the same facts, which is what
// the previous version did and why the two could disagree.
//
// Two front-ends arrive at the same gate:
//
//   voice   you held a key and spoke        -> voice/voiced.ts
//   agent   an MCP client asked for something -> server/server.ts
//
// Dictation deliberately does NOT pass through the policy. You pressing a key
// and speaking is you typing; gating it would make it unusable, and the policy
// forbids typing into terminals -- correct for an agent, wrong for you. Only
// command mode and agent actions are gated.

import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "ui"

Item {
  id: root

  property var shell: null
  property var manifest: null

  readonly property string home: Quickshell.env("HOME")
  readonly property string configDir: home + "/.config/desktop-agent"
  readonly property string policyPath: configDir + "/policy.jsonc"
  readonly property string stateDir: home + "/.local/state/desktop-agent"
  readonly property string auditPath: home + "/.local/share/desktop-agent/desktop.log"

  // The kill switch is a flag file, not an edit to the policy.
  //
  // The old implementation ran `sed -i '0,/"enabled": true/s//false/'` over
  // policy.jsonc. On a hand-edited policy where that string appears in a
  // nested section first -- yolo.enabled, say -- it silently flips the wrong
  // key and reports success. A separate flag file cannot mis-target, cannot
  // destroy the comments in a JSONC file, and matches how the lease already
  // works: a file on disk that needs nothing running to stay true.
  readonly property string disabledFlag: stateDir + "/disabled"
  readonly property string yoloPath: stateDir + "/yolo.json"

  property bool policyEnabled: true
  property bool policyReadable: true

  // ------------------------------------------------------------------ lease

  property real yoloUntil: 0
  property int yoloRemaining: 0
  readonly property bool yoloActive: yoloRemaining > 0
  readonly property string yoloClock: {
    var m = Math.floor(yoloRemaining / 60)
    var s = yoloRemaining % 60
    return m + ":" + (s < 10 ? "0" : "") + s
  }

  // ------------------------------------------------------------- approvals

  property var pending: []
  property var verdicts: ({})
  property int nextId: 1
  readonly property var currentRequest: pending.length > 0 ? pending[0] : null
  readonly property int pendingCount: pending.length

  // ----------------------------------------------------------------- voice

  property string voiceState: "idle"
  property string voiceMode: "dictate"
  property string voiceTranscript: ""
  property string voiceError: ""
  property string voiceMatched: ""
  property var voiceLevels: []
  property real voiceElapsed: 0
  property bool voiceAvailable: false

  // ----------------------------------------------------------------- recap

  property var recap: null

  function log(msg) { console.log("desktop-agent: " + msg) }

  function notify(title, body) {
    notifyProc.command = ["notify-send", "-a", "Desktop Agent",
                          "-i", "preferences-desktop-remote-desktop", title, body]
    notifyProc.running = true
  }

  // --------------------------------------------------------- kill switch

  function setEnabled(on) {
    if (!on) endYolo()
    killProc.command = on
      ? ["rm", "-f", root.disabledFlag]
      : ["bash", "-c", "mkdir -p \"$1\" && : > \"$1/disabled\"", "ks", root.stateDir]
    killProc.running = true
    root.policyEnabled = on
    notify("Desktop Agent", on ? "Policy re-enabled." : "Kill switch on — every gated action refuses.")
  }

  function toggleKillswitch() { setEnabled(!root.policyEnabled) }

  // --------------------------------------------------------------- lease

  function yoloTick() {
    var left = root.yoloUntil > 0 ? Math.max(0, Math.round((root.yoloUntil - Date.now()) / 1000)) : 0
    if (left === 0 && root.yoloRemaining > 0) {
      root.yoloUntil = 0
      notify("Desktop Agent", "Lease expired — approvals are back on.")
    }
    root.yoloRemaining = left
  }

  function grantYolo(minutes) {
    var now = Date.now()
    var until = now + minutes * 60000
    var payload = JSON.stringify({ until: until, grantedAt: now, minutes: minutes, by: "bar" })
    // Positional arguments, never interpolated into the script body, so there
    // is no quoting for a payload to escape from.
    yoloProc.command = ["bash", "-c",
      "mkdir -p \"$1\" && chmod 700 \"$1\" && umask 077 && printf '%s' \"$2\" > \"$1/yolo.json\"",
      "yolo", root.stateDir, payload]
    yoloProc.running = true
    root.yoloUntil = until
    yoloTick()
    notify("Desktop Agent",
           "Full access for " + minutes + " min. Destructive commands and anything denied still stop.")
  }

  function endYolo() {
    var was = root.yoloActive
    yoloProc.command = ["rm", "-f", root.yoloPath]
    yoloProc.running = true
    root.yoloUntil = 0
    root.yoloRemaining = 0
    if (was) notify("Desktop Agent", "Lease ended — approvals are back on.")
  }

  // ----------------------------------------------------------- approvals

  function enqueue(payload) {
    var req
    try { req = JSON.parse(payload) }
    catch (e) { log("malformed approval payload, refusing to queue it: " + e); return "" }

    var id = "req-" + root.nextId
    root.nextId++

    var list = root.pending.slice()
    list.push({
      id: id,
      tool: String(req.tool || "desktop action"),
      capability: String(req.capability || ""),
      scope: String(req.scope || ""),
      target: String(req.target || ""),
      principal: String(req.principal || "claude"),
      severity: String(req.severity || "normal"),
      reasons: Array.isArray(req.reasons) ? req.reasons.map(String) : []
    })
    root.pending = list
    return id
  }

  function answer(id, value) {
    if (!id) return
    root.verdicts[id] = value
    var next = []
    for (var i = 0; i < root.pending.length; i++)
      if (root.pending[i].id !== id) next.push(root.pending[i])
    root.pending = next
  }

  function answerCurrent(value) { if (root.currentRequest) answer(root.currentRequest.id, value) }

  function readVerdict(id) {
    if (root.verdicts.hasOwnProperty(id)) return root.verdicts[id]
    for (var i = 0; i < root.pending.length; i++) if (root.pending[i].id === id) return ""
    return "gone"
  }

  function forget(id) {
    if (root.verdicts.hasOwnProperty(id)) delete root.verdicts[id]
    var next = []
    for (var i = 0; i < root.pending.length; i++)
      if (root.pending[i].id !== id) next.push(root.pending[i])
    if (next.length !== root.pending.length) root.pending = next
  }

  // --------------------------------------------------------------- voice

  function applyVoice(patch) {
    var p
    try { p = JSON.parse(patch) } catch (e) { return }
    if ("state" in p) root.voiceState = String(p.state)
    if ("mode" in p) root.voiceMode = String(p.mode)
    if ("transcript" in p) root.voiceTranscript = String(p.transcript)
    if ("errorText" in p) root.voiceError = String(p.errorText)
    if ("matched" in p) root.voiceMatched = String(p.matched)
    if ("elapsed" in p) root.voiceElapsed = Number(p.elapsed) || 0
    if ("levels" in p && Array.isArray(p.levels)) root.voiceLevels = p.levels
  }

  function voiceSend(verb) {
    voiceCtlProc.command = ["bash", "-c",
      "printf '%s' \"$1\" | socat - \"UNIX-CONNECT:${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/desktop-agent-voice.sock\" >/dev/null 2>&1 || true",
      "vc", verb]
    voiceCtlProc.running = true
  }

  // --------------------------------------------------------------- recap

  function showRecap(payload) {
    var data
    try { data = JSON.parse(payload) } catch (e) { return }
    var lines = []
    if (Array.isArray(data.lines))
      for (var i = 0; i < data.lines.length; i++)
        if (data.lines[i])
          lines.push({ text: String(data.lines[i].text || ""), tone: String(data.lines[i].tone || "ok") })
    var counts = data.counts || {}
    root.recap = {
      actions: Number(counts.actions) || lines.length,
      approvals: Number(counts.approvals) || 0,
      problems: Number(counts.problems) || 0,
      seconds: Math.max(1, Math.round((Number(data.endedAt) - Number(data.startedAt)) / 1000)),
      lines: lines
    }
    recapTimer.restart()
  }

  function dismissRecap() { recapTimer.stop(); root.recap = null }

  function openAuditLog() {
    auditProc.command = ["omarchy-launch-tui", "--app-id=org.omarchy.desktop-agent-log",
                         "bash", "-c", "touch '" + root.auditPath + "'; tail -n 200 -f '" + root.auditPath + "'"]
    auditProc.running = true
    dismissRecap()
  }

  // Opens the policy in whatever the user actually chose as their editor,
  // rather than the author's. xdg-open is no use: .jsonc resolves to a
  // Terminal=true desktop entry with no terminal to host it.
  function openPolicy() {
    if (openProc.running) return
    openProc.command = ["omarchy-launch-editor", root.policyPath]
    openProc.running = true
  }

  // ------------------------------------------------------------ processes

  Process { id: notifyProc }
  Process { id: killProc; onExited: root.probe() }
  Process { id: yoloProc; onExited: root.readYolo() }
  Process { id: auditProc }
  Process { id: openProc }
  Process { id: voiceCtlProc }

  function probe() { if (!probeProc.running) probeProc.running = true }
  function readYolo() { if (!yoloReadProc.running) yoloReadProc.running = true }

  Process {
    id: probeProc
    command: ["bash", "-c",
      "[ -e \"$1\" ] && echo disabled || echo enabled; " +
      "[ -r \"$2\" ] && echo readable || echo unreadable; " +
      "[ -S \"${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/desktop-agent-voice.sock\" ] && echo voice-up || echo voice-down",
      "probe", root.disabledFlag, root.policyPath]
    stdout: SplitParser {
      onRead: function(line) {
        var t = String(line).trim()
        if (t === "enabled") root.policyEnabled = true
        else if (t === "disabled") root.policyEnabled = false
        else if (t === "readable") root.policyReadable = true
        else if (t === "unreadable") root.policyReadable = false
        else if (t === "voice-up") root.voiceAvailable = true
        else if (t === "voice-down") root.voiceAvailable = false
      }
    }
  }

  Process {
    id: yoloReadProc
    command: ["bash", "-c", "cat \"$1\" 2>/dev/null || echo '{}'", "yolo", root.yoloPath]
    stdout: SplitParser {
      onRead: function(line) {
        var until = 0
        try { until = Number(JSON.parse(String(line)).until) || 0 } catch (e) { until = 0 }
        root.yoloUntil = until
        root.yoloTick()
      }
    }
  }

  Timer { interval: 1000; repeat: true; running: root.yoloUntil > 0; onTriggered: root.yoloTick() }
  Timer { interval: 5000; repeat: true; running: true; onTriggered: { root.probe(); root.readYolo() } }
  Timer { id: recapTimer; interval: 25000; onTriggered: root.recap = null }

  FileView {
    path: root.stateDir
    watchChanges: true
    printErrors: false
    onFileChanged: { root.probe(); root.readYolo() }
  }

  Component.onCompleted: {
    log("service started")
    probe()
    readYolo()
  }

  // ------------------------------------------------------------------ IPC

  IpcHandler {
    target: "io.github.zedster07.desktop-agent"

    function request(payload: string): string { return root.enqueue(payload) }
    function verdict(id: string): string { return root.readVerdict(id) }
    function cancel(id: string): void { root.forget(id) }
    function pendingCount(): int { return root.pendingCount }

    function status(): string {
      return JSON.stringify({
        enabled: root.policyEnabled,
        policyReadable: root.policyReadable,
        pendingCount: root.pendingCount,
        yolo: root.yoloActive,
        yoloRemaining: root.yoloRemaining,
        voice: root.voiceAvailable,
        voiceState: root.voiceState
      })
    }

    function toggleKillswitch(): string { root.toggleKillswitch(); return root.policyEnabled ? "enabled" : "disabled" }

    function yolo(minutes: int): string {
      if (minutes <= 0) { root.endYolo(); return "off" }
      root.grantYolo(Math.min(minutes, 240))
      return "on for " + minutes + " min (clamped by policy)"
    }
    function yoloOff(): string { root.endYolo(); return "off" }
    function yoloStatus(): string {
      return JSON.stringify({ active: root.yoloActive, until: root.yoloUntil, remainingSeconds: root.yoloRemaining })
    }

    // Pushed by the voice daemon on every state change.
    function voice(payload: string): void { root.applyVoice(payload) }

    // A spoken phrase that command mode resolved. Intent matching and the
    // policy gate land here in the next step; for now it is surfaced so the
    // path is observable end to end.
    function command(phrase: string): void {
      root.voiceMatched = String(phrase)
      root.voiceState = "done"
      root.log("command phrase: " + phrase)
    }

    function recap(payload: string): void { root.showRecap(payload) }
  }

  // ------------------------------------------------------------------- UI

  ApprovalOverlay {
    request: root.currentRequest
    queueDepth: root.pendingCount
    onAnswered: function(v) { root.answerCurrent(v) }
  }

  VoiceHud {
    phase: root.voiceState
    mode: root.voiceMode
    transcript: root.voiceTranscript
    errorText: root.voiceError
    matchedIntent: root.voiceMatched
    levels: root.voiceLevels
    elapsed: root.voiceElapsed
    onCommit: root.voiceSend("commit")
    onDiscard: root.voiceSend("discard")
  }

  RecapCard {
    recap: root.recap
    onOpenLog: root.openAuditLog()
    onDismissed: root.dismissRecap()
    onHovered: function(hovering) { if (hovering) recapTimer.stop(); else recapTimer.restart() }
  }
}
