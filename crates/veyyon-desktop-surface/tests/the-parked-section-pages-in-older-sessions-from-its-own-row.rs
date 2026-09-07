//! WHY: `Parked` is the one unbounded queue partition, so the rail draws 25 of
//! its rows and offers the rest behind an `Older` row the operator clicks
//! (§5.2). The paging arithmetic already has a unit test over `RailMotion` and
//! `paged_rail_fill`; nothing drove the rendered rail, so an `Older` row that
//! was never built, never hit-testable, or wired to nothing left every
//! assertion green while an operator could not reach a parked session past the
//! first page.
//!
//! CLASS CLOSED:
//! 1. The rail building no `Older` item when a parked overflow exists.
//! 2. The `Older` row rendering as decoration the frame answers no click on.
//! 3. The `Older` click failing to advance the page, or advancing it without
//!    the rail drawing the next page of rows.
//! 4. The `Older` click selecting a session, since it is not a session row.
//! 5. An `Older` row appearing for a parked section that fits in one page.
//! 6. Paging leaking onto a partition that is not `Parked`, which would hide
//!    `Unsent`, `Pinned`, `Live` or `Deferred` rows behind a control their
//!    sections never draw.
//!
//! NOT CAUGHT: the row's label text. A headless capture carries text run
//! geometry without its string, so `Older (35 remaining)` stating the wrong
//! count is not observable here; the drawn and hidden counts it is formatted
//! from are asserted instead.

#[path = "support/queue-actions/mod.rs"]
mod queue_actions;
#[path = "support/queue-scroll/mod.rs"]
mod queue_scroll;

use queue_actions::{QueueMetrics, center_of, find_queue_rows};
use queue_scroll::{open_session, row};
use veyyon_desktop_scene::headless::headless_context;
use veyyon_desktop_surface::{ShellState, attach::ConnectionPhase, model::Section};
use veyyon_gpui::{Point, px};

/// The token page size the rail draws before it holds the rest back.
const PAGE: usize = 25;

/// A session id no fixture row carries, so nothing auto-pages to reveal the
/// selection and no row draws as selected.
const NO_SELECTION: u64 = 999;

fn state_with(section: Section, count: usize) -> ShellState {
	let rows = (1..=count)
		.map(|i| row(i as u64, format!("session {i}"), "veyyon-desktop-surface", None, None))
		.collect();
	ShellState {
		title: "veyyon-desktop-surface".to_owned(),
		sections: vec![(section, rows)],
		current_id: NO_SELECTION,
		connection: ConnectionPhase::Attached,
		..ShellState::default()
	}
}

#[test]
fn a_parked_overflow_draws_an_older_row_whose_click_pages_in_the_next_page() {
	let metrics = QueueMetrics::load();
	let mut cx = headless_context().expect("headless renderer is required");
	let mut session = open_session(&mut cx, state_with(Section::Parked, 60), 1440, 1400);

	let frame = session.frame().expect("shell renders frame");
	let rail_rows = find_queue_rows(&frame, &metrics);
	assert_eq!(
		rail_rows.len(),
		PAGE + 1,
		"the rail draws one page of parked lines plus the Older row that reaches the rest"
	);

	session
		.update(|view, _window, _cx| {
			assert_eq!(view.rail_motion().parked_page(), 1, "the rail opens on the first page");
			assert_eq!(
				view.rail_motion().list_state().item_count(),
				1 + PAGE + 1,
				"the built list is the section header, one page of rows, and the Older row"
			);
		})
		.expect("first page observed");

	let older = *rail_rows
		.last()
		.expect("the Older row is the last line in the rail");
	assert_eq!(
		older.size.height, metrics.line_height,
		"the Older row draws at the archival line height"
	);
	session
		.click(center_of(older))
		.expect("the frame answers a click on the Older row");

	session
		.update(|view, _window, _cx| {
			assert_eq!(view.rail_motion().parked_page(), 2, "the click advances the parked page");
			assert_eq!(
				view.rail_motion().list_state().item_count(),
				1 + PAGE * 2 + 1,
				"the rail now draws two pages of rows and still offers the remainder"
			);
			assert_eq!(
				view.state().current_id,
				NO_SELECTION,
				"the Older row is not a session row and selects nothing"
			);
			assert!(
				view.drain_intents().is_empty(),
				"paging is a rail-local move and asks the host for nothing"
			);
		})
		.expect("second page observed");
}

#[test]
fn a_parked_section_that_fits_one_page_draws_no_older_row() {
	let metrics = QueueMetrics::load();
	let mut cx = headless_context().expect("headless renderer is required");
	let mut session = open_session(&mut cx, state_with(Section::Parked, PAGE), 1440, 1400);

	let frame = session.frame().expect("shell renders frame");
	let rail_rows = find_queue_rows(&frame, &metrics);
	assert_eq!(rail_rows.len(), PAGE, "an exact page draws its rows and nothing more");

	session
		.update(|view, _window, _cx| {
			assert_eq!(
				view.rail_motion().list_state().item_count(),
				1 + PAGE,
				"the built list is the section header and its rows, with no Older row"
			);
		})
		.expect("exact page observed");

	let last = *rail_rows.last().expect("the section drew its rows");
	let below = Point { x: center_of(last).x, y: last.origin.y + last.size.height + px(18.0) };
	session
		.click(below)
		.expect("a click below the last row is answered");

	session
		.update(|view, _window, _cx| {
			assert_eq!(
				view.rail_motion().parked_page(),
				1,
				"nothing under the last row pages a section that has no hidden rows"
			);
			assert_eq!(
				view.rail_motion().list_state().item_count(),
				1 + PAGE,
				"the list is unchanged by a click on empty rail"
			);
		})
		.expect("no paging observed");
}

#[test]
fn a_deferred_overflow_draws_every_row_and_never_pages() {
	let mut cx = headless_context().expect("headless renderer is required");
	let mut session = open_session(&mut cx, state_with(Section::Deferred, 60), 1440, 1400);
	session.frame().expect("shell renders frame");

	session
		.update(|view, _window, _cx| {
			assert_eq!(
				view.rail_motion().list_state().item_count(),
				1 + 60,
				"Deferred is bounded by the operator, so the rail builds every row with no Older row"
			);
		})
		.expect("deferred list observed");
}
