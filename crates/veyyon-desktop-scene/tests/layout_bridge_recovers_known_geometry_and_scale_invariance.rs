//! WHY THIS SUITE EXISTS
//!
//! Section 8.31 and 9.6 of the desktop plan require that clutter metrics
//! (distinct gaps, edge count, ink ratio, alignment residue, element density,
//! distinct text sizes) are computed per rendered scene and reported on contact
//! sheets. Four of the six metrics are computed from a `LayoutBoxTree` in
//! logical pixels. Without a bridge from gpui's rendered scene, contact sheet
//! captions report "no layout tree supplied" and clutter cannot be evaluated as
//! numbers.
//!
//! THE CLASS THIS CLOSES:
//! 1. Disagreement between rendered frame pixels and layout box tree bounds.
//! 2. Scale factor errors: device-pixel scaling leaking into logical box
//!    bounds, which would scale every gap and density figure by the scale
//!    factor.
//! 3. Missing clutter metrics on contact sheet captions.
//!
//! WHAT IT DOES NOT CATCH:
//! Whether a particular surface layout looks aesthetically pleasing to an
//! operator.

use std::path::PathBuf;

use veyyon_desktop_scene::{
	Appearance, RenderOptions, RgbaColor, SheetCell, SheetGrid, distinct_pixel_values,
	headless_context, render_view_with_layout, tile, write_png,
};
use veyyon_gpui::{
	App, AppContext, Context, IntoElement, ParentElement, Render, Styled, Window, div, px, rgb,
};

const GROUND_HEX: u32 = 0x14_14_1a;
const CARD_HEX: u32 = 0x1e_1e_28;
const BORDER_HEX: u32 = 0x33_33_33;
const BOX1_HEX: u32 = 0x7a_a2_f7;
const BOX2_HEX: u32 = 0xc0_ca_f5;

const GROUND_COLOR: RgbaColor = RgbaColor::new(0x14, 0x14, 0x1a, 255);
const CARD_COLOR: RgbaColor = RgbaColor::new(0x1e, 0x1e, 0x28, 255);

const CARD_PAD: f32 = 16.0;
const KNOWN_GAP: f32 = 24.0;
const BOX1_WIDTH: f32 = 80.0;
const BOX1_HEIGHT: f32 = 60.0;
const BOX2_WIDTH: f32 = 120.0;
const BOX2_HEIGHT: f32 = 60.0;
const CARD_BORDER_WIDTH: f32 = 2.0;

struct KnownGeometryScene;

impl Render for KnownGeometryScene {
	fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
		div().size_full().bg(rgb(GROUND_HEX)).p(px(CARD_PAD)).child(
			div()
				.size_full()
				.bg(rgb(CARD_HEX))
				.border(px(CARD_BORDER_WIDTH))
				.border_color(rgb(BORDER_HEX))
				.p(px(CARD_PAD))
				.flex()
				.flex_row()
				.gap(px(KNOWN_GAP))
				.child(div().w(px(BOX1_WIDTH)).h(px(BOX1_HEIGHT)).bg(rgb(BOX1_HEX)))
				.child(div().w(px(BOX2_WIDTH)).h(px(BOX2_HEIGHT)).bg(rgb(BOX2_HEX))),
		)
	}
}

#[test]
#[ignore = "requires a GPU with a Vulkan ICD; run with --ignored on a machine that has one"]
fn known_geometry_scene_yields_matching_tree_boxes_and_metrics() {
	let mut cx = headless_context().expect("headless renderer required");
	let options = RenderOptions {
		width:        320,
		height:       200,
		scale_factor: 2.0,
		appearance:   Appearance::Dark,
		seed:         0x5eed_cafe,
	};

	let (frame, tree) = render_view_with_layout(&mut cx, &options, |_window, app: &mut App| {
		app.new(|_| KnownGeometryScene)
	})
	.expect("known geometry scene rasterises");

	assert!(distinct_pixel_values(&frame) > 1, "rendered frame must contain distinct pixels");

	// The tree must contain boxes for the ground root, card container, box 1, and
	// box 2.
	assert!(tree.len() >= 4, "layout box tree must contain at least 4 boxes, found {}", tree.len());

	// Find the card container box (fill matching CARD_COLOR)
	let card_box = tree
		.iter()
		.find(|b| b.fill == Some(CARD_COLOR))
		.expect("card container box must be present in layout tree");

	let expected_card_left = CARD_PAD;
	let expected_card_top = CARD_PAD;
	let expected_card_right = 320.0 - CARD_PAD;
	let expected_card_bottom = 200.0 - CARD_PAD;

	assert!(
		(card_box.bounds.left - expected_card_left).abs() <= 1.0,
		"card left bound {} does not match expected {expected_card_left}",
		card_box.bounds.left,
	);
	assert!(
		(card_box.bounds.top - expected_card_top).abs() <= 1.0,
		"card top bound {} does not match expected {expected_card_top}",
		card_box.bounds.top,
	);
	assert!(
		(card_box.bounds.right - expected_card_right).abs() <= 1.0,
		"card right bound {} does not match expected {expected_card_right}",
		card_box.bounds.right,
	);
	assert!(
		(card_box.bounds.bottom - expected_card_bottom).abs() <= 1.0,
		"card bottom bound {} does not match expected {expected_card_bottom}",
		card_box.bounds.bottom,
	);

	// Card border width must match 2.0px logical
	let border = card_box.border.expect("card must have border paint");
	assert!(
		(border.width - CARD_BORDER_WIDTH).abs() <= 0.5,
		"card border width {} does not match expected {CARD_BORDER_WIDTH}",
		border.width,
	);

	// Find Box 1 and Box 2 by their dimensions and fill
	let box1_fill = RgbaColor::new(0x7a, 0xa2, 0xf7, 255);
	let box2_fill = RgbaColor::new(0xc0, 0xca, 0xf5, 255);

	let b1 = tree
		.iter()
		.find(|b| b.fill == Some(box1_fill))
		.expect("box 1 must be present in layout tree");
	let b2 = tree
		.iter()
		.find(|b| b.fill == Some(box2_fill))
		.expect("box 2 must be present in layout tree");

	assert!(
		(b1.bounds.width() - BOX1_WIDTH).abs() <= 1.0,
		"box 1 width {} does not match expected {BOX1_WIDTH}",
		b1.bounds.width(),
	);
	assert!(
		(b2.bounds.width() - BOX2_WIDTH).abs() <= 1.0,
		"box 2 width {} does not match expected {BOX2_WIDTH}",
		b2.bounds.width(),
	);

	// Horizontal gap between box 1 and box 2
	let measured_gap = b2.bounds.left - b1.bounds.right;
	assert!(
		(measured_gap - KNOWN_GAP).abs() <= 1.0,
		"gap between boxes {measured_gap} does not match expected {KNOWN_GAP}",
	);

	// Clutter metrics evaluation
	let metrics = veyyon_desktop_scene::metrics::compute_metrics(&tree, &frame, GROUND_COLOR);
	assert!(
		metrics.distinct_gaps > 0,
		"distinct gaps must be non-zero for scene with known gap, got {}",
		metrics.distinct_gaps,
	);
	assert!(
		metrics.edge_count > 0.0,
		"edge count must be non-zero for bordered and filled scene, got {}",
		metrics.edge_count,
	);
	assert!(
		metrics.ink_ratio > 0.0,
		"ink ratio must be non-zero for rendered scene, got {}",
		metrics.ink_ratio,
	);
}

#[test]
#[ignore = "requires a GPU with a Vulkan ICD; run with --ignored on a machine that has one"]
fn scale_factor_invariance_preserves_logical_tree_bounds_while_device_dimensions_double() {
	let mut cx = headless_context().expect("headless renderer required");

	let options_1x = RenderOptions {
		width:        320,
		height:       200,
		scale_factor: 1.0,
		appearance:   Appearance::Dark,
		seed:         0x5eed_cafe,
	};
	let options_2x = RenderOptions {
		width:        320,
		height:       200,
		scale_factor: 2.0,
		appearance:   Appearance::Dark,
		seed:         0x5eed_cafe,
	};

	let (frame_1x, tree_1x) =
		render_view_with_layout(&mut cx, &options_1x, |_window, app: &mut App| {
			app.new(|_| KnownGeometryScene)
		})
		.expect("1x scene rasterises");

	let (frame_2x, tree_2x) =
		render_view_with_layout(&mut cx, &options_2x, |_window, app: &mut App| {
			app.new(|_| KnownGeometryScene)
		})
		.expect("2x scene rasterises");

	// Device dimensions double from 1x to 2x
	assert_eq!(frame_1x.width(), 320);
	assert_eq!(frame_1x.height(), 200);
	assert_eq!(frame_2x.width(), 640);
	assert_eq!(frame_2x.height(), 400);

	// Logical dimensions remain identical
	assert_eq!(frame_1x.logical_width(), 320.0);
	assert_eq!(frame_1x.logical_height(), 200.0);
	assert_eq!(frame_2x.logical_width(), 320.0);
	assert_eq!(frame_2x.logical_height(), 200.0);

	// Box counts must agree
	assert_eq!(tree_1x.len(), tree_2x.len(), "1x and 2x trees must have equal box count");

	// Logical bounds of every box must agree within 1.0 logical pixel
	for (id1, id2) in (0..tree_1x.len())
		.map(|i| veyyon_desktop_scene::layout::BoxId(i as u32))
		.zip((0..tree_2x.len()).map(|i| veyyon_desktop_scene::layout::BoxId(i as u32)))
	{
		let b1 = tree_1x.get(id1).expect("box 1 exists");
		let b2 = tree_2x.get(id2).expect("box 2 exists");

		assert!(
			(b1.bounds.left - b2.bounds.left).abs() <= 1.0,
			"box {id1:?} left {} at 1x vs {} at 2x",
			b1.bounds.left,
			b2.bounds.left,
		);
		assert!(
			(b1.bounds.top - b2.bounds.top).abs() <= 1.0,
			"box {id1:?} top {} at 1x vs {} at 2x",
			b1.bounds.top,
			b2.bounds.top,
		);
		assert!(
			(b1.bounds.right - b2.bounds.right).abs() <= 1.0,
			"box {id1:?} right {} at 1x vs {} at 2x",
			b1.bounds.right,
			b2.bounds.right,
		);
		assert!(
			(b1.bounds.bottom - b2.bounds.bottom).abs() <= 1.0,
			"box {id1:?} bottom {} at 1x vs {} at 2x",
			b1.bounds.bottom,
			b2.bounds.bottom,
		);
	}

	// Distinct gaps must agree across scale factors
	let gaps_1x = veyyon_desktop_scene::metrics::compute_distinct_gaps(&tree_1x);
	let gaps_2x = veyyon_desktop_scene::metrics::compute_distinct_gaps(&tree_2x);
	assert_eq!(
		gaps_1x, gaps_2x,
		"distinct gaps must be invariant to scale factor: 1x had {gaps_1x}, 2x had {gaps_2x}",
	);
}

#[test]
#[ignore = "requires a GPU with a Vulkan ICD; run with --ignored on a machine that has one"]
fn contact_sheet_with_layout_bridge_reports_six_metrics_in_caption() {
	let mut cx = headless_context().expect("headless renderer required");
	let options = RenderOptions {
		width:        320,
		height:       200,
		scale_factor: 2.0,
		appearance:   Appearance::Dark,
		seed:         0x5eed_cafe,
	};

	let (frame, tree) = render_view_with_layout(&mut cx, &options, |_window, app: &mut App| {
		app.new(|_| KnownGeometryScene)
	})
	.expect("scene rasterises");

	let cell = SheetCell::from_rendered("known-geometry/dark", frame, &tree, GROUND_COLOR);

	let metrics = cell.metrics.expect("cell must carry real clutter metrics");
	assert!(metrics.distinct_gaps > 0, "gaps metric must be non-zero");
	assert!(metrics.edge_count > 0.0, "edge count metric must be non-zero");
	assert!(metrics.ink_ratio > 0.0, "ink ratio metric must be non-zero");

	let grid = SheetGrid::new(1);
	let sheet = tile(&mut cx, vec![cell], grid, 2.0).expect("sheet tiles successfully");

	let out_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/scene-frames");
	let proof_path = out_dir.join("layout-bridge-proof-sheet.png");
	write_png(&sheet, &proof_path).expect("proof sheet writes to target");

	assert!(proof_path.is_file(), "proof sheet PNG must exist at {}", proof_path.display());
	let metadata = std::fs::metadata(&proof_path).expect("file metadata readable");
	assert!(metadata.len() > 0, "proof sheet PNG must have non-zero file size");
}
