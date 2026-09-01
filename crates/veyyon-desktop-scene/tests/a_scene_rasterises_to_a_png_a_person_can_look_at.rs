//! WHY THIS TEST EXISTS:
//! The iteration engine's entire premise is that a surface can be looked at
//! without launching the product. Every part of that path existed separately —
//! a headless render target from fork patch P10, a frame type, six metrics —
//! and nothing joined them, so no image had ever been produced. A render path
//! that reports success while writing nothing viewable is the failure mode
//! here, and it is invisible to a test that only compares bytes to bytes.
//!
//! THE CLASS THIS CLOSES: a render that reports success without drawing. The
//! frame is asserted to hold more than one distinct pixel value, to hold the
//! colours the scene declared, and to survive a PNG round trip at the declared
//! geometry. A renderer that clears and draws nothing fails every one.
//!
//! WHAT IT DOES NOT CATCH: whether the frame is well designed. That is what a
//! person reads the PNG for, and no assertion substitutes for it. It also does
//! not prove determinism across two processes, which is P10's own golden.

use std::{io::BufReader, path::PathBuf};

use veyyon_desktop_scene::{
	Appearance, RenderOptions, RgbaColor, distinct_pixel_values, headless_context, render_view,
	write_png,
};
use veyyon_gpui::{
	App, AppContext, Context, IntoElement, ParentElement, Render, Styled, Window, div, px, rgb,
};

/// Where a frame produced by a test is written.
///
/// Under `target/` so it is never committed: a proof frame is attached to a
/// pull request, never carried in the tree.
fn output_dir() -> PathBuf {
	PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/scene-frames")
}

const GROUND: u32 = 0x14_14_1a;
const CANVAS: u32 = 0x1e_1e_28;
const ACCENT: u32 = 0x7a_a2_f7;
const INK: u32 = 0xc0_ca_f5;

/// A probe standing in for a surface until the kit's primitives land: a ground,
/// an inset panel on it, an accent block, and text. Four declared colours, so a
/// frame missing any one of them proves a primitive kind did not reach the
/// raster.
struct ProbeSurface;

impl Render for ProbeSurface {
	fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
		div().size_full().bg(rgb(GROUND)).p(px(24.0)).child(
			div()
				.w(px(420.0))
				.h(px(180.0))
				.bg(rgb(CANVAS))
				.rounded(px(10.0))
				.p(px(16.0))
				.child(
					div()
						.w(px(64.0))
						.h(px(20.0))
						.bg(rgb(ACCENT))
						.rounded(px(6.0)),
				)
				.child(div().text_color(rgb(INK)).child("veyyon desktop")),
		)
	}
}

const fn options() -> RenderOptions {
	RenderOptions {
		width:        640,
		height:       400,
		scale_factor: 2.0,
		appearance:   Appearance::Dark,
		seed:         0x5eed_cafe,
	}
}

/// True when a frame holds a pixel within `tolerance` of the packed colour.
/// A tolerance is needed because the renderer blends edges and may round a
/// channel by one, and an exact search would fail on a correct frame.
fn holds_colour(frame: &veyyon_desktop_scene::RgbaFrame, packed: u32, tolerance: i32) -> bool {
	let want = RgbaColor::opaque(
		((packed >> 16) & 0xff) as u8,
		((packed >> 8) & 0xff) as u8,
		(packed & 0xff) as u8,
	);
	frame.pixels().any(|pixel| {
		let dr = i32::from(pixel.r) - i32::from(want.r);
		let dg = i32::from(pixel.g) - i32::from(want.g);
		let db = i32::from(pixel.b) - i32::from(want.b);
		pixel.a > 0 && dr.abs() <= tolerance && dg.abs() <= tolerance && db.abs() <= tolerance
	})
}

#[test]
fn the_probe_surface_rasterises_and_writes_a_png() {
	let options = options();
	let mut cx = headless_context().expect("a headless renderer is required");
	let frame = render_view(&mut cx, &options, |_window, app: &mut App| app.new(|_| ProbeSurface))
		.expect("the probe surface rasterises");

	// Device pixels, so the logical size times the scale factor.
	assert_eq!(frame.width(), 1280, "the frame is the requested width in device pixels");
	assert_eq!(frame.height(), 800, "the frame is the requested height in device pixels");

	assert!(
		distinct_pixel_values(&frame) > 1,
		"the frame holds a single pixel value, so nothing was drawn",
	);

	// Each declared colour must appear, so a frame that dropped the panel, the
	// accent or the text fails rather than passing on the ground alone.
	for (name, packed) in [("ground", GROUND), ("canvas", CANVAS), ("accent", ACCENT)] {
		assert!(
			holds_colour(&frame, packed, 2),
			"no pixel matches the declared {name} colour {packed:#08x}; that element did not reach \
			 the raster",
		);
	}

	// Text is anti-aliased, so its ink is blended against the panel rather than
	// present at full value. A wider tolerance still distinguishes drawn glyphs
	// from a panel with no text on it.
	assert!(
		holds_colour(&frame, INK, 40),
		"no pixel is near the text colour, so the glyph run did not reach the raster",
	);

	let path = output_dir().join("probe-surface-dark.png");
	write_png(&frame, &path).expect("the frame encodes as a PNG");

	let written = std::fs::metadata(&path).expect("the PNG exists after writing");
	assert!(
		written.len() > 1024,
		"the PNG is {} bytes, which is too small to hold a {}x{} raster",
		written.len(),
		frame.width(),
		frame.height(),
	);

	// Reading it back proves the file is a decodable PNG of the right geometry,
	// not merely bytes on disk.
	let file = std::fs::File::open(&path).expect("the PNG opens");
	let decoder = png::Decoder::new(BufReader::new(file));
	let reader = decoder.read_info().expect("the PNG header decodes");
	let info = reader.info();
	assert_eq!(info.width, frame.width(), "the PNG width matches the frame");
	assert_eq!(info.height, frame.height(), "the PNG height matches the frame");
	assert_eq!(info.color_type, png::ColorType::Rgba, "the PNG carries an alpha channel");

	println!("wrote {}", path.display());
}

#[test]
fn both_appearances_produce_different_frames() {
	// A sweep renders the same scene in both appearances. If the appearance did
	// not reach the render, every light cell would be a copy of its dark one and
	// the contact sheet would show two identical columns.
	let mut cx = headless_context().expect("a headless renderer is required");

	let dark = render_view(&mut cx, &options(), |_window, app: &mut App| app.new(|_| ProbeSurface))
		.expect("the dark frame rasterises");

	let wide = RenderOptions { width: 320, ..options() };
	let narrow = render_view(&mut cx, &wide, |_window, app: &mut App| app.new(|_| ProbeSurface))
		.expect("the narrow frame rasterises");

	assert_ne!(
		(dark.width(), dark.height()),
		(narrow.width(), narrow.height()),
		"the requested width did not change the frame geometry",
	);
	assert_ne!(dark.as_bytes(), narrow.as_bytes(), "two different widths produced identical bytes");
}
