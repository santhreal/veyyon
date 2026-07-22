/* Veyyon — the sun field: the single source of truth for the sun's material.
   veyyōn is Tamil for the sun, and every sun the brand draws is made of the same
   thing: stepped ember bands and a per-cell ordered dither, never a smooth
   gradient (see docs/internal/design.md, "The sun"). Two renderers draw it today
   — the hero journey (sun.js) and the structural marks (sunmark.js) — and the TUI
   splash will draw it next. They must all share one ramp and one dither or they
   drift, so the ramp, the glyph vocabulary, the sky, and the hash live here and
   nowhere else. A consumer reads window.veyyonSun; it never re-declares a copy.

   Classic script on purpose: sun.js and sunmark.js are plain deferred scripts, so
   this assigns a global and must load before them (it is listed first on every
   page that draws a sun). When the TypeScript TUI splash lands, it reads these
   same values from one shared source rather than pasting a second ramp. */
(function () {
  "use strict";

  // The ember bands, dark rim to hot core. Eight stops; a cell's brightness
  // selects a band. Stepped on purpose: the sun is cell-native, not a gradient.
  var COLORS = ["#4a2714", "#6e3418", "#96431b", "#c25a24", "#f0862e", "#fb9e44", "#fbc06d", "#ffe3ad"];

  // The glyph ramp, dim to solid, aligned index-for-index with COLORS. Text-cell
  // renderers (sun.js, the TUI splash) print GLYPH[band]; pixel renderers
  // (sunmark.js) fill COLORS[band] and ignore this. Matches the ramp named in
  // design.md: · : ░ ▒ ▓ █.
  var GLYPH = ["·", "·", ":", "░", "▒", "▒", "▓", "█"];

  // The dawn/sunset sky, zenith to horizon. Long and fine-grained, warmth eased
  // toward the line so the strip blends out of page-black instead of popping.
  var SKY = ["#000000", "#060201", "#0c0302", "#130603", "#1b0904", "#240d05", "#2e1207", "#39180a", "#451f0d", "#54280f", "#653112", "#783a16", "#8c451b", "#a15120", "#b85e25", "#cf6b29", "#e67a2c", "#f0862e"];

  // Integer hash for the per-cell ordered dither: same cell and step give the
  // same value everywhere, so the dither is stable and identical across renderers.
  function hash(x, y, s) {
    var h = (x * 374761393 + y * 668265263 + s * 1274126177) >>> 0;
    h = ((h ^ (h >>> 13)) * 1274126177) >>> 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  }

  window.veyyonSun = { COLORS: COLORS, GLYPH: GLYPH, SKY: SKY, hash: hash };
})();
