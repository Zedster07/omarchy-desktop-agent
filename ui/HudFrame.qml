import QtQuick
import QtQuick.Shapes
import qs.Commons

// Corner brackets instead of a box.
//
// A full border says "dialog". Four L-shaped corners say "instrument", and
// they do it while covering about a fifth of the pixels -- so the surface
// reads as framed without the frame competing with the text inside it. The
// faint full-rect outline underneath keeps the shape legible on a busy
// wallpaper; the brackets carry the character.
Item {
  id: root

  property color color: Color.accent
  property real thickness: Math.max(2, Style.space(2.5))
  /**
   * Arm length as a fraction of the SHORTER side, clamped.
   *
   * Tuned down from 0.16 after seeing it render: on a wide card the arms grew
   * long enough to read as a broken border rather than as corner marks, which
   * is the opposite of the intent. Short and thick reads as an instrument;
   * long and thin just looks like a rectangle someone erased bits of.
   */
  property real armRatio: 0.085
  property real minArm: Style.space(10)
  property real maxArm: Style.space(22)
  property real radius: Style.cornerRadius
  /** 0 draws nothing, 1 draws full-length arms. Animate for a reveal. */
  property real progress: 1
  property real hairlineOpacity: 0.10

  readonly property real arm: Math.max(minArm,
    Math.min(maxArm, Math.min(width, height) * armRatio)) * Math.max(0, Math.min(1, progress))

  // The quiet outline that stops the card dissolving into the desktop.
  Rectangle {
    anchors.fill: parent
    radius: root.radius
    color: "transparent"
    border.width: 1
    border.color: Util.alpha(root.color, root.hairlineOpacity)
  }

  Shape {
    anchors.fill: parent
    antialiasing: true
    preferredRendererType: Shape.CurveRenderer

    // Four corners, each an L. Drawn as separate paths so a partial
    // `progress` shortens every arm from its corner outward rather than
    // sweeping one continuous stroke around the box.
    ShapePath {
      strokeColor: root.color
      strokeWidth: root.thickness
      fillColor: "transparent"
      capStyle: ShapePath.RoundCap
      startX: 0; startY: root.radius + root.arm
      PathLine { x: 0; y: root.radius }
      PathArc {
        x: root.radius; y: 0
        radiusX: root.radius; radiusY: root.radius
        direction: PathArc.Clockwise
      }
      PathLine { x: root.radius + root.arm; y: 0 }
    }

    ShapePath {
      strokeColor: root.color
      strokeWidth: root.thickness
      fillColor: "transparent"
      capStyle: ShapePath.RoundCap
      startX: root.width - root.radius - root.arm; startY: 0
      PathLine { x: root.width - root.radius; y: 0 }
      PathArc {
        x: root.width; y: root.radius
        radiusX: root.radius; radiusY: root.radius
        direction: PathArc.Clockwise
      }
      PathLine { x: root.width; y: root.radius + root.arm }
    }

    ShapePath {
      strokeColor: root.color
      strokeWidth: root.thickness
      fillColor: "transparent"
      capStyle: ShapePath.RoundCap
      startX: root.width; startY: root.height - root.radius - root.arm
      PathLine { x: root.width; y: root.height - root.radius }
      PathArc {
        x: root.width - root.radius; y: root.height
        radiusX: root.radius; radiusY: root.radius
        direction: PathArc.Clockwise
      }
      PathLine { x: root.width - root.radius - root.arm; y: root.height }
    }

    ShapePath {
      strokeColor: root.color
      strokeWidth: root.thickness
      fillColor: "transparent"
      capStyle: ShapePath.RoundCap
      startX: root.radius + root.arm; startY: root.height
      PathLine { x: root.radius; y: root.height }
      PathArc {
        x: 0; y: root.height - root.radius
        radiusX: root.radius; radiusY: root.radius
        direction: PathArc.Clockwise
      }
      PathLine { x: 0; y: root.height - root.radius - root.arm }
    }
  }
}
