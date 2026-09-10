//! WHY: the host cuts a changes snapshot at a byte budget for the diff and a
//! count for the files, rather than sending a frame the window's decoder
//! rejects as fatal. A cut nobody draws is the worse failure: the pane shows a
//! diff that stops at an arbitrary file and reads as the whole working tree.
//!
//! CLASS CLOSED: the pane draws one row per fact the host cut, above the first
//! file rather than at the end of a scroll a reader of a truncated diff never
//! reaches, inside the panel's own width, and draws nothing extra when the
//! host sent the scope whole. The reading is positional: each notice's row,
//! the rows it pushed the diff down by, and the box it stayed inside, all from
//! the frame the shell rendered rather than from the text the notice returns.
//!
//! NOT CAUGHT: the notice's words, which are `withheld_notices`' and are
//! asserted in `a-cut-the-host-made-is-stated-in-the-pane-that-draws-it.rs` --
//! a shaped text run carries its box and its size, not its string. Whether the
//! row cursor advanced past the notices, which decides admission at the far
//! end of a long scroll rather than layout here.

#[path = "support/mono-pane/mod.rs"]
#[allow(dead_code, reason = "this binary uses a subset of the shared pane helpers")]
mod mono_pane;

use mono_pane::{WINDOW_H, WINDOW_W, open_session, panel_region, rect};
use veyyon_desktop_kit::load_bundled_tokens;
use veyyon_desktop_model::DiffMode;
use veyyon_desktop_scene::{BoxBounds, Captured, headless_context};
use veyyon_desktop_surface::{
	DiffStatus, DiffWithheld, PanelContent, PanelTab, ShellState, diff::parse_diff, fixture,
};
use veyyon_desktop_tokens::PanelsSurfaceTokens;

/// A diff of two files, so the pane draws chrome the notices sit above.
fn diff_text() -> String {
	let mut text = String::new();
	for file in ["src/first.rs", "src/second.rs"] {
		text.push_str(&format!("diff --git a/{file} b/{file}\n"));
		text.push_str(&format!("--- a/{file}\n"));
		text.push_str(&format!("+++ b/{file}\n"));
		text.push_str("@@ -1,2 +1,2 @@\n");
		text.push_str(" the context line\n");
		text.push_str("-pub const OLD: u32 = 0;\n");
		text.push_str("+pub const NEW: u32 = 1;\n");
	}
	text
}

/// The panel showing that diff, stating `withheld`, over an empty transcript.
///
/// Empty on purpose: a turn's prose runs the width of the session column and
/// crosses the panel's own rows, so a transcript here would put runs in the
/// band this reads and none of them would be the pane's.
fn state_with(withheld: DiffWithheld) -> ShellState {
	let mut state = fixture::populated();
	state.transcript.clear();
	state.keymap.panel_collapsed = false;
	state.panel = PanelContent {
		tabs: vec![PanelTab::Diff, PanelTab::File],
		active_tab: PanelTab::Diff,
		diff: parse_diff(&diff_text()),
		diff_status: DiffStatus::Loaded,
		diff_mode: DiffMode::Unified,
		withheld,
		..PanelContent::default()
	};
	state
}

/// Every run the panel drew under its tab strip, ordered down the pane.
fn panel_runs(
	captured: &Captured,
	panel: BoxBounds,
	panels: &PanelsSurfaceTokens,
) -> Vec<BoxBounds> {
	let mut runs: Vec<BoxBounds> = captured
		.text_runs
		.iter()
		.map(|run| rect(run.bounds))
		.filter(|bounds| {
			bounds.top >= panel.top + panels.tabs_height_px - 0.5 && bounds.left >= panel.left - 0.5
		})
		.collect();
	runs.sort_by(|a, b| a.top.total_cmp(&b.top).then(a.left.total_cmp(&b.left)));
	runs
}

/// The pane's rows: the runs the panel drew, grouped by the row they share.
///
/// Grouped rather than indexed because the toolbar alone draws several runs on
/// one line, so a run's index says nothing about which row it belongs to.
fn rows(runs: &[BoxBounds]) -> Vec<(f32, Vec<BoxBounds>)> {
	let mut grouped: Vec<(f32, Vec<BoxBounds>)> = Vec::new();
	for run in runs {
		match grouped.last_mut() {
			Some((top, band)) if (*top - run.top).abs() < 0.5 => band.push(*run),
			_ => grouped.push((run.top, vec![*run])),
		}
	}
	grouped
}

/// The rows the panel drew for one `withheld` statement, and the panel's box.
fn drawn(withheld: DiffWithheld) -> (Vec<(f32, Vec<BoxBounds>)>, BoxBounds) {
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let panels = &tokens.surface.panels;
	let mut cx = headless_context().expect("a headless renderer is required");
	let mut session = open_session(&mut cx, state_with(withheld), WINDOW_W, WINDOW_H);
	let frame = session.frame().expect("the shell renders at rest");
	let panel = panel_region(&mut session);
	(rows(&panel_runs(&frame, panel, panels)), panel)
}

/// A host that cut the diff and held files back: two facts, two rows.
const fn a_cut() -> DiffWithheld {
	DiffWithheld { diff_truncated: true, files_withheld: 41, diff_bytes: 4 * 1024 * 1024 }
}

#[test]
fn a_whole_snapshot_draws_no_notice() {
	let (whole, _) = drawn(DiffWithheld::default());
	let (cut, _) = drawn(a_cut());

	assert_eq!(
		cut.len(),
		whole.len() + 2,
		"a cut draws one row per fact and nothing else: {cut:?} against {whole:?}"
	);
}

#[test]
fn each_notice_is_drawn_above_the_first_file_it_cut_and_inside_the_panel() {
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let panels = &tokens.surface.panels;
	let (whole, panel) = drawn(DiffWithheld::default());
	let (cut, _) = drawn(a_cut());

	let toolbar = whole.first().expect("the diff pane draws its toolbar").0;
	let first_file = whole
		.get(1)
		.expect("the diff pane draws its first file's header")
		.0;

	// The rows the cut frame has that the whole one does not are the notices,
	// and they land between the toolbar and the header the whole frame drew
	// there.
	for index in 1..=2 {
		let (top, band) = cut
			.get(index)
			.cloned()
			.unwrap_or_else(|| panic!("a cut draws a notice at row {index}"));
		assert_eq!(band.len(), 1, "a notice is one run of its own row: {band:?}");
		let notice = band[0];
		assert!(
			top >= toolbar + 0.5,
			"the notice sits under the toolbar: {notice:?} against a toolbar at {toolbar}"
		);
		assert!(
			top < first_file + panels.diff_row_height_px.mul_add(2.0, 0.5),
			"the notice sits above the first file's rows: {notice:?} against a header at {first_file}"
		);
		// Truncated rather than carried past the edge: the panel masks what
		// crosses it, so a notice drawn wider than the panel is read mid-word.
		assert!(
			notice.left >= panel.left - 0.5 && notice.right <= panel.right + 0.5,
			"the notice is drawn inside the panel: {notice:?} against {panel:?}"
		);
	}
}

#[test]
fn the_notices_take_one_row_each_from_the_diff_and_no_more() {
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let panels = &tokens.surface.panels;
	let (whole, _) = drawn(DiffWithheld::default());
	let (cut, _) = drawn(a_cut());

	// Every row the whole frame drew below the toolbar is two rows lower in the
	// cut frame: the notices took their own height and pushed the diff down,
	// rather than overlapping a row or taking the space of three.
	let pushed = panels.diff_row_height_px * 2.0;
	for (index, (top, band)) in whole.iter().enumerate().skip(1) {
		let (moved, moved_band) = cut
			.get(index + 2)
			.cloned()
			.unwrap_or_else(|| panic!("the cut frame draws the row at {index}"));
		assert_eq!(
			moved_band.len(),
			band.len(),
			"a row keeps its runs across the notices: {band:?} against {moved_band:?}"
		);
		assert!(
			(moved - top - pushed).abs() < 0.5,
			"a row moves down by exactly the notices' height: {top} against {moved}"
		);
	}
}

#[test]
fn a_cut_draws_one_row_for_each_fact_it_states() {
	let (whole, _) = drawn(DiffWithheld::default());
	for (withheld, lines) in [
		(DiffWithheld { diff_truncated: true, files_withheld: 0, diff_bytes: 4 * 1024 * 1024 }, 1),
		(DiffWithheld { diff_truncated: false, files_withheld: 108, diff_bytes: 12_345 }, 1),
		(a_cut(), 2),
	] {
		let (cut, _) = drawn(withheld);
		assert_eq!(cut.len(), whole.len() + lines, "{withheld:?} draws {lines} notice(s): {cut:?}");
	}
}
