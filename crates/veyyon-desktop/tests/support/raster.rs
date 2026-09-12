//! Device-pixel arithmetic shared by the repaint suites: which pixels two
//! rasters differ in, and whether a device pixel lies inside a logical
//! rectangle at a scale factor.

use veyyon_desktop_scene::RgbaFrame;
use veyyon_gpui::{Bounds, Pixels};

pub fn device_area(logical_area: f64, scale: f64) -> u64 {
	(logical_area * scale * scale).round() as u64
}

/// The device pixels that differ between two rasters of equal size.
pub fn differing_pixels(before: &RgbaFrame, after: &RgbaFrame) -> Vec<(u32, u32)> {
	assert_eq!((before.width(), before.height()), (after.width(), after.height()));
	let width = before.width() as usize;
	before
		.as_bytes()
		.as_chunks::<4>()
		.0
		.iter()
		.zip(after.as_bytes().as_chunks::<4>().0)
		.enumerate()
		.filter(|(_, (a, b))| a != b)
		.map(|(i, _)| ((i % width) as u32, (i / width) as u32))
		.collect()
}

/// Whether a device pixel lies inside a logical rectangle at `scale`. The
/// rectangle is widened to whole device pixels, which is what the renderer's
/// scissor does with a fractional edge.
pub fn inside(rect: &Bounds<Pixels>, scale: f32, x: u32, y: u32) -> bool {
	let left = (f32::from(rect.origin.x) * scale).floor();
	let top = (f32::from(rect.origin.y) * scale).floor();
	let right = ((f32::from(rect.origin.x) + f32::from(rect.size.width)) * scale).ceil();
	let bottom = ((f32::from(rect.origin.y) + f32::from(rect.size.height)) * scale).ceil();
	let (x, y) = (x as f32, y as f32);
	x >= left && x < right && y >= top && y < bottom
}

pub fn contains(outer: &Bounds<Pixels>, inner: &Bounds<Pixels>) -> bool {
	inner.origin.x >= outer.origin.x
		&& inner.origin.y >= outer.origin.y
		&& inner.origin.x + inner.size.width <= outer.origin.x + outer.size.width + Pixels::from(0.01)
		&& inner.origin.y + inner.size.height
			<= outer.origin.y + outer.size.height + Pixels::from(0.01)
}
