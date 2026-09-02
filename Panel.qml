// Desktop Agent control panel.
//
// Reads state off the service object the shell injects. It keeps no copy of
// its own: an earlier version re-probed the same facts with its own
// subprocesses and ran its own lease clock, which meant the bar and the panel
// could disagree about whether a lease was running.
//
// Laid out as an instrument rather than a form -- a status block you read at
// a glance, then controls in descending order of how often they are wanted
// and ascending order of how much damage they do.

import QtQuick
import QtQuick.Effects
import Quickshell
import Quickshell.Io
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
  property var service: null
  readonly property var barIdentity: hostWidget || root

  readonly property string fontFamily: root.bar ? root.bar.fontFamily : Style.font.family

  readonly property bool policyEnabled: service ? service.policyEnabled : true
  readonly property bool policyReadable: service ? service.policyReadable : true
  readonly property int pendingCount: service ? service.pendingCount : 0
  readonly property bool yoloActive: service ? service.yoloActive : false
  readonly property string yoloClock: service ? service.yoloClock : "0:00"
  readonly property bool voiceAvailable: service ? service.voiceAvailable : false
  readonly property string voicePhase: service ? service.voiceState : "idle"
  readonly property bool listening: voicePhase === "listening"

  readonly property color tone: !policyEnabled || !policyReadable ? Theme.danger
    : yoloActive ? Theme.caution
    : listening ? Theme.ok
    : Theme.ok

  readonly property string glyph: !policyEnabled ? "󰜺"
    : listening ? "󰍬" : yoloActive ? "󰸋" : "󰂽"

  readonly property string statusLine: !policyReadable ? "policy unreadable — everything refuses"
    : !policyEnabled ? "kill switch on — every gated action refuses"
    : yoloActive ? "full access · " + yoloClock + " left"
    : listening ? "listening"
    : "policy active"

  function refresh() { if (service) { service.probe(); service.readYolo() } }
  function toggleKillswitch() { if (service) service.toggleKillswitch() }

  function open() { setCenterHoverRevealSuppressed(false); root.controller.show(); refresh() }
  function openFromHotkey() {
    root.controller.show(); refresh()
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

  // Restored after being dropped in the redesign: without it the panel has an
  // ipcTarget nobody serves, so `ipc call ... panel open` answers "Target not
  // found" and the only way in is the bar icon.
  IpcHandler {
    target: root.ipcTarget

    function open(): void { root.openFromHotkey() }
    function close(): void { root.close() }
    function show(): void { root.openFromHotkey() }
    function hide(): void { root.close() }
    function toggle(): void { root.toggle() }
  }

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    centerOnBar: true
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(430))
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

          // ---- status block
          Item {
            width: parent.width
            height: hero.implicitHeight + Style.spacing.xxl * 2

            MultiEffect {
              anchors.fill: heroPlate
              source: heroPlate
              shadowEnabled: true
              shadowColor: Util.alpha(root.tone, 0.35)
              shadowBlur: 0.9
              shadowScale: 1.02
            }

            Rectangle {
              id: heroPlate
              anchors.fill: parent
              radius: Style.cornerRadius
              color: Util.alpha(root.tone, 0.06)
            }

            HudScanlines { anchors.fill: parent; color: Color.foreground; strength: 0.02 }
            HudFrame { anchors.fill: parent; color: root.tone; hairlineOpacity: 0.16 }

            Row {
              id: hero
              anchors.left: parent.left
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              anchors.margins: Style.spacing.xxl
              spacing: Style.spacing.xxl

              Text {
                anchors.verticalCenter: parent.verticalCenter
                text: root.glyph
                color: root.tone
                font.family: root.fontFamily
                font.pixelSize: Style.font.displayLarge
              }

              Column {
                anchors.verticalCenter: parent.verticalCenter
                width: parent.width - Style.space(40) - Style.spacing.xxl
                spacing: Style.spacing.xs

                HudLabel { text: "desktop agent"; tone: Color.foreground }

                Text {
                  width: parent.width
                  text: root.statusLine
                  color: root.tone
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.subtitle
                  font.bold: true
                  elide: Text.ElideRight
                }
              }
            }
          }

          // ---- readouts
          Row {
            width: parent.width
            spacing: Style.spacing.controlGap

            Repeater {
              model: [
                { k: "voice",   v: root.voiceAvailable ? "ready" : "offline", ok: root.voiceAvailable },
                { k: "waiting", v: String(root.pendingCount),                 ok: root.pendingCount === 0 },
                { k: "policy",  v: root.policyEnabled ? "armed" : "off",      ok: root.policyEnabled },
              ]
              Item {
                width: (main.width - Style.spacing.controlGap * 2) / 3
                height: cell.implicitHeight + Style.spacing.xl * 2

                Rectangle {
                  anchors.fill: parent
                  radius: Style.cornerRadius
                  color: Util.alpha(Color.foreground, 0.04)
                  border.width: 1
                  border.color: Util.alpha(modelData.ok ? Color.foreground : Theme.danger, 0.16)
                }

                Column {
                  id: cell
                  anchors.centerIn: parent
                  spacing: Style.spacing.xxs

                  HudLabel {
                    text: modelData.k
                    tone: Color.foreground
                    anchors.horizontalCenter: parent.horizontalCenter
                  }
                  Text {
                    anchors.horizontalCenter: parent.horizontalCenter
                    text: modelData.v
                    color: modelData.ok ? Color.foreground : Theme.danger
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.body
                    font.bold: true
                  }
                }
              }
            }
          }

          HudRail { width: parent.width; color: root.tone; sweep: root.listening }

          // ---- lease
          Column {
            width: parent.width
            spacing: Style.spacing.md

            HudLabel {
              text: root.yoloActive ? "full access · " + root.yoloClock + " left" : "full access"
              tone: root.yoloActive ? Theme.caution : Color.foreground
              color: root.yoloActive ? Theme.caution : Util.alpha(Color.foreground, 0.45)
            }

            Text {
              width: parent.width
              wrapMode: Text.WordWrap
              text: root.yoloActive
                ? "Approvals are being granted without asking. Destructive commands and anything denied still stop."
                : "Skip approvals for a while. Never overrides a denial, and never auto-runs rm, dd, chmod, kill, systemctl or a package manager."
              color: Util.alpha(Color.foreground, 0.62)
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

          HudRail { width: parent.width; color: Color.foreground }

          // ---- controls, most destructive last
          Column {
            width: parent.width
            spacing: Style.spacing.controlGap

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
          }
        }
      }
    }
  }
}
