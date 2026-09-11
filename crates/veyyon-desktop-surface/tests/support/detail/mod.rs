//! The window every detail-popover suite drives, and the three controls that
//! open one (§5.6, §8.25).
//!
//! One window with the workspace panel docked open serves all three sources:
//! the tree row, the composer's model chip and the diff pane's hunk header are
//! each reached by a secondary press on the run the surface drew, so a suite
//! aims at text the frame reports rather than at a measured offset.
//!
//! Several test binaries include this module and each uses a subset of it, so
//! each `mod` site carries its own `allow(dead_code)`.

#[allow(dead_code, reason = "this module uses a subset of the shared session helpers")]
#[path = "../text-selection/mod.rs"]
mod text_selection;

use std::{path::Path, thread::sleep, time::Duration};

pub use text_selection::{along, run_labelled};
use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_scene::{
	headless::{Captured, RenderOptions, headless_context},
	session::HeadlessSession,
};
use veyyon_desktop_surface::{
	Detail, DetailKind, DetailSource, Keymap, PanelTab, ShellState, ShellView, fixture,
	install_tokens,
};
use veyyon_gpui::{App, AppContext, Bounds, Pixels, Point};

/// Wide enough for the panel to dock beside the transcript rather than overlay
/// it, so a tree row and a transcript turn are on screen at once.
///
/// Held as `u16` so both the renderer's pixel count and the float a drawn box
/// is measured against are exact conversions of one number.
pub const WIDTH: u16 = 1400;
pub const HEIGHT: u16 = 900;

/// The fixture's changed file. The tree draws its last segment and the popover
/// states the path whole, so this string tells the two apart in one frame.
pub const FILE_PATH: &str = "crates/veyyon-desktop-surface/src/panel.rs";
/// The name the tree row draws, which is where its secondary press lands.
pub const FILE_NAME: &str = "panel.rs";
/// The range the fixture's one hunk header draws.
pub const HUNK_RANGE: &str = "@@ -1,5 +1,6 @@";
/// The display name the composer's model chip draws.
pub const MODEL_NAME: &str = "Claude Sonnet 4.5";

/// The state every case opens on: the panel docked open on `tab`, motion off
/// so a popover is at its settled opacity in the frame the press produced.
pub fn state_on(tab: PanelTab) -> ShellState {
	let mut state = fixture::populated();
	state.keymap.panel_collapsed = false;
	state.panel.active_tab = tab;
	state.reduced_motion = true;
	state
}

/// Opens the window on `state` with the keymap bound, which is what `Escape`
/// needs to reach the shell, and runs `test`.
pub fn open_window<R>(
	state: ShellState,
	test: impl FnOnce(&mut HeadlessSession<'_, ShellView>) -> R,
) -> R {
	let mut cx = headless_context().expect("a headless renderer is required");
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let theme = load_bundled_theme("dark").expect("the bundled dark theme loads");
	let options = RenderOptions {
		width: u32::from(WIDTH),
		height: u32::from(HEIGHT),
		scale_factor: 1.0,
		..RenderOptions::default()
	};
	let mut session = HeadlessSession::open(&mut cx, &options, move |_window, app: &mut App| {
		let installed =
			install_tokens(app, &tokens, &theme, Path::new("surface")).expect("the tokens install");
		app.bind_keys(Keymap::default().bindings());
		veyyon_desktop_kit::input::ensure_editor_bindings_registered(app);
		app.new(|_| ShellView::new(installed, state))
	})
	.expect("the session opens offscreen");
	test(&mut session)
}

/// The panel tab a source's control is drawn on.
pub const fn tab_for(source: DetailSource) -> PanelTab {
	match source {
		DetailSource::TreeRow => PanelTab::Tree,
		// The chip is on the composer's footer row, which every tab draws
		// beside; the fixture opens on Diff.
		DetailSource::Model | DetailSource::DiffHunk => PanelTab::Diff,
	}
}

/// The run a source's control is reached by a secondary press on.
pub const fn control_label(source: DetailSource) -> &'static str {
	match source {
		DetailSource::TreeRow => FILE_NAME,
		DetailSource::Model => MODEL_NAME,
		DetailSource::DiffHunk => HUNK_RANGE,
	}
}

/// The detail a source's control opens, at `origin`, as the control itself
/// builds it.
pub fn detail_for(source: DetailSource, origin: Point<Pixels>) -> Detail {
	match source {
		DetailSource::TreeRow => Detail::below(DetailKind::TreeRow(FILE_PATH.to_owned()), origin),
		DetailSource::Model => Detail::above(DetailKind::Model, origin),
		DetailSource::DiffHunk => {
			Detail::below(DetailKind::DiffHunk { path: FILE_PATH.to_owned(), row: 0 }, origin)
		},
	}
}

/// One fact a source's popover states, as a label and the value the fixture's
/// state gives it.
///
/// Each label is one the rest of the window does not draw, so a case can
/// require exactly one run of it: the panel's own tab strip draws "File" and
/// the tree row draws its counts, which is why the hunk is named by the span
/// it covers rather than by the file it is in.
pub const fn stated_fact(source: DetailSource) -> (&'static str, &'static str) {
	match source {
		DetailSource::TreeRow => ("Path", FILE_PATH),
		DetailSource::Model => ("Provider", "anthropic"),
		DetailSource::DiffHunk => ("Before", "lines 1-5"),
	}
}

/// Longer than the longest float transition the token table declares: 90ms of
/// fade with a spring behind it, and 60ms of fade alone under reduced motion.
///
/// A float is sampled against the wall clock, so waiting it out is what puts a
/// case past a transition it is not the subject of. A case that read the frame
/// the dismissal produced would be asserting on whatever part of the exit had
/// run by then.
pub const SETTLE: Duration = Duration::from_millis(250);

/// The frame left behind once a transition has finished. The second frame is
/// the one read: the first carries the repaint the settled sample asked for.
pub fn settled_frame(session: &mut HeadlessSession<'_, ShellView>) -> Captured {
	sleep(SETTLE);
	session
		.frame()
		.expect("the window repaints after the transition");
	session.frame().expect("the settled frame")
}

/// How many runs of exactly `label` the frame drew.
pub fn runs_labelled(captured: &Captured, label: &str) -> usize {
	captured
		.text_runs
		.iter()
		.filter(|run| run.text.as_ref().trim() == label)
		.count()
}

/// Whether every run of `label` the frame drew sits inside the window.
pub fn runs_inside_window(captured: &Captured, label: &str) -> bool {
	captured
		.text_runs
		.iter()
		.filter(|run| run.text.as_ref().trim() == label)
		.all(|run| inside_window(run.bounds))
}

/// Whether a box the frame drew is inside the window it was drawn in.
pub fn inside_window(bounds: Bounds<Pixels>) -> bool {
	let left = f32::from(bounds.origin.x);
	let top = f32::from(bounds.origin.y);
	left >= 0.0
		&& top >= 0.0
		&& left + f32::from(bounds.size.width) <= f32::from(WIDTH)
		&& top + f32::from(bounds.size.height) <= f32::from(HEIGHT)
}
