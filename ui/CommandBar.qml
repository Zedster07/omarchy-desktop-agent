import QtQuick
import QtQuick.Effects
import Quickshell
import Quickshell.Wayland
import qs.Commons
import qs.Ui
import "."

// Typing the same requests you would say.
//
// The voice HUD is radial because it is showing you something continuous --
// your voice arriving. Text is a line, so this is a line: a single field in the
// middle of the screen, the same brackets and bloom, and the same pipeline
// behind it. Nothing here decides anything; it collects a sentence and hands it
// to the daemon that already knows what to do with one.
//
// It DOES take keyboard focus, unlike every other surface in this plugin --
// obviously, since it is asking you to type. Escape gives it back.
Item {
  id: root

  property bool open: false
  // idle | working | done | error
  property string phase: "idle"
  property string result: ""

  signal submitted(string text)
  signal dismissed()

  readonly property color tone: phase === "error" ? Theme.danger
    : phase === "done" ? Theme.ok
    : Theme.caution

  function show() { root.open = true; field.text = ""; root.phase = "idle"; root.result = ""; field.forceActiveFocus() }
  function hide() { root.open = false; field.text = "" }

  onOpenChanged: if (open) Qt.callLater(function() { field.forceActiveFocus() })

  PanelWindow {
    id: window
    visible: root.open
    anchors { top: true; bottom: true; left: true; right: true }
    color: "transparent"
    WlrLayershell.namespace: "omarchy-desktop-agent-prompt"
    WlrLayershell.layer: WlrLayer.Overlay
    WlrLayershell.keyboardFocus: WlrKeyboardFocus.Exclusive
    exclusionMode: ExclusionMode.Ignore

    // Translucent so the compositor blur behind this layer has something to
    // work through; an opaque fill would blur nothing.
    Rectangle {
      anchors.fill: parent
      color: Qt.rgba(0, 0, 0, 1)
      opacity: root.open ? 0.42 : 0
      Behavior on opacity { NumberAnimation { duration: Theme.normal; easing.type: Easing.OutCubic } }
    }

    MouseArea {
      anchors.fill: parent
      onClicked: root.dismissed()
    }

    Item {
      id: stage
      anchors.centerIn: parent
      width: Math.min(Style.space(760), parent.width - Style.gapsOut * 6)
      height: card.implicitHeight

      opacity: root.open ? 1 : 0
      scale: root.open ? 1 : 0.96
      transform: Translate { y: root.open ? 0 : Style.space(10) }
      Behavior on opacity { NumberAnimation { duration: Theme.fast; easing.type: Easing.OutCubic } }
      Behavior on scale { NumberAnimation { duration: Theme.normal; easing.type: Easing.OutBack } }

      MultiEffect {
        anchors.fill: plate
        source: plate
        shadowEnabled: true
        shadowColor: Util.alpha(root.tone, 0.6)
        shadowBlur: 1.0
        shadowScale: 1.03
        Behavior on shadowColor { ColorAnimation { duration: Theme.normal } }
      }

      Rectangle {
        id: plate
        anchors.fill: parent
        radius: Style.cornerRadius
        color: Util.alpha(Theme.cardBackground, 0.88)
      }

      HudScanlines { anchors.fill: parent; color: Theme.cardText }
      HudFrame { anchors.fill: parent; color: root.tone; armRatio: 0.05 }

      Column {
        id: card
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        anchors.margins: Style.spacing.huge
        spacing: Style.spacing.lg

        Row {
          width: parent.width
          spacing: Style.spacing.xxl

          // A small ring, so this reads as the same instrument as the voice
          // core rather than a search box that wandered in.
          Item {
            width: Style.space(34); height: Style.space(34)
            anchors.verticalCenter: parent.verticalCenter

            Rectangle {
              anchors.fill: parent
              radius: width / 2
              color: "transparent"
              border.width: Math.max(1, Style.space(1.5))
              border.color: Util.alpha(root.tone, 0.55)
            }
            Rectangle {
              anchors.centerIn: parent
              width: parent.width * 0.44; height: width
              radius: width / 2
              color: Util.alpha(root.tone, 0.22)
              SequentialAnimation on scale {
                running: root.phase === "working"
                loops: Animation.Infinite
                NumberAnimation { from: 0.7; to: 1.25; duration: 700; easing.type: Easing.InOutQuad }
                NumberAnimation { from: 1.25; to: 0.7; duration: 700; easing.type: Easing.InOutQuad }
              }
            }
            Text {
              anchors.centerIn: parent
              text: root.phase === "error" ? "󰍭" : root.phase === "done" ? "󰄬" : "󰘳"
              color: root.tone
              font.family: Style.font.family
              font.pixelSize: Style.font.bodySmall
            }
          }

          TextField {
            id: field
            width: parent.width - Style.space(34) - Style.spacing.xxl
            anchors.verticalCenter: parent.verticalCenter
            enabled: root.phase !== "working"
            placeholderText: "what would you like done?"
            foreground: Theme.cardText
            accent: root.tone
            font.family: Style.font.family
            font.pixelSize: Style.font.heading
            onAccepted: {
              var t = text.trim()
              if (t.length === 0) return
              root.phase = "working"
              root.result = ""
              root.submitted(t)
            }
          }
        }

        HudRail {
          width: parent.width
          color: root.tone
          sweep: root.phase === "working"
          opacity: 0.9
        }

        Row {
          width: parent.width
          spacing: Style.spacing.md

          HudLabel {
            text: root.phase === "working" ? "thinking"
              : root.phase === "error" ? "failed"
              : root.phase === "done" ? "done"
              : "enter to run · esc to close"
            tone: root.tone
            color: root.phase === "idle" ? Util.alpha(Theme.cardText, 0.45) : root.tone
          }

          Text {
            width: parent.width - Style.space(160)
            visible: root.result !== ""
            text: root.result
            color: root.phase === "error" ? Theme.danger : Util.alpha(Theme.cardText, 0.8)
            font.family: Style.font.family
            font.pixelSize: Style.font.caption
            elide: Text.ElideRight
          }
        }
      }
    }

    Item {
      anchors.fill: parent
      focus: root.open
      Keys.onEscapePressed: root.dismissed()
    }
  }
}
