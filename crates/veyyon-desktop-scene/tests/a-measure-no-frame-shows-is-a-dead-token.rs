//! WHY: a token file states the product's measures, and the loader already
//! rejects an entry nobody parses. Nothing rejected the next failure along: an
//! entry the loader parses, the struct carries and no renderer ever draws.
//! Four of them shipped — `elevation.toml` declared `shadow_x`, `shadow_y`,
//! `shadow_blur` and `shadow_spread` for the float, `surface/composer.toml`
//! declared five more, and the floats drew a curve compiled into the kit
//! instead — so editing either file moved nothing on screen.
//!
//! THE CLASS THIS CLOSES: a measure that is authored, loaded and never reaches
//! the raster. This suite owns the kit's groups — every field of
//! `ControlTokens`, of the elevation model and of the transcript's
//! `[tool_view]` table — enumerated from the loaded value at run time through
//! serde, doubled one at a time against a probe drawing every primitive that
//! reads one. A field that moves no pixel and changes no reported box fails by
//! name, and a field added to any of those structs arrives in the sweep with
//! no edit here.
//!
//! WHAT IT DOES NOT CATCH: a measure drawn in the wrong place. A frame that
//! differs proves the value reached the raster, not that it landed where the
//! design system puts it, which is what the proof frames on the pull request
//! are read for. The surface and motion groups are swept by their own suites,
//! against the states that draw them; `GROUPS` is the partition and
//! `a-every-measure-belongs-to-a-suite-that-sweeps-it.rs` proves it covers
//! every measure.

mod dead_token_probe;

use dead_token_probe::{assert_every_measure_is_drawn, views};

#[test]
fn every_control_measure_moves_a_pixel_or_a_reported_box() {
	assert_every_measure_is_drawn("controls", views::render_all);
}

#[test]
fn every_elevation_measure_moves_a_pixel() {
	assert_every_measure_is_drawn("elevation", views::render_all);
}

#[test]
fn every_tool_view_measure_moves_a_pixel() {
	assert_every_measure_is_drawn("surface.transcript.tool_view_", views::render_all);
}
