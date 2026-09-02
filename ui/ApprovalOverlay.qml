import QtQuick
import Quickshell
import Quickshell.Wayland
import qs.Commons
import qs.Ui
import "."

// The approval prompt.
//
// This is an authorization dialog, so it is built on the shell's polkit
// surface rather than the generic popup one: same background, same border
// tokens, same scrim, same gradient if the theme defines one. A user who has
// themed "something wants permission" has themed this too, and it sits next
// to the system password prompt without looking like a different application
// wrote it.
//
// Three things this deliberately does that the version it replaces did not:
//
//   * The auto-deny timeout is visible. A prompt that silently expires after
//     two minutes trains people to distrust the whole mechanism -- you walk
//     back to your desk, the thing was refused, and nothing ever said so. The
//     bar across the top drains in real time and the button relabels itself as
//     it gets close.
//   * Severity is carried by the card, not just the text. A destructive
//     command re-tints the border and the header so the irreversible case
//     cannot be waved through with the same muscle memory as a click.
//   * Nothing is a hardcoded colour, so it survives a theme swap mid-prompt.
Item {
  id: root

  // { id, tool, capability, scope, target, reasons[], principal, severity }
  property var request: null
  property int queueDepth: 0
  // Seconds the server will wait before treating silence as a denial.
  property int timeoutSec: 120
  property int remainingSec: 0

  signal answered(string verdict)

  readonly property bool active: request !== null
  readonly property bool destructive: request && String(request.severity || "") === "destructive"
  readonly property string principal: request ? String(request.principal || "claude") : ""

  // Danger recolours the whole card, not just a label.
  readonly property color tone: destructive ? Theme.danger : Theme.authAccent
  readonly property color edge: destructive ? Theme.authBorderError : Theme.authBorder

  readonly property real fraction: timeoutSec > 0 ? Math.max(0, Math.min(1, remainingSec / timeoutSec)) : 0
  // Only start nagging in the last quarter; before that the countdown is
  // information, not pressure.
  readonly property bool urgentClock: fraction > 0 && fraction < 0.25

  function answer(verdict) {
    if (!root.active) return
    root.answered(verdict)
  }

  onActiveChanged: if (active) root.remainingSec = root.timeoutSec

  Timer {
    interval: 1000
    repeat: true
    running: root.active
    onTriggered: if (root.remainingSec > 0) root.remainingSec--
  }

  PanelWindow {
    id: window
    visible: root.active
    anchors { top: true; bottom: true; left: true; right: true }
    color: "transparent"
    WlrLayershell.namespace: "omarchy-desktop-agent-approval"
    WlrLayershell.layer: WlrLayer.Overlay
    WlrLayershell.keyboardFocus: WlrKeyboardFocus.Exclusive
    exclusionMode: ExclusionMode.Ignore

    Rectangle {
      anchors.fill: parent
      color: Theme.authScrim
      opacity: root.active ? 1 : 0
      Behavior on opacity { NumberAnimation { duration: Theme.normal; easing.type: Easing.OutCubic } }
    }

    BorderSurface {
      id: card
      width: Math.min(Style.space(560), parent.width - Style.gapsOut * 2)
      height: Math.min(content.implicitHeight + Style.spacing.panelPadding * 2,
                       parent.height - Style.gapsOut * 2)
      anchors.centerIn: parent
      radius: Style.cornerRadius
      color: Theme.authBackground
      borderSpec: Border.surfaceSpec("polkit",
                                     root.destructive ? "border-error" : "border",
                                     root.edge,
                                     Math.max(1, Style.space(2)),
                                     "border-alpha")

      // Rises slightly as it appears. Enough to register as "this arrived",
      // not enough to make you wait for it.
      opacity: root.active ? 1 : 0
      scale: root.active ? 1 : 0.97
      Behavior on opacity { NumberAnimation { duration: Theme.normal; easing.type: Easing.OutCubic } }
      Behavior on scale { NumberAnimation { duration: Theme.normal; easing.type: Easing.OutCubic } }

      Column {
        id: content
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        anchors.margins: Style.spacing.panelPadding
        spacing: Style.spacing.xl

        // ---- countdown to auto-deny
        Rectangle {
          width: parent.width
          height: Style.space(3)
          radius: height / 2
          color: Util.alpha(Theme.authText, 0.12)

          Rectangle {
            width: parent.width * root.fraction
            height: parent.height
            radius: parent.radius
            color: root.urgentClock ? Theme.danger : root.tone
            Behavior on width { NumberAnimation { duration: 1000; easing.type: Easing.Linear } }
            Behavior on color { ColorAnimation { duration: Theme.fast } }
          }
        }

        // ---- header
        Row {
          width: parent.width
          spacing: Style.spacing.xl

          Text {
            anchors.verticalCenter: parent.verticalCenter
            text: root.principal === "voice" ? "󰔞" : "󰂽"
            color: root.tone
            font.family: Style.font.family
            font.pixelSize: Style.font.displayLarge
          }

          Column {
            anchors.verticalCenter: parent.verticalCenter
            width: parent.width - Style.space(52)
            spacing: Style.spacing.xxs

            Text {
              width: parent.width
              text: root.destructive ? "This cannot be undone" : "Desktop Agent wants permission"
              color: root.destructive ? Theme.authTextError : Theme.authText
              font.family: Style.font.family
              font.pixelSize: Style.font.heading
              font.bold: true
              elide: Text.ElideRight
            }

            Text {
              width: parent.width
              text: root.principal === "voice"
                ? "Asked for by something you said"
                : "Asked for by " + root.principal
              color: Theme.authTextSecondary
              font.family: Style.font.family
              font.pixelSize: Style.font.caption
            }
          }
        }

        Rectangle { width: parent.width; height: 1; color: Util.alpha(Theme.authText, 0.14) }

        // ---- what is being asked for
        Column {
          width: parent.width
          spacing: Style.spacing.sm

          Text {
            width: parent.width
            text: root.request ? String(root.request.tool || "") : ""
            color: Theme.authText
            font.family: Style.font.family
            font.pixelSize: Style.font.subtitle
            font.bold: true
            wrapMode: Text.Wrap
          }

          Text {
            width: parent.width
            text: root.request ? String(root.request.target || "") : ""
            color: Theme.authTextSecondary
            font.family: Style.font.family
            font.pixelSize: Style.font.bodySmall
            wrapMode: Text.Wrap
            visible: text !== ""
          }
        }

        // ---- why the policy stopped, rather than a black box to approve
        Column {
          width: parent.width
          spacing: Style.spacing.xxs
          visible: root.request && root.request.reasons && root.request.reasons.length > 0

          Text {
            text: "WHY YOU ARE BEING ASKED"
            color: Theme.authTextTertiary
            font.family: Style.font.family
            font.pixelSize: Style.font.caption
            font.bold: true
            font.letterSpacing: 1
          }

          Repeater {
            model: root.request && root.request.reasons ? root.request.reasons : []
            Text {
              width: content.width
              text: "· " + modelData
              color: Theme.authTextSecondary
              font.family: Style.font.family
              font.pixelSize: Style.font.caption
              wrapMode: Text.Wrap
            }
          }
        }

        // ---- queue depth
        Text {
          width: parent.width
          visible: root.queueDepth > 1
          text: (root.queueDepth - 1) + " more waiting behind this one"
          color: root.tone
          font.family: Style.font.family
          font.pixelSize: Style.font.caption
        }

        // ---- actions
        Row {
          anchors.right: parent.right
          spacing: Style.spacing.controlGap

          Button {
            text: root.remainingSec > 0 && root.urgentClock
              ? "Deny  ·  " + root.remainingSec + "s"
              : "Deny  Esc"
            foreground: Theme.danger
            accent: Theme.danger
            bordered: true
            focusable: true
            fontSize: Style.font.bodySmall
            tooltipText: "Refuse this once. Silence does the same thing."
            onClicked: root.answer("deny")
          }

          Button {
            text: "Allow once  ⏎"
            foreground: root.tone
            accent: root.tone
            bordered: true
            focusable: true
            fontSize: Style.font.bodySmall
            onClicked: root.answer("allow")
          }

          // Deliberately the quietest of the three. "Always" is the answer
          // people reach for to make a prompt stop, and it is the one that
          // should take the most intent to pick.
          Button {
            text: "Always  A"
            visible: !root.destructive
            foreground: Theme.authTextSecondary
            accent: root.tone
            focusable: true
            fontSize: Style.font.bodySmall
            tooltipText: "Allow this scope until the agent's server restarts."
            onClicked: root.answer("always")
          }
        }

        Text {
          width: parent.width
          text: root.destructive
            ? "Destructive actions are never auto-approved, lease or no lease."
            : "\"Always\" lasts until the server restarts. Edit the policy to make it permanent."
          color: Theme.authTextTertiary
          font.family: Style.font.family
          font.pixelSize: Style.font.caption
          wrapMode: Text.Wrap
        }
      }
    }

    // Keyboard is owned here rather than on a child so it keeps working no
    // matter which button happens to hold focus.
    Item {
      anchors.fill: parent
      focus: window.visible
      Keys.onPressed: function(event) {
        if (event.key === Qt.Key_Escape) { root.answer("deny"); event.accepted = true }
        else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) { root.answer("allow"); event.accepted = true }
        else if (event.key === Qt.Key_A && !root.destructive) { root.answer("always"); event.accepted = true }
      }
    }
  }
}
