//! Fixture generation and headless session setup for queue scroll, paging,
//! and selection tests.
//!
//! Several test binaries include this module and each uses a subset of it, so
//! each `mod` site carries its own `allow(dead_code)`.

use std::path::Path;

use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_scene::{
	HeadlessSession,
	headless::{Headless, RenderOptions},
};
use veyyon_desktop_surface::{Badge, Row, ShellState, ShellView, install_tokens};
use veyyon_gpui::{App, AppContext};

fn test_opts(width: u32, height: u32) -> RenderOptions {
	RenderOptions { width, height, scale_factor: 1.0, ..RenderOptions::default() }
}

pub fn row(
	id: u64,
	title: String,
	subtitle: &str,
	badge: Option<Badge>,
	meta: Option<&str>,
) -> Row {
	Row { id, title, subtitle: subtitle.into(), badge, meta: meta.map(Into::into) }
}

pub fn open_session(
	cx: &mut Headless,
	state: ShellState,
	w: u32,
	h: u32,
) -> HeadlessSession<'_, ShellView> {
	let tokens = load_bundled_tokens().expect("bundled tokens load");
	let theme = load_bundled_theme("dark").expect("bundled dark theme loads");
	HeadlessSession::open(cx, &test_opts(w, h), move |_window, app: &mut App| {
		let installed =
			install_tokens(app, &tokens, &theme, Path::new("surface")).expect("tokens install");
		let view = ShellView::new(installed, state);
		app.new(|_| view)
	})
	.expect("session opens offscreen")
}
