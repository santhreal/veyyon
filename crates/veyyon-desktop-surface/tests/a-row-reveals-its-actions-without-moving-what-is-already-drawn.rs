//! WHY: A queue row keeps its contextual actions unpainted until the pointer is
//! over the row (§5.1, §5.2). The reveal has to be ink and nothing else. A row
//! that grows a control on hover reflows its own meta text, its title
//! truncation and every row below it, so the pointer lands on a row that moved
//! out from under it while the click was travelling, and the rect it answers
//! after the reflow is not the rect the operator aimed at.
//!
//! THE CLASS THIS CLOSES: geometry, and reach, that arrive with the reveal —
//! for every row shape the rail draws. Both shapes are swept from the shipped
//! fixture at run time rather than named here: the card sections (`Unsent`,
//! `Pinned`, `Live`) and the line sections (`Deferred`, `Parked`) are found by
//! the height the tokens give each shape and the width the rail gives a row, so
//! a section that changes shape is swept in its new shape. The suite holds
//! four invariants at once, which is what makes the obvious refactors — a
//! reveal driven from tracked hover state instead of a hidden element, and a
//! slot taken out of the row's flow so it costs no width — fail rather than
//! pass quietly:
//!
//! 1. Every text box in the rail column keeps its exact rect across the hover.
//! 2. Every rect the row answers is the same rect before and after, so the
//!    reveal adds no control and moves none.
//! 3. The reserved slots gain ink under the pointer, so the reveal is a reveal
//!    and not a no-op that would satisfy the others by drawing nothing.
//! 4. A revealed slot covers none of the rail's text, so a slot that costs the
//!    row no width is caught by the text it lands on.
//!
//! WHAT IT DOES NOT CATCH: the intents those actions dispatch, which
//! `queue-row-hover-actions-and-menu-dispatch` drives; the motion of a row that
//! changes partition, which `the-rail-moves-a-row-with-shift-and-settles`
//! owns; and hover reveals outside the rail. A hover style cannot move a box in
//! this element system — layout is computed from the base style and hover
//! resolves at paint — so invariant 1 guards the state-driven reveal rather
//! than the styled one, and the reachability of a hidden slot is unreachable by
//! construction rather than asserted here: the reveal is derived from the
//! pointer's position, so a pointer inside the slot has already painted it.

#[path = "support/queue-scroll/mod.rs"]
#[allow(dead_code, reason = "this binary uses a subset of the shared session helpers")]
mod queue_scroll;

use queue_scroll::open_session;
use veyyon_desktop_kit::load_bundled_tokens;
use veyyon_desktop_scene::{BoxBounds, Captured, HeadlessSession, headless_context, text_boxes};
use veyyon_desktop_surface::{ShellView, fixture};
use veyyon_gpui::{Bounds, Pixels, Point};

/// The window this renders in. Wide enough that no width shed is in play, so a
/// moved text box is the hover's doing and not the breakpoint's.
const WINDOW_W: u32 = 1280;
const WINDOW_H: u32 = 900;

fn rect(bounds: Bounds<Pixels>) -> BoxBounds {
	BoxBounds {
		left:   f32::from(bounds.origin.x),
		top:    f32::from(bounds.origin.y),
		right:  f32::from(bounds.origin.x) + f32::from(bounds.size.width),
		bottom: f32::from(bounds.origin.y) + f32::from(bounds.size.height),
	}
}

fn ordered(mut boxes: Vec<BoxBounds>) -> Vec<BoxBounds> {
	boxes.sort_by(|a, b| {
		(a.top, a.left, a.right, a.bottom)
			.partial_cmp(&(b.top, b.left, b.right, b.bottom))
			.unwrap_or(std::cmp::Ordering::Equal)
	});
	boxes
}

/// Every text box drawn inside the rail's own column.
fn rail_texts(captured: &Captured, rail_px: f32) -> Vec<BoxBounds> {
	ordered(
		text_boxes(captured)
			.into_iter()
			.filter(|b| b.right <= rail_px + 1.0)
			.collect(),
	)
}

/// The rows the rail draws whole at the given shape height, in draw order.
///
/// A row is as wide as the rail less its insets, which is what separates it
/// from the footer's gear and a section header's chevron — both of which are
/// square controls that can share a shape's height. `floor` is the lower edge
/// of the rail's list: the last row is clipped against it, and a slot clipped
/// out of the viewport can paint no ink to compare.
fn rows_of_height(captured: &Captured, rail_px: f32, height: f32, floor: f32) -> Vec<BoxBounds> {
	ordered(
		captured
			.hitboxes
			.iter()
			.map(|b| rect(*b))
			.filter(|b| {
				b.right <= rail_px + 1.0
					&& (b.height() - height).abs() < 0.5
					&& b.width() > rail_px / 2.0
					&& b.bottom <= floor + 0.5
			})
			.collect(),
	)
}

/// Every hitbox that lies inside the row's rect, the row's own included.
fn hitboxes_within(captured: &Captured, row: BoxBounds) -> Vec<BoxBounds> {
	ordered(
		captured
			.hitboxes
			.iter()
			.map(|b| rect(*b))
			.filter(|b| {
				b.left >= row.left - 0.5
					&& b.right <= row.right + 0.5
					&& b.top >= row.top - 0.5
					&& b.bottom <= row.bottom + 0.5
			})
			.collect(),
	)
}
/// Whether `outer` holds `inner` entirely.
fn contains(outer: &BoxBounds, inner: &BoxBounds) -> bool {
	inner.left >= outer.left - 0.5
		&& inner.right <= outer.right + 0.5
		&& inner.top >= outer.top - 0.5
		&& inner.bottom <= outer.bottom + 0.5
}

/// The controls a row holds: every distinct hitbox inside it that is not the
/// row, and not a band around other controls. A single action and the band
/// around it occupy the same rect, so coincident rects count once.
fn leaf_controls(captured: &Captured, row: BoxBounds) -> Vec<BoxBounds> {
	let mut within: Vec<BoxBounds> = Vec::new();
	for slot in hitboxes_within(captured, row) {
		if slot != row && !within.contains(&slot) {
			within.push(slot);
		}
	}
	within
		.iter()
		.filter(|slot| {
			!within
				.iter()
				.any(|other| other != *slot && contains(slot, other))
		})
		.copied()
		.collect()
}

/// How many distinct colours a rect holds. A slot that reserves space but
/// paints nothing is one flat ground colour; a glyph in it is many.
fn colours_in(captured: &Captured, area: BoxBounds) -> usize {
	let mut seen: Vec<veyyon_desktop_scene::RgbaColor> = Vec::new();
	let left = area.left.max(0.0) as u32;
	let top = area.top.max(0.0) as u32;
	let right = area.right.max(0.0) as u32;
	let bottom = area.bottom.max(0.0) as u32;
	for y in top..bottom {
		for x in left..right {
			if let Some(colour) = captured.frame.pixel(x, y)
				&& !seen.contains(&colour)
			{
				seen.push(colour);
			}
		}
	}
	seen.len()
}

fn centre(area: BoxBounds) -> Point<Pixels> {
	Point {
		x: Pixels::from(f32::midpoint(area.left, area.right)),
		y: Pixels::from(f32::midpoint(area.top, area.bottom)),
	}
}

/// Hovers one row of the given shape and holds the three invariants over it.
fn a_row_of_this_shape_reveals_without_moving(shape: &str, height: f32, actions: usize) {
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let rail_px = tokens
		.surface
		.breakpoints
		.resolve(WINDOW_W as f32)
		.queue_width_px;
	assert!(rail_px > 0.0, "the window draws a rail at {WINDOW_W}px");

	let mut cx = headless_context().expect("headless renderer is required");
	let mut session: HeadlessSession<'_, ShellView> =
		open_session(&mut cx, fixture::populated(), WINDOW_W, WINDOW_H);

	let rest = session.frame().expect("the shell renders at rest");
	let rest_texts = rail_texts(&rest, rail_px);
	let floor = WINDOW_H as f32 - tokens.surface.queue.footer_height_px;
	let rows = rows_of_height(&rest, rail_px, height, floor);
	assert!(
		!rows.is_empty(),
		"the fixture draws at least one {shape} row of {height}px in the rail"
	);

	// The last row of the shape, not the first: a row at the top of the rail
	// can only push rows below it, while a row further down would also move
	// under a reflow above it. Both directions are covered by asserting the
	// whole column, but the hovered row is the one whose own slot is at issue.
	let row = *rows.last().expect("the shape draws a row");
	let rest_reach = hitboxes_within(&rest, row);

	session
		.hover(centre(row))
		.expect("the pointer reaches the row");
	let hovered = session
		.frame()
		.expect("the shell renders under the pointer");

	assert_eq!(
		rail_texts(&hovered, rail_px),
		rest_texts,
		"hovering a {shape} row moves no text in the rail column"
	);

	assert_eq!(
		hitboxes_within(&hovered, row),
		rest_reach,
		"hovering a {shape} row changes nothing about what it answers: the reveal is ink, so the \
		 rects are the rects the row already held"
	);

	// The row's own rect answers a click anywhere on it, which is how a session
	// opens. What is left is the action slots, which the row reserves whether
	// or not the pointer is over it.
	let slots = leaf_controls(&rest, row);
	assert_eq!(
		slots.len(),
		actions,
		"a {shape} row reserves {actions} action slot(s) at rest; got {slots:?}"
	);

	for slot in &slots {
		let at_rest = colours_in(&rest, *slot);
		let under_pointer = colours_in(&hovered, *slot);
		assert!(
			under_pointer > at_rest,
			"the {shape} row's action slot {slot:?} gains ink under the pointer: {at_rest} colour(s) \
			 at rest, {under_pointer} hovered"
		);
		// A slot out of the row's flow takes no width from the text beside it,
		// so the reveal lands on top of that text instead of beside it. The
		// hovered frame is the one that shows it, and the resting frame proves
		// the slot was never over the text to begin with.
		for text in rail_texts(&hovered, rail_px) {
			assert!(
				text.overlap_x(slot) <= 0.0 || text.overlap_y(slot) <= 0.0,
				"the {shape} row's revealed action at {slot:?} draws beside the rail's text, not over \
				 it; {text:?} is underneath"
			);
		}
	}
}

#[test]
fn hovering_a_card_reveals_its_actions_and_moves_nothing_the_rail_already_drew() {
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	// Park and defer: §5.1 caps a card at two hover actions, and the card is
	// the shape the active sections draw.
	a_row_of_this_shape_reveals_without_moving("card", tokens.surface.queue.card_px, 2);
}

#[test]
fn hovering_a_line_reveals_its_action_and_moves_nothing_the_rail_already_drew() {
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	// One restore action: recall for `Deferred`, unpark for `Parked`.
	a_row_of_this_shape_reveals_without_moving("line", tokens.surface.queue.line_px, 1);
}

#[test]
fn the_pointer_leaving_a_row_puts_the_ink_back_without_moving_anything_either() {
	// A reveal that is undone by a reflow is the same defect arriving on the
	// way out, and a row that keeps its actions painted and reachable after the
	// pointer has left is a permanent control the section never asked for.
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let rail_px = tokens
		.surface
		.breakpoints
		.resolve(WINDOW_W as f32)
		.queue_width_px;
	let mut cx = headless_context().expect("headless renderer is required");
	let mut session: HeadlessSession<'_, ShellView> =
		open_session(&mut cx, fixture::populated(), WINDOW_W, WINDOW_H);

	let rest = session.frame().expect("the shell renders at rest");
	let rest_texts = rail_texts(&rest, rail_px);
	let floor = WINDOW_H as f32 - tokens.surface.queue.footer_height_px;
	let cards = rows_of_height(&rest, rail_px, tokens.surface.queue.card_px, floor);
	let row = *cards.last().expect("the fixture draws a card");
	let rest_reach = hitboxes_within(&rest, row);

	session
		.hover(centre(row))
		.expect("the pointer reaches the card");
	let _ = session.frame().expect("the hovered frame renders");

	// Off the rail entirely, over the transcript column.
	session
		.hover(Point { x: Pixels::from(rail_px + 200.0), y: Pixels::from(300.0) })
		.expect("the pointer leaves the rail");
	let left = session
		.frame()
		.expect("the frame after the pointer leaves renders");

	assert_eq!(
		rail_texts(&left, rail_px),
		rest_texts,
		"the pointer leaving the rail moves no text back"
	);
	assert_eq!(
		hitboxes_within(&left, row),
		rest_reach,
		"the row answers the rects it answered before the pointer arrived, and no others"
	);
}
