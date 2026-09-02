import QtQuick
import qs.Commons
import "."

// The panel's section switcher.
//
// Underline rather than a filled pill: a filled tab competes with the state
// colour the rest of the panel uses to mean something, and this bar should
// never look like a status.
Item {
  id: root
  property var tabs: []
  property int current: 0
  signal picked(int index)

  implicitHeight: row.implicitHeight + Style.spacing.md

  Row {
    id: row
    anchors.left: parent.left
    spacing: Style.spacing.xxl

    Repeater {
      model: root.tabs
      Item {
        width: label.implicitWidth
        height: label.implicitHeight + Style.spacing.md

        HudLabel {
          id: label
          text: modelData
          tone: Color.foreground
          color: index === root.current ? Color.accent : Util.alpha(Color.foreground, 0.38)
          Behavior on color { ColorAnimation { duration: 120 } }
        }

        Rectangle {
          anchors.bottom: parent.bottom
          anchors.left: parent.left
          width: index === root.current ? parent.width : 0
          height: Math.max(1, Style.space(1.5))
          color: Color.accent
          Behavior on width { NumberAnimation { duration: 160; easing.type: Easing.OutCubic } }
        }

        MouseArea {
          anchors.fill: parent
          hoverEnabled: true
          cursorShape: Qt.PointingHandCursor
          onClicked: root.picked(index)
        }
      }
    }
  }

  Rectangle {
    anchors.bottom: parent.bottom
    width: parent.width
    height: 1
    color: Util.alpha(Color.foreground, 0.10)
  }
}
