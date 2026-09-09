//! WHY: §5.11's mono panes window both axes and scroll both axes, and each
//! axis belongs to a different region: the file's rows to the pane's vertical
//! region, one pane's code to the horizontal region inside it. A native take
//! opened a 120-line file of 760 columns, wheeled down it, and wheeled
//! sideways over the code: the code moved and the line numbers moved 4,695
//! pixels with it, because the vertical region took the sideways delta and
//! mapped it onto the one axis it scrolls. §5.11 pins the gutter, so a
//! sideways gesture that scrolls the file is the pinning undone by the gesture
//! it was authored for.
//!
//! `a-line-wider-than-the-panel-is-reachable-and-its-numbers-stay.rs` reads
//! the gutter's own column and a four-line file, which cannot scroll
//! vertically at all: the numbers were pinned sideways in a pane with nowhere
//! to travel. This suite drives both gestures against a file taller and wider
//! than the pane, which is the state the mapping shows up in.
//!
//! CLASS CLOSED:
//! 1. A gesture on one axis reaching the other axis's region, in either
//!    direction, for the file tenant and the diff tenant, unified and split.
//! 2. Cost following the file rather than the box once the other axis has left
//!    its origin. Every combination of the two gestures is drawn and the runs
//!    the pane drew stay at the count its own box shows, so a pane that widens
//!    to the whole line once the file is scrolled, or empties once the code
//!    is, fails here whatever the constants are.
//!
//! NOT CAUGHT: how long a frame takes, which is what the windowing defect was
//! recorded in. A count of runs is the cause; a millisecond is a machine's
//! answer to it. Nor the gesture the platform sends: X11 turns a wheel with
//! shift held into a horizontal delta, and that translation is the display
//! server's.

#[path = "support/mono-pane/mod.rs"]
#[allow(dead_code, reason = "this binary uses a subset of the shared pane helpers")]
mod mono_pane;

use mono_pane::{
	WINDOW_H, WINDOW_W, code_runs, diff_state, gutter_runs, lefts, open_session, over_code,
	panel_region, state_with_wide_lines, tops,
};
use veyyon_desktop_kit::load_bundled_tokens;
use veyyon_desktop_model::DiffMode;
use veyyon_desktop_scene::{BoxBounds, headless_context};

/// The fixture the native take drove: more rows than any pane's box holds,
/// each of them wider than the panel by an order of magnitude.
const LINES: usize = 120;
const PIECES: usize = 253;

#[test]
fn a_pane_scrolled_down_a_file_of_wide_lines_still_draws_one_box_of_columns() {
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let panels = &tokens.surface.panels;
	let mut cx = headless_context().expect("a headless renderer is required");
	let mut session =
		open_session(&mut cx, state_with_wide_lines(LINES, PIECES), WINDOW_W, WINDOW_H);
	let rest = session.frame().expect("the shell renders at rest");
	let panel = panel_region(&mut session);
	let at_rest = (
		gutter_runs(&rest, panel, panels).len(),
		code_runs(&rest, panel, panels).len(),
	);
	assert!(
		at_rest.0 > 0 && at_rest.1 > 0,
		"the pane drew rows for any of this to read: {} numbers, {} code runs",
		at_rest.0,
		at_rest.1
	);
	assert!(
		at_rest.1 < LINES * PIECES,
		"and it drew fewer pieces than the file holds, so a pane that admits everything fails \
		 here rather than passing the counts below: {} of {}",
		at_rest.1,
		LINES * PIECES
	);

	// Down the file, then sideways across one of its lines, which is the order
	// the take made them in and the order a reader makes them in.
	for _ in 0..4 {
		session
			.scroll(over_code(panel, panels), 4.0)
			.expect("the wheel reaches the pane");
	}
	let down = session.frame().expect("the shell renders down the file");
	let scrolled_down = (
		gutter_runs(&down, panel, panels).len(),
		code_runs(&down, panel, panels).len(),
	);

	for _ in 0..10 {
		session
			.scroll_across(over_code(panel, panels), 4.0)
			.expect("the sideways wheel reaches the pane");
	}
	let across = session
		.frame()
		.expect("the shell renders across the line");
	let scrolled_across = (
		gutter_runs(&across, panel, panels).len(),
		code_runs(&across, panel, panels).len(),
	);

	for (name, drawn) in [("down the file", scrolled_down), ("across a line", scrolled_across)] {
		assert!(
			drawn.0 > 0 && drawn.1 > 0,
			"{name}: the pane still draws rows and code, and this frame drew {} numbers and {} \
			 code runs",
			drawn.0,
			drawn.1
		);
		assert!(
			drawn.1 <= at_rest.1 * 2,
			"{name}: a pane costs what its own box shows on both axes at once. It drew {} code \
			 runs against {} at rest, which is a window that followed the file once the other \
			 axis left its origin",
			drawn.1,
			at_rest.1
		);
		assert!(
			drawn.0 <= at_rest.0 * 2,
			"{name}: and the same of the numbers beside them: {} against {} at rest",
			drawn.0,
			at_rest.0
		);
	}
}

/// The rows a set of runs stands on, once each: a pane scrolled sideways puts
/// the leftmost pieces of its own overscan behind the gutter's band, where the
/// region clips them and a read of the band counts them. Which rows the pane
/// drew is the claim here, so the rows are taken once each rather than once
/// per run.
fn ladder(runs: &[BoxBounds]) -> Vec<f32> {
	let mut rows = tops(runs);
	rows.sort_by(f32::total_cmp);
	rows.dedup_by(|left, right| (*left - *right).abs() < 0.5);
	rows
}

#[test]
fn a_sideways_wheel_over_the_code_leaves_the_file_where_it_was() {
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let panels = &tokens.surface.panels;
	let mut cx = headless_context().expect("a headless renderer is required");
	let mut session =
		open_session(&mut cx, state_with_wide_lines(LINES, PIECES), WINDOW_W, WINDOW_H);
	let rest = session.frame().expect("the shell renders at rest");
	let panel = panel_region(&mut session);

	// Down the file first, so the vertical region has travelled and has
	// somewhere left to travel in both directions. A pane at its own origin
	// cannot show a sideways delta being mapped onto the axis it is already at
	// the end of.
	for _ in 0..4 {
		session
			.scroll(over_code(panel, panels), 4.0)
			.expect("the wheel reaches the pane");
	}
	let down = session.frame().expect("the shell renders down the file");
	let rows_before = ladder(&gutter_runs(&down, panel, panels));
	assert_ne!(
		rows_before,
		ladder(&gutter_runs(&rest, panel, panels)),
		"the vertical wheel moved the file, for the sideways one to be measured against"
	);

	session
		.scroll_across(over_code(panel, panels), 4.0)
		.expect("the sideways wheel reaches the pane");
	let across = session
		.frame()
		.expect("the shell renders across the line");
	let code = code_runs(&across, panel, panels);
	assert_ne!(
		lefts(&code),
		lefts(&code_runs(&down, panel, panels)),
		"the sideways wheel reached the code column at all"
	);
	assert_eq!(
		ladder(&gutter_runs(&across, panel, panels)),
		rows_before,
		"and the file stayed where it was: a sideways delta belongs to the region under the \
		 pointer, so a vertical region that maps it onto its own axis scrolls the file under a \
		 gesture authored to move one line's text"
	);
}

#[test]
fn a_sideways_wheel_over_a_diff_leaves_the_diff_where_it_was() {
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let panels = &tokens.surface.panels;
	for mode in [DiffMode::Unified, DiffMode::Split] {
		let mut cx = headless_context().expect("a headless renderer is required");
		let mut session = open_session(&mut cx, diff_state(400, mode), WINDOW_W, WINDOW_H);
		session.frame().expect("the shell renders at rest");
		let panel = panel_region(&mut session);
		for _ in 0..4 {
			session
				.scroll(over_code(panel, panels), 4.0)
				.expect("the wheel reaches the pane");
		}
		let down = session.frame().expect("the shell renders down the diff");
		let rows_before = ladder(&gutter_runs(&down, panel, panels));

		session
			.scroll_across(over_code(panel, panels), 4.0)
			.expect("the sideways wheel reaches the pane");
		let across = session
			.frame()
			.expect("the shell renders across the diff");
		assert_eq!(
			ladder(&gutter_runs(&across, panel, panels)),
			rows_before,
			"{mode:?}: the diff's rows stay where they were under a sideways gesture, which \
			 belongs to the pane's code column"
		);
	}
}
