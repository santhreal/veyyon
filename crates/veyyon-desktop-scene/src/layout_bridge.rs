//! The bridge from a rendered GPUI scene to the box tree the metrics evaluate.
//!
//! A render produces quads in device pixels with no hierarchy; a metric needs
//! logical pixels and a nesting relation. Reconstructing one from the other is
//! its own concern, so it lives beside `layout`, whose tree it builds, rather
//! than inside the renderer that happens to call it.

use veyyon_gpui::{Hsla, Quad};

use crate::{
	frame::RgbaColor,
	layout::{
		BorderPaint, BoxBounds, BoxId, LayoutBoxSpec, LayoutBoxTree, LayoutBoxTreeBuilder,
		LayoutError,
	},
};

/// Converts an HSLA colour to an RGBA8 colour.
fn hsla_to_rgba(hsla: Hsla) -> RgbaColor {
	let rgba = hsla.to_rgb();
	RgbaColor {
		r: (rgba.r * 255.0).round().clamp(0.0, 255.0) as u8,
		g: (rgba.g * 255.0).round().clamp(0.0, 255.0) as u8,
		b: (rgba.b * 255.0).round().clamp(0.0, 255.0) as u8,
		a: (rgba.a * 255.0).round().clamp(0.0, 255.0) as u8,
	}
}

/// Constructs a [`LayoutBoxTree`] from a slice of rendered GPUI [`Quad`]
/// primitives.
///
/// Converts bounds from device pixels (scaled pixels) to logical pixels using
/// `scale_factor`. Coincident quads (such as background fill and border quads
/// emitted by the same element) are merged into a single layout box.
pub fn layout_box_tree_from_quads(
	quads: &[Quad],
	scale_factor: f32,
) -> Result<LayoutBoxTree, LayoutError> {
	if scale_factor <= 0.0 || !scale_factor.is_finite() {
		return LayoutBoxTreeBuilder::new().build();
	}

	let mut specs: Vec<LayoutBoxSpec> = Vec::with_capacity(quads.len());

	for quad in quads {
		let left = quad.bounds.origin.x.0 / scale_factor;
		let top = quad.bounds.origin.y.0 / scale_factor;
		let right = (quad.bounds.origin.x.0 + quad.bounds.size.width.0) / scale_factor;
		let bottom = (quad.bounds.origin.y.0 + quad.bounds.size.height.0) / scale_factor;
		let bounds = BoxBounds::new(left, top, right, bottom);

		if bounds.is_empty() {
			continue;
		}

		let fill = quad
			.background
			.as_solid()
			.filter(|hsla| hsla.a > 0.0)
			.map(hsla_to_rgba);
		let max_border_scaled = quad
			.border_widths
			.top
			.0
			.max(quad.border_widths.right.0)
			.max(quad.border_widths.bottom.0)
			.max(quad.border_widths.left.0);
		let border_width = max_border_scaled / scale_factor;
		let border = if border_width > 0.0 && quad.border_color.a > 0.0 {
			Some(BorderPaint { width: border_width, color: hsla_to_rgba(quad.border_color) })
		} else {
			None
		};

		if fill.is_none() && border.is_none() {
			continue;
		}
		// Merge coincident quads (e.g. background fill and border of the same
		// container)
		if let Some(existing) = specs.iter_mut().find(|s| {
			(s.bounds.left - bounds.left).abs() < 0.01
				&& (s.bounds.top - bounds.top).abs() < 0.01
				&& (s.bounds.right - bounds.right).abs() < 0.01
				&& (s.bounds.bottom - bounds.bottom).abs() < 0.01
		}) {
			if existing.border.is_none() && border.is_some() {
				existing.border = border;
				continue;
			}
			if existing.fill.is_none() && fill.is_some() {
				existing.fill = fill;
				continue;
			}
		}
		specs.push(LayoutBoxSpec {
			bounds,
			visible: true,
			interactive: false,
			fill,
			border,
			divider: None,
			text: None,
		});
	}

	let mut builder = LayoutBoxTreeBuilder::new();
	for (i, spec) in specs.iter().enumerate() {
		let mut best_parent = None;
		let mut min_parent_area = f32::INFINITY;

		for (j, candidate) in specs[..i].iter().enumerate() {
			let encloses = candidate.bounds.left <= spec.bounds.left + 0.5
				&& candidate.bounds.top <= spec.bounds.top + 0.5
				&& candidate.bounds.right >= spec.bounds.right - 0.5
				&& candidate.bounds.bottom >= spec.bounds.bottom - 0.5;

			if encloses {
				let area = candidate.bounds.area();
				if area > spec.bounds.area() + 0.5 && area < min_parent_area {
					min_parent_area = area;
					best_parent = Some(BoxId(j as u32));
				}
			}
		}

		builder.push(best_parent, spec.clone());
	}
	builder.build()
}
