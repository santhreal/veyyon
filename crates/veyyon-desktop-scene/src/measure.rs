//! The six metrics of §9.6, taken from what one render actually produced.
//!
//! A capture carries three channels: the quad tree, the shaped text runs and
//! the registered hit rects. Four metrics read the tree and the frame, and two
//! read the channels the tree does not carry - a tree recovered from quads has
//! no text leaves and marks no box interactive, so
//! `compute_distinct_text_sizes` and `compute_element_density` return zero on
//! that path however much text and however many controls the frame holds.
//! Reading the metric off the tree alone therefore reports two absences as
//! measurements of zero and inflates a third, because a gap that spans a line
//! of prose is content rather than rhythm and is suppressed only when the runs
//! are supplied.
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
		ClutterMetrics, Measured, cluster_text_sizes, compute_alignment_residue, compute_edge_count,
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

/// The largest spacing step `scale.toml` authors (s13).
///
/// §9.3 makes a larger authored gap impossible, so a span past it is a layout
/// remainder: the canvas under a short transcript, the rail below its last row.
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

/// The hit rects that are controls the operator can see and press.
///
/// A registered hit rect is not the same thing as a control. Three kinds of
/// rect answer no press:
///
/// - a duplicate, where a tooltip tracks hover over the box its control already
///   occupies;
/// - a container, which holds other hit rects and groups them — the rail row
///   around its actions, the panel body around its rows;
/// - a hidden control, which a hover reveals. gpui inserts its hitbox during
///   prepaint and registers its listeners in paint, and paint returns early for
///   a hidden element, so the rect is live and nothing answers it.
///
/// A hidden control is also the one §6.6 exists to ignore: the ceilings are
/// clutter ceilings, and a control that paints nothing competes for no
/// attention. Seen is read from the frame rather than the tree, because an
/// icon is a path and the recovered tree carries quads: a box holding one flat
/// wash of colour drew nothing, and a control that drew shows at least its
/// glyph against its own ground.
pub fn reachable_controls(captured: &Captured) -> Vec<BoxBounds> {
	let rects: Vec<BoxBounds> = captured
		.hitboxes
		.iter()
		.map(|rect| {
			BoxBounds::new(
				f32::from(rect.origin.x),
				f32::from(rect.origin.y),
				f32::from(rect.origin.x + rect.size.width),
				f32::from(rect.origin.y + rect.size.height),
			)
		})
		.collect();
	let mut reachable = Vec::new();
	for (index, rect) in rects.iter().enumerate() {
		let duplicate = rects.iter().take(index).any(|earlier| earlier == rect);
		if duplicate || holds_another(rect, &rects) || !drew_anything(captured, rect) {
			continue;
		}
		reachable.push(*rect);
	}
	reachable
}

/// True when `rect` holds a hit rect other than a copy of itself.
fn holds_another(rect: &BoxBounds, rects: &[BoxBounds]) -> bool {
	rects.iter().any(|other| {
		other != rect
			&& other.left >= rect.left
			&& other.top >= rect.top
			&& other.right <= rect.right
			&& other.bottom <= rect.bottom
	})
}

/// True when the frame drew more than one colour inside `rect`.
fn drew_anything(captured: &Captured, rect: &BoxBounds) -> bool {
	let scale = captured.frame.scale_factor();
	let left = (rect.left * scale).round().max(0.0) as u32;
	let top = (rect.top * scale).round().max(0.0) as u32;
	let right = (rect.right * scale).round().max(0.0) as u32;
	let bottom = (rect.bottom * scale).round().max(0.0) as u32;
	let mut first = None;
	for y in top..bottom.min(captured.frame.height()) {
		for x in left..right.min(captured.frame.width()) {
			let Some(colour) = captured.frame.pixel(x, y) else {
				continue;
			};
			match first {
				None => first = Some(colour),
				Some(seen) if seen != colour => return true,
				Some(_) => {},
			}
		}
	}
	false
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

/// Measures a capture: each metric from the channel that carries it.
pub fn measure(captured: &Captured, ground: RgbaColor) -> Measured {
	let width = captured.frame.logical_width().round() as u32;
	let height = captured.frame.logical_height().round() as u32;
	// One definition of a control for both columns §6.6 states in controls:
	// the count and the density it is dense at.
	let controls = reachable_controls(captured);
	let centers: Vec<(f32, f32)> = controls
		.iter()
		.map(|rect| (rect.left + rect.width() / 2.0, rect.top + rect.height() / 2.0))
		.collect();

	Measured {
		metrics:     ClutterMetrics {
			distinct_gaps:       rhythm_spans(captured).len(),
			distinct_text_sizes: cluster_text_sizes(&text_sizes(captured)),
			edge_count:          compute_edge_count(&captured.layout, &captured.frame),
			ink_ratio:           compute_ink_ratio(&captured.frame, ground),
			element_density:     element_density_of_centers(&centers, width, height),
			alignment_residue:   compute_alignment_residue(&captured.layout, 4),
		},
		interactive: controls.len(),
	}
}
