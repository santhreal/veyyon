/* Veyyon — the sun as a brand, outside the journey (sunmark.js).
   The wordmark never carries an icon; the sun shows up structurally instead:
     data-sun="progress" — a small sun gliding along the header's baseline as you scroll
     data-sun="sunset"   — a blood-orange pixel sunset closing the page above the footer
     data-sun="rest"     — the night sun on the 404 page
   Same stepped ember bands and ordered dither as the journey sun (sun.js). */
(function () {
  "use strict";

  // sun bands, dark rim -> hot core (identical to sun.js)
  var COLORS = ["#4a2714", "#6e3418", "#96431b", "#c25a24", "#f0862e", "#fb9e44", "#fbc06d", "#ffe3ad"];
  // sunset sky, zenith -> horizon. Long, fine-grained ramp with the warmth eased
  // toward the line, so the strip blends out of the page black instead of popping
  var SKY = ["#000000", "#060201", "#0c0302", "#130603", "#1b0904", "#240d05", "#2e1207", "#39180a", "#451f0d", "#54280f", "#653112", "#783a16", "#8c451b", "#a15120", "#b85e25", "#cf6b29", "#e67a2c", "#f0862e"];

  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function smooth(e0, e1, x) {
    var t = clamp01((x - e0) / (e1 - e0));
    return t * t * (3 - 2 * t);
  }
  function hash(x, y, s) {
    var h = (x * 374761393 + y * 668265263 + s * 1274126177) >>> 0;
    h = ((h ^ (h >>> 13)) * 1274126177) >>> 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  }

  // one banded, dithered pixel disc; coordinates in css px; clipY (optional) is a
  // hard horizon — nothing of the disc renders below it
  function disc(ctx, W, H, px, cx, cy, R, t, dim, clipY) {
    var cols = Math.ceil(W / px), rows = Math.ceil(H / px);
    var step = Math.floor(t * 2.5);
    ctx.globalAlpha = dim;
    for (var gy = 0; gy < rows; gy++) {
      if (clipY !== undefined && gy * px > clipY) break;
      for (var gx = 0; gx < cols; gx++) {
        var x = gx * px + px / 2, y = gy * px + px / 2;
        var d = Math.hypot(x - cx, y - cy) / R;
        if (d > 1.32) continue;
        var base = 1 - smooth(0.72, 1.02, d);
        var val = base;
        if (base > 0.02) val += (hash(gx, gy, step) - 0.5) * 0.22 * Math.min(1, base + 0.25);
        else if (R > 30 && d < 1.28 && hash(gx, gy, step + 5) < 0.16) val = 0.3 + hash(gx, gy, 9) * 0.2;
        if (val <= 0.14) continue;
        ctx.fillStyle = COLORS[Math.min(7, Math.floor(Math.min(1, val) * 8))];
        ctx.fillRect(gx * px, gy * px, px, px);
      }
    }
    ctx.globalAlpha = 1;
  }

  // the sunset: dithered sky bands, a huge sun mostly below the horizon,
  // a melting ember line, faint stars up top, slow sparks rising off the arc
  function sunset(ctx, W, H, t) {
    var px = W < 720 ? 5 : 6;
    var horizonY = Math.round(H * 0.82);
    var cols = Math.ceil(W / px);
    var step = Math.floor(t * 2.5);
    ctx.clearRect(0, 0, W, H);
    // sky (above the line only; the ground stays page-black and merges with the footer)
    for (var gy = 0, rows = Math.ceil(horizonY / px); gy < rows; gy++) {
      var y = gy * px + px / 2;
      var s = clamp01(y / horizonY);
      var se = s * s; // ease the warmth down toward the horizon: the top of the strip stays night-black
      for (var gx = 0; gx < cols; gx++) {
        var sj = se + (hash(gx, gy, step) - 0.5) * 0.13;
        var idx = sj <= 0 ? 0 : sj >= 1 ? SKY.length - 1 : Math.floor(sj * SKY.length);
        if (idx > 0) { ctx.fillStyle = SKY[idx]; ctx.fillRect(gx * px, gy * px, px, px); }
        // sparse stars in the upper sky, flickering slowly
        else if (s < 0.4 && hash(gx, gy, 77) < 0.012 && hash(gx, gy, step >> 2) < 0.5) {
          ctx.fillStyle = "rgba(232,232,232,.5)";
          ctx.fillRect(gx * px, gy * px, px, px);
        }
      }
    }
    // the sun: most of the disc below the line, a broad arc glowing above it — the
    // horizon cuts it hard; below the line there is only the glow and the sparks
    var R = H * 1.05, cx = W / 2, cy = horizonY + R * 0.62;
    disc(ctx, W, H, px, cx, cy, R, t, 1, horizonY - px * 0.5);
    // the horizon: a hot pixel line melting into a short glow below
    ctx.fillStyle = "rgba(251,192,109,.5)"; ctx.fillRect(0, horizonY, W, 1);
    ctx.fillStyle = "rgba(240,134,46,.20)"; ctx.fillRect(0, horizonY + 1, W, 2);
    ctx.fillStyle = "rgba(194,90,36,.10)"; ctx.fillRect(0, horizonY + 3, W, 4);
    // sparks rising off the arc
    for (var i = 0; i < 12; i++) {
      var sp = 0.05 + hash(i, 3, 1) * 0.06;
      var life = (t * sp + hash(i, 7, 2)) % 1;
      var ex = (0.32 + hash(i, 11, 3) * 0.36) * W + (hash(i, 13, step) - 0.5) * 14;
      var ey = horizonY - (0.04 + life * 0.5) * H;
      ctx.globalAlpha = (1 - life) * 0.85;
      ctx.fillStyle = i % 3 === 0 ? "#fbc06d" : "#f0862e";
      ctx.fillRect(Math.round(ex / px) * px, Math.round(ey / px) * px, px, px);
    }
    ctx.globalAlpha = 1;
  }

  var targets = [];
  function fit(el) {
    var mode = el.getAttribute("data-sun");
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var w, h;
    if (mode === "sunset") { w = el.parentElement.clientWidth; h = el.parentElement.clientHeight; }
    else { w = el.width; h = el.height; }
    el.style.width = w + "px"; el.style.height = h + "px";
    el.width = Math.round(w * dpr); el.height = Math.round(h * dpr);
    var ctx = el.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { el: el, ctx: ctx, mode: mode, w: w, h: h };
  }

  function positionProgress(t) {
    if (t.mode !== "progress") return;
    var track = t.el.parentElement;
    var max = document.documentElement.scrollHeight - window.innerHeight;
    var pct = max > 0 ? clamp01(window.scrollY / max) : 0;
    t.el.style.left = (10 + pct * (track.clientWidth - 20)) + "px";
  }

  function render(t, time) {
    if (t.mode === "sunset") sunset(t.ctx, t.w, t.h, time);
    else if (t.mode === "rest") {
      t.ctx.clearRect(0, 0, t.w, t.h);
      disc(t.ctx, t.w, t.h, t.w / 24, t.w / 2, t.h / 2, t.w * 0.42, time * 0.6, 1);
    } else if (t.mode === "progress") {
      t.ctx.clearRect(0, 0, t.w, t.h);
      positionProgress(t);
      disc(t.ctx, t.w, t.h, t.w / 8, t.w / 2, t.h / 2, t.w * 0.44, time, 1);
    }
  }

  var els = document.querySelectorAll("canvas[data-sun]");
  if (!els.length) return;
  for (var i = 0; i < els.length; i++) targets.push(fit(els[i]));

  if (reduce) {
    for (var j = 0; j < targets.length; j++) render(targets[j], 0.6);
  } else {
    var last = 0;
    var loop = function (now) {
      requestAnimationFrame(loop);
      if (now - last < 100) return; // ~10fps is plenty for sky churn and sparks
      last = now;
      for (var k = 0; k < targets.length; k++) render(targets[k], now / 1000);
    };
    requestAnimationFrame(loop);
  }

  window.addEventListener("scroll", function () {
    for (var m = 0; m < targets.length; m++) positionProgress(targets[m]);
  }, { passive: true });
  window.addEventListener("resize", function () {
    for (var n = 0; n < targets.length; n++) { targets[n] = fit(targets[n].el); render(targets[n], 0.6); }
  });
})();
