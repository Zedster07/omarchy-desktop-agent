// Desktop Agent control panel.
//
// Reads everything off the service object the shell injects. The version this
// replaces re-probed the same facts with its own subprocesses and kept its own
// copy of the lease clock, which meant the bar and the panel could disagree
// about whether a lease was running. There is one owner now, and this is not
// it.

import QtQuick
import Quickshell
import qs.Commons
import qs.Ui
import "ui"

Panel {
  id: root
  moduleName: "io.github.zedster07.desktop-agent"
  ipcTarget: "io.github.zedster07.desktop-agent.panel"
  manageIpc: false

  property var anchorItem: null
  property var hostWidget: null
  // Injected by the panel loader for plugins that pair a panel with a service.
  property var service: null
  readonly property var barIdentity: hostWidget || root

  readonly property string fontFamily: root.bar ? root.bar.fontFamily : Style.font.family

  // ---- mirrored service state (read-only; this panel never writes it)
  readonly property bool policyEnabled: service ? service.policyEnabled : true
  readonly property bool policyReadable: service ? service.policyReadable : true
  readonly property int pendingCount: service ? service.pendingCount : 0
  readonly property bool yoloActive: service ? service.yoloActive : false
  readonly property string yoloClock: service ? service.yoloClock : "0:00"
  readonly property bool voiceAvailable: service ? service.voiceAvailable : false
  readonly property string voicePhase: service ? service.voiceState : "idle"
  readonly property bool listening: voicePhase === "listening"

  readonly property string glyph: !policyEnabled ? "󰜺"
    : listening ? "󰍬"
    : yoloActive ? "󰸋"
    : "󰂽"

  function refresh() { if (service) { service.probe(); service.readYolo() } }
  function toggleKillswitch() { if (service) service.toggleKillswitch() }

  function open() { setCenterHoverRevealSuppressed(false); root.controller.show(); refresh() }
  function openFromHotkey() {
    root.controller.show()
    refresh()
    Qt.callLater(function() { if (root.opened) setCenterHoverRevealSuppressed(true) })
  }
  function close() { setCenterHoverRevealSuppressed(false); root.controller.hide() }
  function toggle() { if (root.opened) root.close(); else root.openFromHotkey() }

  function switchPanel(direction) {
    if (root.bar && typeof root.bar.switchPanelFrom === "function")
      return root.bar.switchPanelFrom(root.barIdentity, direction)
    return false
  }

  function setCenterHoverRevealSuppressed(value) {
    if (root.bar && "centerHoverRevealSuppressed" in root.bar)
      root.bar.centerHoverRevealSuppressed = value
  }

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    centerOnBar: true
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(440))
    contentHeight: panel.fittedContentHeight(main.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onCloseRequested: root.close()
      onReturnRequested: root.refresh()
      onTabRequested: function(direction) { root.switchPanel(direction) }

      Flickable {
        id: scroll
        anchors.fill: parent
        contentWidth: width
        contentHeight: main.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        interactive: contentHeight > height

        Column {
          id: main
          width: scroll.width
          spacing: Style.spacing.xxl

          // ---- header
          Row {
            spacing: Style.spacing.xxl
            leftPadding: Style.spacing.sm

            Text {
              anchors.verticalCenter: parent.verticalCenter
              text: root.glyph
              color: !root.policyEnabled ? Theme.danger
                : root.listening ? Theme.ok
                : root.yoloActive ? Theme.caution
                : Theme.ok
              font.family: root.fontFamily
              font.pixelSize: Style.font.displayLarge
            }

            Column {
              anchors.verticalCenter: parent.verticalCenter
              spacing: Style.spacing.xxs

              Text {
                text: "DESKTOP AGENT"
                color: Color.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.title
                font.bold: true
                font.letterSpacing: 1
              }

              Text {
                text: !root.policyReadable ? "Policy unreadable — everything refuses"
                  : !root.policyEnabled ? "Kill switch on — every gated action refuses"
                  : root.yoloActive ? "Full access for " + root.yoloClock
                  : root.listening ? "Listening"
                  : "Policy active"
                color: (!root.policyEnabled || !root.policyReadable) ? Theme.danger
                  : root.yoloActive ? Theme.caution
                  : Util.alpha(Color.foreground, 0.72)
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
              }
            }
          }

          PanelSeparator { width: parent.width }

          // ---- status
          Column {
            width: parent.width
            spacing: Style.spacing.md

            StatusRow {
              width: parent.width
              label: "Voice"
              value: root.voiceAvailable ? "ready" : "not running"
              good: root.voiceAvailable
              fontFamily: root.fontFamily
            }

            StatusRow {
              width: parent.width
              label: "Waiting for you"
              value: String(root.pendingCount)
              good: root.pendingCount === 0
              fontFamily: root.fontFamily
            }
          }

          PanelSeparator { width: parent.width }

          // ---- lease
          Column {
            width: parent.width
            spacing: Style.spacing.md

            PanelSectionHeader {
              width: parent.width
              text: root.yoloActive ? "FULL ACCESS — " + root.yoloClock + " LEFT" : "FULL ACCESS"
            }

            Text {
              width: parent.width
              wrapMode: Text.WordWrap
              text: root.yoloActive
                ? "Approvals are being granted without asking. Destructive commands and anything denied still stop."
                : "Skip approvals for a while. Never overrides a denial, and never auto-runs rm, dd, chmod, kill, systemctl or a package manager."
              color: Util.alpha(Color.foreground, 0.72)
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
            }

            Row {
              visible: !root.yoloActive && root.policyEnabled
              width: parent.width
              spacing: Style.spacing.controlGap

              Repeater {
                model: [15, 30, 60]
                Button {
                  text: modelData + " min"
                  foreground: Theme.caution
                  accent: Theme.caution
                  bordered: true
                  focusable: true
                  fontSize: Style.font.bodySmall
                  onClicked: if (root.service) root.service.grantYolo(modelData)
                }
              }
            }

            Button {
              visible: root.yoloActive
              text: "End full access now"
              foreground: Theme.ok
              accent: Theme.ok
              bordered: true
              focusable: true
              fontSize: Style.font.bodySmall
              onClicked: if (root.service) root.service.endYolo()
            }
          }

          PanelSeparator { width: parent.width }

          // ---- actions
          Column {
            width: parent.width
            spacing: Style.spacing.controlGap

            Button {
              width: parent.width
              text: root.policyEnabled ? "Disable — emergency kill switch" : "Re-enable policy"
              foreground: root.policyEnabled ? Theme.danger : Theme.ok
              accent: root.policyEnabled ? Theme.danger : Theme.ok
              bordered: true
              focusable: true
              fontSize: Style.font.bodySmall
              onClicked: root.toggleKillswitch()
            }

            Row {
              width: parent.width
              spacing: Style.spacing.controlGap

              Button {
                text: "Edit policy"
                foreground: Color.foreground
                bordered: true
                focusable: true
                fontSize: Style.font.bodySmall
                onClicked: { if (root.service) root.service.openPolicy(); root.close() }
              }

              Button {
                text: "Audit log"
                foreground: Color.foreground
                bordered: true
                focusable: true
                fontSize: Style.font.bodySmall
                onClicked: { if (root.service) root.service.openAuditLog(); root.close() }
              }
            }
          }
        }
      }
    }
  }
}
