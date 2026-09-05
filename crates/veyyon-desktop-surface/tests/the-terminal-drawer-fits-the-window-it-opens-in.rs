//! WHY: the drawer was the one region with a vertical measure and no rule
//! bounding it. Its height came from a token that no window size could cut
//! back, so a 280px drawer in a 300px window left the transcript with nothing,
//! and at the 800px collapsed width it docked and took 180px out of a
//! transcript that had none to give. The height also had two owners: the
//! breakpoint row and a `panels.terminal_drawer.default_height_px` that
//! duplicated the wide row's 280 and that no surface read.
//!
//! THE CLASS THIS CLOSES: a drawer measure that ignores the window it is opened
//! in. Both sweeps read `shell_widths`, the one function the drawer's measure
//! passes through: one sweeps every width from below the floor to past the
//! widest row and pins placement and height to the row that resolved, the other
//! sweeps window heights from shorter than the drawer's own floor to taller
//! than any declared height and pins the result against the declared share.
//! A fifth breakpoint row, or a row that declares a height no window can hold,
//! is covered without touching this file.
//!
//! WHAT IT DOES NOT CATCH: whether the drawer draws anything in the height it
//! is given, which the frame suite covers, and whether the declared heights are
//! the right ones, which is a judgement made by looking at the rendered sheet.

use veyyon_desktop_kit::{SpacingStep, TokenSet, load_bundled_tokens};
use veyyon_desktop_surface::layout::{LabelState, ShedInput, shell_widths};
use veyyon_desktop_tokens::{DrawerPlacement, SurfaceTokens};

/// The window height the width sweep holds constant: tall enough that the
/// drawer's window-share ceiling never binds, so a width assertion is about
/// width.
const SWEPT_HEIGHT: f32 = 900.0;

fn surface() -> SurfaceTokens {
	load_bundled_tokens()
		.expect("the bundled tokens load")
		.surface
}

fn shed(viewport_px: f32, viewport_height_px: f32) -> ShedInput {
	ShedInput {
		viewport_px,
		viewport_height_px,
		chrome_height_px: surface().shell.titlebar_height_px,
		gutter_px: f32::from(TokenSet::default().spacing(SpacingStep::S4)),
		queue_collapsed: false,
		panel_open: true,
		panel_width: None,
		labels: LabelState::default(),
	}
}

#[test]
fn the_drawer_takes_the_placement_and_height_the_breakpoint_declares() {
	let surface = surface();

	for width in (320..=2400).step_by(8).map(|w| w as f32) {
		let declared = surface.breakpoints.resolve(width);
		let widths = shell_widths(shed(width, SWEPT_HEIGHT), &surface);

		assert_eq!(
			(widths.drawer.placement, widths.drawer.height_px),
			(declared.terminal_drawer_placement, declared.terminal_drawer_height_px),
			"at {width}px in a {SWEPT_HEIGHT}px window the drawer disagreed with the breakpoint it \
			 resolved"
		);

		// An overlaid drawer is the one that takes no height from the
		// transcript. That is the whole reason it overlays below 980px, where
		// the transcript has none to give.
		let taken = widths.drawer.column_height();
		match declared.terminal_drawer_placement {
			DrawerPlacement::Row => assert_eq!(
				taken, declared.terminal_drawer_height_px,
				"at {width}px a docked drawer took {taken}px from the session column"
			),
			DrawerPlacement::Overlay => assert_eq!(
				taken, 0.0,
				"at {width}px an overlaid drawer took {taken}px out of the session column"
			),
		}
	}
}

#[test]
fn the_drawer_never_takes_more_of_the_window_than_its_share() {
	let surface = surface();
	let ratio = surface.panels.terminal_drawer_max_viewport_ratio;
	let floor = surface.panels.terminal_drawer_min_height_px;

	// The height sweep runs from a window shorter than the drawer's own floor
	// to one taller than any declared height, at a collapsed and a wide width,
	// so the ceiling is checked against both declared heights.
	for height in (120..=1200).step_by(8).map(|h| h as f32) {
		for width in [800.0, 1440.0] {
			let declared = surface.breakpoints.resolve(width);
			let drawn = shell_widths(shed(width, height), &surface).drawer.height_px;
			let ceiling = height * ratio;

			assert!(
				drawn <= ceiling + f32::EPSILON,
				"in a {height}px window at {width}px the drawer drew {drawn}px, past the {ceiling}px \
				 its {ratio} share allows"
			);
			assert!(
				drawn <= declared.terminal_drawer_height_px,
				"in a {height}px window at {width}px the drawer drew {drawn}px, more than the {}px \
				 its breakpoint declared",
				declared.terminal_drawer_height_px
			);

			// The floor holds wherever the window can hold it, and where it
			// cannot the drawer takes what there is rather than the window.
			let expected_floor = floor.min(ceiling).min(declared.terminal_drawer_height_px);
			assert!(
				drawn >= expected_floor,
				"in a {height}px window at {width}px the drawer drew {drawn}px, under the \
				 {expected_floor}px floor that window allows"
			);
		}
	}
}

#[test]
fn a_window_height_nobody_can_measure_still_resolves_a_drawer() {
	let surface = surface();

	// A viewport read before the window has one, or a NaN out of a layout pass,
	// is not a layout to solve. The declared height is the only value there is
	// to draw at, and it is what the drawer gets — never a zero-height drawer
	// and never a NaN passed on to the frame.
	for height in [0.0, -400.0, f32::NAN, f32::INFINITY] {
		let widths = shell_widths(shed(1440.0, height), &surface);
		assert_eq!(
			widths.drawer.height_px, surface.breakpoints.wide.terminal_drawer_height_px,
			"a window height of {height} resolved the drawer to {}px",
			widths.drawer.height_px
		);
	}
}
