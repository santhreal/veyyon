//! The window the menu-bar suites drive, and the readings they take off its
//! frames: one headless `ShellView` with a seeded refusal list, the centre of
//! the single text run a word was drawn in, and whether a box short enough to
//! be the titlebar covers a point.
//!
//! The harness sits here rather than in a suite because a suite is a sentence
//! about the bar's behaviour and stays readable only while the window it opens
//! is somewhere else.
#![allow(dead_code, reason = "each including suite calls a subset of these helpers")]

use std::path::Path;

use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_scene::{
	headless::{Captured, RenderOptions, headless_context},
	session::HeadlessSession,
};
use veyyon_desktop_surface::{Command, Keymap, ShellState, ShellView, fixture, install_tokens};
use veyyon_gpui::{App, AppContext, Point};

pub const WIDTH: u32 = 1440;
pub const HEIGHT: u32 = 900;

/// The tallest box that can still be a titlebar word rather than a layer over
/// the window: the titlebar itself is 52 px.
pub const WORD_CEILING_PX: f32 = 60.0;

/// The fixture with the panel folded away, refusing `declined`.
///
/// The panel is folded so that the words the bar draws are the only place the
/// frame draws them, which is what `drawn_once` depends on.
pub fn seeded_state(declined: &[Command]) -> ShellState {
	let mut state = fixture::populated();
	state.keymap.panel_collapsed = true;
	state.menu.declined = declined.to_vec();
	state
}

/// Opens the shell in a 1440x900 headless window with the production keymap and
/// the kit's editor bindings, and runs `test` against it.
pub fn render_session<R>(
	declined: &[Command],
	test: impl FnOnce(&mut HeadlessSession<ShellView>) -> R,
) -> R {
	let mut cx = headless_context().expect("headless context available");
	let tokens = load_bundled_tokens().expect("tokens load");
	let theme = load_bundled_theme("dark").expect("theme loads");
	let options =
		RenderOptions { width: WIDTH, height: HEIGHT, scale_factor: 1.0, ..RenderOptions::default() };
	let declined = declined.to_vec();

	let mut session = HeadlessSession::open(&mut cx, &options, move |_window, app: &mut App| {
		let installed = install_tokens(app, &tokens, &theme, Path::new("surface"))
			.expect("tokens and theme install");
		app.bind_keys(Keymap::default().bindings());
		veyyon_desktop_kit::input::ensure_editor_bindings_registered(app);
		app.new(|_| ShellView::new(installed, seeded_state(&declined)))
	})
	.expect("session opens");

	test(&mut session)
}

/// Where the frame drew `label`, as the centre of the one text run whose
/// content is exactly that word.
pub fn drawn_once(captured: &Captured, label: &str) -> Point<f32> {
	let runs: Vec<Point<f32>> = captured
		.text_runs
		.iter()
		.filter(|run| run.text.as_ref().trim() == label)
		.map(|run| Point {
			x: f32::from(run.bounds.origin.x) + f32::from(run.bounds.size.width) / 2.0,
			y: f32::from(run.bounds.origin.y) + f32::from(run.bounds.size.height) / 2.0,
		})
		.collect();
	assert_eq!(runs.len(), 1, "the frame draws `{label}` exactly once, drew {}", runs.len());
	runs[0]
}

/// Whether a box no taller than the titlebar covers `at`, which is what makes
/// a drawn word a control rather than a caption.
pub fn hit(captured: &Captured, at: Point<f32>) -> bool {
	captured.hitboxes.iter().any(|rect| {
		let left = f32::from(rect.origin.x);
		let top = f32::from(rect.origin.y);
		let width = f32::from(rect.size.width);
		let height = f32::from(rect.size.height);
		height <= WORD_CEILING_PX
			&& left <= at.x
			&& at.x <= left + width
			&& top <= at.y
			&& at.y <= top + height
	})
}
