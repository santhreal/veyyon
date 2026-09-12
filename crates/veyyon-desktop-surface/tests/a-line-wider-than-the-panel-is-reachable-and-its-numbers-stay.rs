//! WHY: §5.11 authors the mono panes with word wrap off, horizontal scroll and
//! both gutters pinned. The file pane had the first clause and neither of the
//! others: every line was laid out in a cell that clipped it, so a line wider
//! than the panel was cut at the panel's edge — mid-glyph, with no ellipsis to
//! say it was cut — and there was no gesture, chord or bar that reached the
//! rest of it. A native take of the docked panel photographed exactly that: a
//! README line running under the window's right edge.
//!
//! Clipping and scrolling are not alternatives. The rest of the line has to
//! arrive without the line numbers leaving with it, which is what "pinned"
//! means, so the pane is two columns and only the code one scrolls.
//!
//! CLASS CLOSED:
//! 1. The pane not scrolling at all, or scrolling by something other than the
//!    gesture: the code runs are required to move by the wheel's own pixel
//!    delta.
//! 2. The gutter travelling with the code, which is the whole of "pinned": the
//!    line numbers are read before and after the same gesture.
//! 3. An unbounded offset. The pane is scrolled far past the widest line and
//!    the offset is asserted to stop where that line's end reaches the pane's
//!    edge, so a pane that keeps travelling into blank space fails, as does one
//!    that stops short of the line's end.
//! 4. No way back. The reverse gesture is asserted to return every run to the
//!    left edge it started at, exactly, so an offset that latches fails.
//! 5. The axis. GPUI maps a vertical wheel onto whichever single axis a region
//!    scrolls unless the region restricts it, so a vertical wheel over the code
//!    is asserted to leave the horizontal offset alone while the file scrolls.
//! 6. The columns drifting out of step: each line's gutter cell and code cell
//!    are asserted to share a top, at every line of the file.
//! 7. The row's size being a step the surface does not author. `diff.font_size`
//!    is authored beside `diff.row_height_px` in the panel's own token file and
//!    was read by nothing that drew a row, which is a dead token (§9.3): every
//!    run in the pane is asserted to carry the authored size.
//! 8. The pane's extent taken from the widest span rather than the widest line.
//!    A line arrives in the pieces its highlighting split it into, so the
//!    fixture's long line is two spans and the pane is required to stop at the
//!    end of both.
//!
//! 9. The row height following GPUI's default line rather than the panel's
//!    token. A shaped mono line at the pane's own size is exactly the authored
//!    18px, so every assertion above holds either way: the token is moved and
//!    the rows are required to follow it.
//!
//! NOT CAUGHT: whether a horizontal scrollbar is drawn — the pane offers the
//! gesture, and a scrollbar is a separate control with its own hit rect. Nor
//! the diff tenant, whose rows carry tints, signs and hunk headers of their
//! own; `a-diff-line-wider-than-the-pane-arrives-without-its-numbers.rs` owns
//! that.

#[path = "support/mono-pane/mod.rs"]
#[allow(dead_code, reason = "this binary uses a subset of the shared pane helpers")]
mod mono_pane;

use mono_pane::{
	WINDOW_H, WINDOW_W, code_runs, gutter_runs, lefts, open_session, open_session_on_tokens,
	over_code, panel_region, row_runs, state_with_a_file_of, state_with_a_long_file,
	state_with_long_line, tops, widest_row,
};
use veyyon_desktop_kit::load_bundled_tokens;
use veyyon_desktop_scene::headless_context;

#[test]
fn the_wheel_moves_the_code_and_leaves_the_line_numbers() {
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let panels = &tokens.surface.panels;

	let mut cx = headless_context().expect("a headless renderer is required");
	let mut session = open_session(&mut cx, state_with_long_line(), WINDOW_W, WINDOW_H);
	let rest = session.frame().expect("the shell renders at rest");
	let panel = panel_region(&mut session);

	let at_rest = code_runs(&rest, panel, panels);
	let numbers_at_rest = gutter_runs(&rest, panel, panels);
	assert!(at_rest.len() >= 4, "the pane draws a run for each of the four lines; got {at_rest:?}");

	session
		.scroll_across(over_code(panel, panels), 3.0)
		.expect("the wheel reaches the code column");
	let scrolled = session.frame().expect("the shell renders scrolled");
	let moved = code_runs(&scrolled, panel, panels);
	let numbers = gutter_runs(&scrolled, panel, panels);

	let shift: Vec<f32> = lefts(&at_rest)
		.iter()
		.zip(lefts(&moved).iter())
		.map(|(before, after)| before - after)
		.collect();
	assert!(
		shift.iter().all(|by| *by > 0.5),
		"every line moves leftward under the wheel, so the rest of the widest one arrives: {shift:?}"
	);
	assert!(
		shift.windows(2).all(|pair| (pair[0] - pair[1]).abs() < 0.5),
		"every line moves by the same offset, so the file does not shear: {shift:?}"
	);
	assert_eq!(
		lefts(&numbers),
		lefts(&numbers_at_rest),
		"the line numbers are pinned: the gutter is outside the region the wheel scrolls"
	);
}

#[test]
fn the_pane_stops_where_the_widest_line_ends_and_comes_back() {
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let panels = &tokens.surface.panels;

	let mut cx = headless_context().expect("a headless renderer is required");
	let mut session = open_session(&mut cx, state_with_long_line(), WINDOW_W, WINDOW_H);
	let rest = session.frame().expect("the shell renders at rest");
	let panel = panel_region(&mut session);
	let at_rest = code_runs(&rest, panel, panels);
	let widest = widest_row(&at_rest);

	for _ in 0..40 {
		session
			.scroll_across(over_code(panel, panels), 20.0)
			.expect("the wheel reaches the code column");
	}
	let far = session
		.frame()
		.expect("the shell renders at the end of the line");
	let ends = code_runs(&far, panel, panels)
		.into_iter()
		.map(|run| run.right)
		.fold(f32::MIN, f32::max);
	assert!(
		(ends - panel.right).abs() < 2.0,
		"the pane stops with the widest line's end at its own edge, rather than travelling into \
		 blank space or stopping short: the last ink is at {ends}px against an edge at {}px",
		panel.right
	);

	for _ in 0..40 {
		session
			.scroll_across(over_code(panel, panels), -20.0)
			.expect("the wheel reaches the code column");
	}
	let home = session
		.frame()
		.expect("the shell renders back at the left edge");
	let back = code_runs(&home, panel, panels);
	assert_eq!(
		lefts(&back),
		lefts(&at_rest),
		"the reverse gesture returns the pane to the left edge it started at"
	);
	assert!(
		widest > panel.right - panel.left - panels.diff_gutter_width_px,
		"the fixture's widest line has to be wider than the pane for any of this to mean anything: \
		 {widest}px against {}px",
		panel.right - panel.left - panels.diff_gutter_width_px
	);
}

#[test]
fn a_vertical_wheel_over_the_code_scrolls_the_file_and_not_the_line() {
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let panels = &tokens.surface.panels;

	let mut cx = headless_context().expect("a headless renderer is required");
	let mut session = open_session(&mut cx, state_with_a_long_file(), WINDOW_W, WINDOW_H);
	let rest = session.frame().expect("the shell renders at rest");
	let panel = panel_region(&mut session);
	let at_rest = code_runs(&rest, panel, panels);

	session
		.scroll(over_code(panel, panels), 4.0)
		.expect("the wheel reaches the code column");
	let scrolled = session.frame().expect("the shell renders scrolled");
	let moved = code_runs(&scrolled, panel, panels);

	assert_ne!(
		tops(&moved),
		tops(&at_rest),
		"a vertical wheel over the code scrolls the file: the pane's own vertical scroll answers it \
		 rather than being blocked by the horizontal region inside it"
	);
	let left_at_rest = lefts(&at_rest).into_iter().fold(f32::MAX, f32::min);
	let left_moved = lefts(&moved).into_iter().fold(f32::MAX, f32::min);
	assert!(
		(left_at_rest - left_moved).abs() < 0.5,
		"a vertical wheel leaves the horizontal offset alone: the leading edge went from \
		 {left_at_rest}px to {left_moved}px, which is GPUI mapping one axis onto the other"
	);
}

#[test]
fn a_file_a_little_taller_than_the_pane_scrolls_to_its_last_line() {
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let panels = &tokens.surface.panels;

	// The window a native take of this pane records at, and a file whose rows
	// come to a couple of dozen pixels past the pane rather than to hundreds:
	// a scroll container laid out taller than the viewport it sits in scrolls
	// the long file and cannot scroll this one, so the long file alone is not
	// evidence that the pane scrolls at all.
	let mut cx = headless_context().expect("a headless renderer is required");
	let mut session = open_session(&mut cx, state_with_a_file_of(40), 1180, 800);
	let rest = session.frame().expect("the shell renders at rest");
	let panel = panel_region(&mut session);
	let at_rest = gutter_runs(&rest, panel, panels);

	session
		.scroll(over_code(panel, panels), 6.0)
		.expect("the wheel reaches the pane");
	let scrolled = session.frame().expect("the shell renders scrolled");
	let moved = gutter_runs(&scrolled, panel, panels);

	let last_at_rest = tops(&at_rest).into_iter().fold(f32::MIN, f32::max);
	assert_ne!(
		tops(&moved),
		tops(&at_rest),
		"the file scrolls to its last line: 40 rows of {row}px stand in a panel of {panel:?}, \
		 {drawn} of them drawn and the lowest at {last_at_rest}px, and the wheel moved none of them \
		 -- a pane whose own box is as tall as its rows has nowhere to scroll to and clips the rest \
		 against the window instead",
		row = panels.diff_row_height_px,
		drawn = at_rest.len(),
	);
}

#[test]
fn every_row_of_the_pane_is_the_size_and_the_line_its_tokens_author() {
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let panels = &tokens.surface.panels;

	let mut cx = headless_context().expect("a headless renderer is required");
	let mut session = open_session(&mut cx, state_with_long_line(), WINDOW_W, WINDOW_H);
	let rest = session.frame().expect("the shell renders at rest");
	let panel = panel_region(&mut session);

	let code = code_runs(&rest, panel, panels);
	let numbers = gutter_runs(&rest, panel, panels);
	assert_eq!(numbers.len(), 4, "the gutter draws one number per line of the file: {numbers:?}");
	// Paired by the row they share, not by their order in the frame: a line
	// arrives in as many runs as its highlighting split it into, so a count
	// against a count would say nothing about the columns keeping step.
	for number in &numbers {
		let beside = code.iter().any(|run| (run.top - number.top).abs() < 0.5);
		assert!(
			beside,
			"the number at {number:?} has its line's text on the same row: code {code:?}"
		);
	}
	for run in &code {
		assert!(
			numbers
				.iter()
				.any(|number| (number.top - run.top).abs() < 0.5),
			"every code run sits on a row the gutter numbered: {run:?} against {numbers:?}"
		);
	}

	// The premise `is_number` rests on, asserted rather than assumed: no line of
	// this file fits inside the band the gutter pins, so no code run can be read
	// as a number at any offset the gesture reaches.
	for run in &code {
		assert!(
			run.width() > panels.diff_gutter_width_px,
			"every line of this file is wider than the gutter it sits beside: {run:?} against {}px",
			panels.diff_gutter_width_px
		);
	}

	let pane_sizes: Vec<f32> = row_runs(&rest, panel, panels)
		.into_iter()
		.map(|(_, size)| size)
		.collect();
	assert!(!pane_sizes.is_empty(), "the pane drew rows under its own header for this to read");
	for size in pane_sizes {
		assert!(
			(size - panels.diff_font_size.size).abs() < 0.5,
			"every row of the pane is drawn at the size the panel's tokens author for it: {size}px \
			 against {}px",
			panels.diff_font_size.size
		);
	}
}

#[test]
fn a_row_stands_at_the_height_the_panel_authors_it() {
	// `diff.row_height_px` is 18px and a shaped mono line at the panel's own
	// size is 18px too, so a pane that let its rows take their content's height
	// would draw the same frame and every assertion above would hold. The token
	// is moved instead: a row follows what the panel authors, or it follows
	// GPUI's default line and this is the only test that can tell.
	let mut tokens = load_bundled_tokens().expect("the bundled tokens load");
	let authored = tokens.surface.panels.diff_row_height_px + 6.0;
	tokens.surface.panels.diff_row_height_px = authored;

	let mut cx = headless_context().expect("a headless renderer is required");
	let mut session =
		open_session_on_tokens(&mut cx, state_with_long_line(), WINDOW_W, WINDOW_H, tokens.clone());
	let rest = session.frame().expect("the shell renders at rest");
	let panel = panel_region(&mut session);
	let numbers = gutter_runs(&rest, panel, &tokens.surface.panels);
	assert_eq!(numbers.len(), 4, "the gutter drew its four numbers: {numbers:?}");

	let mut tops: Vec<f32> = numbers.iter().map(|run| run.top).collect();
	tops.sort_by(f32::total_cmp);
	for pair in tops.windows(2) {
		let pitch = pair[1] - pair[0];
		assert!(
			(pitch - authored).abs() < 0.5,
			"a row is the height the panel's tokens author: the rows step by {pitch}px against the \
			 authored {authored}px"
		);
	}
}
