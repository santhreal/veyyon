//! Reading the decision card stack's fold out of a rendered frame (§5.5).
//!
//! Several test binaries include this module and each uses a subset of it, so
//! each `mod` site carries its own `allow(dead_code)`.

#[path = "../queue-scroll/mod.rs"]
#[allow(dead_code, reason = "this module uses a subset of the shared session helpers")]
mod queue_scroll;

pub use queue_scroll::open_session;
use veyyon_desktop_scene::{BoxBounds, Captured, HeadlessSession, text_boxes};
use veyyon_desktop_surface::{Card, ShellState, ShellView, damage::Region, fixture};
use veyyon_gpui::{Bounds, Pixels, Point};

/// The window this renders in: wide enough that no width shed is in play, so
/// the stack keeps the composer's measure.
pub const WINDOW_W: u32 = 1280;
pub const WINDOW_H: u32 = 900;

pub fn rect(bounds: Bounds<Pixels>) -> BoxBounds {
	BoxBounds {
		left:   f32::from(bounds.origin.x),
		top:    f32::from(bounds.origin.y),
		right:  f32::from(bounds.origin.x) + f32::from(bounds.size.width),
		bottom: f32::from(bounds.origin.y) + f32::from(bounds.size.height),
	}
}

pub fn centre(area: BoxBounds) -> Point<Pixels> {
	Point {
		x: Pixels::from(f32::midpoint(area.left, area.right)),
		y: Pixels::from(f32::midpoint(area.top, area.bottom)),
	}
}

/// Decisions with subjects of visibly different lengths, so a fold that names
/// each one draws runs of different widths and a fold that repeats one label
/// draws runs of the same width.
pub fn decisions() -> Vec<Card> {
	vec![
		Card::Approval { tool: "bash".to_owned(), detail: vec!["cargo test".to_owned()] },
		Card::Question {
			prompt:  "Which of the two shapes gives way under 208px?".to_owned(),
			options: vec!["The badge".to_owned(), "The elapsed time".to_owned()],
		},
		Card::Plan {
			title: "Move the surface leaves onto the kit primitives, in order".to_owned(),
			body:  vec!["Replace the answer row with Button.".to_owned()],
		},
		Card::Approval {
			tool:   "write — crates/veyyon-desktop-surface/src/cards/mod.rs".to_owned(),
			detail: vec!["Adds the fold's own row.".to_owned()],
		},
		Card::Question { prompt: "Ship it?".to_owned(), options: vec!["Yes".to_owned()] },
	]
}

/// A state carrying `count` decisions, in the fixture's own window.
pub fn state_with(count: usize) -> ShellState {
	let mut state = fixture::populated();
	state.cards = decisions().into_iter().take(count).collect();
	assert_eq!(state.cards.len(), count, "the fixture set carries {count} decisions to attach");
	state
}

/// The row the fold occupies: the stack's last child, so its lower edge is the
/// cards region's own.
///
/// Found by position rather than by height, which is what leaves the height
/// free to be asserted: a row identified by being 24px tall could not then be
/// checked for being 24px tall.
pub fn fold_row(captured: &Captured, cards: BoxBounds) -> Option<BoxBounds> {
	let rows: Vec<BoxBounds> = captured
		.hitboxes
		.iter()
		.map(|bounds| rect(*bounds))
		.filter(|row| (row.bottom - cards.bottom).abs() < 1.5 && row.width() > 300.0)
		.collect();
	assert!(
		rows.len() <= 1,
		"the stack's lower edge carries at most the fold's own row; got {rows:?}"
	);
	rows.first().copied()
}

/// Every text run drawn inside `row`.
pub fn runs_within(captured: &Captured, row: BoxBounds) -> Vec<BoxBounds> {
	text_boxes(captured)
		.into_iter()
		.filter(|run| {
			run.left >= row.left - 0.5
				&& run.right <= row.right + 0.5
				&& run.top >= row.top - 0.5
				&& run.bottom <= row.bottom + 0.5
		})
		.collect()
}

/// The lines the fold draws from its own text inset downward: the count first,
/// then one for each folded decision, whether or not the row's box contains
/// them.
///
/// The inset is what identifies them. Reading the row's box instead is what
/// hides the defect this is here for, since a line the row squeezed rather
/// than clipped hangs past the row's lower edge and a containment filter
/// discards it. The composer under the fold and the cards over it draw at
/// their own insets, so their runs start at another edge and drop out.
pub fn fold_lines(captured: &Captured, row: BoxBounds, lines: usize, line: f32) -> Vec<BoxBounds> {
	let mut runs: Vec<BoxBounds> = text_boxes(captured)
		.into_iter()
		.filter(|run| {
			run.top >= row.top - 0.5
				&& run.top <= line.mul_add(lines as f32, row.top)
				&& run.left >= row.left - 0.5
				&& run.right <= row.right + 0.5
		})
		.collect();
	runs.sort_by(|left, right| left.top.total_cmp(&right.top));
	let Some(first) = runs.first().copied() else {
		return Vec::new();
	};
	runs.retain(|run| (run.left - first.left).abs() < 0.5);
	runs
}

/// The cards region's box, as the frame just laid it out.
pub fn cards_region(session: &mut HeadlessSession<'_, ShellView>) -> BoxBounds {
	let bounds = session
		.update(|view, _window, _cx| view.laid_out().drawn_bounds(Region::Cards))
		.expect("the window updates")
		.expect("a state with cards lays the cards region out");
	rect(bounds)
}

/// Somewhere with no card under it, for the pointer to leave to.
pub fn away() -> Point<Pixels> {
	Point { x: Pixels::from(4.0), y: Pixels::from(4.0) }
}
