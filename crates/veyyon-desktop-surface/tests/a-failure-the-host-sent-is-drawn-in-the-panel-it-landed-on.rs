//! WHY: a request the panel sends -- the working tree, a file, the tree, the
//! usage totals -- fails on a control of its own, and the failure carries the
//! host's sentence plus whether asking again is offered. The panel read that
//! error only to set a status enum, so `DiffStatus::Failed` drew "Failed to
//! load changes" over a refused working tree: no reason, and no way to retry,
//! while the retry the host would honour was already remembered against the
//! surface the request went out on.
//!
//! CLASS CLOSED: whichever tab the panel is drawing, a failure it holds is
//! drawn as its own row between the tab strip and that tab's content, inside
//! the panel's box, pushing every content row down by one row's height and by
//! the same amount for all of them; a panel with no failure draws no such row;
//! a panel whose capabilities went away and left it tab-less still draws it.
//! The sweep is over `PanelTab::iter()`, so a tab added to the panel is a red
//! suite until it is stated here, and the retryable and final cases are read
//! apart by the runs the row draws, so a hairline that drops the Retry is a
//! failure rather than a smaller row.
//!
//! NOT CAUGHT: the words in the row, which are the host's and which a shaped
//! text run carries no string for -- `error_hairline` is asserted by the
//! control suites that drive it, and which surface the row's Retry sends is
//! the model suite's
//! (`a-failure-on-a-panel-control-is-stated-by-the-tab-it-landed-on.rs`).
//! Which of a tab's candidate surfaces a failure is read from is also that
//! suite's; this one is given the failure and reads what was drawn for it.

#[path = "support/mono-pane/mod.rs"]
#[allow(dead_code, reason = "this binary uses a subset of the shared pane helpers")]
mod mono_pane;

use mono_pane::{WINDOW_H, WINDOW_W, open_session, panel_region, rect};
use strum::IntoEnumIterator as _;
use veyyon_desktop_kit::{TextRamp, load_bundled_tokens};
use veyyon_desktop_model::{SessionId, SurfaceId};
use veyyon_desktop_scene::{BoxBounds, Captured, headless_context};
use veyyon_desktop_surface::{ControlError, PanelFailure, PanelTab, ShellState, fixture};
use veyyon_desktop_tokens::PanelsSurfaceTokens;

/// The failure a refused working tree leaves: the host's sentence, and the
/// offer to send the same request again.
fn refused() -> PanelFailure {
	PanelFailure {
		surface: SurfaceId::RightPanelDiffTab(SessionId::from("1")),
		error:   ControlError::new("git diff refused: not a repository", true),
	}
}

/// The fixture panel on `tab`, holding `failure`, over an empty transcript.
///
/// Empty on purpose: a turn's prose runs the width of the session column and
/// crosses the panel's own rows, so a transcript here would put runs in the
/// band this reads and none of them would be the panel's.
fn state_with(tab: PanelTab, failure: Option<PanelFailure>) -> ShellState {
	let mut state = fixture::populated();
	state.transcript.clear();
	state.keymap.panel_collapsed = false;
	state.panel.tabs = PanelTab::all().to_vec();
	state.panel.active_tab = tab;
	state.panel.failure = failure;
	state
}

/// The panel's rows: every run it drew under its tab strip, grouped by the row
/// they share and ordered down the pane.
///
/// Grouped rather than indexed because one row draws several runs -- the
/// hairline draws its sentence and its two answers, the diff toolbar draws
/// several labels -- so a run's index says nothing about the row it is in.
fn rows(captured: &Captured, panel: BoxBounds, panels: &PanelsSurfaceTokens) -> Vec<(f32, usize)> {
	let mut runs: Vec<BoxBounds> = captured
		.text_runs
		.iter()
		.map(|run| rect(run.bounds))
		.filter(|bounds| {
			bounds.top >= panel.top + panels.tabs_height_px - 0.5 && bounds.left >= panel.left - 0.5
		})
		.collect();
	runs.sort_by(|a, b| a.top.total_cmp(&b.top).then(a.left.total_cmp(&b.left)));

	let mut grouped: Vec<(f32, usize)> = Vec::new();
	for run in &runs {
		match grouped.last_mut() {
			Some((top, count)) if (*top - run.top).abs() < 0.5 => *count += 1,
			_ => grouped.push((run.top, 1)),
		}
	}
	grouped
}

/// The runs of the panel's first row under the tab strip, and its box.
fn first_row_runs(
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
	let Some(top) = runs.first().map(|run| run.top) else {
		return Vec::new();
	};
	runs.retain(|run| (run.top - top).abs() < 0.5);
	runs
}

/// What one state drew: its panel's rows, its panel's box, and the runs of the
/// first row under the tab strip.
struct Drawn {
	rows:      Vec<(f32, usize)>,
	panel:     BoxBounds,
	first_row: Vec<BoxBounds>,
	micro:     f32,
}

fn drawn(state: ShellState) -> Drawn {
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let panels = &tokens.surface.panels;
	let mut cx = headless_context().expect("a headless renderer is required");
	let mut session = open_session(&mut cx, state, WINDOW_W, WINDOW_H);
	let frame = session.frame().expect("the shell renders at rest");
	let panel = panel_region(&mut session);
	let micro = session
		.update(|view, _window, _cx| f32::from(view.installed().set.line_height(TextRamp::Micro)))
		.expect("the window updates");
	Drawn {
		rows: rows(&frame, panel, panels),
		panel,
		first_row: first_row_runs(&frame, panel, panels),
		micro,
	}
}

#[test]
fn every_tab_draws_the_failure_between_its_strip_and_its_content() {
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let panels = &tokens.surface.panels;

	for tab in PanelTab::iter() {
		let bare = drawn(state_with(tab, None));
		let failed = drawn(state_with(tab, Some(refused())));

		assert_eq!(
			failed.rows.len(),
			bare.rows.len() + 1,
			"{tab:?} draws the failure as one row of its own: {:?} against {:?}",
			failed.rows,
			bare.rows
		);

		let strip_bottom = failed.panel.top + panels.tabs_height_px;
		let row = failed
			.rows
			.first()
			.copied()
			.unwrap_or_else(|| panic!("{tab:?} draws a first row"));
		assert!(
			row.0 >= strip_bottom - 0.5,
			"{tab:?} draws the failure under the tab strip: {row:?} against a strip ending at \
			 {strip_bottom}"
		);

		// The sentence and both answers, on the failure's own row: a hairline
		// that lost its Retry draws two runs here rather than a shorter row.
		assert_eq!(
			row.1, 3,
			"{tab:?} draws the sentence, the Retry and the Dismiss on that row: {:?}",
			failed.first_row
		);

		// Truncated rather than carried past the edge: the panel masks what
		// crosses it, so a row drawn wider than the panel is read mid-word.
		for run in &failed.first_row {
			assert!(
				run.left >= failed.panel.left - 0.5 && run.right <= failed.panel.right + 0.5,
				"{tab:?} draws the failure inside the panel: {run:?} against {:?}",
				failed.panel
			);
		}
	}
}

#[test]
fn the_failure_pushes_every_row_of_the_tab_down_by_one_row() {
	for tab in PanelTab::iter() {
		let bare = drawn(state_with(tab, None));
		let failed = drawn(state_with(tab, Some(refused())));

		let mut shifts: Vec<f32> = Vec::new();
		for (index, (top, count)) in bare.rows.iter().enumerate() {
			let (moved, moved_count) = failed
				.rows
				.get(index + 1)
				.copied()
				.unwrap_or_else(|| panic!("{tab:?} draws the row at {index} below the failure"));
			assert_eq!(
				moved_count, *count,
				"{tab:?} keeps a row's runs across the failure: {count} against {moved_count}"
			);
			shifts.push(moved - top);
		}

		// One amount for every row, so the failure took its own height rather
		// than overlapping the first row or reflowing the pane.
		if let Some(first) = shifts.first().copied() {
			assert!(
				first >= bare.micro,
				"{tab:?} gives the failure at least its own line: {first} against {}",
				bare.micro
			);
			for shift in &shifts {
				assert!(
					(shift - first).abs() < 0.5,
					"{tab:?} moves every row down by the same amount: {shifts:?}"
				);
			}
		}
	}
}

#[test]
fn a_failure_the_host_will_not_retry_draws_no_retry() {
	let final_failure = PanelFailure {
		surface: SurfaceId::RightPanelDiffTab(SessionId::from("1")),
		error:   ControlError::new("the working tree is not a repository", false),
	};
	let retryable = drawn(state_with(PanelTab::Diff, Some(refused())));
	let once = drawn(state_with(PanelTab::Diff, Some(final_failure)));

	assert_eq!(
		retryable.first_row.len(),
		3,
		"a retryable failure draws its sentence and both answers: {:?}",
		retryable.first_row
	);
	assert_eq!(
		once.first_row.len(),
		2,
		"a failure the host will not retry draws its sentence and the Dismiss alone: {:?}",
		once.first_row
	);
	assert_eq!(
		once.rows.len(),
		retryable.rows.len(),
		"either failure is one row: {:?} against {:?}",
		once.rows,
		retryable.rows
	);
}

#[test]
fn a_panel_left_without_tabs_still_draws_the_failure_it_holds() {
	// The capabilities that filled the panel can go away while a request it
	// sent is still in flight, and the answer that comes back is the reason
	// the panel is empty.
	let mut bare = state_with(PanelTab::Diff, None);
	bare.panel.tabs.clear();
	let mut failed = state_with(PanelTab::Diff, Some(refused()));
	failed.panel.tabs.clear();

	let bare = drawn(bare);
	let failed = drawn(failed);

	assert_eq!(
		failed.rows.len(),
		bare.rows.len() + 1,
		"a tab-less panel draws the failure above its reason: {:?} against {:?}",
		failed.rows,
		bare.rows
	);
	assert_eq!(failed.first_row.len(), 3, "and draws it whole: {:?}", failed.first_row);
}
