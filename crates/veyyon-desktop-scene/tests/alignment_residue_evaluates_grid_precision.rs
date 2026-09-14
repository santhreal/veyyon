//! Contract test: alignment residue evaluates grid alignment precision,
//! detects single-coordinate nudges, and handles edge cases gracefully.

use veyyon_desktop_scene::{
	frame::RgbaColor,
	layout::{LayoutBoxSpec, LayoutBoxTreeBuilder},
	metrics::compute_alignment_residue,
};

#[test]
fn test_all_on_grid_tree_yields_zero_residue() {
	let mut builder = LayoutBoxTreeBuilder::new();
	let color = RgbaColor::opaque(10, 10, 10);

	// Grid step 4: all coordinates multiples of 4
	builder.push(None, LayoutBoxSpec::new().rect(0.0, 0.0, 16.0, 32.0).fill(color));
	builder.push(None, LayoutBoxSpec::new().rect(20.0, 4.0, 40.0, 24.0).fill(color));

	let tree = builder.build().expect("tree builds");
	let residue = compute_alignment_residue(&tree, 4);
	assert_eq!(residue, 0.0);
}

#[test]
fn test_single_nudged_coordinate_yields_exact_fraction() {
	let mut builder = LayoutBoxTreeBuilder::new();
	let color = RgbaColor::opaque(10, 10, 10);

	// Box 1: 4 aligned coordinates [0, 0, 16, 16]
	builder.push(None, LayoutBoxSpec::new().rect(0.0, 0.0, 16.0, 16.0).fill(color));

	// Box 2: 3 aligned coordinates, 1 nudged coordinate [17.0, 0.0, 32.0, 16.0]
	// 17.0 % 4.0 = 1.0 (dist 1.0 > 0.01)
	builder.push(None, LayoutBoxSpec::new().rect(17.0, 0.0, 32.0, 16.0).fill(color));

	let tree = builder.build().expect("tree builds");
	let residue = compute_alignment_residue(&tree, 4);

	// 1 misaligned coordinate out of 8 total coordinates = 1/8 = 0.125
	assert_eq!(residue, 0.125);
}

#[test]
fn test_zero_grid_step_returns_zero() {
	let mut builder = LayoutBoxTreeBuilder::new();
	builder.push(
		None,
		LayoutBoxSpec::new()
			.rect(5.0, 7.0, 15.0, 25.0)
			.fill(RgbaColor::opaque(0, 0, 0)),
	);

	let tree = builder.build().expect("tree builds");
	assert_eq!(compute_alignment_residue(&tree, 0), 0.0);
}

#[test]
fn test_empty_tree_returns_zero() {
	let builder = LayoutBoxTreeBuilder::new();
	let tree = builder.build().expect("tree builds");
	assert_eq!(compute_alignment_residue(&tree, 4), 0.0);
}
