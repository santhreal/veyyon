//! The width sweep shared by the shed suites: every width from below the
//! declared window floor to past the widest breakpoint, and the `ShedInput`
//! a freshly opened window of that width settles on.

use veyyon_desktop_kit::{SpacingStep, TokenSet, load_bundled_tokens};
use veyyon_desktop_surface::layout::{LabelState, ShedInput};
use veyyon_desktop_tokens::SurfaceTokens;

/// Every width the sweep visits: from well below the declared window floor to
/// well past the widest breakpoint, at a step fine enough to land on both sides
/// of every threshold.
pub fn swept_widths() -> Vec<f32> {
	(320..=2400).step_by(8).map(|w| w as f32).collect()
}

pub fn surface() -> SurfaceTokens {
	load_bundled_tokens()
		.expect("the bundled tokens load")
		.surface
}

/// The window height the width sweep holds constant: tall enough that no
/// vertical rule binds, so a width assertion is about width.
pub const SWEPT_HEIGHT: f32 = 900.0;

/// What the titlebar takes off the top of that height. No attention strip is
/// shown in a width sweep, so the titlebar is the whole of the chrome.
pub fn swept_chrome() -> f32 {
	surface().shell.titlebar_height_px
}

/// The shed's input for a width. The gutter is the session column's own inset,
/// read from the tokens rather than restated, and the previous state is the
/// default, so a sweep reads as the state a freshly opened window settles on.
pub fn shed(viewport_px: f32, panel_open: bool) -> ShedInput {
	let gutter_px = f32::from(TokenSet::default().spacing(SpacingStep::S4));
	ShedInput {
		viewport_px,
		viewport_height_px: SWEPT_HEIGHT,
		chrome_height_px: swept_chrome(),
		gutter_px,
		queue_collapsed: false,
		panel_open,
		panel_width: None,
		labels: LabelState::default(),
	}
}
