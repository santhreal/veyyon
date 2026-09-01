//! WHY: the shell's regions are placed from token values, and a region whose
//! width silently stops tracking its token is invisible in review — the window
//! still looks plausible, just wrong. These assertions pin each region's edge
//! to the token that decides it, so a hardcoded dimension creeping into a
//! surface turns the suite red rather than shipping.
//!
//! The class this closes is "a surface stopped reading its token". It does not
//! catch a token file whose value is itself wrong, which is a design judgement
//! made by looking at the rendered sheet, nor does it check colour fidelity
//! beyond regions being distinguishable from one another.

use std::{collections::BTreeMap, path::Path};

use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_scene::{
	frame::RgbaColor,
	headless::{RenderOptions, distinct_pixel_values, headless_context, render_view, write_png},
};
use veyyon_desktop_surface::{ShellView, fixture, install_tokens};
use veyyon_gpui::{App, AppContext};

/// The window the shell is judged at. Wide enough that the queue, the session
/// surface and the right panel are all present at once.
const WIDTH: u32 = 1440;
const HEIGHT: u32 = 900;

fn options() -> RenderOptions {
	RenderOptions { width: WIDTH, height: HEIGHT, scale_factor: 1.0, ..RenderOptions::default() }
}

#[test]
fn the_shell_draws_its_regions_where_the_tokens_put_them() {
	let mut cx = headless_context().expect("a headless renderer is required to render the shell");
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let theme = load_bundled_theme("dark").expect("the bundled dark theme loads");

	let queue_width = tokens.surface.queue.width_default_px;
	let titlebar = tokens.surface.shell.titlebar_height_px;

	let frame = render_view(&mut cx, &options(), move |_window, app: &mut App| {
		let installed = install_tokens(app, &tokens, &theme, Path::new("surface"))
			.expect("the bundled tokens and theme install");
		app.new(|_| ShellView::new(installed, fixture::populated()))
	})
	.expect("the shell renders offscreen");

	// Written so the surface can be judged by looking at it, which is the only
	// way a layout decision is actually reviewed.
	write_png(&frame, Path::new("../../target/scene-frames/shell-populated.png"))
		.expect("the frame is written");

	assert_eq!((frame.width(), frame.height()), (WIDTH, HEIGHT), "the frame is the window's size");

	// A blank or near-blank frame satisfies every geometric assertion below,
	// because they all compare pixels that would then be equal. This is the
	// floor that makes the rest of the test mean anything.
	let distinct = distinct_pixel_values(&frame);
	assert!(distinct > 24, "the shell drew only {distinct} distinct pixel values, so it is blank");

	// A single pixel anywhere useful may land on a glyph, so each region is
	// identified by the most common colour down a column through it: its
	// ground. That is the value a region's width actually controls.
	let ground_at = |x: f32| -> RgbaColor {
		let mut counts: BTreeMap<[u8; 4], u32> = BTreeMap::new();
		for y in (titlebar as u32 + 4)..(HEIGHT - 4) {
			let pixel = frame
				.pixel(x as u32, y)
				.expect("the sample is inside the frame");
			*counts
				.entry([pixel.r, pixel.g, pixel.b, pixel.a])
				.or_default() += 1;
		}
		let (bytes, _) = counts
			.into_iter()
			.max_by_key(|(_, count)| *count)
			.expect("the column has at least one pixel");
		RgbaColor { r: bytes[0], g: bytes[1], b: bytes[2], a: bytes[3] }
	};

	let rail = ground_at(queue_width / 2.0);
	let inside_rail_edge = ground_at(queue_width - 2.0);
	let outside_rail_edge = ground_at(queue_width + 8.0);
	let panel = ground_at((WIDTH as f32) - 8.0);

	assert_eq!(rail, inside_rail_edge, "the queue rail is one ground up to its token width");
	assert_ne!(
		rail, outside_rail_edge,
		"the queue rail's ground continues past its token width, so its width is not the token's"
	);
	assert_ne!(
		outside_rail_edge, panel,
		"the right panel is not distinguishable from the session surface"
	);
	// The titlebar is its own band: the ground across it differs from the
	// ground of the row below it. Compared as a row rather than a pixel for
	// the same reason as the columns above.
	let row_ground = |y: u32| -> RgbaColor {
		let mut counts: BTreeMap<[u8; 4], u32> = BTreeMap::new();
		for x in 0..WIDTH {
			let pixel = frame.pixel(x, y).expect("the sample is inside the frame");
			*counts
				.entry([pixel.r, pixel.g, pixel.b, pixel.a])
				.or_default() += 1;
		}
		let (bytes, _) = counts
			.into_iter()
			.max_by_key(|(_, count)| *count)
			.expect("the row has at least one pixel");
		RgbaColor { r: bytes[0], g: bytes[1], b: bytes[2], a: bytes[3] }
	};

	assert_ne!(
		row_ground(titlebar as u32 / 2),
		row_ground(titlebar as u32 + 40),
		"the titlebar is not a distinct band"
	);
}

#[test]
fn a_notice_adds_the_attention_strip() {
	let mut cx = headless_context().expect("a headless renderer is required to render the shell");
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let theme = load_bundled_theme("dark").expect("the bundled dark theme loads");

	let build = |notice: Option<String>| {
		let tokens = tokens.clone();
		let theme = theme.clone();
		move |_window: &mut veyyon_gpui::Window, app: &mut App| {
			let installed = install_tokens(app, &tokens, &theme, Path::new("surface"))
				.expect("the bundled tokens and theme install");
			app.new(|_| {
				let mut view = ShellView::new(installed, fixture::populated());
				view.set_notice(notice);
				view
			})
		}
	};

	let quiet = render_view(&mut cx, &options(), build(None)).expect("the quiet shell renders");
	let noticed = render_view(
		&mut cx,
		&options(),
		build(Some("themes/dark.toml: missing required key \"plan_ink\"".to_owned())),
	)
	.expect("the shell with a notice renders");

	write_png(&noticed, Path::new("../../target/scene-frames/shell-notice.png"))
		.expect("the frame is written");

	// The strip displaces everything under it, so the two frames differ well
	// below the strip itself. Comparing whole frames rather than one pixel is
	// what catches a strip that renders at zero height.
	assert_ne!(
		quiet.as_bytes(),
		noticed.as_bytes(),
		"a notice must be visible; the two frames are identical"
	);
}

#[test]
fn the_drawer_docks_under_the_session_surface() {
	let mut cx = headless_context().expect("a headless renderer is required to render the shell");
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let theme = load_bundled_theme("dark").expect("the bundled dark theme loads");

	let queue_width = tokens.surface.queue.width_default_px;
	let drawer_height = tokens.surface.panels.terminal_drawer_default_height_px;

	let build = |state: veyyon_desktop_surface::ShellState| {
		let tokens = tokens.clone();
		let theme = theme.clone();
		move |_window: &mut veyyon_gpui::Window, app: &mut App| {
			let installed = install_tokens(app, &tokens, &theme, Path::new("surface"))
				.expect("the bundled tokens and theme install");
			app.new(|_| ShellView::new(installed, state))
		}
	};

	let closed =
		render_view(&mut cx, &options(), build(fixture::populated())).expect("the shell renders");
	let open = render_view(&mut cx, &options(), build(fixture::with_drawer()))
		.expect("the shell with the drawer renders");

	write_png(&open, Path::new("../../target/scene-frames/shell-drawer.png"))
		.expect("the frame is written");

	// The drawer occupies the bottom of the session column and nothing else.
	// Sampled inside the queue rail, the two frames agree; sampled inside the
	// session column at the drawer's height, they differ. That is the whole
	// contract: it docks under one region, not across the window.
	let band = HEIGHT - (drawer_height as u32) / 2;
	let in_rail = |frame: &veyyon_desktop_scene::frame::RgbaFrame| {
		frame
			.pixel((queue_width / 2.0) as u32, band)
			.expect("inside the rail")
	};
	let in_session = |frame: &veyyon_desktop_scene::frame::RgbaFrame| {
		frame
			.pixel((queue_width + 200.0) as u32, band)
			.expect("inside the session column")
	};

	assert_eq!(in_rail(&closed), in_rail(&open), "the drawer changed the queue rail");
	assert_ne!(
		in_session(&closed),
		in_session(&open),
		"the drawer is not visible in the session column"
	);
}
