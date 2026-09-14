//! Contract test: element density identifies the densest 100x100 region
//! via sliding sample windows rather than reporting the whole-frame average.

use veyyon_desktop_scene::{
	layout::{LayoutBoxSpec, LayoutBoxTreeBuilder},
	metrics::{compute_element_density, count_interactive},
};

#[test]
fn test_crowded_corner_is_isolated_from_sparse_viewport() {
	let mut builder = LayoutBoxTreeBuilder::new();

	// Place 15 interactive elements packed inside the top-left [0..80, 0..80]
	// region
	for i in 0..15 {
		let x = ((i % 4) as f32).mul_add(18.0, 2.0);
		let y = ((i / 4) as f32).mul_add(18.0, 2.0);
		builder.push(
			None,
			LayoutBoxSpec::new()
				.rect(x, y, x + 10.0, y + 10.0)
				.interactive(true),
		);
	}

	let tree = builder.build().expect("tree builds");
	assert_eq!(count_interactive(&tree), 15);
	// Large 1000x1000 viewport (46x46 = 2116 sliding windows at stride 20)
	let density = compute_element_density(&tree, 1000, 1000);

	// The (0, 0) window contains all 15 elements, and adjacent overlapping windows
	// capture portions of the cluster, giving a top-10 mean of 7.5.
	// Over the 2,116 total windows in the frame, the whole-frame average is ~0.035.
	// The top-10 density (7.5) isolates the crowded corner (>200x whole-frame
	// average).
	assert!(density >= 7.0, "expected dense cluster >= 7.0, got {density}");
}

#[test]
fn test_no_interactive_elements_returns_zero() {
	let mut builder = LayoutBoxTreeBuilder::new();
	builder.push(
		None,
		LayoutBoxSpec::new()
			.rect(0.0, 0.0, 200.0, 200.0)
			.interactive(false),
	);

	let tree = builder.build().expect("tree builds");
	assert_eq!(count_interactive(&tree), 0);
	assert_eq!(compute_element_density(&tree, 500, 500), 0.0);
}
