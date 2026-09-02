//! Pixel-driven clutter metrics evaluated over [`RgbaFrame`] and
//! [`LayoutBoxTree`].

use crate::{
	frame::{FrameError, PerceptualDiff, RgbaColor, RgbaFrame},
	layout::{DividerAxis, LayoutBoxTree},
};

/// Compute the average number of structural vertical edge boundaries per
/// scanline.
///
/// Collects border edges, vertical dividers, and contrasting hairline fill
/// boundaries across every device scanline.
pub fn compute_edge_count(tree: &LayoutBoxTree, frame: &RgbaFrame) -> f32 {
	// Note: RgbaFrame enforces width > 0 and height > 0 upon construction,
	// so frame.height() is guaranteed non-zero.
	let scale = frame.scale_factor();
	let height = frame.height();
	let sibling_groups = tree.sibling_groups();
	let mut total_edges = 0usize;

	for dev_y in 0..height {
		let logical_y = dev_y as f32 / scale;
		let mut candidates = Vec::new();

		// (a) Box borders with width > 0 and visible color
		// (b) Explicit vertical dividers
		for b in tree.iter() {
			if !b.visible {
				continue;
			}
			if logical_y >= b.bounds.top && logical_y <= b.bounds.bottom {
				if b
					.border
					.is_some_and(|border| border.width > 0.0 && !border.color.is_invisible())
				{
					candidates.push(b.bounds.left);
					candidates.push(b.bounds.right);
				}
				if b.divider == Some(DividerAxis::Vertical) {
					candidates.push(f32::midpoint(b.bounds.left, b.bounds.right));
				}
			}
		}

		// (c) Hairline fill boundaries between horizontally adjacent siblings
		for group in &sibling_groups {
			let count = group.len();
			for i in 0..count {
				let Some(&id1) = group.get(i) else { continue };
				let Some(b1) = tree.get(id1) else { continue };
				if !b1.visible || logical_y < b1.bounds.top || logical_y > b1.bounds.bottom {
					continue;
				}

				for j in 0..count {
					if i == j {
						continue;
					}
					let Some(&id2) = group.get(j) else { continue };
					let Some(b2) = tree.get(id2) else { continue };
					if !b2.visible || logical_y < b2.bounds.top || logical_y > b2.bounds.bottom {
						continue;
					}

					// Adjacent on X with gap of zero (facing edges within 0.5px)
					if (b2.bounds.left - b1.bounds.right).abs() <= 0.5 {
						let edge_x = f32::midpoint(b1.bounds.right, b2.bounds.left);
						if let Some(dev_x) = frame.device_x(edge_x)
							&& dev_x >= 2 && dev_x + 2 < frame.width()
							&& let (Some(p_left), Some(p_right)) =
								(frame.pixel(dev_x - 2, dev_y), frame.pixel(dev_x + 2, dev_y))
							&& p_left.contrast_ratio(&p_right) > 1.2
						{
							candidates.push(edge_x);
						}
					}
				}
			}
		}

		// Deduplicate edge positions within 0.5 logical px
		candidates.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
		let mut scanline_edges = 0usize;
		let mut last_x: Option<f32> = None;

		for x in candidates {
			match last_x {
				None => {
					scanline_edges += 1;
					last_x = Some(x);
				},
				Some(prev) => {
					if x - prev > 0.5 {
						scanline_edges += 1;
						last_x = Some(x);
					}
				},
			}
		}

		total_edges += scanline_edges;
	}

	total_edges as f32 / height as f32
}

/// Compute the contrast-weighted ink ratio over the frame relative to a
/// background ground color.
pub fn compute_ink_ratio(frame: &RgbaFrame, ground: RgbaColor) -> f32 {
	// Note: The sum accumulates continuous luminance deltas (ΔL), not the count
	// of qualifying pixels. Contrast-weighting is what separates dense-with-content
	// (e.g. high-contrast text) from dense-with-decoration (low-contrast tinted
	// surfaces) when evaluated beside edge count.
	let ground_luma = ground.luma_255();
	let total_pixels = (frame.width() as usize).saturating_mul(frame.height() as usize);
	if total_pixels == 0 {
		return 0.0;
	}

	let mut sum_delta = 0.0f32;
	for p in frame.pixels() {
		let composited = p.over(&ground);
		let delta = (composited.luma_255() - ground_luma).abs() / 255.0;
		if delta > 0.02 {
			sum_delta += delta;
		}
	}

	sum_delta / (total_pixels as f32)
}

/// Compute perceptual luminance differences between two frames of identical
/// geometry.
pub fn perceptual_diff(a: &RgbaFrame, b: &RgbaFrame) -> Result<PerceptualDiff, FrameError> {
	if a.width() != b.width() || a.height() != b.height() {
		return Err(FrameError::GeometryMismatch {
			a_width:  a.width(),
			a_height: a.height(),
			b_width:  b.width(),
			b_height: b.height(),
		});
	}

	let total_pixels = (a.width() as usize).saturating_mul(a.height() as usize);
	if total_pixels == 0 {
		return Ok(PerceptualDiff {
			changed_fraction: 0.0,
			mean_delta:       0.0,
			max_delta:        0.0,
		});
	}

	let mut changed_count = 0usize;
	let mut sum_delta = 0.0f32;
	let mut max_delta = 0.0f32;

	for (pa, pb) in a.pixels().zip(b.pixels()) {
		let delta = (pa.luma_255() - pb.luma_255()).abs() / 255.0;
		if delta > 0.02 {
			changed_count += 1;
		}
		sum_delta += delta;
		if delta > max_delta {
			max_delta = delta;
		}
	}

	Ok(PerceptualDiff {
		changed_fraction: changed_count as f32 / total_pixels as f32,
		mean_delta: sum_delta / total_pixels as f32,
		max_delta,
	})
}
