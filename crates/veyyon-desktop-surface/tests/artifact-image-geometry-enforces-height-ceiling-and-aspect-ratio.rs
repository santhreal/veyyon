//! WHY: Expanded artifact image previews (both Image attachments and
//! File mentions with embedded images) must enforce the configured
//! `TranscriptSurfaceTokens.chrome_image_max_height_px` ceiling, fit within the
//! transcript column width, preserve intrinsic aspect ratio without distortion,
//! retain native dimensions for small images without artificial enlargement,
//! respect non-default token ceilings supplied via geometry configuration,
//! and deterministically advance reveal animation state during headless
//! testing.

use std::{
	path::Path,
	sync::Arc,
	time::{Duration, Instant},
};

use image::{ImageBuffer, Rgba};
use veyyon_desktop_kit::{TokenSet, load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_motion::MotionTokens;
use veyyon_desktop_scene::{
	frame::RgbaFrame,
	headless::{Captured, RenderOptions, headless_context, render_view_captured},
};
use veyyon_desktop_surface::{
	install_tokens,
	model::Artifact,
	transcript::{TranscriptViewportState, blocks::artifact::render_artifact_block},
};
use veyyon_desktop_tokens::TranscriptSurfaceTokens;
use veyyon_gpui::{
	App, AppContext, Context, IntoElement, ParentElement, Render, Styled, Window, div,
};

fn make_png_with_color(w: u32, h: u32, color: [u8; 4]) -> Vec<u8> {
	let mut img: ImageBuffer<Rgba<u8>, Vec<u8>> = ImageBuffer::new(w, h);
	for pixel in img.pixels_mut() {
		*pixel = Rgba(color);
	}
	let mut bytes = Vec::new();
	let enc = image::codecs::png::PngEncoder::new(&mut bytes);
	image::ImageEncoder::write_image(enc, &img, w, h, image::ExtendedColorType::Rgba8).expect("png");
	bytes
}

struct GeometryTestView {
	state:    TranscriptViewportState,
	geometry: TranscriptSurfaceTokens,
	tokens:   TokenSet,
	motion:   MotionTokens,
	artifact: Artifact,
}

impl Render for GeometryTestView {
	fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
		div().size_full().child(render_artifact_block(
			0,
			0,
			&self.artifact,
			true,
			&self.geometry,
			&self.tokens,
			&self.motion,
			true,
			&self.state,
			None,
		))
	}
}

fn render_expanded_artifact(
	artifact: Artifact,
	geometry_override: Option<TranscriptSurfaceTokens>,
	viewport_width: u32,
	viewport_height: u32,
) -> Captured {
	let tokens = load_bundled_tokens().expect("bundled tokens");
	let theme = load_bundled_theme("dark").expect("bundled theme");
	let state = TranscriptViewportState::new();
	let mut cx = headless_context().expect("headless context");

	render_view_captured(
		&mut cx,
		&RenderOptions {
			width: viewport_width,
			height: viewport_height,
			scale_factor: 1.0,
			..RenderOptions::default()
		},
		move |_, app: &mut App| {
			let ins = install_tokens(app, &tokens, &theme, Path::new("surface")).expect("installed");
			let geometry = geometry_override.unwrap_or(tokens.surface.transcript);
			state.record_reveal_height(0, 0, 800.0);
			state.set_block_expanded(0, 0, true, &ins.motion, true, Instant::now());
			assert_eq!(
				state.sample_reveal(0, 0, Instant::now() + Duration::from_secs(1)),
				(1.0, true)
			);
			app.new(|_| GeometryTestView {
				state,
				geometry,
				tokens: ins.set,
				motion: ins.motion,
				artifact,
			})
		},
	)
	.expect("rendered view")
}

fn measure_color_box(frame: &RgbaFrame, color: [u8; 4]) -> Option<(u32, u32, u32, u32)> {
	let width = frame.width();
	let height = frame.height();
	let bytes = frame.as_bytes();
	let mut min_x = u32::MAX;
	let mut max_x = 0;
	let mut min_y = u32::MAX;
	let mut max_y = 0;
	let mut found = false;

	for y in 0..height {
		for x in 0..width {
			let idx = ((y * width + x) * 4) as usize;
			if bytes[idx..idx + 4] == color {
				found = true;
				min_x = min_x.min(x);
				max_x = max_x.max(x);
				min_y = min_y.min(y);
				max_y = max_y.max(y);
			}
		}
	}

	if found {
		Some((min_x, min_y, max_x, max_y))
	} else {
		None
	}
}

#[test]
fn tall_image_is_clamped_to_max_height_ceiling_preserving_aspect_ratio() {
	let color = [255, 0, 128, 255];
	// 200x800 tall image (aspect ratio 0.25)
	let png = make_png_with_color(200, 800, color);

	// 1. Artifact::Image
	let image_art = Artifact::Image {
		media_type: "image/png".into(),
		data:       Arc::from(png.clone()),
		alt:        Some("Tall preview".into()),
	};
	let captured = render_expanded_artifact(image_art, None, 768, 600);
	let (min_x, min_y, max_x, max_y) =
		measure_color_box(&captured.frame, color).expect("painted tall image");
	let rendered_w = max_x - min_x + 1;
	let rendered_h = max_y - min_y + 1;

	// Default ceiling is 400px; height must not exceed 400px and width must
	// preserve 0.25 ratio (100px)
	assert!(rendered_h <= 400, "Rendered height {rendered_h} exceeds default ceiling 400px");
	assert!(
		(390..=400).contains(&rendered_h),
		"Rendered height {rendered_h} should clamp near 400px ceiling"
	);
	assert!(
		(95..=105).contains(&rendered_w),
		"Rendered width {rendered_w} should scale with aspect ratio 0.25 to ~100px"
	);

	// 2. Artifact::File with image
	let file_art = Artifact::File {
		path:               "photos/tall.png".into(),
		has_content:        false,
		lines:              None,
		bytes:              Some(png.len() as u64),
		unavailable_reason: None,
		image:              Some(Arc::from(png)),
	};
	let captured_file = render_expanded_artifact(file_art, None, 768, 600);
	let (f_min_x, f_min_y, f_max_x, f_max_y) =
		measure_color_box(&captured_file.frame, color).expect("painted file tall image");
	let f_rendered_w = f_max_x - f_min_x + 1;
	let f_rendered_h = f_max_y - f_min_y + 1;

	assert!(f_rendered_h <= 400, "File embedded height {f_rendered_h} exceeds ceiling");
	assert!(
		(390..=400).contains(&f_rendered_h),
		"File embedded height {f_rendered_h} should clamp near 400px"
	);
	assert!(
		(95..=105).contains(&f_rendered_w),
		"File embedded width {f_rendered_w} should be ~100px"
	);
}

#[test]
fn wide_image_fits_column_width_and_scales_height_proportionally() {
	let color = [0, 200, 255, 255];
	// 1600x400 wide image (aspect ratio 4.0)
	let png = make_png_with_color(1600, 400, color);

	let image_art = Artifact::Image {
		media_type: "image/png".into(),
		data:       Arc::from(png.clone()),
		alt:        Some("Wide banner".into()),
	};
	let captured = render_expanded_artifact(image_art, None, 768, 400);
	let (min_x, min_y, max_x, max_y) =
		measure_color_box(&captured.frame, color).expect("painted wide image");
	let rendered_w = max_x - min_x + 1;
	let rendered_h = max_y - min_y + 1;

	// Viewport is 768px wide; inside container padding (details p-s3 = 6px each
	// side -> 756px max)
	assert!(rendered_w <= 768, "Rendered width {rendered_w} must fit within transcript width 768px");
	assert!(
		(740..=768).contains(&rendered_w),
		"Rendered width {rendered_w} should fill available content width"
	);
	let expected_h = (rendered_w as f32 / 4.0).round() as u32;
	assert!(
		rendered_h.abs_diff(expected_h) <= 5,
		"Rendered height {rendered_h} must match 4:1 aspect ratio expected ~{expected_h}"
	);
	assert!(rendered_h <= 400, "Rendered height {rendered_h} must be within 400px ceiling");

	// Also verify Artifact::File
	let file_art = Artifact::File {
		path:               "diagrams/wide.png".into(),
		has_content:        false,
		lines:              None,
		bytes:              Some(png.len() as u64),
		unavailable_reason: None,
		image:              Some(Arc::from(png)),
	};
	let captured_file = render_expanded_artifact(file_art, None, 768, 400);
	let (f_min_x, f_min_y, f_max_x, f_max_y) =
		measure_color_box(&captured_file.frame, color).expect("painted file wide image");
	let f_rendered_w = f_max_x - f_min_x + 1;
	let f_rendered_h = f_max_y - f_min_y + 1;
	assert!(
		f_rendered_w <= 768,
		"File embedded wide image width {f_rendered_w} must fit within transcript width"
	);
	assert!(
		f_rendered_h <= 400,
		"File embedded wide image height {f_rendered_h} must be within ceiling"
	);
}

#[test]
fn small_image_retains_intrinsic_dimensions_without_upscaling() {
	let color = [255, 180, 0, 255];
	// 64x48 small image (width < 768, height < 400)
	let png = make_png_with_color(64, 48, color);

	let image_art = Artifact::Image {
		media_type: "image/png".into(),
		data:       Arc::from(png.clone()),
		alt:        Some("Small icon".into()),
	};
	let captured = render_expanded_artifact(image_art, None, 768, 300);
	let (min_x, min_y, max_x, max_y) =
		measure_color_box(&captured.frame, color).expect("painted small image");
	let rendered_w = max_x - min_x + 1;
	let rendered_h = max_y - min_y + 1;

	// Intrinsic dimensions 64x48 must be preserved exactly (within 1px edge
	// anti-aliasing)
	assert!(
		(62..=64).contains(&rendered_w),
		"Small image width {rendered_w} must retain intrinsic width 64px"
	);
	assert!(
		(46..=48).contains(&rendered_h),
		"Small image height {rendered_h} must retain intrinsic height 48px"
	);

	// File form
	let file_art = Artifact::File {
		path:               "icons/small.png".into(),
		has_content:        false,
		lines:              None,
		bytes:              Some(png.len() as u64),
		unavailable_reason: None,
		image:              Some(Arc::from(png)),
	};
	let captured_file = render_expanded_artifact(file_art, None, 768, 300);
	let (f_min_x, f_min_y, f_max_x, f_max_y) =
		measure_color_box(&captured_file.frame, color).expect("painted file small image");
	let f_rendered_w = f_max_x - f_min_x + 1;
	let f_rendered_h = f_max_y - f_min_y + 1;
	assert!(
		(62..=64).contains(&f_rendered_w),
		"File small image width {f_rendered_w} must retain intrinsic width 64px"
	);
	assert!(
		(46..=48).contains(&f_rendered_h),
		"File small image height {f_rendered_h} must retain intrinsic height 48px"
	);
}

#[test]
fn non_default_token_height_ceiling_is_enforced_dynamically() {
	let color = [160, 32, 240, 255];
	// 200x800 tall image
	let png = make_png_with_color(200, 800, color);
	let tokens = load_bundled_tokens().expect("tokens");

	// Non-default custom geometry with a strict 150px image height ceiling
	let mut custom_geometry = tokens.surface.transcript;
	custom_geometry.chrome_image_max_height_px = 150.0;

	let image_art = Artifact::Image {
		media_type: "image/png".into(),
		data:       Arc::from(png.clone()),
		alt:        Some("Custom ceiling".into()),
	};
	let captured = render_expanded_artifact(image_art, Some(custom_geometry.clone()), 768, 400);
	let (min_x, min_y, max_x, max_y) =
		measure_color_box(&captured.frame, color).expect("painted custom ceiling image");
	let rendered_w = max_x - min_x + 1;
	let rendered_h = max_y - min_y + 1;

	// Height must be bounded by custom 150px token ceiling
	assert!(rendered_h <= 150, "Rendered height {rendered_h} exceeds custom ceiling 150px");
	assert!(
		(140..=150).contains(&rendered_h),
		"Rendered height {rendered_h} should clamp near custom 150px ceiling"
	);
	// Aspect ratio 0.25 -> 150 * 0.25 = ~37.5px width
	assert!(
		(35..=40).contains(&rendered_w),
		"Rendered width {rendered_w} should scale to ~37.5px for 150px height"
	);

	// File form with custom geometry
	let file_art = Artifact::File {
		path:               "docs/ceiling.png".into(),
		has_content:        false,
		lines:              None,
		bytes:              Some(png.len() as u64),
		unavailable_reason: None,
		image:              Some(Arc::from(png)),
	};
	let captured_file = render_expanded_artifact(file_art, Some(custom_geometry), 768, 400);
	let (f_min_x, f_min_y, f_max_x, f_max_y) =
		measure_color_box(&captured_file.frame, color).expect("painted custom file image");
	let f_rendered_w = f_max_x - f_min_x + 1;
	let f_rendered_h = f_max_y - f_min_y + 1;

	assert!(f_rendered_h <= 150, "File image height {f_rendered_h} exceeds custom ceiling 150px");
	assert!(
		(140..=150).contains(&f_rendered_h),
		"File image height {f_rendered_h} should clamp near 150px"
	);
	assert!((35..=40).contains(&f_rendered_w), "File image width {f_rendered_w} should be ~37.5px");
}
