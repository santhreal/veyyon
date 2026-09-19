//! WHY: a token file states the product's measures, and the loader already
//! rejects an entry nobody parses. Nothing rejected the next failure along: an
//! entry the loader parses, the struct carries and no renderer ever draws.
//! Four of them shipped — `elevation.toml` declared `shadow_x`, `shadow_y`,
//! `shadow_blur` and `shadow_spread` for the float, `surface/composer.toml`
//! declared five more, and the floats drew a curve compiled into the kit
//! instead — so editing either file moved nothing on screen.
//!
//! THE CLASS THIS CLOSES: a measure that is authored, loaded and never
//! reaches the raster. Every field of `ControlTokens`, of the float shadow
//! model and of the transcript's `[tool_view]` table is enumerated from the
//! loaded value at run time through serde, doubled one at a time, and the
//! probe surface is rendered again. A field that moves no pixel fails by
//! name. A field added to any of those structs arrives in the sweep with no
//! edit here, and fails until something draws it.
//!
//! WHAT IT DOES NOT CATCH: a measure drawn in the wrong place. A frame that
//! differs proves the value reached the raster, not that it landed where the
//! design system puts it, which is what the proof frames on the pull request
//! are read for. It also reaches only the three structs named above: a dead
//! entry in another surface table is still invisible here.

mod dead_token_probe;

use dead_token_probe::{Observation, mutate_number, number_keys, observe};
use veyyon_desktop_scene::headless_context;
use veyyon_desktop_tokens::{Tokens, load_bundled_tokens};

/// Every measure under sweep, as a path into the loaded token value.
fn swept_keys(tokens: &Tokens) -> Vec<String> {
	let mut keys = Vec::new();
	keys.extend(number_keys("controls", &tokens.controls));
	keys.extend(number_keys("elevation.float_shadow", &tokens.elevation.float_shadow));
	keys.push("elevation.overlay_blur_px".to_owned());
	keys.extend(
		number_keys("surface.transcript", &tokens.surface.transcript)
			.into_iter()
			.filter(|key| key.contains(".tool_view_")),
	);
	keys
}

#[test]
fn every_authored_measure_moves_a_pixel_or_a_reported_box() {
	let shipped = load_bundled_tokens().expect("the bundled tokens must load");
	let keys = swept_keys(&shipped);
	assert!(
		keys.len() >= 42,
		"the sweep lost coverage: {} measures enumerated, expected at least 42",
		keys.len()
	);

	let mut cx = headless_context().expect("a GPU with a Vulkan ICD is required");
	let baseline = observe(&mut cx, &shipped);

	let mut dead: Vec<String> = Vec::new();
	for key in &keys {
		let mutated = mutate_number(&shipped, key);
		if observe(&mut cx, &mutated) == baseline {
			dead.push(key.clone());
		}
	}
	assert!(
		dead.is_empty(),
		"these authored measures changed nothing the product produced, so nothing reads them: \
		 {dead:?}"
	);
}

#[test]
fn the_probe_shows_something_a_mutation_could_change() {
	let shipped = load_bundled_tokens().expect("the bundled tokens must load");
	let mut cx = headless_context().expect("a GPU with a Vulkan ICD is required");
	let observed = observe(&mut cx, &shipped);

	// An observation that is empty or uniform proves nothing about a
	// mutation, because two blank frames also compare equal.
	for observation in observed.frames() {
		match observation {
			Observation::Frame { name, distinct_values, .. } => assert!(
				*distinct_values > 1,
				"probe frame {name} drew one colour, so no mutation of it could be seen"
			),
			Observation::Report { name, text } => assert!(
				!text.is_empty(),
				"probe report {name} is empty, so no mutation of it could be seen"
			),
		}
	}
}
