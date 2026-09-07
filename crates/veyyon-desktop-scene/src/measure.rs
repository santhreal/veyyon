//! The six metrics of §9.6, taken from what one render actually produced.
//!
//! A capture carries three channels: the quad tree, the shaped text runs and
//! the registered hit rects. Four metrics read the tree and the frame, and two
//! read the channels the tree does not carry - a tree recovered from quads has
//! no text leaves and marks no box interactive, so `compute_distinct_text_sizes`
//! and `compute_element_density` return zero on that path however much text and
//! however many controls the frame holds. Reading the metric off the tree alone
//! therefore reports two absences as measurements of zero and inflates a third,
//! because a gap that spans a line of prose is content rather than rhythm and
//! is suppressed only when the runs are supplied.
//!
//! This module is where a capture becomes a measurement, so the CLI's report
//! and the width gate read the same numbers from one definition.

use std::{collections::BTreeMap, path::Path};

use veyyon_desktop_tokens::{ColorRole, Theme, TokenError};

use crate::{
	frame::RgbaColor,
	headless::Captured,
	layout::BoxBounds,
	metrics::{
		ClutterMetrics, cluster_text_sizes, compute_alignment_residue, compute_edge_count,
		compute_ink_ratio, element_density_of_centers, gap_spans,
	},
};

/// The theme's ground, as the metrics read it: the colour ink is measured
/// against, so a frame is not scored against a ground it never painted.
pub fn theme_ground(theme: &Theme, surface: &Path) -> Result<RgbaColor, TokenError> {
	let ground = theme.role(surface, ColorRole::Ground)?;
	let channel = |value: f32| (value.clamp(0.0, 1.0) * 255.0).round() as u8;
	Ok(RgbaColor::new(channel(ground.r), channel(ground.g), channel(ground.b), channel(ground.a)))
}

/// The largest spacing step `scale.toml` authors (s13). §9.3 makes a larger
/// authored gap impossible, so a span past it is a layout remainder: the canvas
/// under a short transcript, the rail below its last row.
pub const LARGEST_AUTHORED_STEP: i64 = 64;

/// The shaped runs' line boxes, in logical pixels.
pub fn text_boxes(captured: &Captured) -> Vec<BoxBounds> {
	captured
		.text_runs
		.iter()
		.map(|run| {
			let left = f32::from(run.bounds.origin.x);
			let top = f32::from(run.bounds.origin.y);
			BoxBounds::new(
				left,
				top,
				left + f32::from(run.bounds.size.width),
				top + f32::from(run.bounds.size.height),
			)
		})
		.collect()
}

/// Every shaped run's font size, ascending, as `cluster_text_sizes` requires.
pub fn text_sizes(captured: &Captured) -> Vec<f32> {
	let mut sizes: Vec<f32> = captured
		.text_runs
		.iter()
		.map(|run| f32::from(run.font_size))
		.collect();
	sizes.sort_by(f32::total_cmp);
	sizes
}

/// The centre of every hit rect: the set a click can reach.
pub fn hitbox_centers(captured: &Captured) -> Vec<(f32, f32)> {
	captured
		.hitboxes
		.iter()
		.map(|rect| {
			(
				f32::from(rect.origin.x) + f32::from(rect.size.width) / 2.0,
				f32::from(rect.origin.y) + f32::from(rect.size.height) / 2.0,
			)
		})
		.collect()
}

/// The gaps that are rhythm, with the spans that produced each.
///
/// §6.6 caps the rhythm vocabulary, so two filters keep the count on rhythm and
/// off geometry: a span larger than [`LARGEST_AUTHORED_STEP`] is a remainder
/// rather than a decision, and a value backed by one span is a placement
/// accident - the slack `justify_between` distributes, the margin a centred
/// column leaves - because a rhythm step is reused.
///
/// What this does not catch: an off-scale gap authored once, in one place. The
/// scale lint owns that.
pub fn rhythm_spans(captured: &Captured) -> BTreeMap<i64, Vec<BoxBounds>> {
	let mut spans = gap_spans(&captured.layout, &text_boxes(captured));
	spans.retain(|gap, rects| *gap <= LARGEST_AUTHORED_STEP && rects.len() >= 2);
	spans
}

/// A capture's six metrics, and the interactive count §6.6 caps beside them.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Measured {
	pub metrics:     ClutterMetrics,
	/// Hit rects the frame registered, which is what the interactive ceiling
	/// counts: controls a click reaches, not elements drawn to look like one.
	pub interactive: usize,
}

/// Measures a capture: each metric from the channel that carries it.
pub fn measure(captured: &Captured, ground: RgbaColor) -> Measured {
	let width = captured.frame.logical_width().round() as u32;
	let height = captured.frame.logical_height().round() as u32;

	Measured {
		metrics:     ClutterMetrics {
			distinct_gaps:       rhythm_spans(captured).len(),
			distinct_text_sizes: cluster_text_sizes(&text_sizes(captured)),
			edge_count:          compute_edge_count(&captured.layout, &captured.frame),
			ink_ratio:           compute_ink_ratio(&captured.frame, ground),
			element_density:     element_density_of_centers(
				&hitbox_centers(captured),
				width,
				height,
			),
			alignment_residue:   compute_alignment_residue(&captured.layout, 4),
		},
		interactive: captured.hitboxes.len(),
	}
}
