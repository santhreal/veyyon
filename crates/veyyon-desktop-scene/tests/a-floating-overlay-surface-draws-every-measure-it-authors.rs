//! WHY: floating overlay surfaces state their layout and typography in token
//! files, but compiled-in literals and unrendered states left measures dead. A
//! palette or settings measure could be altered in its TOML file without moving
//! a pixel on screen, creating dead tokens that drift silently from the design.
//!
//! THE CLASS THIS CLOSES: floating overlay measures authored in token files
//! that fail to reach the raster. The sweep enumerates every numeric measure in
//! `surface.palette`, `surface.settings`, `surface.agents` and `surface.share`
//! at run time through serde, doubles each in turn against seeded floating
//! overlay states, and fails naming any measure whose rendered frame was
//! unchanged.
//!
//! WHAT IT DOES NOT CATCH: whether the visual elements land in the exact
//! spatial coordinates dictated by high-level design guidelines, or dynamic
//! interactive transitions driven by keystroke sequences.

mod dead_token_probe;
mod overlay_probe;

use dead_token_probe::assert_every_measure_is_drawn;

#[test]
fn every_palette_measure_moves_a_pixel() {
	assert_every_measure_is_drawn("surface.palette", overlay_probe::observations);
}

#[test]
fn every_settings_measure_moves_a_pixel() {
	assert_every_measure_is_drawn("surface.settings", overlay_probe::observations);
}

#[test]
fn every_agents_measure_moves_a_pixel() {
	assert_every_measure_is_drawn("surface.agents", overlay_probe::observations);
}

#[test]
fn every_share_measure_moves_a_pixel() {
	assert_every_measure_is_drawn("surface.share", overlay_probe::observations);
}
