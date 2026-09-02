import QtQuick
import qs.Commons

// A barely-there horizontal rule pattern.
//
// At 3% alpha this is invisible as a texture and unmistakable as a mood: it
// is what makes a flat panel read as a display rather than a dialog. Anything
// stronger becomes a novelty and starts to hurt text legibility, so the
// opacity ceiling here is deliberate.
Item {
  id: root
  property color color: Color.foreground
  property real strength: 0.03
  property int spacing: Math.max(3, Style.space(3))

  clip: true

  Column {
    width: parent.width
    spacing: root.spacing - 1
    Repeater {
      model: Math.ceil(root.height / Math.max(1, root.spacing))
      Rectangle {
        width: root.width
        height: 1
        color: Util.alpha(root.color, root.strength)
      }
    }
  }
}
