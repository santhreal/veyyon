//! WHY: the palette and the settings editor are floats over the shell, and a
//! float that stops floating — renders under the columns, or paints over the
//! titlebar it must leave reachable — still passes every intent-level test,
//! because those never look at a pixel. These frames make the float visible:
//! the overlay changes the columns it dims and leaves the bar above them
//! untouched.
//!
//! The class this closes is "an overlay stopped reaching the frame or stopped
//! floating". It does not judge the overlay's own layout, which a person does
//! on the written PNGs.

use std::path::Path;

use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_scene::{
	RgbaFrame,
	headless::{RenderOptions, headless_context, render_view, write_png},
};
use veyyon_desktop_surface::{
	Overlay, PaletteState, ShellView, fixture, install_tokens,
};
use veyyon_gpui::{App, AppContext};

const WIDTH: u32 = 1440;
const HEIGHT: u32 = 900;

fn options() -> RenderOptions {
	RenderOptions { width: WIDTH, height: HEIGHT, scale_factor: 1.0, ..RenderOptions::default() }
}

fn render(cx: &mut veyyon_gpui::HeadlessAppContext, overlay: Option<Overlay>) -> RgbaFrame {
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let theme = load_bundled_theme("dark").expect("the bundled dark theme loads");
	render_view(cx, &options(), move |_window, app: &mut App| {
		let installed = install_tokens(app, &tokens, &theme, Path::new("surface"))
			.expect("the bundled tokens and theme install");
		app.new(|_| {
			let mut state = fixture::populated();
			state.overlay.clone_from(&overlay);
			ShellView::new(installed, state)
		})
	})
	.expect("the shell renders offscreen")
}

/// The device pixels two frames share along one row band.
fn band_equal(a: &RgbaFrame, b: &RgbaFrame, top: u32, bottom: u32) -> bool {
	let width = a.width() as usize;
	a.as_bytes()
		.as_chunks::<4>().0.iter()
		.zip(b.as_bytes().as_chunks::<4>().0)
		.enumerate()
		.filter(|(i, _)| {
			let y = (i / width) as u32;
			y >= top && y < bottom
		})
		.all(|(_, (x, y))| x == y)
}

#[test]
fn the_overlays_float_over_the_columns_and_leave_the_titlebar() {
	let mut cx = headless_context().expect("a headless renderer is required to render the shell");
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let titlebar = tokens.surface.shell.titlebar_height_px as u32;

	let base = render(&mut cx, None);
	let palette = render(&mut cx, Some(Overlay::Palette(PaletteState::commands())));
	let settings = render(&mut cx, Some(Overlay::Settings(Box::default())));

	let dir = Path::new("../../target/scene-frames");
	write_png(&palette, &dir.join("shell-palette.png")).expect("the palette frame is written");
	write_png(&settings, &dir.join("shell-settings.png")).expect("the settings frame is written");

	for (name, frame) in [("palette", &palette), ("settings", &settings)] {
		assert_ne!(
			frame.as_bytes(),
			base.as_bytes(),
			"the {name} overlay changed nothing: it never reached the frame"
		);
		assert!(
			band_equal(frame, &base, 0, titlebar),
			"the {name} overlay painted into the titlebar, which floats above every overlay"
		);
	}
}
