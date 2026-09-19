//! The one conversion between an authored colour and a drawn one.
//!
//! A theme file states a colour in linear RGB and the renderer takes HSLA, so
//! the conversion is here rather than at each role that resolves one.

use veyyon_desktop_tokens::RgbColor;
use veyyon_gpui::Hsla;

/// Converts linear RGB color to GPUI HSLA representation.
#[allow(
	clippy::many_single_char_names,
	reason = "r, g, b, h, s and l are the colour components this conversion is named for"
)]
pub fn rgb_to_hsla(rgb: RgbColor) -> Hsla {
	let (r, g, b) = (rgb.r, rgb.g, rgb.b);
	let (min, max) = (r.min(g.min(b)), r.max(g.max(b)));
	let delta = max - min;
	let l = f32::midpoint(max, min);
	let s = if delta == 0.0 {
		0.0
	} else if l < 0.5 {
		delta / (max + min)
	} else {
		delta / (2.0 - max - min)
	};
	let h = if delta == 0.0 {
		0.0
	} else if (max - r).abs() < f32::EPSILON {
		let mut h = (g - b) / delta;
		if h < 0.0 {
			h += 6.0;
		}
		h / 6.0
	} else if (max - g).abs() < f32::EPSILON {
		((b - r) / delta + 2.0) / 6.0
	} else {
		((r - g) / delta + 4.0) / 6.0
	};
	Hsla { h, s, l, a: rgb.a }
}
