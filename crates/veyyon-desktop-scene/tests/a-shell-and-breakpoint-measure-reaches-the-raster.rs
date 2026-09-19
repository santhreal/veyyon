//! WHY: token files state the breakpoint and window shell measures, but
//! several measures never reached the raster because no renderer read them, or
//! because no test rendered the window state or breakpoint width that activates
//! them. The titlebar controls, grain texture, pending gate strength, rename
//! field, and responsive breakpoint tiers each went dead without detection.
//!
//! THE CLASS THIS CLOSES: measures authored in the surface token files that
//! are loaded into memory but never reach the raster. This suite sweeps every
//! measure in the `surface.breakpoints` and `surface.shell` groups, enumerated
//! from the loaded token tree through serde at run time, doubling each measure
//! in turn against states that render the shell across every breakpoint class
//! and with active chrome controls. Any measure that changes no pixel in the
//! rendered observations fails by name.
//!
//! WHAT IT DOES NOT CATCH: window minimum floor constraints enforced by the
//! window keeper when placing and resizing the window rather than in layout,
//! which are proven by `a-remembered-window-opens-where-it-can-be-reached`.

mod dead_token_probe;
mod shell_probe;

use dead_token_probe::{assert_every_measure_is_drawn, assert_every_measure_is_drawn_except};

#[test]
fn every_breakpoint_measure_moves_a_pixel() {
	assert_every_measure_is_drawn("surface.breakpoints", shell_probe::observations);
}

#[test]
fn every_shell_measure_moves_a_pixel() {
	assert_every_measure_is_drawn_except("surface.shell", shell_probe::observations, &[
		(
			"surface.shell.window_min_width_px",
			"crates/veyyon-desktop/tests/a-remembered-window-opens-where-it-can-be-reached.rs",
		),
		(
			"surface.shell.window_min_height_px",
			"crates/veyyon-desktop/tests/a-remembered-window-opens-where-it-can-be-reached.rs",
		),
	]);
}
