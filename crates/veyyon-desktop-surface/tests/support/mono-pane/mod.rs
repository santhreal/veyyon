//! Reading a mono pane's two columns out of a rendered frame (§5.11).
//!
//! The file pane and both diff panes are the same element, so the suites that
//! drive them read them the same way: the runs the pane's rows drew, split into
//! the numbers it pins and the code it scrolls.
//!
//! Several test binaries include this module and each uses a subset of it, so
//! each `mod` site carries its own `allow(dead_code)`.

#[path = "../queue-scroll/mod.rs"]
#[allow(dead_code, reason = "this module uses a subset of the shared session helpers")]
mod queue_scroll;

use std::path::Path;

pub use queue_scroll::open_session;
use veyyon_desktop_kit::{ColorRole, Tokens, load_bundled_theme};
use veyyon_desktop_scene::{
	BoxBounds, Captured, HeadlessSession,
	headless::{Headless, RenderOptions},
};
use veyyon_desktop_surface::{
	FileLine, FileView, HighlightSpan, PanelTab, ShellState, ShellView, damage::Region, fixture,
	install_tokens,
};
use veyyon_desktop_tokens::PanelsSurfaceTokens;
use veyyon_gpui::{App, AppContext, Bounds, Pixels, Point};

/// Opens the shell on a token set the caller has edited, so a suite can prove
/// a metric follows its token rather than the value it happens to equal.
pub fn open_session_on_tokens(
	cx: &mut Headless,
	state: ShellState,
	width: u32,
	height: u32,
	tokens: Tokens,
) -> HeadlessSession<'_, ShellView> {
	let theme = load_bundled_theme("dark").expect("the bundled dark theme loads");
	let options = RenderOptions { width, height, scale_factor: 1.0, ..RenderOptions::default() };
	HeadlessSession::open(cx, &options, move |_window, app: &mut App| {
		let installed =
			install_tokens(app, &tokens, &theme, Path::new("surface")).expect("the tokens install");
		app.new(|_| ShellView::new(installed, state))
	})
	.expect("the session opens offscreen")
}

/// Wide enough for the panel to dock beside the transcript rather than overlay
/// it, so the pane has its authored width to be too narrow for.
pub const WINDOW_W: u32 = 1400;
pub const WINDOW_H: u32 = 900;

/// A line no 540px panel can hold, in the two highlighted pieces a real file
/// arrives in, and short ones around it, so the pane's content width is one
/// line's and the rest have room to spare.
///
/// Two pieces on purpose: a line's width is the sum of its spans, and a pane
/// that took the widest span for the widest line stops the code short of the
/// end of a line whose highlighting split it.
pub const LONG_HEAD: &str = "let the_widest_line_in_this_file = compose(the_left_hand_side, ";
pub const LONG_TAIL: &str = "the_right_hand_side, and_the_one_after_it, plus_another_argument);";

pub fn rect(bounds: Bounds<Pixels>) -> BoxBounds {
	BoxBounds {
		left:   f32::from(bounds.origin.x),
		top:    f32::from(bounds.origin.y),
		right:  f32::from(bounds.origin.x) + f32::from(bounds.size.width),
		bottom: f32::from(bounds.origin.y) + f32::from(bounds.size.height),
	}
}

pub fn line(number: usize, text: &str) -> FileLine {
	spans(number, &[text])
}

pub fn spans(number: usize, pieces: &[&str]) -> FileLine {
	FileLine {
		line_number: number,
		spans:       pieces
			.iter()
			.map(|piece| HighlightSpan { text: (*piece).to_owned(), role: ColorRole::Foreground })
			.collect(),
	}
}

/// A state whose File tab is open on a file whose second line is wider than
/// the pane, and whose transcript is empty.
///
/// Empty on purpose: a turn's prose runs the width of the session column and
/// crosses the pane's own rows, so a transcript here would put runs in the band
/// this reads and none of them would be the pane's.
pub fn state_with_long_line() -> ShellState {
	let mut state = fixture::populated();
	state.transcript.clear();
	state.keymap.panel_collapsed = false;
	state.panel.active_tab = PanelTab::File;
	state.panel.file = Some(FileView {
		path:      "crates/veyyon-desktop-surface/src/right_panel/mono_pane.rs".to_owned(),
		lines:     vec![
			line(1, "//! The pane's own module."),
			spans(2, &[LONG_HEAD, LONG_TAIL]),
			line(3, "fn short() {}"),
			line(4, "// end"),
		],
		truncated: false,
		binary:    false,
	});
	state
}

/// The same file with enough lines below the long one for the pane to have
/// somewhere to scroll vertically to.
pub fn state_with_a_long_file() -> ShellState {
	let mut state = state_with_long_line();
	let mut lines = state
		.panel
		.file
		.clone()
		.expect("the state carries a file")
		.lines;
	for number in 5..80 {
		lines.push(line(number, "// filler"));
	}
	state.panel.file = state.panel.file.map(|file| FileView { lines, ..file });
	state
}

/// The panel's box, as the frame just laid it out.
pub fn panel_region(session: &mut HeadlessSession<'_, ShellView>) -> BoxBounds {
	let bounds = session
		.update(|view, _window, _cx| view.laid_out().drawn_bounds(Region::Panel))
		.expect("the window updates")
		.expect("an open panel lays its region out");
	rect(bounds)
}

/// The top edge of the pane's rows: under the tab strip and under the file
/// header, both of which draw runs of their own that are not rows.
pub fn pane_top(panel: BoxBounds, panels: &PanelsSurfaceTokens) -> f32 {
	panel.top + panels.tabs_height_px + panels.chrome_row_height_px
}

/// Every text run the pane's rows drew, with the run's own font size.
pub fn row_runs(
	captured: &Captured,
	panel: BoxBounds,
	panels: &PanelsSurfaceTokens,
) -> Vec<(BoxBounds, f32)> {
	captured
		.text_runs
		.iter()
		.map(|run| (rect(run.bounds), f32::from(run.font_size)))
		.filter(|(bounds, _)| {
			bounds.top >= pane_top(panel, panels) - 0.5
				&& bounds.right > panel.left
				&& bounds.left < panel.right
		})
		.collect()
}

/// The left edge of the code column: the gutter's own width in from the
/// panel's left edge.
pub fn code_edge(panel: BoxBounds, panels: &PanelsSurfaceTokens) -> f32 {
	panel.left + panels.diff_gutter_width_px
}

/// Whether a row run is one of the gutter's numbers: it sits wholly inside the
/// band the gutter pins, left of the code column's edge.
///
/// Reading the two columns apart by their left edges instead would have been
/// circular, since the code column's left edge is what the gesture moves. The
/// band is fixed, and no code line of this file fits inside it — every line
/// here is wider than the gutter, which
/// `every_row_of_the_pane_is_the_size_and_the_line_its_tokens_author` asserts
/// rather than assumes.
pub fn is_number(run: BoxBounds, panel: BoxBounds, panels: &PanelsSurfaceTokens) -> bool {
	run.left >= panel.left - 0.5 && run.right <= code_edge(panel, panels) + 0.5
}

/// The pane's code runs: every row run that is not one of the gutter's
/// numbers.
pub fn code_runs(
	captured: &Captured,
	panel: BoxBounds,
	panels: &PanelsSurfaceTokens,
) -> Vec<BoxBounds> {
	row_runs(captured, panel, panels)
		.into_iter()
		.filter(|(bounds, _)| !is_number(*bounds, panel, panels))
		.map(|(bounds, _)| bounds)
		.collect()
}

/// The pane's gutter runs: the line numbers.
pub fn gutter_runs(
	captured: &Captured,
	panel: BoxBounds,
	panels: &PanelsSurfaceTokens,
) -> Vec<BoxBounds> {
	row_runs(captured, panel, panels)
		.into_iter()
		.filter(|(bounds, _)| is_number(*bounds, panel, panels))
		.map(|(bounds, _)| bounds)
		.collect()
}

pub fn lefts(runs: &[BoxBounds]) -> Vec<f32> {
	runs.iter().map(|run| run.left).collect()
}

pub fn tops(runs: &[BoxBounds]) -> Vec<f32> {
	runs.iter().map(|run| run.top).collect()
}

/// Somewhere inside the code column, for the wheel to arrive at.
pub fn over_code(panel: BoxBounds, panels: &PanelsSurfaceTokens) -> Point<Pixels> {
	Point {
		x: Pixels::from(f32::midpoint(panel.left + panels.diff_gutter_width_px, panel.right)),
		y: Pixels::from(pane_top(panel, panels) + panels.diff_row_height_px),
	}
}

/// How wide the pane's widest row is, measured across the pieces one line
/// arrives in.
///
/// A line's own width is its spans' together. Reading the widest run instead
/// would have measured one piece of a highlighted line and called it the line.
pub fn widest_row(runs: &[BoxBounds]) -> f32 {
	let mut rows: Vec<(f32, f32, f32)> = Vec::new();
	for run in runs {
		match rows
			.iter_mut()
			.find(|(top, ..)| (*top - run.top).abs() < 0.5)
		{
			Some((_, left, right)) => {
				*left = left.min(run.left);
				*right = right.max(run.right);
			},
			None => rows.push((run.top, run.left, run.right)),
		}
	}
	rows
		.into_iter()
		.map(|(_, left, right)| right - left)
		.fold(0.0, f32::max)
}
