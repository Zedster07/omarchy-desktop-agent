import QtQuick
import qs.Commons
import "."

// One "label — value" line. Value is coloured by meaning, never by literal.
Row {
  id: root
  property string label: ""
  property string value: ""
  property bool good: true
  property string fontFamily: Style.font.family

  spacing: Style.spacing.lg

  Text {
    text: root.label
    color: Util.alpha(Color.foreground, 0.72)
    font.family: root.fontFamily
    font.pixelSize: Style.font.bodySmall
  }

  Text {
    text: root.value
    color: root.good ? Color.foreground : Theme.danger
    font.family: root.fontFamily
    font.pixelSize: Style.font.bodySmall
    font.bold: true
  }
}
