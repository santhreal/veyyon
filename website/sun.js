/* Veyyon — the hero sun (sun.js).
   veyyōn is Tamil for the sun, so the sun stays as the brand's one piece of
   atmosphere. It does NOT own the page: it is a modest disc living inside the
   hero box, beside the product copy, drawn in the same monospace cell field as
   the rest of the sun marks (stepped ember bands + per-cell dither, a true
   circle from each cell centre). Ripples follow the cursor and a click flares.

   Deliberately not a scroll journey. The earlier version pinned a 750vh runway
   and cross-faded eleven scenes over a fullscreen sun, which made the sun the
   subject and the harness the footnote. The canvas is now a normal element in
   the hero's flow, so scrolling just scrolls: nothing is hijacked, nothing can
   ghost over later sections, and the install command is visible on load.
   Rendering stops whenever the hero leaves the viewport. Reduced motion draws
   one static frame instead of animating. */
(function () {
  var cv = document.getElementById("sun");
  if (!cv) return;
  var host = cv.parentElement;
  var ctx = cv.getContext("2d", { alpha: true });
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Sun material comes from the single source of truth (sun-field.js, loaded
  // first): one ramp, one glyph vocabulary, one dither, shared with sunmark.js.
  var COLORS = window.veyyonSun.COLORS;
  var GLYPH = window.veyyonSun.GLYPH;
  var hash = window.veyyonSun.hash;
  var GAIN = 0.84; // brightness scale for the hero disc (see the note in draw())

  var W = 0, H = 0, dpr = 1, cellW = 6, cellH = 12, cols = 0, rows = 0, fontPx = 11, mono = "monospace";
  var cxPx = 0, cyPx = 0, Rpx = 0;
  var ripples = [];
  var t0 = performance.now();
  var visible = true;

  function clamp01(x) {
    return x < 0 ? 0 : x > 1 ? 1 : x;
  }
  function smooth(e0, e1, x) {
    var t = clamp01((x - e0) / (e1 - e0));
    return t * t * (3 - 2 * t);
  }

  function layout() {
    W = host.clientWidth;
    H = host.clientHeight;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = Math.floor(W * dpr);
    cv.height = Math.floor(H * dpr);
    cv.style.width = W + "px";
    cv.style.height = H + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    fontPx = W < 720 ? 10 : 11;
    mono = (getComputedStyle(document.body).getPropertyValue("--mono") || "monospace").trim();
    cellW = Math.max(5, Math.round(fontPx * 0.62));
    cellH = Math.max(9, Math.round(fontPx * 1.15));
    cols = Math.ceil(W / cellW);
    rows = Math.ceil(H / cellH);
    place();
  }

  // Where the disc sits inside the hero box. Wide screens: docked right of the
  // copy column. Narrow screens: the copy is full width, so the sun goes up top
  // behind the eyebrow and site.css dims it — it must never fight the text.
  function place() {
    var narrow = W < 860;
    if (narrow) {
      // Clipped into the top-right corner, above the eyebrow. It sat lower and
      // larger at first and washed out the middle of the h1, which is exactly the
      // "sun over the product" problem the hero was rebuilt to end.
      cxPx = W * 0.93;
      cyPx = H * 0.015;
      Rpx = Math.min(W * 0.2, H * 0.13);
    } else {
      cxPx = W * 0.8;
      cyPx = H * 0.44;
      // Deliberately small. A disc big enough to fill the right half of the hero
      // reads as the subject of the page; this one is scaled to sit beside the
      // copy as atmosphere. site.css dims it further with #sun{opacity}.
      Rpx = Math.min(W * 0.13, H * 0.32);
    }
  }

  function spawn(px, py, amp) {
    ripples.push({ x: px, y: py, t: (performance.now() - t0) / 1000, amp: amp });
    if (ripples.length > 16) ripples.shift();
  }
  function at(e) {
    var r = cv.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return null;
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  var lastEmit = 0;
  window.addEventListener("mousemove", function (e) {
    if (reduce || !visible) return;
    var q = at(e);
    if (!q) return;
    var now = performance.now();
    if (now - lastEmit < 90) return;
    lastEmit = now;
    spawn(q.x, q.y, 0.3);
  });
  window.addEventListener("click", function (e) {
    if (reduce || !visible) return;
    var q = at(e);
    if (q) spawn(q.x, q.y, 1.0);
  });

  var lastPulse = -99;
  function draw(time) {
    var R = Rpx * (1 + Math.sin(time * 0.6) * 0.02);
    if (time - lastPulse > 3.4) {
      lastPulse = time;
      spawn(cxPx, cyPx, 0.32);
    }
    ctx.clearRect(0, 0, W, H);
    ctx.font = fontPx + "px " + mono;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    var pad = R * 0.28;
    var gx0 = Math.max(0, Math.floor((cxPx - R - pad) / cellW));
    var gx1 = Math.min(cols, Math.ceil((cxPx + R + pad) / cellW));
    var gy0 = Math.max(0, Math.floor((cyPx - R - pad) / cellH));
    var gy1 = Math.min(rows, Math.ceil((cyPx + R + pad) / cellH));
    var step = Math.floor(time * 5);

    for (var gy = gy0; gy < gy1; gy++) {
      var py = gy * cellH + cellH / 2;
      for (var gx = gx0; gx < gx1; gx++) {
        var px = gx * cellW + cellW / 2;
        var d = Math.hypot(px - cxPx, py - cyPx) / R;
        var base = 1 - smooth(0.72, 1.02, d);
        var corona = d > 1.0 && d < 1.26 ? smooth(1.26, 1.0, d) * 0.5 : 0;

        var rp = 0;
        for (var i = 0; i < ripples.length; i++) {
          var rs = ripples[i];
          var age = time - rs.t;
          if (age < 0 || age > 3.2) continue;
          var rd = Math.hypot(px - rs.x, py - rs.y);
          rp += Math.sin(rd * 0.05 - age * 7) * Math.exp(-age * 1.7) * Math.exp(-rd * 0.006) * rs.amp;
        }
        var churn = (Math.sin(gx * 0.34 + time * 0.9) * Math.sin(gy * 0.42 - time * 0.75) +
          Math.sin(gx * 0.13 - gy * 0.17 + time * 0.5)) * 0.045;

        var val = base * 0.9 + rp * 0.55 + churn * base;
        if (base > 0.02) val += (hash(gx, gy, step) - 0.5) * 0.2 * Math.min(1, base + 0.25);
        else if (corona > 0 && hash(gx, gy, step + 5) < corona * 0.5) val = corona * (0.5 + hash(gx, gy, 9) * 0.5);
        if (base > 0.8) val += Math.sin(time * 1.3) * 0.04;

        if (val <= 0.12) continue;
        if (val > 1) val = 1;
        // GAIN pulls the whole brightness field down so the core lands in the
        // ember bands and only the dither reaches the near-white COLORS[7]. Two
        // rejected alternatives, both worse: CSS opacity desaturates the warm
        // core to grey-beige on black, and clamping the band index to 5 collapses
        // the core into one flat brown slab with no cell structure left. Scaling
        // the field keeps all eight steps (so the disc still reads as stepped
        // bands) at a luminance the h1 wins against.
        var bi = Math.min(7, Math.floor(val * GAIN * 8));
        ctx.fillStyle = COLORS[bi];
        ctx.fillText(GLYPH[bi], px, py);
      }
    }
  }

  var last = 0;
  function loop(now) {
    requestAnimationFrame(loop);
    if (!visible) return; // hero is off-screen: no cell field, no cost
    if (now - last < 30) return;
    last = now;
    draw((now - t0) / 1000);
  }

  var rz;
  window.addEventListener("resize", function () {
    clearTimeout(rz);
    rz = setTimeout(function () {
      layout();
      if (reduce) draw(0.6);
    }, 120);
  });

  layout();
  if (reduce) {
    draw(0.6); // one still frame; the disc is decoration, so it stays visible
    return;
  }
  if (typeof IntersectionObserver === "function") {
    new IntersectionObserver(function (entries) {
      visible = entries[0].isIntersecting;
    }, { rootMargin: "80px" }).observe(host);
  }
  requestAnimationFrame(loop);
})();
