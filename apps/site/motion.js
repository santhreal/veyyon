/* Veyyon — motion.
   No scroll reveal. Every section renders at its final position on first
   paint — no transform, no opacity fade, no second paint. The earlier
   reveal choreography caused a visible jump: elements painted at rest,
   then the deferred script added transform:translateY(20px), then the
   IntersectionObserver slid them back. Removing it eliminates the flash. */
