//! Contract test: distinct gap computation filters blocked pairs,
//! ignores flush/overlapping boxes, deduplicates integer-rounded values,
//! and evaluates painted extents rather than unpainted wrapper bounds.

use veyyon_desktop_scene::{
	frame::RgbaColor,
	layout::{LayoutBoxSpec, LayoutBoxTreeBuilder},
	metrics::compute_distinct_gaps,
};

#[test]
fn test_three_boxes_in_a_row_rejects_intervening_pair() {
	let mut builder = LayoutBoxTreeBuilder::new();
	let red = RgbaColor::opaque(255, 0, 0);

	// Three boxes in a row: B1 (0..10), B2 (20..30), B3 (40..50)
	// Gap(B1, B2) = 10
	// Gap(B2, B3) = 10
	// Gap(B1, B3) = 30 (blocked by B2)
	builder.push(None, LayoutBoxSpec::new().rect(0.0, 0.0, 10.0, 20.0).fill(red));
	builder.push(None, LayoutBoxSpec::new().rect(20.0, 0.0, 30.0, 20.0).fill(red));
	builder.push(None, LayoutBoxSpec::new().rect(40.0, 0.0, 50.0, 20.0).fill(red));

	let tree = builder.build().expect("tree builds successfully");
	let gaps = compute_distinct_gaps(&tree);

	// Both adjacent pairs have gap = 10 (deduped to 1), and B1->B3 (gap 30) is
	// blocked.
	assert_eq!(gaps, 1);
}

#[test]
fn test_differing_adjacent_gaps_accumulate() {
	let mut builder = LayoutBoxTreeBuilder::new();
	let red = RgbaColor::opaque(255, 0, 0);

	// Three boxes with different adjacent gaps:
	// B1 (0..10), B2 (18..28) -> gap 8
	// B3 (44..54) -> gap 16
	builder.push(None, LayoutBoxSpec::new().rect(0.0, 0.0, 10.0, 20.0).fill(red));
	builder.push(None, LayoutBoxSpec::new().rect(18.0, 0.0, 28.0, 20.0).fill(red));
	builder.push(None, LayoutBoxSpec::new().rect(44.0, 0.0, 54.0, 20.0).fill(red));

	let tree = builder.build().expect("tree builds successfully");
	assert_eq!(compute_distinct_gaps(&tree), 2);
}

#[test]
fn test_flush_pair_contributes_no_gaps() {
	let mut builder = LayoutBoxTreeBuilder::new();
	let blue = RgbaColor::opaque(0, 0, 255);

	// Flush pair: B1 (0..20), B2 (20..40) -> gap = 0.0
	builder.push(None, LayoutBoxSpec::new().rect(0.0, 0.0, 20.0, 20.0).fill(blue));
	builder.push(None, LayoutBoxSpec::new().rect(20.0, 0.0, 40.0, 20.0).fill(blue));

	let tree = builder.build().expect("tree builds successfully");
	assert_eq!(compute_distinct_gaps(&tree), 0);
}

#[test]
fn test_overlapping_pair_contributes_no_gaps() {
	let mut builder = LayoutBoxTreeBuilder::new();
	let blue = RgbaColor::opaque(0, 0, 255);

	// Overlapping pair: B1 (50..70), B2 (60..80) -> gap < 0.0
	builder.push(None, LayoutBoxSpec::new().rect(50.0, 0.0, 70.0, 20.0).fill(blue));
	builder.push(None, LayoutBoxSpec::new().rect(60.0, 0.0, 80.0, 20.0).fill(blue));

	let tree = builder.build().expect("tree builds successfully");
	assert_eq!(compute_distinct_gaps(&tree), 0);
}
#[test]
fn test_unpainted_wrapper_reports_descendant_painted_extent_spacing() {
	let mut builder = LayoutBoxTreeBuilder::new();
	let red = RgbaColor::opaque(255, 0, 0);

	// Two unpainted sibling wrapper containers:
	// Wrapper 1: bounds (0..100, 0..100), but painted child is at (10..40, 10..40)
	// Wrapper 2: bounds (100..200, 0..100), but painted child is at (160..190,
	// 10..40)
	//
	// Raw wrapper distance would be 100 - 100 = 0 (flush).
	// Painted extent gap is 160 - 40 = 120.
	let w1 = builder.push(
		None,
		LayoutBoxSpec::new().rect(0.0, 0.0, 100.0, 100.0), // unpainted
	);
	builder.push(Some(w1), LayoutBoxSpec::new().rect(10.0, 10.0, 40.0, 40.0).fill(red));

	let w2 = builder.push(
		None,
		LayoutBoxSpec::new().rect(100.0, 0.0, 200.0, 100.0), // unpainted
	);
	builder.push(
		Some(w2),
		LayoutBoxSpec::new()
			.rect(160.0, 10.0, 190.0, 40.0)
			.fill(red),
	);

	let tree = builder.build().expect("tree builds successfully");
	let gaps = compute_distinct_gaps(&tree);

	// Should report the 120px gap between the painted extents of the two wrappers.
	assert_eq!(gaps, 1);
}
