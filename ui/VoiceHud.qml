import QtQuick
import QtQuick.Effects
import Quickshell
import Quickshell.Wayland
import qs.Commons
import qs.Ui
import "."

// The readout you glance at while talking.
//
// Small on purpose: you are looking at the window you are dictating INTO, not
// at this. Its job is to answer three things without being read -- is it
// hearing me, is it still working, what did it think I said -- so the state
// lives in colour and motion rather than in words.
//
// Takes keyboard focus in exactly one state, `preview`, where it has to
// because it is asking for a keystroke. A HUD that steals focus mid-sentence
// is worse than no HUD.
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
  readonly property bool failed: phase === "error"
  readonly property bool commanding: mode === "command"

  readonly property color tone: failed ? Theme.danger
    : phase === "done" ? Theme.ok
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
    if (phase === "listening") return commanding ? "listening for a command" : "listening"
    if (phase === "transcribing") return matchedIntent !== "" ? matchedIntent : "transcribing"
    if (phase === "preview") return "enter to insert · esc to discard"
    if (phase === "done") return commanding && matchedIntent !== "" ? matchedIntent : "inserted"
    return ""
  }

  PanelWindow {
    id: window
    visible: root.active
    anchors { bottom: true; left: true; right: true }
    margins.bottom: Style.bar.sizeHorizontal + Style.gapsOut * 3
    implicitHeight: card.implicitHeight + Style.space(30)
    color: "transparent"
    WlrLayershell.namespace: "omarchy-desktop-agent-voice"
    WlrLayershell.keyboardFocus: root.phase === "preview"
      ? WlrKeyboardFocus.Exclusive : WlrKeyboardFocus.None
    WlrLayershell.layer: WlrLayer.Overlay
    exclusionMode: ExclusionMode.Ignore

    Item {
      id: card
      anchors.horizontalCenter: parent.horizontalCenter
      anchors.bottom: parent.bottom
      anchors.bottomMargin: Style.space(8)
      width: Math.min(Math.max(Style.space(320), inner.implicitWidth + Style.spacing.popupPadding * 2),
                      parent.width - Style.gapsOut * 4)
      implicitHeight: inner.implicitHeight + Style.spacing.popupPadding * 2

      opacity: root.active ? 1 : 0
      transform: Translate { y: root.active ? 0 : Style.space(12) }
      Behavior on opacity { NumberAnimation { duration: Theme.fast; easing.type: Easing.OutCubic } }

      MultiEffect {
        anchors.fill: plate
        source: plate
        shadowEnabled: true
        shadowColor: Util.alpha(root.tone, root.listening ? 0.7 : 0.45)
        shadowBlur: 1.0
        shadowScale: 1.03
        Behavior on shadowColor { ColorAnimation { duration: Theme.normal } }
      }

      Rectangle {
        id: plate
        anchors.fill: parent
        radius: Style.cornerRadius
        color: Theme.cardBackground
      }

      HudScanlines { anchors.fill: parent; color: Theme.cardText }
      HudFrame { anchors.fill: parent; color: root.tone }

      Row {
        id: inner
        anchors.centerIn: parent
        width: parent.width - Style.spacing.popupPadding * 2
        spacing: Style.spacing.xl

        // ---- state glyph with a breathing halo while it hears you
        Item {
          width: Style.space(28); height: Style.space(28)
          anchors.verticalCenter: parent.verticalCenter

          Rectangle {
            anchors.centerIn: parent
            width: parent.width; height: parent.height
            radius: width / 2
            color: Util.alpha(root.tone, 0.18)
            visible: root.listening
            SequentialAnimation on scale {
              running: root.listening
              loops: Animation.Infinite
              NumberAnimation { from: 0.82; to: 1.18; duration: 880; easing.type: Easing.InOutQuad }
              NumberAnimation { from: 1.18; to: 0.82; duration: 880; easing.type: Easing.InOutQuad }
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
          width: parent.width - Style.space(28) - Style.spacing.xl
          anchors.verticalCenter: parent.verticalCenter
          spacing: Style.spacing.xs

          // ---- waveform, newest sample on the right so it reads
          // left-to-right like the text it is about to become
          Item {
            width: parent.width
            height: Style.space(24)
            visible: root.listening

            Row {
              anchors.centerIn: parent
              spacing: Style.space(2)

              Repeater {
                model: 32
                Rectangle {
                  readonly property real level: {
                    var l = root.levels
                    if (!l || l.length === 0) return 0
                    var i = l.length - 32 + index
                    return i >= 0 && i < l.length ? Math.max(0, Math.min(1, l[i])) : 0
                  }
                  width: Style.space(3)
                  height: Style.space(3) + level * Style.space(21)
                  radius: width / 2
                  anchors.verticalCenter: parent.verticalCenter
                  // Bars brighten with level rather than only growing, so a
                  // quiet room still looks alive instead of dead flat.
                  color: Util.alpha(root.tone, 0.3 + level * 0.7)
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

            HudLabel {
              text: root.caption
              tone: root.failed ? Theme.danger : Theme.cardText
              color: root.failed ? Theme.danger : Util.alpha(Theme.cardText, 0.55)
            }

            HudLabel {
              visible: root.listening && root.elapsed >= 1
              text: "· " + Math.floor(root.elapsed) + "s"
              tone: Theme.cardText
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
