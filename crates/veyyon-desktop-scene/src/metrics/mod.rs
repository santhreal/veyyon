//! Clutter metrics evaluation suite and report generation.

pub mod ceilings;
pub mod layout;
pub mod raster;

use std::fmt;

pub use ceilings::{
	Ceilings, DENSEST_REGION_CEILING, MetricBreach, SurfaceClass, Verdict, ceilings, check,
};
pub use layout::{
	compute_alignment_residue, compute_distinct_gaps, compute_distinct_text_sizes,
	compute_element_density, count_interactive,
};
pub use raster::{compute_edge_count, compute_ink_ratio, perceptual_diff};

use crate::{
	frame::{RgbaColor, RgbaFrame},
	layout::LayoutBoxTree,
};

/// The six clutter metrics defined in §8.31 / §9.6.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ClutterMetrics {
	pub distinct_gaps:       usize,
	pub distinct_text_sizes: usize,
	pub edge_count:          f32,
	pub ink_ratio:           f32,
	pub element_density:     f32,
	pub alignment_residue:   f32,
}

/// Compute the full suite of six clutter metrics for a rendered frame.
///
/// Viewport dimensions are derived from the frame's logical dimensions.
pub fn compute_metrics(
	tree: &LayoutBoxTree,
	frame: &RgbaFrame,
	ground: RgbaColor,
) -> ClutterMetrics {
	let width = frame.logical_width().round() as u32;
	let height = frame.logical_height().round() as u32;

	ClutterMetrics {
		distinct_gaps:       compute_distinct_gaps(tree),
		distinct_text_sizes: compute_distinct_text_sizes(tree),
		edge_count:          compute_edge_count(tree, frame),
		ink_ratio:           compute_ink_ratio(frame, ground),
		element_density:     compute_element_density(tree, width, height),
		alignment_residue:   compute_alignment_residue(tree, 4),
	}
}

/// Evaluation report pairing computed metrics with surface ceilings and
/// verdict.
#[derive(Clone, Debug, PartialEq)]
pub struct MetricReport {
	pub metrics: ClutterMetrics,
	pub surface: SurfaceClass,
	pub verdict: Verdict,
}

impl MetricReport {
	/// Create a new report by checking the metrics against the specified surface
	/// class.
	pub fn new(metrics: ClutterMetrics, surface: SurfaceClass) -> Self {
		let verdict = check(&metrics, surface);
		Self { metrics, surface, verdict }
	}
}

impl fmt::Display for MetricReport {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		let status = if self.verdict.passed() {
			"PASS"
		} else {
			"FAIL"
		};
		write!(
			f,
			"edges: {:.1} | gaps: {} | text: {} | density: {:.1} | ink: {:.3} | align: {:.1}% [{}]",
			self.metrics.edge_count,
			self.metrics.distinct_gaps,
			self.metrics.distinct_text_sizes,
			self.metrics.element_density,
			self.metrics.ink_ratio,
			self.metrics.alignment_residue * 100.0,
			status,
		)
	}
}
