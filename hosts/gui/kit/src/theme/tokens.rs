//! Numeric visual tokens.
//!
//! Typography, spacing, radii and opacities. The boxes they sit in are in
//! [`super::geometry`]. Product surfaces consume these names and contain no
//! local design literals.
//!
//! A type size is a function, not a constant, because it is multiplied by the
//! interface scale in [`super::scale`]. A ratio, a gap, a radius and an opacity
//! are constants: they are the same at every text size, and scaling a gap makes
//! a narrow window unusable at the size that was supposed to make it readable.

use gpui::FontWeight;

use super::scale::scaled_type;

pub mod size {
	use super::scaled_type;

	const OVERLINE_PX: f32 = 11.0;
	const META_PX: f32 = 12.0;
	const MONO_PX: f32 = 12.5;
	const BODY_PX: f32 = 13.0;
	const LEAD_PX: f32 = 15.0;
	const SECTION_PX: f32 = 20.0;
	const DISPLAY_PX: f32 = 26.0;
	const DISPLAY_LARGE_PX: f32 = 32.0;

	pub fn overline() -> f32 {
		scaled_type(OVERLINE_PX)
	}

	pub fn meta() -> f32 {
		scaled_type(META_PX)
	}

	pub fn mono() -> f32 {
		scaled_type(MONO_PX)
	}

	pub fn body() -> f32 {
		scaled_type(BODY_PX)
	}

	pub fn lead() -> f32 {
		scaled_type(LEAD_PX)
	}

	pub fn section() -> f32 {
		scaled_type(SECTION_PX)
	}

	pub fn display() -> f32 {
		scaled_type(DISPLAY_PX)
	}

	pub fn display_large() -> f32 {
		scaled_type(DISPLAY_LARGE_PX)
	}

	/// The three sizes the appearance page offers, and the one the tokens were
	/// designed at. Read from here rather than written into the settings page,
	/// so the choices and the design values cannot drift apart.
	pub const CHOICES_PX: [f32; 5] = [META_PX, BODY_PX, LEAD_PX, 17.0, SECTION_PX];

	// A line height is a ratio, so it is the same at every text size.
	pub const LINE_CHROME: f32 = 1.25;
	pub const LINE_PROSE: f32 = 1.48;
	pub const LINE_CODE: f32 = 1.55;
}

pub mod weight {
	use super::FontWeight;
	pub const REGULAR: FontWeight = FontWeight::NORMAL;
	pub const MEDIUM: FontWeight = FontWeight::MEDIUM;
	pub const STRONG: FontWeight = FontWeight::SEMIBOLD;
}

pub mod space {
	pub const X2: f32 = 2.0;
	pub const X4: f32 = 4.0;
	pub const X6: f32 = 6.0;
	pub const X8: f32 = 8.0;
	pub const X10: f32 = 10.0;
	pub const X12: f32 = 12.0;
	pub const X16: f32 = 16.0;
	pub const X20: f32 = 20.0;
	pub const X24: f32 = 24.0;
	pub const X32: f32 = 32.0;

	pub const PAIR: f32 = X2;
	pub const ROWS: f32 = X2;
	pub const TIGHT: f32 = X4;
	pub const SNUG: f32 = X6;
	pub const BASE: f32 = X10;
	pub const WIDE: f32 = X16;
	pub const LOOSE: f32 = X20;
	pub const HUGE: f32 = X32;
}

pub mod radius {
	pub const CONTROL: f32 = 4.0;
	pub const ROW: f32 = 6.0;
	pub const CARD: f32 = 6.0;
	pub const POPOVER: f32 = 8.0;
	pub const COMPOSER: f32 = 12.0;
	pub const SHEET: f32 = 12.0;
	pub const PILL: f32 = 999.0;
}

pub mod opacity {
	pub const SCRIM_DARK: f32 = 0.52;
	pub const SCRIM_LIGHT: f32 = 0.32;
	pub const DISABLED: f32 = 0.42;
	pub const PLACEHOLDER: f32 = 0.62;
}
