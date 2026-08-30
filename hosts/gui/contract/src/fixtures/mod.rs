//! One of every shape in the contract, for drawing without a session behind it.
//!
//! A window draws the same components whether a live session or this module
//! supplies the data, so a layout, a theme or a motion token is checked against
//! every variant before any transport exists. That is also what the drift test
//! enumerates against: a variant with no fixture here has never been rendered.
//!
//! This is a real module rather than `#[cfg(test)]` code. The window binary
//! draws from it, which is what makes a capture of every route possible without
//! an agent, a provider key or a network.

pub mod routes;
pub mod session;
pub mod views;

pub use routes::{route, routes};
pub use session::{
	capabilities, composer_states, dialog_results, dialogs, overlays, status_lines, terminal_panel,
	transcript_blocks, ui_events, workspace,
};
pub use views::{view, views};

use crate::{
	screen::{Route, RouteId},
	session::{Frame, Hud, HudAgent},
	source::Source,
};

/// A [`Source`] with no session behind it.
///
/// Every window path is built against this first. A window that can only be
/// driven by a live agent cannot be captured, cannot be tested, and needs a
/// provider key to answer a layout question.
#[derive(Debug, Clone)]
pub struct Fixtures {
	/// Which route the window opens on.
	pub route:   RouteId,
	/// Which entry of [`dialogs`] to show, if any.
	pub dialog:  Option<usize>,
	/// Which entry of [`overlays`] to show, if any.
	pub overlay: Option<usize>,
}

impl Fixtures {
	/// The fixture session on the transcript route, with no dialog and no
	/// overlay.
	pub fn new() -> Fixtures {
		Fixtures { route: RouteId::Session, dialog: None, overlay: None }
	}

	/// The fixture session opened on `route`.
	pub fn at(route: RouteId) -> Fixtures {
		Fixtures { route, ..Fixtures::new() }
	}

	pub fn dialog(mut self, index: usize) -> Fixtures {
		self.dialog = Some(index);
		self
	}

	pub fn overlay(mut self, index: usize) -> Fixtures {
		self.overlay = Some(index);
		self
	}
}

impl Default for Fixtures {
	fn default() -> Fixtures {
		Fixtures::new()
	}
}

impl Source for Fixtures {
	fn frame(&self) -> Frame {
		let statuses = status_lines();
		let composers = composer_states();
		Frame {
			blocks:       transcript_blocks(),
			composer:     composers
				.first()
				.cloned()
				.expect("the composer fixtures are never empty"),
			status:       statuses
				.first()
				.cloned()
				.expect("the status fixtures are never empty"),
			capabilities: capabilities(),
			workspace:    workspace(),
			terminal:     terminal_panel(),
			notices:      statuses
				.into_iter()
				.filter_map(|status| status.notice)
				.collect(),
			hud:          Some(hud()),
			overlay:      self
				.overlay
				.and_then(|index| overlays().into_iter().nth(index)),
			dialog:       self
				.dialog
				.and_then(|index| dialogs().into_iter().nth(index)),
		}
	}

	fn route(&self) -> Route {
		route(self.route)
	}
}

/// Two running sub-agents, and a fan-out wider than the panel.
pub fn hud() -> Hud {
	Hud {
		agents:  vec![
			HudAgent::new("agent-1", "PortTheKernel")
				.kind("deep")
				.recent_output("Reading the matcher's public surface.")
				.elapsed_ms(41_200),
			HudAgent::new("agent-2", "SweepCallSites")
				.kind("deep")
				.recent_output("Rewriting the last two call sites.")
				.elapsed_ms(8_900),
		],
		omitted: 2,
	}
}

#[cfg(test)]
mod tests {
	//! WHY THIS SUITE EXISTS.
	//!
	//! [`Fixtures`] is what every window path is driven by, including the
	//! captures. A frame it builds by indexing into a fixture list is a panic
	//! waiting on an empty list, and an out-of-range dialog index arrives from
	//! an operator's own argument.
	//!
	//! WHAT IT DOES NOT CATCH. Whether a window draws what the frame says.

	use super::*;

	#[test]
	fn the_default_source_is_the_transcript_with_nothing_over_it() {
		let fixtures = Fixtures::new();
		assert_eq!(fixtures.route().id(), RouteId::Session);
		let frame = fixtures.frame();
		assert!(!frame.is_blocked());
		assert!(frame.overlay.is_none());
		assert!(!frame.blocks.is_empty());
	}

	#[test]
	fn a_dialog_index_past_the_end_opens_no_dialog_rather_than_panicking() {
		let frame = Fixtures::new().dialog(9_999).frame();
		assert!(frame.dialog.is_none());
		assert!(!frame.is_blocked());
	}

	#[test]
	fn an_open_dialog_blocks_the_frame() {
		let frame = Fixtures::new().dialog(0).frame();
		assert!(frame.dialog.is_some());
		assert!(frame.is_blocked());
	}

	#[test]
	fn every_route_can_be_opened_through_the_source() {
		for id in RouteId::ALL {
			let fixtures = Fixtures::at(id);
			assert_eq!(fixtures.route().id(), id, "{} did not open its own route", id.key());
			assert!(!fixtures.frame().blocks.is_empty(), "{} lost the transcript under it", id.key());
		}
	}
}
