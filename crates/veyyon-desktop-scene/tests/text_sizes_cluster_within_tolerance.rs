//! Contract test: distinct text sizes cluster within 0.1px tolerance
//! and ignore invisible text nodes.

use veyyon_desktop_scene::{
	layout::{LayoutBoxSpec, LayoutBoxTreeBuilder},
	metrics::compute_distinct_text_sizes,
};

#[test]
fn test_font_sizes_within_point_one_cluster_together() {
	let mut builder = LayoutBoxTreeBuilder::new();

	// 13.0 and 13.05 are within 0.1px -> 1 cluster
	builder.push(None, LayoutBoxSpec::new().text(13.0));
	builder.push(None, LayoutBoxSpec::new().text(13.05));

	let tree = builder.build().expect("tree builds");
	assert_eq!(compute_distinct_text_sizes(&tree), 1);
}

#[test]
fn test_font_sizes_exceeding_point_one_separate() {
	let mut builder = LayoutBoxTreeBuilder::new();

	// 13.0 and 13.2 exceed 0.1px -> 2 clusters
	builder.push(None, LayoutBoxSpec::new().text(13.0));
	builder.push(None, LayoutBoxSpec::new().text(13.2));

	let tree = builder.build().expect("tree builds");
	assert_eq!(compute_distinct_text_sizes(&tree), 2);
}

#[test]
fn test_invisible_text_leaves_are_ignored() {
	let mut builder = LayoutBoxTreeBuilder::new();

	// Visible 14.0, invisible 18.0 and 24.0
	builder.push(None, LayoutBoxSpec::new().text(14.0).visible(true));
	builder.push(None, LayoutBoxSpec::new().text(18.0).visible(false));
	builder.push(None, LayoutBoxSpec::new().text(24.0).visible(false));

	let tree = builder.build().expect("tree builds");
	assert_eq!(compute_distinct_text_sizes(&tree), 1);
}

#[test]
fn test_tree_without_text_returns_zero() {
	let mut builder = LayoutBoxTreeBuilder::new();
	builder.push(None, LayoutBoxSpec::new().rect(0.0, 0.0, 100.0, 100.0));

	let tree = builder.build().expect("tree builds");
	assert_eq!(compute_distinct_text_sizes(&tree), 0);
}
