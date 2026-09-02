import QtQuick
import Quickshell
import Quickshell.Wayland
import qs.Commons
import qs.Ui
import "."

// The thing you actually look at while dictating.
//
// It sits just above the bar, centred, and it is deliberately small: you are
// looking at the window you are dictating INTO, not at this. Its whole job is
// to answer three questions without being read -- is it hearing me, is it
// still working, and what did it think I said.
//
// It does not take keyboard focus in any state except `preview`, where it has
// to, because it is asking you to press Enter. A HUD that steals focus while
// you are mid-sentence in another window is worse than no HUD.
Item {
  id: root

  // idle | listening | transcribing | preview | done | error
  // Named "phase", not "state": Item already defines a string `state` for QML
  // state machines, and redeclaring it is a load-time error.
  property string phase: "idle"
  // dictate | command
  property string mode: "dictate"
  property string transcript: ""
  property string errorText: ""
  // Matched intent in command mode, "" when nothing matched.
  property string matchedIntent: ""
  // 0..1 audio levels, newest last. Fed by the voice daemon.
  property var levels: []
  // Rough seconds of speech captured so far, shown while listening.
  property real elapsed: 0

  signal commit()
  signal discard()

  readonly property bool active: phase !== "idle"
  readonly property bool listening: phase === "listening"
  readonly property bool failed: phase === "error"
  readonly property bool commanding: mode === "command"

  readonly property color tone: failed ? Theme.danger
    : commanding ? Theme.caution
    : Theme.ok

  readonly property string glyph: {
    if (failed) return "󰍭"
    if (phase === "transcribing") return "󰔟"
    if (phase === "done") return "󰄬"
    return commanding ? "󰘳" : "󰍬"
  }

  readonly property string caption: {
    if (failed) return errorText !== "" ? errorText : "Didn't catch that"
    if (phase === "listening") return commanding ? "Listening for a command" : "Listening"
    if (phase === "transcribing") return "Transcribing"
    if (phase === "preview") return "Enter to insert · Esc to discard"
    if (phase === "done") return commanding && matchedIntent !== "" ? matchedIntent : "Inserted"
    return ""
  }

  PanelWindow {
    id: window
    visible: root.active
    anchors { bottom: true; left: true; right: true }
    margins.bottom: Style.bar.sizeHorizontal + Style.gapsOut * 3
    implicitHeight: card.implicitHeight + Style.space(8)
    color: "transparent"
    WlrLayershell.namespace: "omarchy-desktop-agent-voice"
    WlrLayershell.layer: WlrLayer.Overlay
    // Focus only where it is actually needed. Everywhere else this is a
    // read-only readout and must not intercept a keystroke.
    WlrLayershell.keyboardFocus: root.phase === "preview"
      ? WlrKeyboardFocus.Exclusive
      : WlrKeyboardFocus.None
    exclusionMode: ExclusionMode.Ignore

    BorderSurface {
      id: card
      anchors.horizontalCenter: parent.horizontalCenter
      anchors.bottom: parent.bottom
      width: Math.min(Math.max(Style.space(300), body.implicitWidth + Style.spacing.popupPadding * 2),
                      parent.width - Style.gapsOut * 4)
      implicitHeight: body.implicitHeight + Style.spacing.popupPadding * 2
      radius: Style.cornerRadius
      color: Theme.cardBackground
      borderSpec: Border.surfaceSpec("popups", "border", root.tone,
                                     Math.max(1, Style.normalBorderWidth), "border-alpha")

      opacity: root.active ? 1 : 0
      // Comes up from the bar rather than fading in place -- the motion says
      // "this belongs to the bar" without needing a label.
      transform: Translate { y: root.active ? 0 : Style.space(10) }
      Behavior on opacity { NumberAnimation { duration: Theme.fast; easing.type: Easing.OutCubic } }

      Row {
        id: body
        anchors.centerIn: parent
        width: parent.width - Style.spacing.popupPadding * 2
        spacing: Style.spacing.xl

        // ---- state glyph, pulsing only while it is actually hearing you
        Item {
          width: Style.space(26)
          height: Style.space(26)
          anchors.verticalCenter: parent.verticalCenter

          Rectangle {
            anchors.centerIn: parent
            width: parent.width
            height: parent.height
            radius: width / 2
            color: Util.alpha(root.tone, 0.16)
            visible: root.listening

            SequentialAnimation on scale {
              running: root.listening
              loops: Animation.Infinite
              NumberAnimation { from: 0.85; to: 1.15; duration: 900; easing.type: Easing.InOutQuad }
              NumberAnimation { from: 1.15; to: 0.85; duration: 900; easing.type: Easing.InOutQuad }
            }
          }

          Text {
            anchors.centerIn: parent
            text: root.glyph
            color: root.tone
            font.family: Style.font.family
            font.pixelSize: Style.font.icon

            RotationAnimator on rotation {
              running: root.phase === "transcribing"
              loops: Animation.Infinite
              from: 0; to: 360; duration: 1400
            }
          }
        }

        Column {
          width: parent.width - Style.space(26) - Style.spacing.xl
          anchors.verticalCenter: parent.verticalCenter
          spacing: Style.spacing.xs

          // ---- live waveform, or the transcript once there is one
          Item {
            width: parent.width
            height: Style.space(22)
            visible: root.listening

            Row {
              anchors.centerIn: parent
              spacing: Style.space(2)

              Repeater {
                model: 28
                Rectangle {
                  width: Style.space(3)
                  radius: width / 2
                  color: root.tone
                  // Newest sample on the right, so it reads left-to-right like
                  // the text it is about to become.
                  readonly property real level: {
                    var l = root.levels
                    if (!l || l.length === 0) return 0
                    var i = l.length - 28 + index
                    return i >= 0 && i < l.length ? Math.max(0, Math.min(1, l[i])) : 0
                  }
                  height: Style.space(3) + level * Style.space(19)
                  anchors.verticalCenter: parent.verticalCenter
                  opacity: 0.35 + level * 0.65
                  Behavior on height { NumberAnimation { duration: 70 } }
                }
              }
            }
          }

          Text {
            width: parent.width
            visible: !root.listening && root.transcript !== ""
            text: root.transcript
            color: Theme.cardText
            font.family: Style.font.family
            font.pixelSize: Style.font.body
            wrapMode: Text.Wrap
            maximumLineCount: 3
            elide: Text.ElideRight
          }

          Row {
            width: parent.width
            spacing: Style.spacing.md

            Text {
              text: root.caption
              color: root.failed ? Theme.danger : Theme.cardTextSecondary
              font.family: Style.font.family
              font.pixelSize: Style.font.caption
            }

            Text {
              visible: root.listening && root.elapsed >= 1
              text: "· " + Math.floor(root.elapsed) + "s"
              color: Theme.cardTextTertiary
              font.family: Style.font.family
              font.pixelSize: Style.font.caption
            }
          }
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
