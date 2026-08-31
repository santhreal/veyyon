//! Interpolation: a number, and a colour.

use gpui::{Hsla, Rgba};

/// Straight-line interpolation.
pub fn lerp(from: f32, to: f32, t: f32) -> f32 {
	from + (to - from) * t
}

/// Blend two colours the way a browser transitions them: component
/// interpolation with premultiplied alpha.
///
/// Premultiplied is the whole point. A wash fading in from transparent black
/// interpolated naively passes through grey, so a white hover on a dark row
/// dims before it brightens.
pub fn mix(from: Hsla, to: Hsla, t: f32) -> Hsla {
	let t = t.clamp(0.0, 1.0);
	if t <= 0.0 {
		return from;
	}
	if t >= 1.0 {
		return to;
	}
	let (start, end) = (Rgba::from(from), Rgba::from(to));
	let a = lerp(start.a, end.a, t);
	if a <= f32::EPSILON {
		return Hsla::from(Rgba { a: 0.0, ..end });
	}
	Hsla::from(Rgba {
		r: lerp(start.r * start.a, end.r * end.a, t) / a,
		g: lerp(start.g * start.a, end.g * end.a, t) / a,
		b: lerp(start.b * start.a, end.b * end.a, t) / a,
		a,
	})
}
