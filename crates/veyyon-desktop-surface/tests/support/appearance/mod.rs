//! The window the appearance suites drive: every bundled appearance installed
//! the way the binary installs it, opened on the Themes page.
//!
//! The whole library is installed rather than one theme, because the page
//! lists what the library holds: a window seeded with a single theme draws one
//! row and proves nothing about the appearance under the pointer.

use std::path::Path;

use veyyon_desktop_scene::{
	frame::RgbaFrame,
	headless::{RenderOptions, headless_context},
	session::HeadlessSession,
};
use veyyon_desktop_surface::{
	ConnectionPhase, Overlay, SettingsPage, SettingsState, ShellState, ShellView, ThemeLibrary,
	install_appearances,
};
use veyyon_desktop_tokens::{
	APPEARANCES, DEFAULT_APPEARANCE, MotionModel, Theme, Tokens, load_bundled_theme,
	load_bundled_tokens,
};
use veyyon_gpui::{App, AppContext, Bounds, Pixels, Point, TextRunLayout, px};

pub const WIDTH: u32 = 1440;
pub const HEIGHT: u32 = 900;

/// The bundled tokens with the float entrance flattened, so the settings sheet
/// is whole in the first frame and two frames of it differ where the
/// appearance differs rather than where the animation had reached.
pub fn still_tokens() -> Tokens {
	let mut tokens = load_bundled_tokens().expect("the bundled tokens load");
	let MotionModel::SpringFade(float) = &mut tokens.motion.float.model else {
		panic!("the float role must use its spring-fade model");
	};
	float.rise_px = 0.0;
	float.fade_duration_ms = 0;
	tokens
}

/// Every bundled appearance, swept out of `APPEARANCES` at run time so an
/// appearance added to the build reaches the harness without being named here.
pub fn bundled_themes() -> Vec<Theme> {
	APPEARANCES
		.into_iter()
		.map(|appearance| {
			load_bundled_theme(appearance)
				.unwrap_or_else(|error| panic!("the bundled {appearance} theme loads: {error}"))
		})
		.collect()
}

/// The state the suites open on: attached, still, and showing the Themes page.
pub fn on_the_themes_page() -> ShellState {
	ShellState {
		connection: ConnectionPhase::Attached,
		reduced_motion: true,
		overlay: Some(Overlay::Settings(Box::new(SettingsState::new(SettingsPage::Themes)))),
		..ShellState::default()
	}
}

/// Opens a window with the whole library installed, drawn in `appearance`, and
/// runs `drive` against it once it has drawn a frame.
pub fn driven<R>(
	appearance: &str,
	state: ShellState,
	drive: impl FnOnce(&mut HeadlessSession<'_, ShellView>) -> R,
) -> R {
	let mut cx = headless_context().expect("a headless renderer opens the window");
	let options =
		RenderOptions { width: WIDTH, height: HEIGHT, scale_factor: 1.0, ..RenderOptions::default() };
	let tokens = still_tokens();
	let themes = bundled_themes();
	let opened = appearance.to_owned();
	let mut session = HeadlessSession::open(&mut cx, &options, move |_window, app: &mut App| {
		let library = ThemeLibrary::new(&tokens, themes, Path::new("surface"));
		let installed = install_appearances(app, library, &opened)
			.expect("the bundled tokens and the opening appearance install");
		app.new(|_| ShellView::new(installed, state))
	})
	.expect("the shell opens a window");
	session.frame().expect("the shell draws its first frame");
	drive(&mut session)
}

/// The same window opened in the default appearance.
pub fn on_default<R>(
	state: ShellState,
	drive: impl FnOnce(&mut HeadlessSession<'_, ShellView>) -> R,
) -> R {
	driven(DEFAULT_APPEARANCE, state, drive)
}

/// The centre of the one run reading `label`.
///
/// A row is found by the text it drew rather than by a counted offset, so a
/// row added above it moves the pointer with it, and a second run of the same
/// text fails rather than aiming the pointer at whichever came first.
pub fn centre_of_run(runs: &[TextRunLayout], label: &str) -> Point<Pixels> {
	let matched: Vec<&TextRunLayout> = runs_named(runs, label);
	let drawn: Vec<&str> = runs.iter().map(|run| run.text.as_ref()).collect();
	assert_eq!(
		matched.len(),
		1,
		"the frame draws exactly one run reading {label:?}; it drew {drawn:?}"
	);
	let bounds: Bounds<Pixels> = matched[0].bounds;
	Point {
		x: bounds.origin.x + bounds.size.width / 2.0,
		y: bounds.origin.y + bounds.size.height / 2.0,
	}
}

/// Every run reading `label`.
pub fn runs_named<'a>(runs: &'a [TextRunLayout], label: &str) -> Vec<&'a TextRunLayout> {
	runs
		.iter()
		.filter(|run| run.text.as_ref() == label)
		.collect()
}

/// A point on the sheet that is no row: the band above the first one.
pub const fn off_every_row() -> Point<Pixels> {
	Point { x: px(24.0), y: px(24.0) }
}

/// How many pixels two frames disagree on.
pub fn changed_pixels(a: &RgbaFrame, b: &RgbaFrame) -> usize {
	assert_eq!(
		(a.width(), a.height()),
		(b.width(), b.height()),
		"two frames of one window differ in geometry"
	);
	a.as_bytes()
		.chunks_exact(4)
		.zip(b.as_bytes().chunks_exact(4))
		.filter(|(left, right)| left != right)
		.count()
}
