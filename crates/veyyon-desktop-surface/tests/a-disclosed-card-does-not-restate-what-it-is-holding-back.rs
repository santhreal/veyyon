//! WHY: a collapsed tool card's row states how many lines it left out — `5 more
//! lines` at the row's trailing edge — because that is the only thing telling
//! the reader there is a card to open. Disclosing the card kept that count on
//! the row while the card below it was showing every one of those lines, so an
//! open card claimed to be holding back what it had just shown.
//!
//! CLASS CLOSED:
//! 1. A disclosed card of any canonical `ToolView` kind restating a held-back
//!    count. Every kind is swept from the fixture set, which is built from the
//!    exhaustive `kind_of` match, so a new variant fails to compile until it is
//!    given a case.
//! 2. The count going missing from the collapsed row, which is the other half
//!    of the same wiring and would otherwise pass by rendering nothing.
//! 3. The disclosure state failing to reach the row at all: the row of an open
//!    card and the row of a closed one are asserted to differ for every kind
//!    whose collapsed row holds lines back.
//!
//! NOT CAUGHT: the wording of the count. `5 more lines` against `5 more` is a
//! `ViewHiddenCount::format_label` contract, and this suite counts the shaped
//! runs in the row rather than reading them — a rendered frame carries each
//! run's box and size, not its string.

mod support;

use support::tool_cards::{Drawn, draw, kind_of, views_taller_than_a_row};
use veyyon_desktop_model::tool_view::ToolView;

/// Whether a collapsed row of this view states a count of what it holds back.
///
/// A status row is the contract's own one-line shape and holds nothing back;
/// the other four are blocks the row projects onto one line, and each fixture
/// carries more lines than that one.
const fn row_states_a_count(view: &ToolView) -> bool {
	match view {
		ToolView::StatusRow(_) => false,
		ToolView::TextBlock(_)
		| ToolView::HeadedBlock(_)
		| ToolView::FramedBlock(_)
		| ToolView::Notice(_) => true,
	}
}

/// The row of the same card, closed and open.
fn rows(view: &ToolView) -> (Drawn, Drawn) {
	(draw(view, false), draw(view, true))
}

#[test]
fn a_collapsed_row_states_the_lines_it_holds_back() {
	for view in views_taller_than_a_row() {
		let kind = kind_of(&view);
		let (closed, open) = rows(&view);
		if !row_states_a_count(&view) {
			continue;
		}
		assert_eq!(
			closed.row_runs,
			open.row_runs + 1,
			"the collapsed {kind} row carries {} text runs and the disclosed one {}: a collapsed row \
			 states its held-back count and a disclosed row does not, so the two differ by exactly \
			 that one run",
			closed.row_runs,
			open.row_runs
		);
	}
}

#[test]
fn a_row_that_holds_nothing_back_states_nothing_either_way() {
	for view in views_taller_than_a_row() {
		let kind = kind_of(&view);
		if row_states_a_count(&view) {
			continue;
		}
		let (closed, open) = rows(&view);
		assert_eq!(
			closed.row_runs, open.row_runs,
			"the {kind} row holds nothing back, so disclosing the card must not add or drop a run on \
			 it: closed {} against open {}",
			closed.row_runs, open.row_runs
		);
	}
}

#[test]
fn every_kind_is_classified_as_holding_lines_back_or_not() {
	let classified: Vec<(&str, bool)> = views_taller_than_a_row()
		.iter()
		.map(|view| (kind_of(view), row_states_a_count(view)))
		.collect();
	assert_eq!(classified, vec![
		("statusRow", false),
		("textBlock", true),
		("headedBlock", true),
		("framedBlock", true),
		("notice", true),
	]);
}
