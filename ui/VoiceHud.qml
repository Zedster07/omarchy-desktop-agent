import QtQuick
import QtQuick.Effects
import Quickshell
import Quickshell.Wayland
import qs.Commons
import qs.Ui
import "."

// The machine listening to you.
//
// Deliberately not a card in the corner. When you hold the key and speak, the
// core takes the middle of the screen and your voice draws itself around it --
// that moment is the whole product, and a small pill by the bar sells it as a
// utility rather than as a thing that is paying attention.
//
// It still never takes keyboard focus except in `preview`, where it has to
// because it is asking for a keystroke, and it never dims the desktop: you
// are talking ABOUT what is on screen, so covering it up would be perverse.
Item {
  id: root

  property string phase: "idle"
  property string mode: "dictate"
  property string transcript: ""
  property string errorText: ""
  property string matchedIntent: ""
  property var levels: []
  property real elapsed: 0

  signal commit()
  signal discard()

  readonly property bool active: phase !== "idle"
  readonly property bool listening: phase === "listening"
  readonly property bool working: phase === "transcribing"
  readonly property bool failed: phase === "error"
  readonly property bool done: phase === "done"
  readonly property bool commanding: mode === "command"

  readonly property color tone: failed ? Theme.danger
    : done ? Theme.ok
    : commanding ? Theme.caution
    : Theme.ok

  readonly property string glyph: {
    if (failed) return "󰍭"
    if (working) return "󰔟"
    if (done) return "󰄬"
    return commanding ? "󰘳" : "󰍬"
  }

  readonly property string statusWord: {
    if (failed) return "unrecognised"
    if (working) return "processing"
    if (done) return "executed"
    if (phase === "preview") return "confirm"
    return commanding ? "command" : "dictation"
  }

  readonly property string caption: {
    if (failed) return errorText !== "" ? errorText : "Didn't catch that"
    if (listening) return commanding ? "listening for a command" : "listening"
    if (working) return matchedIntent !== "" ? matchedIntent : "transcribing"
    if (phase === "preview") return "enter to insert · esc to discard"
    if (done) return commanding && matchedIntent !== "" ? matchedIntent : "inserted"
    return ""
  }

  PanelWindow {
    id: window
    visible: root.active
    anchors { top: true; bottom: true; left: true; right: true }
    color: "transparent"
    WlrLayershell.namespace: "omarchy-desktop-agent-voice"
    WlrLayershell.layer: WlrLayer.Overlay
    WlrLayershell.keyboardFocus: root.phase === "preview"
      ? WlrKeyboardFocus.Exclusive : WlrKeyboardFocus.None
    exclusionMode: ExclusionMode.Ignore

    // No scrim. The desktop stays fully visible and fully usable behind this.
    Item {
      id: stage
      anchors.centerIn: parent
      width: Math.min(Style.space(520), parent.width - Style.gapsOut * 4)
      height: core.height + readout.implicitHeight + Style.spacing.huge

      opacity: root.active ? 1 : 0
      scale: root.active ? 1 : 0.94
      Behavior on opacity { NumberAnimation { duration: Theme.fast; easing.type: Easing.OutCubic } }
      Behavior on scale { NumberAnimation { duration: Theme.normal; easing.type: Easing.OutBack } }

      // Bloom behind the core only. The readout stays crisp.
      MultiEffect {
        anchors.fill: core
        source: core
        shadowEnabled: true
        shadowColor: Util.alpha(root.tone, root.listening ? 0.75 : 0.45)
        shadowBlur: 1.0
        shadowScale: 1.05
        Behavior on shadowColor { ColorAnimation { duration: Theme.normal } }
      }

      HudCore {
        id: core
        anchors.horizontalCenter: parent.horizontalCenter
        anchors.top: parent.top
        width: Style.space(196)
        height: width
        tone: root.tone
        levels: root.levels
        live: root.listening
        working: root.working
        glyph: root.glyph
        fontFamily: Style.font.family
      }

      // ---- readout beneath the core, centred, no plate behind it
      Column {
        id: readout
        anchors.top: core.bottom
        anchors.topMargin: Style.spacing.huge
        anchors.horizontalCenter: parent.horizontalCenter
        width: parent.width
        spacing: Style.spacing.sm

        Row {
          anchors.horizontalCenter: parent.horizontalCenter
          spacing: Style.spacing.md

          HudLabel {
            text: root.statusWord
            tone: root.tone
            color: root.tone
            anchors.verticalCenter: parent.verticalCenter
          }

          HudLabel {
            visible: root.listening && root.elapsed >= 1
            text: "· " + Math.floor(root.elapsed) + "s"
            tone: Color.foreground
            anchors.verticalCenter: parent.verticalCenter
          }
        }

        // The transcript gets a plate, because it is the one thing here that
        // is text to be read rather than state to be sensed.
        Item {
          width: parent.width
          height: transcriptText.paintedHeight + Style.spacing.xl * 2
          visible: root.transcript !== "" || root.failed

          Rectangle {
            anchors.fill: parent
            radius: Style.cornerRadius
            color: Util.alpha(Theme.cardBackground, 0.86)
          }
          HudFrame { anchors.fill: parent; color: root.tone; armRatio: 0.06 }

          Text {
            id: transcriptText
            anchors.centerIn: parent
            width: parent.width - Style.spacing.huge * 2
            horizontalAlignment: Text.AlignHCenter
            text: root.failed ? root.caption : root.transcript
            color: root.failed ? Theme.danger : Theme.cardText
            font.family: Style.font.family
            font.pixelSize: Style.font.subtitle
            wrapMode: Text.Wrap
            maximumLineCount: 3
            elide: Text.ElideRight
          }
        }

        HudLabel {
          anchors.horizontalCenter: parent.horizontalCenter
          visible: !root.failed && root.caption !== "" && root.transcript !== ""
          text: root.caption
          tone: Color.foreground
        }
      }
    }

    Item {
      anchors.fill: parent
      focus: root.phase === "preview"
      Keys.onPressed: function(event) {
        if (root.phase !== "preview") return
        if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) { root.commit(); event.accepted = true }
        else if (event.key === Qt.Key_Escape) { root.discard(); event.accepted = true }
      }
    }
  }
}
