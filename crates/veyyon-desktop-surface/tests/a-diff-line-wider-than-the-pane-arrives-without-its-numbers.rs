//! WHY: §5.11 authors the mono panes with word wrap off, horizontal scroll and
//! both gutters pinned, and the diff tenant is one of them. Its rows were built
//! as one flex row each — number, sign and text in one box — so there was no
//! seam for a wheel to move the text across: a diff of a generated file was
//! readable to the panel's edge and no further, and the line's remainder was
//! reachable by nothing.
//!
//! The rows are now two columns, one pinned and one scrolled, in unified mode
//! and on each side of a split.
//!
//! CLASS CLOSED:
//! 1. The pane not scrolling: some run of the panel is required to travel under
//!    a horizontal wheel over the code.
//! 2. Shear. Every run in the panel is required to have moved by either nothing
//!    or the pane's own offset, so a row that travels while the row under it
//!    stays still fails, as does a cell that moves by a fraction of the offset.
//! 3. The gutter travelling with the code, which is the whole of "pinned": no
//!    run that starts inside the pinned band may move at all, which covers the
//!    line numbers and the +/- signs beside them.
//! 4. An unbounded offset: the pane is scrolled far past the widest line and
//!    the last ink is asserted to stop at the pane's own edge.
//! 5. One shared offset behind a split. The two sides are separate panes, so
//!    scrolling the old side is asserted to leave every run of the new side
//!    where it was; one region behind both would have moved them together.
//! 6. The sides drifting apart vertically: a split's rows are pushed to both
//!    panes, including the hunk headers and notices that span, so every row of
//!    the old side is asserted to have a row of the new side at its own top.
//!
//! NOT CAUGHT: whether a horizontal scrollbar is drawn, which is a separate
//! control with its own hit rect. Which side of a split a given run belongs to:
//! a line carried past the seam is still the old side's, so the split's claims
//! are made over both sides at once — two offsets in one frame, and rows that
//! step by an authored height — rather than by assigning runs to a side. The
//! file tenant's own suite owns the file pane, and the row heights, sizes and
//! tints the diff draws with are owned by the diff surface suite.

#[path = "support/mono-pane/mod.rs"]
#[allow(dead_code, reason = "this binary uses a subset of the shared pane helpers")]
mod mono_pane;

use mono_pane::{WINDOW_H, WINDOW_W, open_session, panel_region, rect};
use veyyon_desktop_kit::load_bundled_tokens;
use veyyon_desktop_model::DiffMode;
use veyyon_desktop_scene::{BoxBounds, Captured, headless_context};
use veyyon_desktop_surface::{
	DiffStatus, PanelContent, PanelTab, ShellState, diff::parse_diff, fixture,
};
use veyyon_desktop_tokens::PanelsSurfaceTokens;
use veyyon_gpui::{Pixels, Point};

/// A line no 540px panel can hold, added on one side of a hunk so both a
/// unified pane and a split's new side have to reach past their own edge.
const LONG: &str = "pub const THE_WIDEST_LINE_IN_THIS_HUNK: &str = \"and it keeps going well past \
                    the panel's own right edge\";";

/// A diff of one file: a hunk header, context either side, and a change whose
/// added lines are wider than the pane.
///
/// Two lines added against one removed on purpose. A split reads across, so the
/// old side is one line short and takes a blank cell, which is the cell with
/// nothing in it to give it a height: a pane that let its rows take their
/// content's height would put the two sides out of step from there down.
fn diff_text() -> String {
	let mut text = String::new();
	text.push_str("diff --git a/src/generated.rs b/src/generated.rs\n");
	text.push_str("index 1234567..89abcdef 100644\n");
	text.push_str("--- a/src/generated.rs\n");
	text.push_str("+++ b/src/generated.rs\n");
	text.push_str("@@ -1,4 +1,5 @@ pub fn constants()\n");
	text.push_str(" the context line above\n");
	text.push_str("-pub const NARROW: &str = \"short\";\n");
	text.push('+');
	text.push_str(LONG);
	text.push('\n');
	text.push_str(
		"+pub const AND_ANOTHER: &str = \"a second added line, so the old side is short\";\n",
	);
	text.push_str(" the context line below\n");
	text
}

/// The panel showing that diff, in `mode`, over an empty transcript.
///
/// Empty on purpose: a turn's prose runs the width of the session column and
/// crosses the panel's own rows, so a transcript here would put runs in the
/// band this reads and none of them would be the pane's.
fn state_with_a_long_diff(mode: DiffMode) -> ShellState {
	let mut state = fixture::populated();
	state.transcript.clear();
	state.keymap.panel_collapsed = false;
	state.panel = PanelContent {
		tabs: vec![PanelTab::Diff, PanelTab::File],
		active_tab: PanelTab::Diff,
		diff: parse_diff(&diff_text()),
		diff_status: DiffStatus::Loaded,
		diff_mode: mode,
		..PanelContent::default()
	};
	state
}

/// The right edge of the column a pane pins: its line numbers and the sign
/// beside them.
fn pinned_edge(panel: BoxBounds, panels: &PanelsSurfaceTokens) -> f32 {
	panel.left + panels.diff_gutter_width_px + panels.diff_sign_width_px
}

/// Every run the panel drew under its tab strip, which is every run of the
/// diff: its toolbar, the file's header, and the rows themselves.
///
/// Read by where a run starts rather than by the box it ends inside: a line
/// carried past the panel's own right edge is still the panel's, and a filter
/// that dropped it would have compared two different sets of runs across the
/// gesture that moved it.
fn panel_runs(
	captured: &Captured,
	panel: BoxBounds,
	panels: &PanelsSurfaceTokens,
) -> Vec<BoxBounds> {
	captured
		.text_runs
		.iter()
		.map(|run| rect(run.bounds))
		.filter(|bounds| {
			bounds.top >= panel.top + panels.tabs_height_px - 0.5 && bounds.left >= panel.left - 0.5
		})
		.collect()
}

/// How far each run of `before` travelled to reach `after`, positive leftward,
/// paired with the run that travelled.
///
/// Paired by index, which is the order the elements were built in: the gesture
/// moves the panel's runs without adding or dropping any. Each pair is checked
/// to still be one run — same row, same width — so a reordering is a failure
/// rather than a silent comparison of two strangers.
fn shifts(before: &[BoxBounds], after: &[BoxBounds]) -> Vec<(BoxBounds, f32)> {
	assert_eq!(
		before.len(),
		after.len(),
		"the gesture moves the panel's runs without adding or dropping any: {before:?} against \
		 {after:?}"
	);
	before
		.iter()
		.zip(after.iter())
		.map(|(run, other)| {
			assert!(
				(other.top - run.top).abs() < 0.5 && (other.width() - run.width()).abs() < 0.5,
				"a run keeps its row and its width across a horizontal gesture: {run:?} against \
				 {other:?}"
			);
			(*run, run.left - other.left)
		})
		.collect()
}

/// The offsets a frame's runs moved by, one entry per distinct value, ignoring
/// the runs that stayed where they were.
fn offsets(shift: &[(BoxBounds, f32)]) -> Vec<f32> {
	let mut values: Vec<f32> = shift
		.iter()
		.map(|(_, by)| *by)
		.filter(|by| by.abs() >= 0.5)
		.collect();
	values.sort_by(f32::total_cmp);
	values.dedup_by(|a, b| (*a - *b).abs() < 0.5);
	values
}

/// A point inside the code column of the pane starting at `pane_left`.
fn over_code(
	pane_left: f32,
	pane_right: f32,
	panel: BoxBounds,
	panels: &PanelsSurfaceTokens,
) -> Point<Pixels> {
	Point {
		x: Pixels::from(f32::midpoint(
			pane_left + panels.diff_gutter_width_px + panels.diff_sign_width_px,
			pane_right,
		)),
		y: Pixels::from(
			panels
				.chrome_row_height_px
				.mul_add(3.0, panel.top + panels.tabs_height_px),
		),
	}
}

#[test]
fn a_unified_diff_moves_its_code_and_leaves_its_numbers_and_signs() {
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let panels = &tokens.surface.panels;

	let mut cx = headless_context().expect("a headless renderer is required");
	let mut session =
		open_session(&mut cx, state_with_a_long_diff(DiffMode::Unified), WINDOW_W, WINDOW_H);
	let rest = session.frame().expect("the shell renders at rest");
	let panel = panel_region(&mut session);
	let at_rest = panel_runs(&rest, panel, panels);

	session
		.scroll_across(over_code(panel.left, panel.right, panel, panels), 3.0)
		.expect("the wheel reaches the code column");
	let scrolled = session.frame().expect("the shell renders scrolled");
	let moved = panel_runs(&scrolled, panel, panels);

	let shift = shifts(&at_rest, &moved);
	let travelled = offsets(&shift);
	assert_eq!(
		travelled.len(),
		1,
		"one pane, one offset: the code moved as a whole rather than shearing row against row, or \
		 not at all: {shift:?}"
	);
	let offset = travelled[0];
	assert!(
		offset > 0.5,
		"the wheel moves the code leftward, so the rest of the widest line arrives: {offset}px"
	);
	for (run, by) in &shift {
		assert!(
			by.abs() < 0.5 || run.left >= pinned_edge(panel, panels) - 0.5,
			"nothing in the pinned column travels: {run:?} moved {by}px from inside the band ending \
			 at {}px",
			pinned_edge(panel, panels)
		);
	}

	for _ in 0..40 {
		session
			.scroll_across(over_code(panel.left, panel.right, panel, panels), 20.0)
			.expect("the wheel reaches the code column");
	}
	let far = session
		.frame()
		.expect("the shell renders at the end of the line");
	let ends = panel_runs(&far, panel, panels)
		.into_iter()
		.map(|run| run.right)
		.fold(f32::MIN, f32::max);
	assert!(
		(ends - panel.right).abs() < 2.0,
		"the pane stops with the widest line's end at its own edge rather than travelling into \
		 blank space: the last ink is at {ends}px against an edge at {}px",
		panel.right
	);
}

#[test]
fn each_side_of_a_split_diff_scrolls_on_its_own_and_stays_level() {
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let panels = &tokens.surface.panels;

	let mut cx = headless_context().expect("a headless renderer is required");
	let mut session =
		open_session(&mut cx, state_with_a_long_diff(DiffMode::Split), WINDOW_W, WINDOW_H);
	let rest = session.frame().expect("the shell renders at rest");
	let panel = panel_region(&mut session);
	let seam = f32::midpoint(panel.left, panel.right);
	let at_rest = panel_runs(&rest, panel, panels);

	// The two sides are driven by different amounts in one frame. A single
	// region behind both would answer with one offset; two regions answer with
	// two, whichever run belongs to which side.
	session
		.scroll_across(over_code(panel.left, seam, panel, panels), 3.0)
		.expect("the wheel reaches the old side's code column");
	session
		.scroll_across(over_code(seam, panel.right, panel, panels), 1.0)
		.expect("the wheel reaches the new side's code column");
	let scrolled = session
		.frame()
		.expect("the shell renders with both sides scrolled");
	let moved = panel_runs(&scrolled, panel, panels);

	let shift = shifts(&at_rest, &moved);
	let travelled = offsets(&shift);
	assert_eq!(
		travelled.len(),
		2,
		"each side of the split scrolls on its own, so one frame holds both offsets: {shift:?}"
	);
	let (small, large) = (travelled[0], travelled[1]);
	assert!(
		small > 0.5 && small.mul_add(-3.0, large).abs() < 0.5,
		"each side moved by its own gesture rather than both by their sum: {small}px beside \
		 {large}px, for one notch beside three"
	);

	// The rows of both panes are pushed in step, including the hunk header and
	// any notice, so the tops the panel drew step by one authored height at a
	// time. A side that dropped a spanning row would step by some other amount.
	let mut tops: Vec<f32> = at_rest
		.iter()
		.filter(|run| run.top >= panel.top + panels.tabs_height_px + panels.chrome_row_height_px)
		.map(|run| run.top)
		.collect();
	tops.sort_by(f32::total_cmp);
	tops.dedup_by(|a, b| (*a - *b).abs() < 0.5);
	assert!(
		tops.len() >= 3,
		"the split drew its hunk header and its rows for this to read: {tops:?}"
	);
	for pair in tops.windows(2) {
		let pitch = pair[1] - pair[0];
		assert!(
			(pitch - panels.diff_row_height_px).abs() < 0.5
				|| (pitch - panels.diff_hunk_header_height_px).abs() < 0.5,
			"the two sides stay level: the rows step by {pitch}px, which is neither the authored row \
			 height of {}px nor the hunk header's {}px",
			panels.diff_row_height_px,
			panels.diff_hunk_header_height_px
		);
	}
}
