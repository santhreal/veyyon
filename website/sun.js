/* Veyyon — the sun journey.
   veyyōn is Tamil for the sun. A giant round sun fills the screen on load, alive
   and interactive. Scrolling is one long scripted walk: the sun settles to a
   parked disc while the idea is told in centered beats (engine -> harness -> what
   ours does), then it docks to the right and the product is walked through scene
   by scene (plan mode, sandbox, models, cockpit, extensibility). Everything is a
   fixed overlay driven purely by scroll position, so each scene stays dead-centre
   and readable; scroll only advances the crossfade. The sun is a dense field of
   monospace cells with stepped ember bands + per-cell dither — sharp, cell-native,
   no smooth gradient — a true circle (distance from each cell centre in pixels).
   Ripples follow the cursor; a click flares. Reduced motion => static page.
   Dev: append ?p=0.6 to freeze the journey at a scroll fraction. */
(function () {
  var cv = document.getElementById("sun");
  if (!cv) return;
  var ctx = cv.getContext("2d", { alpha: true });
  var stage = document.getElementById("stage");
  var hdr = document.getElementById("hdr");
  var cue = document.getElementById("cue");
  var pin = document.querySelector(".stage-pin");
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // scene [fadeInStart, fadeOutEnd] windows, in document order. Non-overlapping
  // with clear gaps so two scenes never share the screen. Front-loaded: the name
  // lands almost immediately so there's no dead scroll at the top. The last window
  // is the terminal itself, so the walk *ends on the product working* — no fragile
  // hand-off to a separate page.
  var WIN = [
    [0.04, 0.12], [0.14, 0.23], [0.25, 0.34], [0.36, 0.44], // act I — the idea, centered
    [0.49, 0.575], [0.595, 0.665], [0.685, 0.755], [0.775, 0.84], [0.855, 0.915], [0.925, 0.965], // act II — product
    [0.972, 1.2], // act III — the terminal, working
  ];
  var scenes = document.querySelectorAll(".scene");
  var FADE = 0.022;
  var DOCK_START = 0.44,
    DOCK_END = 0.5;

  var COLORS = ["#4a2714", "#6e3418", "#96431b", "#c25a24", "#f0862e", "#fb9e44", "#fbc06d", "#ffe3ad"];
  var GLYPH = ["·", "·", ":", "░", "▒", "▒", "▓", "█"];

  var W, H, dpr, cellW, cellH, cols, rows, fontPx, mono, mn;
  var cxPx, cyPx, Rpx;
  var ripples = [];
  var t0 = performance.now();

  var force = null;
  (function () {
    var m = location.search.match(/[?&]p=([0-9.]+)/);
    if (m) force = Math.min(1, Math.max(0, parseFloat(m[1])));
  })();

  function layout() {
    W = window.innerWidth;
    H = window.innerHeight;
    mn = Math.min(W, H);
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
  }

  function clamp01(x) {
    return x < 0 ? 0 : x > 1 ? 1 : x;
  }
  function smooth(e0, e1, x) {
    var t = clamp01((x - e0) / (e1 - e0));
    return t * t * (3 - 2 * t);
  }
  function ease(p) {
    return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2; // easeInOutCubic
  }
  function lerp(a, b, t) {
    return a + (b - a) * t;
  }
  function hash(x, y, s) {
    var h = (x * 374761393 + y * 668265263 + s * 1274126177) >>> 0;
    h = ((h ^ (h >>> 13)) * 1274126177) >>> 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  }

  // sun path: fullscreen -> parked centre (act I) -> docked right (act II)
  function sunAt(p) {
    var fullR = mn * 0.45,
      parkR = mn * 0.19,
      dockR = mn * 0.26;
    var parkCx = W / 2,
      parkCy = H * 0.34,
      dockCx = W * 0.8,
      dockCy = H * 0.34;
    if (p < 0.05) {
      var t = ease(p / 0.05);
      return { cx: parkCx, cy: lerp(H / 2, parkCy, t), R: lerp(fullR, parkR, t) };
    }
    if (p < DOCK_START) return { cx: parkCx, cy: parkCy, R: parkR };
    var u = ease(clamp01((p - DOCK_START) / (DOCK_END - DOCK_START)));
    return { cx: lerp(parkCx, dockCx, u), cy: lerp(parkCy, dockCy, u), R: lerp(parkR, dockR, u) };
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
    var q = at(e);
    if (!q) return;
    var now = performance.now();
    if (now - lastEmit < 90) return;
    lastEmit = now;
    spawn(q.x, q.y, 0.3);
  });
  window.addEventListener("click", function (e) {
    var q = at(e);
    if (q) spawn(q.x, q.y, 1.0);
  });

  var activeScene = -1;
  function chrome(p) {
    var top = 0,
      topI = -1;
    for (var i = 0; i < scenes.length; i++) {
      var w = WIN[i];
      if (!w) continue;
      var op = smooth(w[0], w[0] + FADE, p) * (1 - smooth(w[1] - FADE, w[1], p));
      var lp = clamp01((p - w[0]) / (w[1] - w[0]));
      scenes[i].style.opacity = op;
      scenes[i].style.transform = "translateY(calc(-50% + " + lerp(15, -15, lp).toFixed(1) + "px))";
      scenes[i].style.pointerEvents = op > 0.6 ? "auto" : "none";
      if (op > top) {
        top = op;
        topI = i;
      }
    }
    // flare the sun each time a new beat takes over — the sun lives with the story
    if (top > 0.5 && topI !== activeScene) {
      activeScene = topI;
      spawn(cxPx, cyPx, 0.7);
    }
    if (hdr) {
      var gp = smooth(DOCK_START + 0.01, DOCK_END, p);
      hdr.style.opacity = gp;
      hdr.style.display = gp < 0.02 ? "none" : "";
      hdr.style.pointerEvents = gp < 0.1 ? "none" : "";
    }
    if (cue) cue.style.opacity = 1 - smooth(0, 0.06, p);
  }

  var lastPulse = -99;
  function draw(time, p) {
    var s = sunAt(p);
    cxPx = s.cx;
    cyPx = s.cy;
    Rpx = s.R * (1 + Math.sin(time * 0.6) * 0.02);
    chrome(p);

    if (time - lastPulse > 3.4) {
      lastPulse = time;
      spawn(cxPx, cyPx, 0.32);
    }
    ctx.clearRect(0, 0, W, H);
    ctx.font = fontPx + "px " + mono;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    var R = Rpx,
      pad = R * 0.28;
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
        var bi = Math.min(7, Math.floor(val * 8));
        ctx.fillStyle = COLORS[bi];
        ctx.fillText(GLYPH[bi], px, py);
      }
    }
  }

  var last = 0;
  function loop(now) {
    if (now - last > 30) {
      last = now;
      var p = 1,
        e = 0;
      if (force !== null) p = force;
      else if (stage) {
        var r = stage.getBoundingClientRect();
        var travel = stage.offsetHeight - H;
        p = travel > 0 ? clamp01(-r.top / travel) : 1;
        e = clamp01((H - r.bottom) / (H * 0.6)); // fade journey out as the runway leaves
      }
      if (pin) pin.style.opacity = String(1 - e);
      cv.style.opacity = String(1 - e);
      draw((now - t0) / 1000, p);
    }
    requestAnimationFrame(loop);
  }
  function boot() {
    if (reduce) {
      cv.style.display = "none"; // static page handles layout under reduced motion
      return;
    }
    layout();
    requestAnimationFrame(loop);
  }
  var rz;
  window.addEventListener("resize", function () {
    if (reduce) return;
    clearTimeout(rz);
    rz = setTimeout(layout, 120);
  });
  boot();
})();
