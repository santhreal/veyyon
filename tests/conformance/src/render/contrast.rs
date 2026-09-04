//! Relative luminance and contrast ratio, as WCAG 2.1 defines them.
//!
//! The formulas are the published ones and are implemented here rather than
//! taken from a dependency, because this is an oracle: a contrast check that
//! shares code with the product's own colour handling cannot disagree with it,
//! and disagreeing with it is the entire job.
//!
//! Two thresholds, and they are not interchangeable. Text is held to the WCAG
//! AA ratio; a fill has no glyph to read and is held to the far lower floor
//! where a reader can still tell that something was painted. Holding fills to
//! the text ratio would report the whole theme, and holding text to the fill
//! floor would pass grey on grey.

use crate::vpty::cell::ColorRgb;

/// WCAG AA for body text.
pub const TEXT_RATIO: f64 = 4.5;

/// The floor a fill has to clear to be visible against the ground it is painted
/// on — a panel, a rail, a bar segment, a selected row.
///
/// NOT WCAG's non-text minimum of 3.0. Both grounds this crate judges are dark,
/// and against them the product's real fills measure far below that: pure black
/// on the grey ground is 1.30, a subtle panel at `#14161a` is 1.12, and a rail
/// at `#4a4f59` is 1.96. A 3.0 floor would report every one of them, which is a
/// check that reports the theme rather than a defect in it.
///
/// 1.05 is where "a reader cannot see that anything was painted" starts:
/// identical colours are 1.00, and a fill within a few code points of the
/// ground lands under it, while every fill above measures as a visible surface
/// on at least one ground.
pub const FILL_RATIO: f64 = 1.05;

/// Relative luminance, per WCAG 2.1.
///
/// `f64::from` on the channel rather than a cast: a `u8` converts to `f64`
/// exactly, and a cast here would be a lint waiver on an operation that needs
/// none.
#[must_use]
pub fn luminance(color: ColorRgb) -> f64 {
	let channel = |value: u8| {
		let normalized = f64::from(value) / 255.0;
		if normalized <= 0.039_28 {
			normalized / 12.92
		} else {
			((normalized + 0.055) / 1.055).powf(2.4)
		}
	};
	// `mul_add` rather than the plain sum: it is one rounding step instead of
	// three, which matters for a formula whose result is compared against a
	// threshold.
	0.0722f64
		.mul_add(channel(color.b), 0.7152f64.mul_add(channel(color.g), 0.2126 * channel(color.r)))
}

/// The contrast ratio between two colours, from 1.0 (identical) to 21.0 (black
/// against white). Order does not matter.
#[must_use]
pub fn ratio(left: ColorRgb, right: ColorRgb) -> f64 {
	let first = luminance(left);
	let second = luminance(right);
	let (lighter, darker) = if first >= second {
		(first, second)
	} else {
		(second, first)
	};
	(lighter + 0.05) / (darker + 0.05)
}

/// Blend `color` toward `toward`, where `weight` is a 0-255 fraction: 0 keeps
/// `color`, 255 becomes `toward`.
///
/// This is how the dim attribute is modelled below. Terminals implement dim
/// differently and some ignore it; a blend toward the background is the
/// conservative reading, because it is the one that makes text harder to read
/// rather than easier.
///
/// Integer arithmetic on purpose. A float weight would need a rounding cast
/// back to `u8` on every channel, and a cast that "cannot" truncate is still a
/// cast somebody has to check; `(a * (255 - w) + b * w + 127) / 255` is exact
/// in `u16` and lands in `0..=255` by construction.
#[must_use]
pub fn blend(color: ColorRgb, toward: ColorRgb, weight: u8) -> ColorRgb {
	let mix = |from: u8, to: u8| {
		let weight = u16::from(weight);
		let value = (u16::from(from) * (255 - weight) + u16::from(to) * weight + 127) / 255;
		u8::try_from(value).unwrap_or(u8::MAX)
	};
	ColorRgb::new(mix(color.r, toward.r), mix(color.g, toward.g), mix(color.b, toward.b))
}
