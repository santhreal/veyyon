//! Icon inventory, semantic uniqueness, and SVG rasterization tests (§8.25).

use std::sync::Arc;

use strum::IntoEnumIterator;
use veyyon_desktop_kit::{
	Icon, IconName, IconSize, TokenSet, icon_bytes, validate_icon_uniqueness,
};
use veyyon_gpui::{
	App, Context, HeadlessAppContext, IntoElement, Render, SvgRenderer, Window, div, prelude::*, px,
	size,
};

#[test]
fn all_icons_have_unique_semantic_meanings_and_valid_mappings() {
	assert!(
		validate_icon_uniqueness(),
		"Icon set contains duplicate meanings or unmapped IconName variants"
	);
}

#[test]
fn every_icon_glyph_parses_rasterizes_within_bounds_and_under_opacity_ceiling() {
	let renderer = SvgRenderer::new(Arc::new(()));

	for name in IconName::iter() {
		let bytes = icon_bytes(name);
		let image = renderer
			.render_single_frame(bytes, 1.0)
			.unwrap_or_else(|err| panic!("Failed to parse/render SVG for {name:?}: {err}"));

		let img_size = image.size(0);
		let width = img_size.width.0 as usize;
		let height = img_size.height.0 as usize;
		assert!(width > 0 && height > 0, "{name:?} rendered zero-sized image");

		let raw_bytes = image
			.as_bytes(0)
			.unwrap_or_else(|| panic!("No raw bytes for {name:?}"));

		let total_pixels = width * height;
		let mut non_zero_alpha_count = 0;
		let mut opaque_count = 0;
		let mut min_x = width;
		let mut max_x = 0;
		let mut min_y = height;
		let mut max_y = 0;

		for (i, pixel) in raw_bytes.as_chunks::<4>().0.iter().enumerate() {
			let alpha = pixel[3];
			if alpha > 0 {
				non_zero_alpha_count += 1;
				let x = i % width;
				let y = i / width;
				min_x = min_x.min(x);
				max_x = max_x.max(x);
				min_y = min_y.min(y);
				max_y = max_y.max(y);
			}
			if alpha >= 128 {
				opaque_count += 1;
			}
		}

		// (a) Parsing succeeded (asserted above via unwrap_or_else).
		// (b) At least one pixel with alpha > 0 and at most 60% of pixels opaque.
		assert!(non_zero_alpha_count > 0, "Icon {name:?} rendered completely transparent frame");
		let opaque_ratio = opaque_count as f64 / total_pixels as f64;
		let opaque_percent = opaque_ratio * 100.0;
		assert!(
			opaque_ratio <= 0.60,
			"Icon {name:?} has {opaque_percent:.1}% opaque pixels (exceeds 60% bound; stroke icons \
			 must not be solid fills)"
		);

		// (c) Painted bounding box lies inside the 24-grid with optical margin.
		// Scale factor is 2.0 (SMOOTH_SVG_SCALE_FACTOR), so 48px canvas for a 24-grid.
		let scale_to_grid = 24.0 / width as f64;
		let min_grid_x = min_x as f64 * scale_to_grid;
		let max_grid_x = (max_x + 1) as f64 * scale_to_grid;
		let min_grid_y = min_y as f64 * scale_to_grid;
		let max_grid_y = (max_y + 1) as f64 * scale_to_grid;

		assert!(
			min_grid_x >= 0.0 && max_grid_x <= 24.0,
			"Icon {name:?} x-bounds [{min_grid_x:.1}, {max_grid_x:.1}] exceed 24-grid bounds [0.0, \
			 24.0]"
		);
		assert!(
			min_grid_y >= 0.0 && max_grid_y <= 24.0,
			"Icon {name:?} y-bounds [{min_grid_y:.1}, {max_grid_y:.1}] exceed 24-grid bounds [0.0, \
			 24.0]"
		);
	}
}

struct SingleIconFixture {
	name: IconName,
}

impl Render for SingleIconFixture {
	fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
		div().child(Icon::new(self.name).size(IconSize::Size16))
	}
}

#[test]
fn every_icon_renders_in_headless_frame() -> Result<(), Box<dyn std::error::Error>> {
	let text_system = Arc::new(gpui_wgpu::CosmicTextSystem::new("sans-serif"));
	let mut cx = HeadlessAppContext::with_platform(text_system, Arc::new(()), || {
		gpui_platform::current_headless_renderer()
	});

	let viewport = size(px(40.0), px(40.0));
	let scale_factor = 1.0;

	for name in IconName::iter() {
		let frame = cx.render_frame(viewport, scale_factor, |_window, app: &mut App| {
			app.set_global(TokenSet::default());
			app.new(|_cx| SingleIconFixture { name })
		})?;

		let bytes = frame.as_bytes();
		let mut has_non_transparent = false;
		for pixel in bytes.as_chunks::<4>().0 {
			if pixel[3] > 0 {
				has_non_transparent = true;
				break;
			}
		}
		assert!(has_non_transparent, "Icon {name:?} rendered completely transparent headless frame");
	}

	Ok(())
}
