/* Veyyon — motion.
   Silky, restrained reveal choreography shared by every page. Elements rise and
   fade in as they enter the viewport (hero on load, the rest on scroll), with a
   short stagger and a premium ease. Purely additive: it tags existing elements,
   so there is no per-page markup to maintain. Honors prefers-reduced-motion by
   showing everything immediately. */
(function () {
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Selectors revealed in document order, grouped so siblings stagger together.
  var GROUPS = [
    ".page-head > *",
    ".values > div",
    ".lead",
    ".panel",
    ".grid > .card",
    ".steps > .step",
    ".tbl-wrap",
    ".thesis > *",
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

  document.addEventListener("DOMContentLoaded", function () {
    var items = collect();
    if (reduce || !("IntersectionObserver" in window)) {
      for (var k = 0; k < items.length; k++) items[k].el.classList.add("in");
      return;
    }
    for (var j = 0; j < items.length; j++) {
      items[j].el.classList.add("reveal");
      // stagger within a group; cap so long groups don't drift too far
      items[j].el.style.setProperty("--d", Math.min(items[j].i, 6) * 70 + "ms");
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

    // Reveal the hero immediately on load (it's above the fold); observe the rest.
    for (var m = 0; m < items.length; m++) {
      var el = items[m].el;
      if (el.closest(".hero")) {
        var delay = parseFloat(el.style.getPropertyValue("--d")) || 0;
        setTimeout(
          (function (node) {
            return function () {
              node.classList.add("in");
            };
          })(el),
          80 + delay
        );
      } else {
        io.observe(el);
      }
    }
  });
})();
