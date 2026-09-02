import QtQuick
import qs.Commons
import qs.Ui

// The bar pill. Carries state in the glyph, detail in the tooltip -- the slot
// is a fixed square, so there is nowhere for a countdown to sit beside it.
BarWidget {
  id: root
  moduleName: "io.github.zedster07.desktop-agent"

  readonly property var panel: panelLoader.item
  readonly property bool opened: panel ? panel.opened === true : false
  readonly property bool popoutSwitchClosing: panel ? panel.popoutSwitchClosing === true : false

  function injectPanel() {
    var t = panelLoader.item
    if (!t) return
    if ("bar" in t) t.bar = root.bar
    if ("settings" in t) t.settings = root.settings
    if ("anchorItem" in t) t.anchorItem = button
    if ("hostWidget" in t) t.hostWidget = root
  }

  function refresh() { if (panel && panel.refresh) panel.refresh() }
  function togglePanel() { if (panel && panel.toggle) panel.toggle() }
  function open() { if (panel && panel.openFromHotkey) panel.openFromHotkey() }
  function close() { if (panel && panel.close) panel.close() }
  function closeForPopoutSwitch() { if (panel) panel.closeForPopoutSwitch() }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onBarChanged: injectPanel()
  onSettingsChanged: injectPanel()

  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("Panel.qml")
    visible: false
    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
    }
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    slotSize: Style.bar.statusSlot
    text: root.panel ? root.panel.glyph : "󰂽"

    tooltipText: {
      if (!root.panel) return "Desktop Agent"
      if (root.panel.policyEnabled === false) return "Desktop Agent — kill switch on, every gated action refuses"
      if (root.panel.listening) return "Desktop Agent — listening"
      if (root.panel.yoloActive) return "Desktop Agent — full access for " + root.panel.yoloClock
      if (root.panel.pendingCount > 0) return "Desktop Agent — " + root.panel.pendingCount + " waiting for you"
      return "Desktop Agent — policy active (right-click for the kill switch)"
    }

    onPressed: function(b) {
      if (!root.bar) return
      if (b === Qt.RightButton) { if (root.panel && root.panel.toggleKillswitch) root.panel.toggleKillswitch() }
      else if (b === Qt.MiddleButton) root.refresh()
      else root.togglePanel()
    }
  }
}
