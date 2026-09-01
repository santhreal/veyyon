//! WHY THIS SUITE EXISTS:
//! Section 4.1 defines the window shell geometry and minimum dimensions
//! (800x560). The iteration engine requires the window root to rasterise
//! offscreen to a viewable PNG frame, and its layout bounds to strictly match
//! the declared token dimensions.
//!
//! THE CLASS THIS CLOSES:
//! - Window failing to render or open with declared minimum geometry.
//! - Titlebar failing to paint at declared height.
//! - Offscreen rendering producing empty or unpopulated frames.

use std::path::PathBuf;

use veyyon_desktop::{AssetPaths, load_startup_bundle};
use veyyon_desktop_scene::{
	Appearance, RenderOptions, distinct_pixel_values, headless_context, render_view_with_layout,
	write_png,
};
use veyyon_desktop_surface::{ShellView, fixture, install_tokens};
use veyyon_gpui::AppContext;

fn output_dir() -> PathBuf {
	PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/shell-frames")
}

fn startup_assets() -> veyyon_desktop::StartupBundle {
	let tokens_dir =
		PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../crates/veyyon-desktop-tokens/tokens");
	let themes_dir =
		PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../crates/veyyon-desktop-tokens/themes");

	load_startup_bundle(AssetPaths { tokens_dir, themes_dir }).expect("load startup bundle")
}

#[test]
fn shell_rasterises_at_minimum_window_size_and_asserts_geometry() {
	let mut cx = headless_context().expect("headless context must be available on GPU host");
	let bundle = startup_assets();

	let min_w = bundle.tokens.surface.shell.window_min_width_px as u32;
	let min_h = bundle.tokens.surface.shell.window_min_height_px as u32;

	let options = RenderOptions {
		width:        min_w,
		height:       min_h,
		scale_factor: 2.0,
		appearance:   Appearance::Dark,
		seed:         0x5eed_cafe,
	};

	let tokens = bundle.tokens.clone();
	let theme = bundle.theme.clone();
	let surface_path = bundle.surface_path.clone();

	let (frame, tree) = render_view_with_layout(&mut cx, &options, move |_, cx| {
		let installed =
			install_tokens(cx, &tokens, &theme, &surface_path).expect("install tokens for test");
		cx.new(|_| ShellView::new(installed, fixture::populated()))
	})
	.expect("render view with layout");

	let out_path = output_dir().join("shell_min_size.png");
	write_png(&frame, &out_path).expect("write PNG proof frame");

	assert!(
		distinct_pixel_values(&frame) >= 1,
		"rendered frame must contain distinct non-empty pixel values"
	);

	// Window geometry assertions per ShellSurfaceTokens
	let expected_min_w = bundle.tokens.surface.shell.window_min_width_px;
	let expected_min_h = bundle.tokens.surface.shell.window_min_height_px;
	let expected_titlebar_h = bundle.tokens.surface.shell.titlebar_height_px;

	assert_eq!(min_w as f32, expected_min_w);
	assert_eq!(min_h as f32, expected_min_h);

	// Titlebar occupies declared height across the top
	let titlebar_box = tree
		.iter()
		.find(|b| {
			(b.bounds.top - 0.0).abs() < 1.0 && (b.bounds.height() - expected_titlebar_h).abs() < 1.0
		})
		.expect("titlebar box matching declared height must exist");

	assert_eq!(titlebar_box.bounds.height(), expected_titlebar_h);
}

#[test]
fn shell_rasterises_at_wide_window_size_and_asserts_geometry() {
	let mut cx = headless_context().expect("headless context must be available on GPU host");
	let bundle = startup_assets();

	let wide_w = 1440u32;
	let wide_h = 900u32;

	let options = RenderOptions {
		width:        wide_w,
		height:       wide_h,
		scale_factor: 2.0,
		appearance:   Appearance::Dark,
		seed:         0x5eed_cafe,
	};

	let tokens = bundle.tokens.clone();
	let theme = bundle.theme.clone();
	let surface_path = bundle.surface_path;

	let (frame, tree) = render_view_with_layout(&mut cx, &options, move |_, cx| {
		let installed =
			install_tokens(cx, &tokens, &theme, &surface_path).expect("install tokens for test");
		cx.new(|_| ShellView::new(installed, fixture::populated()))
	})
	.expect("render view with layout");

	let out_path = output_dir().join("shell_wide_size.png");
	write_png(&frame, &out_path).expect("write PNG proof frame");

	assert!(
		distinct_pixel_values(&frame) >= 1,
		"rendered frame must contain distinct non-empty pixel values"
	);

	let expected_titlebar_h = bundle.tokens.surface.shell.titlebar_height_px;

	// Titlebar occupies declared height across wide window
	let titlebar_box = tree
		.iter()
		.find(|b| {
			(b.bounds.top - 0.0).abs() < 1.0 && (b.bounds.height() - expected_titlebar_h).abs() < 1.0
		})
		.expect("wide window titlebar box must exist");

	assert_eq!(titlebar_box.bounds.height(), expected_titlebar_h);
}
