/* Veyyon — motion.
   Silky, restrained reveal choreography for scroll sections. Above-the-fold content
   (hero and page headers) renders immediately on load with zero flash. Below-the-fold
   elements rise and fade in as they enter the viewport, with a short stagger and
   a premium ease. Honors prefers-reduced-motion. */
(function () {
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Below-the-fold selectors revealed on scroll
  var GROUPS = [
    ".demo-band .showcase",
    ".values > div",
    ".lead",
    ".panel",
    ".grid > .card",
    ".steps > .step",
    ".tbl-wrap",
    ".thesis > *",
    ".ledger > .ledger-row",
    "section > .sub",
  ];

  function collect() {
    var out = [];
    for (var g = 0; g < GROUPS.length; g++) {
      var nodes = document.querySelectorAll(GROUPS[g]);
      for (var i = 0; i < nodes.length; i++) out.push({ el: nodes[i], i: i });
    }
    return out;
  }

  var items = collect();
  if (reduce || !("IntersectionObserver" in window)) {
    for (var k = 0; k < items.length; k++) items[k].el.classList.add("in");
    return;
  }
  for (var j = 0; j < items.length; j++) {
    var rect = items[j].el.getBoundingClientRect();
    if (rect.top < window.innerHeight && rect.bottom > 0) {
      items[j].el.classList.add("in");
    } else {
      items[j].el.classList.add("reveal");
      items[j].el.style.setProperty("--d", Math.min(items[j].i, 6) * 70 + "ms");
    }
  }

  var io = new IntersectionObserver(
    function (entries) {
      for (var e = 0; e < entries.length; e++) {
        if (entries[e].isIntersecting) {
          entries[e].target.classList.add("in");
          io.unobserve(entries[e].target);
        }
      }
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.08 }
  );

  for (var m = 0; m < items.length; m++) {
    if (items[m].el.classList.contains("reveal")) {
      io.observe(items[m].el);
    }
  }
})();
