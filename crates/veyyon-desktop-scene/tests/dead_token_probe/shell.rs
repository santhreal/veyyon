//! The whole window, in whatever state a suite seeds it with.
//!
//! A surface table states measures no primitive probe draws: the rail's
//! widths, the composer's box, the panels' splits, the palette's rows. The one
//! thing that draws them is the shell, and every state it can be in is a field
//! of `ShellState`, so a suite states what it needs and renders it here rather
//! than driving the window through keystrokes to get there.

use std::{path::Path, time::Instant};

use veyyon_desktop_scene::{Appearance, Headless, RenderOptions, headless::render_view};
use veyyon_desktop_surface::{InstalledTokens, ShellView, install_tokens, model::ShellState};
use veyyon_desktop_tokens::{Theme, Tokens, load_bundled_theme};
use veyyon_gpui::AppContext;

use super::{Observation, frame_observation};

/// One shell render a suite asks for.
pub struct Seeded {
	/// What the frame is named in the observation, and in the failure that
	/// names it.
	pub name:    &'static str,
	/// The window the shell is laid out in.
	pub options: RenderOptions,
	/// The state the window draws.
	pub state:   ShellState,
}

/// A window wide enough that no breakpoint sheds a pane, so a measure
/// belonging to a pane is drawn rather than dropped.
#[must_use]
pub const fn wide() -> RenderOptions {
	RenderOptions {
		width:        1600,
		height:       1000,
		scale_factor: 1.0,
		appearance:   Appearance::Dark,
		seed:         11,
	}
}

/// A window of `width` by `height`, for a measure that binds only at a size.
#[must_use]
pub const fn sized(width: u32, height: u32) -> RenderOptions {
	RenderOptions { width, height, scale_factor: 1.0, appearance: Appearance::Dark, seed: 11 }
}

/// Renders each seeded state against `tokens` with the provided `theme`.
pub fn render_with_theme(
	cx: &mut Headless,
	tokens: &Tokens,
	theme: &Theme,
	seeded: Vec<Seeded>,
) -> Vec<Observation> {
	seeded
		.into_iter()
		.map(|Seeded { name, options, state }| {
			let tokens = tokens.clone();
			let theme = theme.clone();
			let frame = render_view(cx, &options, move |_window, app| {
				let installed = install_tokens(app, &tokens, &theme, Path::new("surface"))
					.expect("the bundled token set must install");
				app.new(|_cx| ShellView::new(installed, state))
			})
			.expect("the shell must render");
			frame_observation(name, &frame)
		})
		.collect()
}

/// Renders each seeded state against `tokens`.
pub fn render(cx: &mut Headless, tokens: &Tokens, seeded: Vec<Seeded>) -> Vec<Observation> {
	let theme = load_bundled_theme("dark").expect("a bundled theme must load");
	render_with_theme(cx, tokens, &theme, seeded)
}

/// One shell render whose view is driven after it is constructed.
///
/// A block's disclosure is held by the view, not by `ShellState`, so a measure
/// that only an expanded block draws is unreachable from a seeded state alone.
pub struct Prepared {
	/// What the frame is named in the observation.
	pub name:    &'static str,
	/// The window the shell is laid out in.
	pub options: RenderOptions,
	/// The state the window draws.
	pub state:   ShellState,
	/// Runs against the constructed view before the first frame is laid out,
	/// against the executor's own clock, which is the one the frame samples an
	/// animation on.
	pub prepare: fn(&ShellView, &InstalledTokens, Instant),
}

/// Renders each prepared state against `tokens`, running its hook first.
pub fn render_prepared(
	cx: &mut Headless,
	tokens: &Tokens,
	prepared: Vec<Prepared>,
) -> Vec<Observation> {
	let theme = load_bundled_theme("dark").expect("a bundled theme must load");
	prepared
		.into_iter()
		.map(|Prepared { name, options, state, prepare }| {
			let tokens = tokens.clone();
			let theme = theme.clone();
			let frame = render_view(cx, &options, move |_window, app| {
				let installed = install_tokens(app, &tokens, &theme, Path::new("surface"))
					.expect("the bundled token set must install");
				let now = app.background_executor().now();
				app.new(|_cx| {
					let view = ShellView::new(installed.clone(), state);
					prepare(&view, &installed, now);
					view
				})
			})
			.expect("the shell must render");
			frame_observation(name, &frame)
		})
		.collect()
}
