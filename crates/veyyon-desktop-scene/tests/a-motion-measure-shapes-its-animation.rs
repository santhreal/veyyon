//! WHY: motion tokens state the product's physics, duration and cadence
//! parameters, and the loader validates their syntax and ranges. Nothing
//! verified that an authored motion measure reaches the runtime animation: a
//! renderer or driver could draw with a compiled-in literal or ignore a
//! configured parameter, leaving the token inert.
//!
//! THE CLASS THIS CLOSES: a motion measure that is authored, loaded and never
//! affects an animation trajectory. Every numeric measure under `motion.*` is
//! enumerated from the loaded tokens at run time through serde, doubled and
//! offset one at a time against a probe sampling every motion role across a
//! deterministic clock sequence. A measure that alters no sampled trajectory,
//! opacity or offset fails by name, and a measure added to `motion.toml`
//! arrives in the sweep with no edits to this suite.
//!
//! WHAT IT DOES NOT CATCH: whether the animated trajectory feels right to a
//! user or matches an intended visual design curve. The sweep proves that the
//! measure reaches the animator and shapes the motion, not that the authored
//! numbers produce aesthetic satisfaction.

mod dead_token_probe;
mod motion_probe;

use dead_token_probe::assert_every_measure_is_drawn;

#[test]
fn every_motion_measure_shapes_its_animation() {
	assert_every_measure_is_drawn("motion", motion_probe::observations);
}
