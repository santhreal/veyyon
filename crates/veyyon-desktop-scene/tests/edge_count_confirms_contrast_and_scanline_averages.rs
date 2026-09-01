//! Contract test: edge count computes scanline averages across bordered boxes,
//! vertical dividers, and validates that zero-gap fill adjacencies require
//! raster contrast confirmation to be counted as edges.

use veyyon_desktop_scene::{
	frame::{RgbaColor, RgbaFrame},
	layout::{DividerAxis, LayoutBoxSpec, LayoutBoxTreeBuilder},
	metrics::compute_edge_count,
};

#[test]
fn test_bordered_box_yields_exact_expected_scanline_average() {
	let mut builder = LayoutBoxTreeBuilder::new();
	let border_color = RgbaColor::opaque(0, 0, 0);

	// 100x100 logical viewport, box spanning full height from x=10 to x=90
	builder.push(
		None,
		LayoutBoxSpec::new()
			.rect(10.0, 0.0, 90.0, 100.0)
			.border(1.0, border_color),
	);

	let tree = builder.build().expect("tree builds");
	let frame =
		RgbaFrame::filled(100, 100, 1.0, RgbaColor::opaque(255, 255, 255)).expect("frame creates");

	// Every scanline intersects left (10.0) and right (90.0) -> 2.0 edges
	let edges = compute_edge_count(&tree, &frame);
	assert!((edges - 2.0).abs() < 1e-4);
}

#[test]
fn test_vertical_divider_contributes_center_edge() {
	let mut builder = LayoutBoxTreeBuilder::new();

	builder.push(
		None,
		LayoutBoxSpec::new()
			.rect(49.0, 0.0, 51.0, 100.0)
			.divider(DividerAxis::Vertical),
	);

	let tree = builder.build().expect("tree builds");
	let frame =
		RgbaFrame::filled(100, 100, 1.0, RgbaColor::opaque(255, 255, 255)).expect("frame creates");

	// Divider at center x=50.0 on all 100 scanlines -> 1.0 edge
	let edges = compute_edge_count(&tree, &frame);
	assert!((edges - 1.0).abs() < 1e-4);
}

#[test]
fn test_identical_fill_adjacency_is_not_counted_as_edge() {
	let mut builder = LayoutBoxTreeBuilder::new();
	let white = RgbaColor::opaque(255, 255, 255);

	// Two sibling boxes touching at x=50.0 with identical fills
	builder.push(None, LayoutBoxSpec::new().rect(0.0, 0.0, 50.0, 100.0).fill(white));
	builder.push(
		None,
		LayoutBoxSpec::new()
			.rect(50.0, 0.0, 100.0, 100.0)
			.fill(white),
	);

	let tree = builder.build().expect("tree builds");
	// Frame is all white: contrast across boundary at x=50 (pixels 48 vs 52) is 1.0
	// <= 1.2
	let frame = RgbaFrame::filled(100, 100, 1.0, white).expect("frame creates");

	let edges = compute_edge_count(&tree, &frame);
	assert_eq!(edges, 0.0);
}

#[test]
fn test_contrasting_fill_adjacency_is_confirmed_as_edge() {
	let mut builder = LayoutBoxTreeBuilder::new();
	let white = RgbaColor::opaque(255, 255, 255);
	let black = RgbaColor::opaque(0, 0, 0);

	// Two sibling boxes touching at x=50.0 with contrasting fills
	builder.push(None, LayoutBoxSpec::new().rect(0.0, 0.0, 50.0, 100.0).fill(white));
	builder.push(
		None,
		LayoutBoxSpec::new()
			.rect(50.0, 0.0, 100.0, 100.0)
			.fill(black),
	);

	let tree = builder.build().expect("tree builds");

	// Build raster with white left half (0..50) and black right half (50..100)
	let mut pixels = Vec::with_capacity(100 * 100 * 4);
	for _y in 0..100 {
		for x in 0..100 {
			if x < 50 {
				pixels.extend_from_slice(&[255, 255, 255, 255]);
			} else {
				pixels.extend_from_slice(&[0, 0, 0, 255]);
			}
		}
	}
	let frame = RgbaFrame::new(100, 100, 1.0, pixels).expect("frame creates");

	// Contrast ratio across boundary (white vs black) is 21.0 > 1.2 -> 1.0 edge
	let edges = compute_edge_count(&tree, &frame);
	assert!((edges - 1.0).abs() < 1e-4);
}
