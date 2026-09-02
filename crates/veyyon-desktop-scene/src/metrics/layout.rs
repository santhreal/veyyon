//! Tree-driven clutter metrics evaluated directly on [`LayoutBoxTree`].

use std::collections::BTreeSet;

use crate::layout::{BoxBounds, LayoutBoxTree};

/// Compute the number of distinct spacing values between visually adjacent
/// elements.
///
/// WHY PAINTED EXTENTS: §9.6 defines the metric as spacing between adjacent
/// *painted* elements. In modern UI trees, unpainted wrapper containers and
/// flex layout boxes frequently structure hierarchy without rendering ink.
/// Measuring raw box bounds would report gaps between invisible wrappers
/// that a user cannot see. Measuring painted extents accurately reflects the
/// visual rhythm perceived on screen.
pub fn compute_distinct_gaps(tree: &LayoutBoxTree) -> usize {
	distinct_gap_values(tree, &[]).len()
}

/// The distinct gap values themselves, so a gate that fails the count can
/// name the values that overspent it.
///
/// `text` carries the shaped runs' line boxes when the tree was recovered
/// from a painted frame: a quad tree holds fills and borders only, and a gap
/// that spans a line of prose is content, not rhythm, so a run that overlaps
/// the span suppresses it the same way an intervening box does.
pub fn distinct_gap_values(tree: &LayoutBoxTree, text: &[BoxBounds]) -> BTreeSet<i64> {
	gap_spans(tree, text).keys().copied().collect()
}

/// Every measured gap with the spans that produced it, so a gate can count
/// the values and, when one overspends a ceiling, attribute it to the places
/// it came from. Identical spans are counted once: the pair loop sees one
/// physical gap through every member that shares an edge with it, so a raw
/// map would hold the same rect several times.
pub fn gap_spans(
	tree: &LayoutBoxTree,
	text: &[BoxBounds],
) -> std::collections::BTreeMap<i64, Vec<BoxBounds>> {
	let mut distinct_gaps: std::collections::BTreeMap<i64, Vec<BoxBounds>> =
		std::collections::BTreeMap::new();

	for group in tree.sibling_groups() {
		// Collect painted extents for all siblings in the group
		let members: Vec<(crate::layout::BoxId, BoxBounds)> = group
			.iter()
			.filter_map(|&id| tree.painted_extent(id).map(|ext| (id, ext)))
			.collect();

		let count = members.len();
		for i in 0..count {
			let (id1, b1) = match members.get(i) {
				Some(m) => *m,
				None => continue,
			};

			for j in 0..count {
				if i == j {
					continue;
				}
				let (id2, b2) = match members.get(j) {
					Some(m) => *m,
					None => continue,
				};

				// Horizontal gap candidate: b1 on left, b2 on right, overlapping on Y
				let overlap_y = b1.overlap_y(&b2);
				if overlap_y > 0.0 && b2.left >= b1.right {
					let gap = b2.left - b1.right;
					if gap > 0.0 {
						let gap_rect = BoxBounds::new(
							b1.right,
							b1.top.max(b2.top),
							b2.left,
							b1.bottom.min(b2.bottom),
						);

						let has_intervening = members
							.iter()
							.any(|&(id3, b3)| id3 != id1 && id3 != id2 && b3.intersects(&gap_rect))
							|| text.iter().any(|run| run.intersects(&gap_rect));

						if !has_intervening {
							let rounded = gap.round() as i64;
							if rounded > 0 {
								distinct_gaps.entry(rounded).or_default().push(gap_rect);
							}
						}
					}
				}

				// Vertical gap candidate: b1 on top, b2 on bottom, overlapping on X
				let overlap_x = b1.overlap_x(&b2);
				if overlap_x > 0.0 && b2.top >= b1.bottom {
					let gap = b2.top - b1.bottom;
					if gap > 0.0 {
						let gap_rect = BoxBounds::new(
							b1.left.max(b2.left),
							b1.bottom,
							b1.right.min(b2.right),
							b2.top,
						);

						let has_intervening = members
							.iter()
							.any(|&(id3, b3)| id3 != id1 && id3 != id2 && b3.intersects(&gap_rect))
							|| text.iter().any(|run| run.intersects(&gap_rect));

						if !has_intervening {
							let rounded = gap.round() as i64;
							if rounded > 0 {
								distinct_gaps.entry(rounded).or_default().push(gap_rect);
							}
						}
					}
				}
			}
		}
	}

	for spans in distinct_gaps.values_mut() {
		spans.sort_by_key(|span| {
			(span.left as i64, span.top as i64, span.right as i64, span.bottom as i64)
		});
		spans.dedup_by_key(|span| {
			(span.left as i64, span.top as i64, span.right as i64, span.bottom as i64)
		});
	}

	distinct_gaps
}

/// Compute the count of distinct rendered text font sizes.
///
/// Font sizes are clustered within a 0.1px tolerance.
pub fn compute_distinct_text_sizes(tree: &LayoutBoxTree) -> usize {
	let mut sizes: Vec<f32> = tree
		.text_leaves()
		.filter_map(|b| b.text.as_ref().map(|t| t.font_size))
		.collect();

	if sizes.is_empty() {
		return 0;
	}

	sizes.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
	cluster_text_sizes(&sizes)
}

/// The number of distinct sizes in a sorted list, clustered within the 0.1px
/// tolerance `compute_distinct_text_sizes` uses. Shared with gates whose text
/// comes from a frame's shaped runs rather than a tree's text leaves.
pub fn cluster_text_sizes(sizes: &[f32]) -> usize {
	let mut cluster_count = 0;
	let mut current_rep: Option<f32> = None;

	for &size in sizes {
		match current_rep {
			None => {
				cluster_count = 1;
				current_rep = Some(size);
			},
			Some(rep) => {
				if size > rep + 0.1 {
					cluster_count += 1;
					current_rep = Some(size);
				}
			},
		}
	}

	cluster_count
}

/// Total count of visible interactive elements in the tree.
pub fn count_interactive(tree: &LayoutBoxTree) -> usize {
	tree.interactive_boxes().count()
}

/// Compute interactive element density across 100x100px sliding windows at
/// stride 20.
///
/// Returns the arithmetic mean of the top 10 densest window regions, or 0.0
/// if no interactive boxes exist.
pub fn compute_element_density(tree: &LayoutBoxTree, width: u32, height: u32) -> f32 {
	let centers: Vec<(f32, f32)> = tree
		.interactive_boxes()
		.map(|b| b.bounds.center())
		.collect();

	element_density_of_centers(&centers, width, height)
}

/// The density over an arbitrary center set, for gates whose interactive
/// elements come from a frame's hit rects rather than a tree's interactive
/// boxes (the quad-recovery path marks none).
pub fn element_density_of_centers(centers: &[(f32, f32)], width: u32, height: u32) -> f32 {
	if centers.is_empty() {
		return 0.0;
	}

	let max_x = width.saturating_sub(100);
	let x_positions: Vec<f32> = if width <= 100 {
		vec![0.0]
	} else {
		(0..=max_x).step_by(20).map(|x| x as f32).collect()
	};

	let max_y = height.saturating_sub(100);
	let y_positions: Vec<f32> = if height <= 100 {
		vec![0.0]
	} else {
		(0..=max_y).step_by(20).map(|y| y as f32).collect()
	};

	let mut window_counts = Vec::with_capacity(x_positions.len() * y_positions.len());

	for &wx in &x_positions {
		for &wy in &y_positions {
			let right = wx + 100.0;
			let bottom = wy + 100.0;
			let mut count = 0usize;
			for &(cx, cy) in centers {
				if cx >= wx && cx < right && cy >= wy && cy < bottom {
					count += 1;
				}
			}
			window_counts.push(count);
		}
	}

	if window_counts.is_empty() {
		return 0.0;
	}

	window_counts.sort_by(|a, b| b.cmp(a));

	let top_sample_count = window_counts.len().min(10);
	let sum: usize = window_counts.iter().take(top_sample_count).sum();

	sum as f32 / top_sample_count as f32
}

/// Compute the fraction of painted bounding box coordinates that fall off the
/// layout grid.
///
/// Coordinates within 0.01px of a multiple of `grid_step` are aligned.
pub fn compute_alignment_residue(tree: &LayoutBoxTree, grid_step: u32) -> f32 {
	// grid_step == 0 means no grid exists, so alignment residue is undefined/zero
	// rather than dividing by zero.
	if grid_step == 0 {
		return 0.0;
	}

	let step = grid_step as f32;
	let mut total_coords = 0usize;
	let mut misaligned_coords = 0usize;

	for b in tree.painted_boxes() {
		let coords = [b.bounds.left, b.bounds.top, b.bounds.right, b.bounds.bottom];
		for &c in &coords {
			total_coords += 1;
			let rem = c.rem_euclid(step);
			let dist = rem.min(step - rem);
			if dist > 0.01 {
				misaligned_coords += 1;
			}
		}
	}

	if total_coords == 0 {
		return 0.0;
	}

	misaligned_coords as f32 / total_coords as f32
}
