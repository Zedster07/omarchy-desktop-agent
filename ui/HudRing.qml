import QtQuick
import QtQuick.Shapes
import qs.Commons

// Circular countdown.
//
// Replaces the drain-bar because a ring reads as a gauge at a glance and
// costs less width -- and because a countdown is the one thing on an approval
// prompt that must never be missed. It carries the seconds in the middle so
// the number and the sweep are the same object.
Item {
  id: root

  property real value: 1          // 1 -> full, 0 -> empty
  property color color: Color.accent
  property color trackColor: Util.alpha(Color.foreground, 0.14)
  property real thickness: Math.max(2, Style.space(3))
  property string label: ""
  property string fontFamily: Style.font.family

  implicitWidth: Style.space(46)
  implicitHeight: Style.space(46)

  readonly property real _r: Math.min(width, height) / 2 - thickness / 2
  readonly property real _v: Math.max(0, Math.min(1, value))

  Shape {
    anchors.fill: parent
    antialiasing: true
    preferredRendererType: Shape.CurveRenderer

    ShapePath {
      strokeColor: root.trackColor
      strokeWidth: root.thickness
      fillColor: "transparent"
      capStyle: ShapePath.RoundCap
      PathAngleArc {
        centerX: root.width / 2; centerY: root.height / 2
        radiusX: root._r; radiusY: root._r
        startAngle: -90; sweepAngle: 360
      }
    }

    ShapePath {
      strokeColor: root.color
      strokeWidth: root.thickness
      fillColor: "transparent"
      capStyle: ShapePath.RoundCap
      // Starts at twelve o'clock and unwinds clockwise, which is the
      // direction people read a timer draining.
      PathAngleArc {
        centerX: root.width / 2; centerY: root.height / 2
        radiusX: root._r; radiusY: root._r
        startAngle: -90
        sweepAngle: 360 * root._v
        Behavior on sweepAngle { NumberAnimation { duration: 950; easing.type: Easing.Linear } }
      }
    }
  }

  Text {
    anchors.centerIn: parent
    text: root.label
    color: root.color
    font.family: root.fontFamily
    font.pixelSize: Style.font.bodySmall
    font.bold: true
    visible: root.label !== ""
  }
}
