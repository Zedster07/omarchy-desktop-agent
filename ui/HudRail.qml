import QtQuick
import qs.Commons

// A hairline that fades out at both ends.
//
// Used instead of a full-width divider: a rule that touches both edges boxes
// the content in, while one that dissolves keeps the surface feeling open.
// `sweep` runs a brighter node along it, which is the cheapest way to say
// "this is live" without animating anything expensive.
Item {
  id: root

  property color color: Color.accent
  property real thickness: 1
  property bool sweep: false
  property int sweepDuration: 2600

  implicitHeight: Math.max(thickness, Style.space(1))

  Rectangle {
    anchors.fill: parent
    gradient: Gradient {
      orientation: Gradient.Horizontal
      GradientStop { position: 0.0; color: "transparent" }
      GradientStop { position: 0.5; color: Util.alpha(root.color, 0.55) }
      GradientStop { position: 1.0; color: "transparent" }
    }
  }

  Rectangle {
    id: node
    visible: root.sweep
    width: Math.max(Style.space(40), root.width * 0.18)
    height: parent.height
    gradient: Gradient {
      orientation: Gradient.Horizontal
      GradientStop { position: 0.0; color: "transparent" }
      GradientStop { position: 0.5; color: root.color }
      GradientStop { position: 1.0; color: "transparent" }
    }
    XAnimator on x {
      running: root.sweep && root.visible
      loops: Animation.Infinite
      from: -node.width
      to: root.width
      duration: root.sweepDuration
      easing.type: Easing.InOutSine
    }
  }
}
