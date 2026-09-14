//! WHY: §5.11's mono panes scroll, so the file a pane holds is taller and
//! wider than the box it draws in. Both panes built a cell for every line and
//! a run for every span anyway, and then scissored away everything outside the
//! box. Opening a 40-line file of 900 columns in the docked panel handed GPUI
//! some 13,000 text runs to lay out, shape and paint for the 400 the panel
//! showed. One frame cost 140ms of a core in software rendering, the window
//! redrew at 7fps, and a pointer press, a keystroke and a wheel over the pane
//! all landed on a surface that had stopped answering — the freeze a native
//! take of the pane recorded, with the file drawn and nothing after it
//! responding. A diff of a few thousand rows is the same defect on the other
//! tenant, and a GPU only moves the line.
//!
//! The fix is that a frame costs what the pane draws, never what the file
//! holds: the rows and columns outside the box are replaced by padding of the
//! extent they would have occupied, so the scroll extent, and every offset the
//! wheel can reach, are unchanged.
//!
//! CLASS CLOSED:
//! 1. Cost following the file rather than the box, on either axis. The same
//!    fixture is drawn at two sizes an order of magnitude apart and the runs
//!    the pane drew are required to be the same count, so a pane that builds
//!    per line, or per span, fails whatever the constants are. Asserted for the
//!    file tenant and for the diff tenant, unified and split.
//! 2. A window that is all overscan. The rows and pieces drawn are required to
//!    be strictly fewer than the file's, so a "window" that admits everything
//!    fails rather than passing on the equality above.
//! 3. The rest of the file becoming unreachable, which is what windowing breaks
//!    if the skipped rows leave no extent behind. The wide line is put last in
//!    a file of thousands and the pane is scrolled to it, and it is required to
//!    arrive.
//! 4. A row drawn in the wrong place: the drawn rows are required to step by
//!    the authored row height with no gap where padding meets them, and the
//!    first piece of a row at rest is required to start at the code column's
//!    own left edge rather than indented by a window that forgot its offset.
//! 5. The columns drifting apart, which is what a per-column window would do:
//!    the gutter and the code are required to draw the same rows, at the same
//!    tops, at both sizes.
//! 6. An offset the layout has not clamped yet, on either axis. Every wheel
//!    adds its delta and the next layout clamps it, so a run of the wheel
//!    between two frames leaves a handle reporting a distance the pane cannot
//!    travel — a diff of nine rows reported itself 520px down a file 250px
//!    tall, every row on screen was measured as a row above the box, and the
//!    pane drew the padding standing in for them. A pane is put past its own
//!    extent on each axis and is required to draw the rows and columns at that
//!    end.
//!
//! NOT CAUGHT: how long a frame takes, which is what the defect was measured
//! in. A count of runs is the cause and a millisecond count is a machine's
//! answer to it, so this suite pins the cause. Nor which line a row carries —
//! a captured run has bounds and a size, not text, so the wide line's own
//! width is what identifies it here. The gestures themselves, the pinned
//! gutter and the scroll extent's end belong to
//! `a-line-wider-than-the-panel-is-reachable-and-its-numbers-stay.rs` and
//! `a-diff-line-wider-than-the-pane-arrives-without-its-numbers.rs`.

#[path = "support/mono-pane/mod.rs"]
#[allow(dead_code, reason = "this binary uses a subset of the shared pane helpers")]
mod mono_pane;

use mono_pane::{
	WINDOW_H, WINDOW_W, code_edge, code_runs, diff_state, gutter_runs, open_session, over_code,
	panel_region, state_with_a_file_of, state_with_a_line_of_pieces, state_with_the_long_line_last,
	tops,
};
use veyyon_desktop_kit::load_bundled_tokens;
use veyyon_desktop_model::DiffMode;
use veyyon_desktop_scene::{BoxBounds, Captured, HeadlessSession, headless_context};
use veyyon_desktop_surface::{PaneId, ShellState, ShellView};
use veyyon_gpui::{Pixels, Point, point, px};

/// What one frame of the pane drew: how many rows the gutter numbered, how
/// many runs the code drew, and where the rows stood.
struct Drawn {
	numbers: usize,
	code:    usize,
	tops:    Vec<f32>,
	left:    f32,
	edge:    f32,
}

/// Opens the shell on `state`, draws one frame, and reads the pane out of it.
fn drawn(state: ShellState) -> Drawn {
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let panels = &tokens.surface.panels;
	let mut cx = headless_context().expect("a headless renderer is required");
	let mut session = open_session(&mut cx, state, WINDOW_W, WINDOW_H);
	let frame = session.frame().expect("the shell renders at rest");
	let panel = panel_region(&mut session);
	let code = code_runs(&frame, panel, panels);
	let numbers = gutter_runs(&frame, panel, panels);
	Drawn {
		numbers: numbers.len(),
		code:    code.len(),
		tops:    tops(&numbers),
		left:    code.iter().map(|run| run.left).fold(f32::MAX, f32::min),
		edge:    code_edge(panel, panels),
	}
}

#[test]
fn a_taller_file_does_not_cost_a_pane_another_row() {
	let short = drawn(state_with_a_file_of(400));
	let long = drawn(state_with_a_file_of(4_000));

	assert!(
		short.numbers > 0 && short.code > 0,
		"the pane drew rows for any of this to read: {} numbers, {} code runs",
		short.numbers,
		short.code
	);
	assert_eq!(
		(short.numbers, short.code),
		(long.numbers, long.code),
		"a pane draws the rows its own box shows, so ten times the file is the same frame: {} \
		 numbers and {} code runs against {} and {}",
		short.numbers,
		short.code,
		long.numbers,
		long.code
	);
	assert_eq!(
		short.tops, long.tops,
		"and it draws them in the same places, so the rows follow the box and not the file"
	);
	assert!(
		short.numbers < 400,
		"the rows drawn are fewer than the file's, so a window that admits every row fails here \
		 rather than passing the equality above: {} of 400",
		short.numbers
	);
	assert_eq!(
		short.numbers,
		short.tops.len(),
		"each drawn row is numbered once: the gutter and the code draw the same rows"
	);
}

#[test]
fn a_wider_line_does_not_cost_a_pane_another_piece() {
	let narrow = drawn(state_with_a_line_of_pieces(200));
	let wide = drawn(state_with_a_line_of_pieces(800));

	assert!(narrow.code > 0, "the pane drew the line's pieces for any of this to read");
	assert_eq!(
		narrow.code, wide.code,
		"a pane draws the columns its own box shows, so four times the line is the same frame: {} \
		 pieces against {}",
		narrow.code, wide.code
	);
	assert!(
		narrow.code < 200,
		"the pieces drawn are fewer than the line's, so a window that admits every column fails \
		 here rather than passing the equality above: {} of 200",
		narrow.code
	);
	assert!(
		(narrow.left - narrow.edge).abs() < 0.5,
		"the first piece of an unscrolled row starts at the code column's own left edge: {}px \
		 against {}px, which is a window that dropped pieces without standing the rest where the \
		 line puts them",
		narrow.left,
		narrow.edge
	);
}

#[test]
fn the_rows_a_pane_draws_stand_in_one_unbroken_ladder() {
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let panels = &tokens.surface.panels;
	let pane = drawn(state_with_a_file_of(4_000));

	let mut ladder = pane.tops;
	ladder.sort_by(f32::total_cmp);
	ladder.dedup_by(|left, right| (*left - *right).abs() < 0.5);
	assert!(ladder.len() > 1, "the pane drew a ladder of rows: {ladder:?}");
	for pair in ladder.windows(2) {
		assert!(
			(pair[1] - pair[0] - panels.diff_row_height_px).abs() < 0.5,
			"consecutive rows stand one authored row height apart, so the padding that stands in for \
			 the skipped rows is their own extent and no row is drawn over a gap: {}px between {} \
			 and {}, against {}px",
			pair[1] - pair[0],
			pair[0],
			pair[1],
			panels.diff_row_height_px
		);
	}
}

#[test]
fn the_extent_a_pane_scrolls_is_the_whole_file_and_its_last_line_arrives() {
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let panels = &tokens.surface.panels;
	let lines = 4_000;
	let mut cx = headless_context().expect("a headless renderer is required");
	let mut session =
		open_session(&mut cx, state_with_the_long_line_last(lines), WINDOW_W, WINDOW_H);
	let rest = session.frame().expect("the shell renders at rest");
	let panel = panel_region(&mut session);

	// The extent the wheel can travel, read from the pane's own handle. This
	// is what the padding that stands in for the skipped rows is for: drop it
	// and the region holds the sixty rows the pane built, so the file ends at
	// the bottom of the box and the rest of it cannot be reached at all.
	let travel = session
		.update(|view, _window, _cx| {
			f32::from(view.pane_scrolls().handle(PaneId::FileRows).max_offset().y)
		})
		.expect("the window updates");
	let rows_px = lines as f32 * panels.diff_row_height_px;
	let floor = rows_px - (panel.bottom - panel.top);
	assert!(
		travel > floor,
		"the pane scrolls the whole file: {lines} rows of {row}px come to {rows_px}px, and a panel \
		 {height}px tall leaves at least {floor}px of travel. The handle offers {travel}px, which \
		 is a region holding the rows it drew rather than the file it carries",
		row = panels.diff_row_height_px,
		height = panel.bottom - panel.top,
	);
	assert!(
		travel < rows_px + panels.chrome_row_height_px,
		"and no more than the file: {travel}px against {rows_px}px of rows under a {}px header, \
		 which is padding standing at more than the rows it replaces",
		panels.chrome_row_height_px
	);

	// The head of this file is filler, and its last line is the one no pane
	// can hold, so the widest run drawn states which end of the file is on
	// screen.
	let widest_at_rest = widest_run(&code_runs(&rest, panel, panels));
	for _ in 0..400 {
		session
			.scroll(over_code(panel, panels), 40.0)
			.expect("the wheel reaches the pane");
	}
	let bottom = session
		.frame()
		.expect("the shell renders at the end of the file");
	let rows = gutter_runs(&bottom, panel, panels);
	let widest = widest_run(&code_runs(&bottom, panel, panels));
	assert!(
		!rows.is_empty(),
		"the pane still draws rows at the end of the file: a window measured from the wrong origin \
		 builds nothing once the offset passes it, which reads as a pane that empties as it is \
		 scrolled"
	);
	assert!(
		widest > widest_at_rest * 3.0,
		"the last line of the file arrives: it is the one line no pane can hold, and every other \
		 row of this file is filler. The widest run went from {widest_at_rest}px at the head to \
		 {widest}px at the end"
	);
}

/// The width of the widest run drawn, which for a pane's rows is the widest
/// piece of a line that reached the box.
fn widest_run(runs: &[BoxBounds]) -> f32 {
	runs
		.iter()
		.map(|run| run.right - run.left)
		.fold(0.0, f32::max)
}

#[test]
fn a_longer_diff_does_not_cost_a_pane_another_row() {
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let row_height = tokens.surface.panels.diff_row_height_px;
	for mode in [DiffMode::Unified, DiffMode::Split] {
		let short = drawn(diff_state(400, mode));
		let long = drawn(diff_state(4_000, mode));

		assert!(
			short.numbers > 0 && short.code > 0,
			"{mode:?}: the diff pane drew rows for any of this to read: {} numbers, {} code runs",
			short.numbers,
			short.code
		);
		assert_eq!(
			(short.numbers, short.code),
			(long.numbers, long.code),
			"{mode:?}: a diff pane draws the rows its own box shows, so ten times the diff is the \
			 same frame: {} numbers and {} code runs against {} and {}",
			short.numbers,
			short.code,
			long.numbers,
			long.code
		);
		assert!(
			short.numbers < 400,
			"{mode:?}: the rows drawn are fewer than the diff's, so a window that admits every row \
			 fails here: {} of 400",
			short.numbers
		);
		let mut ladder = short.tops.clone();
		ladder.sort_by(f32::total_cmp);
		ladder.dedup_by(|left, right| (*left - *right).abs() < 0.5);
		for pair in ladder.windows(2) {
			assert!(
				pair[1] - pair[0] >= row_height - 0.5,
				"{mode:?}: no two rows of the region are drawn over each other: {}px between {} and \
				 {}, under the {}px a row stands at, which is a pane whose padding does not account \
				 for what sits above it",
				pair[1] - pair[0],
				pair[0],
				pair[1],
				row_height
			);
		}
	}
}

#[test]
fn a_pane_offset_past_its_own_extent_still_draws_the_rows_at_the_end() {
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let panels = &tokens.surface.panels;
	let mut cx = headless_context().expect("a headless renderer is required");
	let mut session =
		open_session(&mut cx, state_with_the_long_line_last(4_000), WINDOW_W, WINDOW_H);
	session.frame().expect("the shell renders at rest");
	let panel = panel_region(&mut session);

	// Every wheel adds its delta to the offset and the next layout clamps it,
	// so a run of the wheel between two frames leaves the handle reporting a
	// distance the pane cannot travel — 520px down a file 250px tall, in the
	// take that found this. Set here rather than gestured: the excess depends
	// on how many events arrive between two layouts, and the invariant does
	// not.
	let past_the_rows = offset_past(&mut session, PaneId::FileRows, point(px(0.0), px(-100_000.0)));
	let rows = gutter_runs(&past_the_rows, panel, panels);
	assert!(
		!rows.is_empty(),
		"a pane reads the distance it can travel rather than the offset it was handed: the layout \
		 clamps an offset past the extent, so the rows at the end of the file are the ones on \
		 screen. This frame numbered none of them, which is a pane that measured every row of the \
		 file as a row above its box and drew the padding standing in for them"
	);
	let widest = widest_run(&code_runs(&past_the_rows, panel, panels));
	assert!(
		widest > panel.right - panel.left,
		"and they are the rows at the end: the last line of this file is the one no pane can hold, \
		 so the widest run drawn is wider than the panel. It is {widest}px against a panel {}px wide",
		panel.right - panel.left
	);

	// The same past the end of the widest line, which is the other axis of the
	// same read: a window that started a hundred thousand cells into a line
	// would leave the gutter numbering rows beside an empty column.
	let past_the_columns =
		offset_past(&mut session, PaneId::FileColumns, point(px(-100_000.0), px(0.0)));
	assert!(
		!code_runs(&past_the_columns, panel, panels).is_empty(),
		"a pane scrolled past the end of its widest line draws the end of it: the columns on screen \
		 are the ones the clamped offset reaches, and this frame drew none of them"
	);
}

/// Puts `id`'s offset at `offset`, which is past the extent the pane can
/// travel, and draws the frame that reads it.
///
/// The notice is what makes the next frame read the offset: a handle carries
/// no subscription, so a shell that was not told to draw again re-presents the
/// frame it already has.
fn offset_past(
	session: &mut HeadlessSession<'_, ShellView>,
	id: PaneId,
	offset: Point<Pixels>,
) -> Captured {
	session
		.update(|view, _window, cx| {
			view.pane_scrolls().handle(id).set_offset(offset);
			cx.notify();
		})
		.expect("the window updates");
	session
		.frame()
		.expect("the shell renders past the pane's own extent")
}
