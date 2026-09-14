//! WHY: a collapsed tool card occupies one transcript row, and what the host
//! supplies for it is a whole card — a header with lines under it, a block of
//! sections, a notice with a body. The collapsed row rendered that view at its
//! natural height inside a fixed-height row that clipped nothing, so a real
//! `bash` call drew its command, its output and its frame across the operator
//! bubble above it and the prose below it. The row also stated the wrong token:
//! the height of one line inside a pane (12px), not the collapsed chrome height
//! (24px) its own documentation named, so even a one-line status row
//! overflowed.
//!
//! CLASS CLOSED:
//! 1. Any canonical `ToolView` variant whose collapsed projection is taller
//!    than one row. Every variant is swept, each with content taller than a
//!    row, so a variant that renders its whole body in the row fails.
//! 2. A collapsed card that paints outside its row at all — a frame, a fill or
//!    a border past the bottom edge is what overlapped the neighbouring blocks.
//! 3. The row height drifting off the transcript's collapsed chrome token.
//! 4. A projection that closes the row by dropping the content: the expanded
//!    card is asserted to paint past the row for the same view.
//! 5. A new variant: `kind_of` matches exhaustively, so adding one fails to
//!    compile until it is given a case and a fixture here.
//!
//! NOT CAUGHT: whether the line a row projects names the right thing. That a
//! `bash` row states its command rather than its exit code is a judgement made
//! by looking at `proof/scenes/desktop-tool-view.sh`, not by measuring boxes.

mod support;

use support::tool_cards::{draw, kind_of, row_height_px, views_taller_than_a_row};

#[test]
fn every_view_kind_has_a_fixture_taller_than_a_row() {
	let kinds: Vec<&str> = views_taller_than_a_row().iter().map(kind_of).collect();
	assert_eq!(kinds, vec!["statusRow", "textBlock", "headedBlock", "framedBlock", "notice"]);
}

#[test]
fn a_collapsed_card_paints_nothing_below_its_row() {
	let row_height = row_height_px();

	for view in views_taller_than_a_row() {
		let kind = kind_of(&view);
		let drawn = draw(&view, false);
		assert!(
			drawn.bottom > 0.0,
			"the collapsed {kind} row painted nothing, so the measurement proves nothing"
		);
		// Half a pixel of tolerance for the rasteriser's rounding of a border.
		assert!(
			drawn.bottom <= row_height + 0.5,
			"the collapsed {kind} row painted down to {}px, past its {row_height}px row",
			drawn.bottom
		);
		assert!(
			drawn.top >= -0.5,
			"the collapsed {kind} row painted up to {}px, above the top of its row",
			drawn.top
		);
		// The disclosure row is the transcript's collapsed chrome height, whole:
		// a shorter row clips the line it states, and this is the assertion that
		// notices the row stating a pane's line height instead.
		assert!(
			drawn
				.hit_heights
				.iter()
				.any(|height| (height - row_height).abs() <= 0.5),
			"the collapsed {kind} card offers no {row_height}px row to click; it offers {:?}",
			drawn.hit_heights
		);
		assert!(
			drawn
				.hit_heights
				.iter()
				.all(|height| *height <= row_height + 0.5),
			"the collapsed {kind} card answers a click on a target taller than its row: {:?}",
			drawn.hit_heights
		);
	}
}

#[test]
fn an_expanded_card_paints_the_view_the_row_held_back() {
	let row_height = row_height_px();

	for view in views_taller_than_a_row() {
		let kind = kind_of(&view);
		let drawn = draw(&view, true);
		assert!(
			drawn.bottom > row_height,
			"the expanded {kind} card painted only to {}px, so the row's projection dropped the \
			 content instead of collapsing it",
			drawn.bottom
		);
	}
}
