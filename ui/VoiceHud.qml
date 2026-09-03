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
  readonly property bool working: phase === "transcribing" || phase === "working"
  readonly property bool failed: phase === "error"
  readonly property bool done: phase === "done"
  readonly property bool commanding: mode === "command"

  // Full screen is for the moment you are TALKING and nothing else.
  //
  // While you hold the key you are addressing the machine, so it can have the
  // screen -- there is nothing else to look at. The moment it starts working
  // that inverts: the whole point of watching an agent is watching it act on
  // YOUR screen, and a scrim over the top hides the only thing worth seeing.
  // So work, results and failures move to a corner readout that never covers
  // anything and never takes a click.
  readonly property bool immersive: listening || phase === "preview"

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
    if (working) return phase === "working" ? "agent" : "processing"
    if (done) return "executed"
    if (phase === "preview") return "confirm"
    return commanding ? "command" : "dictation"
  }

  readonly property string caption: {
    if (failed) return errorText !== "" ? errorText : "Didn't catch that"
    if (listening) return commanding ? "listening for a command" : "listening"
    if (working) return matchedIntent !== "" ? matchedIntent : phase === "working" ? "working" : "transcribing"
    if (phase === "preview") return "enter to insert · esc to discard"
    if (done) return commanding && matchedIntent !== "" ? matchedIntent : "inserted"
    return ""
  }

  PanelWindow {
    id: window
    visible: root.active

    // The SURFACE shrinks to the readout, it does not just stop painting.
    //
    // Removing the scrim was not enough: the compositor blur rule applies to
    // whatever this surface covers, so a full-screen window with a transparent
    // fill still blurred the entire desktop. The screen looked frosted with
    // nothing drawn on it. Anchored to one corner while compact, the blur
    // lands on the readout and the rest of the screen is untouched.
    // Two shapes, and the difference is the whole point of this file.
    //
    // Listening covers the screen: you are addressing the machine, there is
    // nothing else to look at, and the blur plus dim is what makes it feel
    // like the desktop is waiting on you.
    //
    // Working does the opposite -- corner-sized, no blur, no dim, no input
    // region -- because watching an agent work IS watching your own screen,
    // and anything laid over the top hides the only thing worth seeing.
    anchors {
      top: root.immersive
      left: root.immersive
      bottom: true
      right: true
    }
    margins {
      bottom: root.immersive ? 0 : Style.gapsOut * 2
      right: root.immersive ? 0 : Style.gapsOut * 2
    }
    implicitWidth: root.immersive ? 0 : pill.width
    implicitHeight: root.immersive ? 0 : pill.height
    color: "transparent"
    WlrLayershell.namespace: "omarchy-desktop-agent-voice"
    WlrLayershell.layer: WlrLayer.Overlay
    WlrLayershell.keyboardFocus: root.phase === "preview"
      ? WlrKeyboardFocus.Exclusive : WlrKeyboardFocus.None
    exclusionMode: ExclusionMode.Ignore

    // An empty input region while compact. Without this the surface still
    // covers the screen and silently swallows every click, which is the same
    // complaint as the scrim even once the scrim is invisible.
    mask: root.immersive ? null : passThrough
    Region { id: passThrough }


    // Dim behind the core while listening only. The compositor blurs what this
    // surface covers, and while compact it covers one corner, so this is
    // bound to immersive rather than to active.
    Rectangle {
      anchors.fill: parent
      color: Theme.authScrim
      opacity: root.immersive ? 0.85 : 0
      Behavior on opacity { NumberAnimation { duration: Theme.normal; easing.type: Easing.OutCubic } }
    }

    Item {
      id: stage
      anchors.centerIn: parent
      width: Math.min(Style.space(640), parent.width - Style.gapsOut * 4)
      height: core.height + readout.implicitHeight + Style.spacing.huge

      visible: opacity > 0
      opacity: root.immersive ? 1 : 0
      scale: root.immersive ? 1 : 0.94
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
        width: Style.space(300)
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

    // ---- the corner readout: everything that is not you talking.
    //
    // Bottom right, small, and out of the way. It says what is happening in
    // one line and leaves the rest of the screen alone, because while the
    // agent works the screen IS the interesting part.
    Item {
      id: pill
      anchors.right: parent.right
      anchors.bottom: parent.bottom
      width: pillRow.implicitWidth + Style.spacing.huge * 2
      height: pillRow.implicitHeight + Style.spacing.xl * 2

      visible: opacity > 0
      opacity: root.active && !root.immersive ? 1 : 0
      // Slides up as it appears rather than popping, so something arriving in
      // the corner of your eye reads as arriving and not as a glitch.
      transform: Translate { y: pill.opacity > 0 ? 0 : Style.space(10) }
      Behavior on opacity { NumberAnimation { duration: Theme.normal; easing.type: Easing.OutCubic } }

      MultiEffect {
        anchors.fill: plate
        source: plate
        shadowEnabled: true
        shadowColor: Util.alpha(root.tone, root.working ? 0.34 : 0.2)
        shadowBlur: 1.0
        shadowVerticalOffset: Style.space(4)
        Behavior on shadowColor { ColorAnimation { duration: Theme.normal } }
      }

      Rectangle {
        id: plate
        anchors.fill: parent
        radius: Style.cornerRadius
        color: Util.alpha(Theme.cardBackground, 0.9)
        border.width: Style.spacing.hairline
        border.color: Util.alpha(root.tone, root.working ? 0.5 : 0.28)
        Behavior on border.color { ColorAnimation { duration: Theme.normal } }
      }

      HudScanlines { anchors.fill: parent; color: Theme.cardText; strength: 0.02 }

      Row {
        id: pillRow
        anchors.centerIn: parent
        spacing: Style.spacing.xl

        // The same core, just small. It is the plugin's one recognisable
        // shape, so shrinking it beats swapping in a different indicator --
        // you already know what it means.
        HudCore {
          anchors.verticalCenter: parent.verticalCenter
          width: Style.space(34)
          height: width
          tone: root.tone
          levels: root.levels
          live: false
          working: root.working
          glyph: root.glyph
          fontFamily: Style.font.family
        }

        Column {
          anchors.verticalCenter: parent.verticalCenter
          spacing: Style.spacing.xxs

          HudLabel {
            text: root.statusWord
            tone: root.tone
            color: root.tone
          }

          // What it is actually doing, or what went wrong. One line: this is a
          // glance, not a transcript.
          Text {
            visible: text !== ""
            width: Math.min(implicitWidth, Style.space(420))
            text: root.failed ? (root.errorText !== "" ? root.errorText : root.caption)
              : root.matchedIntent !== "" ? root.matchedIntent
              : root.transcript
            color: root.failed ? Theme.danger : Util.alpha(Theme.cardText, 0.72)
            font.family: Style.font.family
            font.pixelSize: Style.font.caption
            elide: Text.ElideRight
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
