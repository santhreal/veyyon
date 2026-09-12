//! One surface's own box, taken out of the frame the whole window produced.
//!
//! WHY THIS EXISTS: §6.6 caps eight surface classes and only one of them is
//! the window. The per-surface rows are the tighter half of the table and the
//! half where clutter is decided, because a window is dense when forty
//! surfaces each carry one extra edge rather than because its total is high.
//! Judging a queue row against a row's ceiling therefore needs a measurement
//! of the row, not of the rail it sits in.
//!
//! A scene renders the populated shell, so every surface is measured in the
//! window that actually draws it: at the width the shed resolved, with the
//! neighbours it really has. This module cuts one region out of that capture
//! and hands back a capture as if the region were the whole frame — the pixels
//! cropped, the quads, hit rects and shaped runs it contains translated to the
//! region's origin — so `measure` reads it with no notion of where it came
//! from.
//!
//! Retention is by containment, exclusion and clipping by overlap: a quad the
//! region's own edge cuts is kept as the part inside, because the region is
//! also what the viewport clipped, while a quad that belongs wholly to a
//! neighbour is that neighbour's ink and counting it here would charge one
//! edge to two ceilings.

use veyyon_gpui::{Bounds, Pixels};

use crate::{
	frame::{FrameError, RgbaColor},
	headless::Captured,
	layout::{BoxBounds, BoxId, LayoutBoxSpec, LayoutBoxTree, LayoutBoxTreeBuilder, LayoutError},
};

/// Why a region could not be taken out of a capture.
#[derive(Debug, thiserror::Error)]
pub enum RegionError {
	/// The region is empty, or lies wholly outside the frame.
	#[error("the region {region:?} is not inside the captured frame")]
	Outside { region: BoxBounds },
	/// The frame could not be cropped to the region.
	#[error("the frame does not hold the region: {source}")]
	Crop {
		#[source]
		source: FrameError,
	},
	/// The retained quads did not form a tree.
	#[error("the region's quads do not form a tree: {source}")]
	Tree {
		#[source]
		source: LayoutError,
	},
}

/// The logical box `bounds` covers, as the metrics name boxes.
#[must_use]
pub fn logical_box(bounds: Bounds<Pixels>) -> BoxBounds {
	let left = f32::from(bounds.origin.x);
	let top = f32::from(bounds.origin.y);
	BoxBounds::new(
		left,
		top,
		left + f32::from(bounds.size.width),
		top + f32::from(bounds.size.height),
	)
}

/// True when `inner` lies inside `outer`, to within a pixel of rounding.
///
/// A quad and the region that holds it are both rounded through the same
/// device grid, so an exact comparison drops the boxes that share the
/// region's own edge — which is most of a surface's chrome.
fn contains(outer: &BoxBounds, inner: &BoxBounds) -> bool {
	const SLACK: f32 = 1.0;
	inner.left >= outer.left - SLACK
		&& inner.top >= outer.top - SLACK
		&& inner.right <= outer.right + SLACK
		&& inner.bottom <= outer.bottom + SLACK
}

fn shifted(bounds: BoxBounds, dx: f32, dy: f32) -> BoxBounds {
	BoxBounds::new(bounds.left - dx, bounds.top - dy, bounds.right - dx, bounds.bottom - dy)
}

/// `inner` reduced to the part of it `outer` holds, absent when it holds none.
///
/// A surface scrolled past the viewport's edge, or one whose own text is
/// clipped by it, still draws inside the region: its ink is in the crop, and
/// the part outside belongs to nothing this measurement can see.
fn clipped(outer: &BoxBounds, inner: &BoxBounds) -> Option<BoxBounds> {
	let left = inner.left.max(outer.left);
	let top = inner.top.max(outer.top);
	let right = inner.right.min(outer.right);
	let bottom = inner.bottom.min(outer.bottom);
	(right > left && bottom > top).then(|| BoxBounds::new(left, top, right, bottom))
}

/// True when `inner` lies inside any of `outer`.
fn inside_any(outer: &[BoxBounds], inner: &BoxBounds) -> bool {
	outer.iter().any(|held| contains(held, inner))
}

/// True when `inner` draws into any of `outer`.
///
/// Exclusion is by overlap where retention is by containment: a nested
/// surface's own text, clipped at its edge, crosses into the parent's box, and
/// the nested §6.6 row already caps it.
fn touches_any(outer: &[BoxBounds], inner: &BoxBounds) -> bool {
	outer
		.iter()
		.any(|held| held.overlap_x(inner) > 0.0 && held.overlap_y(inner) > 0.0)
}

/// The quads of `tree` that `region` holds, translated to its origin.
///
/// A retained box keeps its nearest retained ancestor as its parent, so a
/// surface whose wrapper lies outside the region is still one subtree rather
/// than a list of orphans. Arena order is parents before children, so the
/// ancestor's new id is already known when its child is pushed.
fn retained_tree(
	tree: &LayoutBoxTree,
	region: &BoxBounds,
	excluded: &[BoxBounds],
	dx: f32,
	dy: f32,
) -> Result<LayoutBoxTree, LayoutError> {
	let mut builder = LayoutBoxTreeBuilder::new();
	let mut mapped: Vec<Option<BoxId>> = vec![None; tree.len()];

	for laid in tree.iter() {
		if inside_any(excluded, &laid.bounds) {
			continue;
		}
		// A quad crossing the boundary is kept as the part inside, because a
		// region is also what the viewport clipped: a turn scrolled half off
		// the top draws its remaining half here, and dropping the quad would
		// report the surface as holding less ink than it draws.
		let Some(held) = clipped(region, &laid.bounds) else {
			continue;
		};
		let mut parent = laid.parent;
		let mut new_parent = None;
		while let Some(id) = parent {
			if let Some(found) = mapped.get(id.0 as usize).copied().flatten() {
				new_parent = Some(found);
				break;
			}
			parent = tree.get(id).and_then(|ancestor| ancestor.parent);
		}
		let id = builder.push(new_parent, LayoutBoxSpec {
			bounds:      shifted(held, dx, dy),
			visible:     laid.visible,
			interactive: laid.interactive,
			fill:        laid.fill,
			border:      laid.border,
			divider:     laid.divider,
			text:        laid.text,
		});
		if let Some(slot) = mapped.get_mut(laid.id.0 as usize) {
			*slot = Some(id);
		}
	}

	builder.build()
}

/// The part of `captured` that `region` holds, as a capture of its own.
///
/// `region` is in logical pixels, as every box a frame records is.
pub fn within(captured: &Captured, region: Bounds<Pixels>) -> Result<Captured, RegionError> {
	cut(captured, region, &[], RgbaColor::TRANSPARENT)
}

/// The same cut with every box in `nested` painted out in `ground` first.
///
/// A surface that holds another surface with a §6.6 row of its own — a
/// transcript turn holding blocks — is judged over its own chrome, because
/// the nested row already caps what the nested surface spends. Measured
/// whole, the turn's ceiling would have to be the sum of its blocks, and a
/// ceiling that is a sum caps nothing.
pub fn within_excluding(
	captured: &Captured,
	region: Bounds<Pixels>,
	nested: &[Bounds<Pixels>],
	ground: RgbaColor,
) -> Result<Captured, RegionError> {
	let boxes: Vec<BoxBounds> = nested.iter().copied().map(logical_box).collect();
	cut(captured, region, &boxes, ground)
}

/// One region out of `captured`, with `excluded` dropped from every channel
/// and painted over in `blank`.
///
/// The region is reduced to the part of the frame that holds it: a surface the
/// viewport clipped, or one laid out past the top of a scrolled list, is
/// measured over the pixels it drew rather than over whatever the frame holds
/// at a clamped origin.
fn cut(
	captured: &Captured,
	region: Bounds<Pixels>,
	excluded: &[BoxBounds],
	blank: RgbaColor,
) -> Result<Captured, RegionError> {
	let asked = logical_box(region);
	if asked.is_empty() {
		return Err(RegionError::Outside { region: asked });
	}
	let scale = captured.frame.scale_factor();
	let frame_box = BoxBounds::new(
		0.0,
		0.0,
		captured.frame.width() as f32 / scale,
		captured.frame.height() as f32 / scale,
	);
	let Some(logical) = clipped(&frame_box, &asked) else {
		return Err(RegionError::Outside { region: asked });
	};
	let x = (logical.left * scale).round() as u32;
	let y = (logical.top * scale).round() as u32;
	let width = (logical.width() * scale).round().max(1.0) as u32;
	let height = (logical.height() * scale).round().max(1.0) as u32;

	let mut frame = captured
		.frame
		.crop(x, y, width, height)
		.map_err(|source| RegionError::Crop { source })?;

	// The crop is taken on the device grid, so the region's logical origin is
	// the cropped column and row rather than the unrounded box: a half-pixel
	// of rounding here would move every translated box off the grid the
	// alignment metric reads.
	let dx = x as f32 / scale;
	let dy = y as f32 / scale;

	for held in excluded {
		let inner = shifted(*held, dx, dy);
		frame.fill(
			(inner.left * scale).round().max(0.0) as u32,
			(inner.top * scale).round().max(0.0) as u32,
			(inner.width() * scale).round().max(0.0) as u32,
			(inner.height() * scale).round().max(0.0) as u32,
			blank,
		);
	}

	let layout = retained_tree(&captured.layout, &logical, excluded, dx, dy)
		.map_err(|source| RegionError::Tree { source })?;

	// A hit rect and a shaped run are kept as the part inside the region, for
	// the same reason a quad is: a control half under the viewport's edge is
	// still a control the operator reaches, and a run clipped at the surface's
	// own edge still draws its size here.
	let hitboxes = captured
		.hitboxes
		.iter()
		.filter_map(|hit| {
			let held = logical_box(*hit);
			if touches_any(excluded, &held) {
				return None;
			}
			clipped(&logical, &held).map(|held| device_box(shifted(held, dx, dy)))
		})
		.collect();

	let text_runs = captured
		.text_runs
		.iter()
		.filter_map(|run| {
			let held = logical_box(run.bounds);
			if touches_any(excluded, &held) {
				return None;
			}
			clipped(&logical, &held).map(|held| {
				let mut moved = run.clone();
				moved.bounds = device_box(shifted(held, dx, dy));
				moved
			})
		})
		.collect();

	Ok(Captured { frame, layout, hitboxes, text_runs })
}

/// A logical box back in the pixel type every capture channel records.
fn device_box(held: BoxBounds) -> Bounds<Pixels> {
	Bounds {
		origin: veyyon_gpui::point(veyyon_gpui::px(held.left), veyyon_gpui::px(held.top)),
		size:   veyyon_gpui::size(veyyon_gpui::px(held.width()), veyyon_gpui::px(held.height())),
	}
}
