//! WHY: the attached stack shows at most two decisions, and everything past
//! that folds into one 24px line. A line that states only `3 more waiting` is a
//! number, not a queue: the operator cannot tell whether the three are an
//! approval that will run a command, a question, or a plan, and the only way to
//! find out is to answer the two on top. §5.5 authors the line as a count that
//! expands on hover or focus, and the expansion is what makes the fold safe.
//!
//! The expansion cannot be a `hover` style. Layout is computed from the base
//! style and a hover refinement resolves at paint, so a row whose open height
//! lives in `.hover()` never grows — it paints a taller background over the
//! same 24px box and clips its own content. The height therefore comes from
//! recorded state, and this suite is what separates the two: it reads the box
//! the frame laid out, not the pixels it filled.
//!
//! CLASS CLOSED, for every hidden count the fold can produce:
//! 1. The fold appearing when nothing is folded, or missing when something is.
//!    Both directions are asserted, at a card count under the cap and over it,
//!    so a row drawn unconditionally fails as loudly as a row never drawn.
//! 2. The collapsed height drifting off the token, or scaling with what it
//!    holds. The token is read at run time and the row is measured against it,
//!    and separately every line the fold draws is read from the row's own text
//!    inset and required to sit one authored line below the one over it, with
//!    the first folded name at or past the row's lower edge. A row that shrank
//!    its lines to share the one row keeps the authored box and draws a cut
//!    name under the count, packing the runs closer than the line.
//! 3. The open height not accounting for what is folded: it is asserted to be
//!    one line per hidden decision plus the count's own, for one, two and three
//!    hidden decisions, so a row that opens by a constant passes at one and
//!    fails at two.
//! 4. The expansion reaching only the pointer. The keyboard arm is driven by a
//!    press that moves the focus to the row and a pointer that then leaves it,
//!    which is the state a `tab` walk arrives in.
//! 5. The row never closing again, which would leave the stack permanently over
//!    its cap: the pointer leaves and the row is measured again.
//! 6. The names going missing, or collapsing to one repeated label. Every
//!    folded decision contributes a text run inside the open row, and the runs
//!    are asserted to be pairwise distinct in width — the fixtures carry
//!    subjects of visibly different lengths, so one label repeated three times
//!    fails.
//! 7. The row being ink the frame will not answer: the box is required to
//!    coincide with a registered hit rect at every count.
//!
//! NOT CAUGHT: the wording. A rendered frame carries each text run's box and
//! size, never its string, so `Approval: bash` against `bash` is a
//! `waiting_line` contract and unreachable from here. Nor does this suite say
//! anything about the two cards on top of the fold, which the card-stack
//! control and ink suites own.

#[path = "support/decision-fold/mod.rs"]
#[allow(dead_code, reason = "this binary uses a subset of the shared fold helpers")]
mod decision_fold;

use decision_fold::{
	WINDOW_H, WINDOW_W, away, cards_region, centre, fold_lines, fold_row, open_session, runs_within,
	state_with,
};
use veyyon_desktop_kit::load_bundled_tokens;
use veyyon_desktop_scene::headless_context;
#[test]
fn a_stack_under_its_cap_folds_nothing_and_draws_no_count() {
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let cap = tokens.surface.attached_cards.stack_max_visible;

	for count in 1..=cap {
		let mut cx = headless_context().expect("a headless renderer is required");
		let mut session = open_session(&mut cx, state_with(count), WINDOW_W, WINDOW_H);
		let rest = session.frame().expect("the shell renders at rest");
		let cards = cards_region(&mut session);

		assert!(
			fold_row(&rest, cards).is_none(),
			"{count} decision(s) fit under the cap of {cap}, so the stack draws no fold: every one \
			 of them is on screen with its own answers"
		);
	}
}

#[test]
fn the_fold_is_one_token_line_however_many_it_holds() {
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let geometry = &tokens.surface.attached_cards;
	let cap = geometry.stack_max_visible;

	for hidden in 1..=3 {
		let mut cx = headless_context().expect("a headless renderer is required");
		let mut session = open_session(&mut cx, state_with(cap + hidden), WINDOW_W, WINDOW_H);
		let rest = session.frame().expect("the shell renders at rest");
		let cards = cards_region(&mut session);
		let row = fold_row(&rest, cards)
			.unwrap_or_else(|| panic!("{hidden} decision(s) past the cap fold into a row"));

		assert!(
			(row.height() - geometry.stack_overflow_collapsed_height_px).abs() < 0.5,
			"the fold holding {hidden} decision(s) is the one line its token authors: {}px against \
			 {}px",
			row.height(),
			geometry.stack_overflow_collapsed_height_px
		);
	}
}

/// A collapsed fold states the count and nothing else. The row is one line
/// tall whatever it holds, so its own height cannot say whether the lines
/// inside it were CLIPPED or SQUEEZED into it: a flex child yields its height
/// by default, and a row of one line holding three of them handed each a third
/// of a line. The frame drawn from that is the count with the first folded name
/// cut through the middle of its glyphs underneath it, which is how a native
/// take found it, and every height assertion above passes on it.
#[test]
fn the_collapsed_fold_holds_the_count_alone_and_clips_the_rest() {
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let geometry = &tokens.surface.attached_cards;
	let cap = geometry.stack_max_visible;
	let line = geometry.stack_overflow_collapsed_height_px;

	for hidden in 1..=3 {
		let mut cx = headless_context().expect("a headless renderer is required");
		let mut session = open_session(&mut cx, state_with(cap + hidden), WINDOW_W, WINDOW_H);
		let rest = session.frame().expect("the shell renders at rest");
		let cards = cards_region(&mut session);
		let row = fold_row(&rest, cards).expect("the stack folds what it cannot show");

		let runs = runs_within(&rest, row);
		assert_eq!(
			runs.len(),
			1,
			"the collapsed fold holding {hidden} decision(s) draws the count and nothing else inside \
			 its own box; got {runs:?}"
		);

		let lines = fold_lines(&rest, row, 1 + hidden, line);
		assert_eq!(
			lines.len(),
			1 + hidden,
			"the fold draws the count and one line for each of the {hidden} decision(s) it holds, \
			 all at the row's own text inset; got {lines:?}"
		);
		assert!(
			lines[0].height() <= line + 0.5,
			"the count keeps the line the token authors rather than a share of it: {}px against \
			 {line}px",
			lines[0].height()
		);
		for pair in lines.windows(2) {
			let pitch = pair[1].top - pair[0].top;
			assert!(
				(pitch - line).abs() < 1.0,
				"the folded lines keep the {line}px line they are authored at and leave the row by \
				 its lower edge; packed {pitch}px apart they were shrunk to share one row, which \
				 draws a cut line of the next name under the count"
			);
		}
		assert!(
			lines[1].top >= row.bottom - 0.5,
			"the first folded line starts at or past the row's lower edge, where the row clips it: \
			 it starts {}px above it",
			row.bottom - lines[1].top
		);
	}
}

#[test]
fn the_pointer_opens_the_fold_onto_one_line_for_each_decision_in_it() {
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let geometry = &tokens.surface.attached_cards;
	let cap = geometry.stack_max_visible;
	let line = geometry.stack_overflow_collapsed_height_px;

	for hidden in 1..=3 {
		let mut cx = headless_context().expect("a headless renderer is required");
		let mut session = open_session(&mut cx, state_with(cap + hidden), WINDOW_W, WINDOW_H);
		let rest = session.frame().expect("the shell renders at rest");
		let cards = cards_region(&mut session);
		let collapsed = fold_row(&rest, cards).expect("the stack folds what it cannot show");

		session
			.hover(centre(collapsed))
			.expect("the pointer reaches the fold");
		let hovered = session
			.frame()
			.expect("the shell renders under the pointer");
		let cards = cards_region(&mut session);
		let open = fold_row(&hovered, cards).expect("the fold is still on screen under the pointer");

		let expected = line * (1 + hidden) as f32;
		assert!(
			(open.height() - expected).abs() < 0.5,
			"the fold holding {hidden} decision(s) opens onto the count's line and one for each of \
			 them: {}px against {expected}px",
			open.height()
		);

		let runs = runs_within(&hovered, open);
		assert_eq!(
			runs.len(),
			1 + hidden,
			"the open fold states the count and names each of the {hidden} decision(s) it holds; got \
			 {runs:?}"
		);
		for (index, run) in runs.iter().enumerate() {
			for other in runs.iter().skip(index + 1) {
				assert!(
					(run.width() - other.width()).abs() > 0.5,
					"each line of the open fold names its own decision, so no two are the same shaped \
					 width: {run:?} against {other:?}"
				);
			}
		}

		session.hover(away()).expect("the pointer leaves the fold");
		let left = session
			.frame()
			.expect("the shell renders with the pointer away");
		let cards = cards_region(&mut session);
		let closed = fold_row(&left, cards).expect("the fold is still on screen");
		assert!(
			(closed.height() - line).abs() < 0.5,
			"the fold closes when the pointer leaves, or the stack stays over its cap for the rest \
			 of the session: {}px against {line}px",
			closed.height()
		);
	}
}

#[test]
fn the_keyboard_holds_the_fold_open_after_the_pointer_has_gone() {
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let geometry = &tokens.surface.attached_cards;
	let cap = geometry.stack_max_visible;
	let hidden = 3;

	let mut cx = headless_context().expect("a headless renderer is required");
	let mut session = open_session(&mut cx, state_with(cap + hidden), WINDOW_W, WINDOW_H);
	let rest = session.frame().expect("the shell renders at rest");
	let cards = cards_region(&mut session);
	let collapsed = fold_row(&rest, cards).expect("the stack folds what it cannot show");

	// A press on the row moves the focus to it, which is the state a `tab`
	// walk arrives in. The pointer then leaves, so what holds the row open is
	// the keyboard alone.
	session
		.click(centre(collapsed))
		.expect("the press reaches the fold");
	session.hover(away()).expect("the pointer leaves the fold");
	let focused = session
		.frame()
		.expect("the shell renders with the fold focused");
	let cards = cards_region(&mut session);
	let open = fold_row(&focused, cards).expect("the fold is still on screen");

	let expected = geometry.stack_overflow_collapsed_height_px * (1 + hidden) as f32;
	assert!(
		(open.height() - expected).abs() < 0.5,
		"the fold that holds the keyboard states what it holds without a pointer on it: {}px \
		 against {expected}px",
		open.height()
	);
}

#[test]
fn the_fold_is_a_rect_the_frame_answers() {
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let cap = tokens.surface.attached_cards.stack_max_visible;

	for hidden in 1..=3 {
		let mut cx = headless_context().expect("a headless renderer is required");
		let mut session = open_session(&mut cx, state_with(cap + hidden), WINDOW_W, WINDOW_H);
		let rest = session.frame().expect("the shell renders at rest");
		let cards = cards_region(&mut session);
		let row = fold_row(&rest, cards).expect("the stack folds what it cannot show");

		// `fold_row` reads the hit rects, so the row being there at all is the
		// reach. What is left is that it is the row and not a sliver of one:
		// a rect narrower than the stack, or of no height, answers a press
		// nowhere the count is drawn.
		assert!(
			row.width() > 300.0 && row.height() > 0.0,
			"the fold answers a press across the line it draws; got {row:?}"
		);
		assert!(
			!runs_within(&rest, row).is_empty(),
			"the rect the frame answers is the one the count is drawn in; got {row:?}"
		);
	}
}
