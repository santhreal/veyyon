//! Clutter metrics evaluation suite and report generation.

pub mod ceilings;
pub mod layout;
pub mod raster;

use std::fmt;

pub use ceilings::{
	Ceilings, MetricBreach, SurfaceClass, Verdict, ceilings, check, density_ceiling,
};
pub use layout::{
	cluster_text_sizes, compute_alignment_residue, compute_distinct_gaps,
	compute_distinct_text_sizes, compute_element_density, count_interactive, distinct_gap_values,
	element_density_of_centers, gap_spans,
};
pub use raster::{compute_edge_count, compute_ink_ratio, perceptual_diff};
use veyyon_desktop_tokens::CeilingTokens;

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

/// A capture's six metrics, and the interactive count §6.6 caps beside them.
///
/// The pair is one value because a §6.6 row caps both, and a verdict taken on
/// the metrics alone leaves the interactive column unchecked.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Measured {
	pub metrics:     ClutterMetrics,
	/// Hit rects the frame registered, which is what the interactive ceiling
	/// counts: controls a click reaches, not elements drawn to look like one.
	pub interactive: usize,
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

/// Evaluation report pairing a measurement with surface ceilings and verdict.
#[derive(Clone, Debug, PartialEq)]
pub struct MetricReport {
	pub measured: Measured,
	pub surface:  SurfaceClass,
	pub verdict:  Verdict,
}

impl MetricReport {
	/// Create a new report by checking the measurement against the ceilings
	/// `tokens` authors for `surface`.
	#[must_use]
	pub fn new(measured: Measured, surface: SurfaceClass, tokens: &CeilingTokens) -> Self {
		let verdict = check(&measured, surface, tokens);
		Self { measured, surface, verdict }
	}
}

impl fmt::Display for MetricReport {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		let status = if self.verdict.passed() {
			"PASS"
		} else {
			"FAIL"
		};
		let m = &self.measured.metrics;
		write!(
			f,
			"edges: {:.1} | gaps: {} | text: {} | controls: {} | density: {:.1} | ink: {:.3} | \
			 align: {:.1}% [{}]",
			m.edge_count,
			m.distinct_gaps,
			m.distinct_text_sizes,
			self.measured.interactive,
			m.element_density,
			m.ink_ratio,
			m.alignment_residue * 100.0,
			status,
		)
	}
}
