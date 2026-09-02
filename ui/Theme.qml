pragma Singleton
import QtQuick
import qs.Commons

// One place that answers "what colour is this, on whatever theme is loaded
// right now".
//
// Everything here is derived from Omarchy's own tokens, never from a literal.
// That is the whole point: a theme swap reassigns Color.shellValues, every
// binding below re-evaluates, and the plugin repaints with it. A hardcoded
// "#ffffff" cannot participate in that, which is why there is not one in this
// plugin.
//
// Two rules worth stating, because both were violated by the version this
// replaces:
//
//   1. Dim text is alpha, not Qt.darker(). On a dark theme darkening the
//      foreground moves it toward the background and reads as "dimmer". On a
//      light theme the foreground is already dark, so darkening it moves it
//      AWAY from the background and reads as *more* prominent -- the opposite
//      of what was meant. Alpha blends toward whatever is behind it and is
//      therefore correct in both directions. The shell itself uses this idiom
//      for Color.lock.placeholder.
//
//   2. Text on a filled button takes its colour from the fill, not from a
//      guess. onFill() picks black or white by the fill's own luminance, so an
//      accent that happens to be pale yellow gets dark text instead of the
//      white-on-white the old code produced.
QtObject {
  id: theme

  // ---------------------------------------------------------------- surfaces
  //
  // An approval prompt is an authorization dialog, so it borrows the shell's
  // polkit surface rather than the generic popup one. Themes that restyle the
  // system password prompt restyle this with it, for free, and a user who has
  // taught their theme what "something wants permission" looks like sees that
  // answer here too.
  readonly property color authBackground: Color.polkit.background
  readonly property color authText: Color.polkit.text
  readonly property color authTextError: Color.polkit.textError
  readonly property color authBorder: Color.polkit.border
  readonly property color authBorderError: Color.polkit.borderError
  readonly property color authAccent: Color.polkit.accent
  readonly property color authScrim: Color.polkit.scrim

  // Non-modal surfaces (recap card, voice HUD) are reports, not prompts, so
  // they use the popup surface and never a scrim.
  readonly property color cardBackground: Color.popups.background
  readonly property color cardText: Color.popups.text
  readonly property color cardBorder: Color.popups.border

  // -------------------------------------------------------------- text ramp
  //
  // Three weights, all alpha over whatever surface is behind them.
  function primary(on)   { return on }
  function secondary(on) { return Util.alpha(on, 0.72) }
  function tertiary(on)  { return Util.alpha(on, 0.48) }

  readonly property color cardTextSecondary: Util.alpha(cardText, 0.72)
  readonly property color cardTextTertiary: Util.alpha(cardText, 0.48)
  readonly property color authTextSecondary: Util.alpha(authText, 0.72)
  readonly property color authTextTertiary: Util.alpha(authText, 0.48)

  // ------------------------------------------------------------ state hues
  //
  // Named by meaning, not by colour, so a theme can disagree about which hue
  // means danger without this plugin needing to care.
  readonly property color ok: Color.accent
  readonly property color danger: Color.urgent
  readonly property color caution: Color.polkit.accent

  // ------------------------------------------------------- text on a fill
  //
  // Relative luminance per WCAG. A fill lighter than ~0.45 gets the theme
  // background as its text colour, anything darker gets the foreground.
  // Falling back to the theme's own two poles rather than pure black/white
  // keeps a filled button inside the palette instead of punching a hole in it.
  function luminance(c) {
    function lin(v) { return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
    return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b)
  }

  function onFill(fill) {
    return luminance(Qt.color(fill)) > 0.45 ? Color.background : Color.foreground
  }

  // Contrast ratio between two colours, for the rare case where a caller wants
  // to check its own pairing rather than trust onFill().
  function contrast(a, b) {
    var la = luminance(Qt.color(a)), lb = luminance(Qt.color(b))
    var hi = Math.max(la, lb), lo = Math.min(la, lb)
    return (hi + 0.05) / (lo + 0.05)
  }

  // ----------------------------------------------------------------- motion
  //
  // Fast enough to feel immediate, slow enough to read as motion. The voice
  // HUD in particular appears and disappears constantly, so anything longer
  // starts to feel like lag.
  readonly property int fast: 120
  readonly property int normal: 180
  readonly property int slow: 260
}
