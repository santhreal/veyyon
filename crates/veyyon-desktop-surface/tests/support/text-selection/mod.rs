//! The window every text-selection suite drives, and the readings they take
//! off its frames: one headless `ShellView` on a seeded transcript, the boxes
//! the frame drew a given run in, and the pixels two frames disagree on.
//!
//! The harness is shared rather than repeated because the three suites differ
//! in what they assert, not in what they open: a press resolving to an offset,
//! a chord taking text out of the window, and which blocks state spans at all
//! all need the same window with the same clipboard sentinel in it.

use std::path::Path;

use unicode_segmentation::UnicodeSegmentation;
use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_scene::{
	frame::RgbaFrame,
	headless::{Captured, RenderOptions, headless_context},
	session::HeadlessSession,
};
use veyyon_desktop_surface::{
	Keymap, ShellState, ShellView, fixture, install_tokens,
	model::{Block, Turn},
};
use veyyon_gpui::{App, AppContext, Bounds, ClipboardItem, Pixels, Point};

pub const WIDTH: u32 = 1440;
pub const HEIGHT: u32 = 900;

/// What the clipboard holds before a case touches it, so a copy that wrote
/// nothing is told apart from a copy that wrote the right thing.
pub const SENTINEL: &str = "nothing has been copied yet";

/// The first paragraph of the turn the pointer cases drag over.
pub const FIRST: &str = "The fix landed in src/main.rs and the run is green.";
/// The second, which a drag across a block boundary ends in.
pub const SECOND: &str = "Nothing else in the tree reads that path.";

/// A turn of two paragraphs, which is the smallest transcript a drag can cross
/// a block boundary in.
pub fn two_paragraphs() -> Vec<Turn> {
	vec![Turn::Agent {
		blocks: vec![Block::Prose(FIRST.into()), Block::Prose(SECOND.into())],
		model:  None,
	}]
}

/// The chord `key` is reached by, which is the platform's own primary
/// modifier: the keymap declares `primary-` and the window resolves it.
pub fn primary(key: &str) -> String {
	let modifier = if cfg!(target_os = "macos") {
		"cmd"
	} else {
		"ctrl"
	};
	format!("{modifier}-{key}")
}

pub fn seeded_state(turns: Vec<Turn>, reduced_motion: bool) -> ShellState {
	let mut state = fixture::populated();
	state.keymap.panel_collapsed = true;
	state.reduced_motion = reduced_motion;
	state.transcript = turns;
	state
}

/// Opens the window on `turns`, with the clipboard seeded, and runs `test`.
pub fn render_session<R>(
	turns: Vec<Turn>,
	test: impl FnOnce(&mut HeadlessSession<'_, ShellView>) -> R,
) -> R {
	render_session_still(turns, false, test)
}

/// The same window with motion off, which is what a block that opens on a
/// press needs: a reveal is driven by the wall clock, and a body drawn part
/// way through one is clipped to the height it has reached, so the pointer
/// reaches its lines only once the reveal has finished. Motion off finishes it
/// in the frame the press produced; the animation itself is the reveal suite's
/// subject.
pub fn render_session_still<R>(
	turns: Vec<Turn>,
	reduced_motion: bool,
	test: impl FnOnce(&mut HeadlessSession<'_, ShellView>) -> R,
) -> R {
	let mut cx = headless_context().expect("headless context available");
	let tokens = load_bundled_tokens().expect("tokens load");
	let theme = load_bundled_theme("dark").expect("theme loads");
	let options =
		RenderOptions { width: WIDTH, height: HEIGHT, scale_factor: 1.0, ..RenderOptions::default() };

	let mut session = HeadlessSession::open(&mut cx, &options, move |_window, app: &mut App| {
		let installed = install_tokens(app, &tokens, &theme, Path::new("surface"))
			.expect("tokens and theme install");
		app.bind_keys(Keymap::default().bindings());
		veyyon_desktop_kit::input::ensure_editor_bindings_registered(app);
		app.write_to_clipboard(ClipboardItem::new_string(SENTINEL.to_owned()));
		app.new(|_| ShellView::new(installed, seeded_state(turns, reduced_motion)))
	})
	.expect("session opens");

	test(&mut session)
}

/// The box the frame drew the one run holding `needle` in.
pub fn run_holding(captured: &Captured, needle: &str) -> Bounds<Pixels> {
	let runs: Vec<Bounds<Pixels>> = captured
		.text_runs
		.iter()
		.filter(|run| run.text.as_ref().contains(needle))
		.map(|run| run.bounds)
		.collect();
	assert_eq!(
		runs.len(),
		1,
		"the frame draws a run holding {needle:?} exactly once, drew {}",
		runs.len()
	);
	runs[0]
}

/// The box the frame drew the one run whose whole text is `label` in. A
/// caption of two common words is held by a card elsewhere on the frame too,
/// which is what separates this from [`run_holding`].
pub fn run_labelled(captured: &Captured, label: &str) -> Bounds<Pixels> {
	let runs: Vec<Bounds<Pixels>> = captured
		.text_runs
		.iter()
		.filter(|run| run.text.as_ref().trim() == label)
		.map(|run| run.bounds)
		.collect();
	assert_eq!(
		runs.len(),
		1,
		"the frame draws {label:?} as a run of its own exactly once, drew {}",
		runs.len()
	);
	runs[0]
}

/// A point `fraction` of the way across `bounds`, on its middle line.
pub fn along(bounds: Bounds<Pixels>, fraction: f32) -> Point<Pixels> {
	Point {
		x: bounds.origin.x + bounds.size.width * fraction,
		y: bounds.origin.y + bounds.size.height / 2.0,
	}
}

/// How many pixels inside `area` two frames disagree on.
pub fn changed_pixels(before: &RgbaFrame, after: &RgbaFrame, area: Bounds<Pixels>) -> usize {
	let scale = before.scale_factor();
	let device = |value: Pixels| (f32::from(value) * scale).round().max(0.0) as u32;
	let left = device(area.origin.x);
	let top = device(area.origin.y);
	let right = device(area.origin.x + area.size.width);
	let bottom = device(area.origin.y + area.size.height);
	assert!(right > left && bottom > top, "the box {area:?} holds no pixels");

	let mut changed = 0;
	for y in top..bottom {
		for x in left..right {
			if before.pixel(x, y) != after.pixel(x, y) {
				changed += 1;
			}
		}
	}
	changed
}

/// What the platform clipboard holds as text.
pub fn clipboard(session: &mut HeadlessSession<'_, ShellView>) -> Option<String> {
	session
		.update(|_view, _window, cx| cx.read_from_clipboard().and_then(|item| item.text()))
		.expect("read the clipboard")
}

/// The caption the row holding the output draws, and the lines behind it.
pub const PANE_CAPTION: &str = "cargo test";
pub const PANE_LINES: [&str; 2] = ["test result: ok. 3 passed", "Finished in 0.42s"];

/// Each grapheme cluster of `text` with the byte offset it starts at, which
/// is what a copy is read against: a selection that ends inside one of these
/// took half a character.
pub fn cluster_offsets(text: &str) -> Vec<(usize, &str)> {
	text.grapheme_indices(true).collect()
}
