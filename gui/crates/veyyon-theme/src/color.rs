//! Colour parsing and the two luminance measures, matching
//! `@veyyon/utils/color`.
//!
//! A theme file states a colour three ways: a hex string, a 256-colour palette
//! index, or the name of an entry in the file's `vars` block. The first two are
//! resolved here; the third is resolved in [`crate::file`], which is what holds
//! the `vars` block.
//!
//! The arithmetic matches the TypeScript because both front ends classify and
//! tint the same theme file, and a light theme that the terminal reads as light
//! and the GUI reads as dark picks different text colours for the same
//! background.

use std::cmp::Ordering;

use gpui::{Hsla, Rgba};

/// A colour with 8 bits per channel, as a theme file writes it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Srgb {
	pub r: u8,
	pub g: u8,
	pub b: u8,
	/// Fully opaque unless a hex string carried an eighth digit.
	pub a: u8,
}

impl Srgb {
	pub const BLACK: Srgb = Srgb::opaque(0x00, 0x00, 0x00);
	/// The smallest luma difference a depth step settles for.
	///
	/// Three 8-bit steps. A boundary between two fills reads as a boundary at
	/// two, which is what `veyyon-ui` asserts across the bundled themes, and the
	/// third step is headroom for the rounding in [`Srgb::mix`].
	pub const DEPTH_FLOOR: f32 = 3.0 / 255.0;
	pub const WHITE: Srgb = Srgb::opaque(0xff, 0xff, 0xff);

	pub const fn opaque(r: u8, g: u8, b: u8) -> Srgb {
		Srgb { r, g, b, a: 0xff }
	}

	/// Perceptual luma: gamma-encoded BT.709 weights over raw sRGB, in 0..=1.
	///
	/// This is the light/dark classifier, and the threshold is 0.5 on the
	/// theme's status-line background. Not a contrast ratio — see
	/// [`Srgb::relative_luminance`] for that.
	pub fn luma(self) -> f32 {
		let Srgb { r, g, b, .. } = self;
		(0.2126 * f32::from(r) + 0.7152 * f32::from(g) + 0.0722 * f32::from(b)) / 255.0
	}

	/// WCAG 2.x relative luminance: BT.709 weights over linearized sRGB, in
	/// 0..=1. The value the contrast-ratio formula takes.
	pub fn relative_luminance(self) -> f32 {
		fn linearize(channel: u8) -> f32 {
			let c = f32::from(channel) / 255.0;
			if c <= 0.039_285_71 {
				c / 12.92
			} else {
				((c + 0.055) / 1.055).powf(2.4)
			}
		}
		0.2126 * linearize(self.r) + 0.7152 * linearize(self.g) + 0.0722 * linearize(self.b)
	}

	/// This colour moved `amount` of the way toward `other`, per channel.
	/// `amount` outside 0..=1 is clamped, so a caller cannot overshoot into a
	/// colour that is not between the two.
	pub fn mix(self, other: Srgb, amount: f32) -> Srgb {
		let t = amount.clamp(0.0, 1.0);
		let blend = |from: u8, to: u8| {
			let from = f32::from(from);
			(from + (f32::from(to) - from) * t)
				.round()
				.clamp(0.0, 255.0) as u8
		};
		Srgb {
			r: blend(self.r, other.r),
			g: blend(self.g, other.g),
			b: blend(self.b, other.b),
			a: blend(self.a, other.a),
		}
	}

	/// The end of the greyscale axis this colour contrasts against: white for a
	/// dark colour, black for a light one.
	pub fn contrast_pole(self) -> Srgb {
		if self.luma() > 0.5 {
			Srgb::BLACK
		} else {
			Srgb::WHITE
		}
	}

	/// Toward the contrast pole: lighter on a dark ground, darker on a light
	/// one.
	///
	/// This is the CONTRAST direction, and it is what a hairline, a border, a
	/// hover wash and a receding text colour want — each has to be seen against
	/// the ground it sits on, whichever ground that is. It is the rule
	/// `ground-tints.ts` already applies in the terminal.
	///
	/// It is not the depth direction. See [`Srgb::lift`].
	pub fn tint(self, amount: f32) -> Srgb {
		self.mix(self.contrast_pole(), amount)
	}

	/// Away from the contrast pole: darker on a dark ground, lighter on a light
	/// one.
	pub fn shade(self, amount: f32) -> Srgb {
		let away = if self.luma() > 0.5 {
			Srgb::WHITE
		} else {
			Srgb::BLACK
		};
		self.mix(away, amount)
	}

	/// Lighter: how a surface lifts off the ground it sits on.
	///
	/// Toward white on a light theme and a dark one alike, because depth is not
	/// contrast. A card is whiter than its page in both, which is not an
	/// assumption — the bundled themes state it: `dark-gruvbox` exports
	/// `pageBg` `#1d2021` under `cardBg` `#282828`, and `alabaster` puts a white
	/// card on an off-white page. Moving a light theme's card away from white,
	/// which the contrast direction would do, inverts what its own author chose.
	///
	/// A ground already at white has nowhere lighter to go, so it darkens
	/// instead. `light` is exactly that: one flat `#ffffff`. Separation is the
	/// contract; direction is what it prefers.
	pub fn lift(self, amount: f32) -> Srgb {
		self
			.toward(Srgb::WHITE, amount)
			.or_else(|| self.toward(Srgb::BLACK, amount))
			.unwrap_or(self)
	}

	/// Darker: how a well is set into the ground it sits in.
	///
	/// The counterpart to [`Srgb::lift`], and the same fallback: a ground
	/// already at black lightens instead. `dark` is exactly that: one flat
	/// `#000000`.
	pub fn sink(self, amount: f32) -> Srgb {
		self
			.toward(Srgb::BLACK, amount)
			.or_else(|| self.toward(Srgb::WHITE, amount))
			.unwrap_or(self)
	}

	/// A mix toward `target` that clears [`Srgb::DEPTH_FLOOR`], or `None` when
	/// this colour is already at `target`'s end of the luma axis.
	///
	/// `amount` is a fraction of the distance to the target, so on a ground near
	/// that end it buys almost nothing: 10% of a page at luma 0.05 is a
	/// difference of 0.005, which is under a single channel step and reads as
	/// one colour. `amethyst` is that page. The fraction is therefore a minimum
	/// rather than the whole rule — it is scaled up until the luma difference
	/// clears the floor, or until it reaches the target and there is no more
	/// room to take.
	///
	/// Rounding is the second way a step disappears: 5% of the five channel
	/// steps between `#fafaf8` and white is a quarter of a step, which rounds
	/// back to the ground. The floor already covers that case, and the
	/// per-channel nudge covers what is left, so the direction reverses only at
	/// the end of the axis and not in its neighbourhood.
	///
	/// A zero step asks for no movement, which is not the same as having no room
	/// for any, so it stays the identity.
	fn toward(self, target: Srgb, amount: f32) -> Option<Srgb> {
		if amount <= 0.0 {
			return Some(self);
		}
		let reach = target.luma() - self.luma();
		if reach == 0.0 {
			return None;
		}
		let needed = Srgb::DEPTH_FLOOR / reach.abs();
		let mixed = self.mix(target, amount.max(needed).min(1.0));
		if mixed != self {
			return Some(mixed);
		}
		let step = |from: u8, to: u8| match from.cmp(&to) {
			Ordering::Less => from + 1,
			Ordering::Greater => from - 1,
			Ordering::Equal => from,
		};
		let nudged = Srgb {
			r: step(self.r, target.r),
			g: step(self.g, target.g),
			b: step(self.b, target.b),
			a: self.a,
		};
		if nudged == self { None } else { Some(nudged) }
	}

	/// The same colour at a different alpha.
	pub fn with_alpha(self, alpha: f32) -> Srgb {
		Srgb { a: (alpha.clamp(0.0, 1.0) * 255.0).round() as u8, ..self }
	}

	/// `#rrggbb`, dropping alpha. For error messages and round-trip tests.
	pub fn to_hex(self) -> String {
		format!("#{:02x}{:02x}{:02x}", self.r, self.g, self.b)
	}
}

impl From<Srgb> for Rgba {
	fn from(color: Srgb) -> Rgba {
		Rgba {
			r: f32::from(color.r) / 255.0,
			g: f32::from(color.g) / 255.0,
			b: f32::from(color.b) / 255.0,
			a: f32::from(color.a) / 255.0,
		}
	}
}

impl From<Srgb> for Hsla {
	fn from(color: Srgb) -> Hsla {
		Rgba::from(color).into()
	}
}

/// Why a colour string could not be read.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ColorError {
	#[error("`{0}` is not a colour: expected #rgb, #rrggbb or #rrggbbaa")]
	Malformed(String),
	#[error("256-colour index {0} is out of range: expected 0 to 255")]
	IndexOutOfRange(i64),
}

/// Parse a hex colour. Accepts `#rgb`, `#rrggbb` and `#rrggbbaa`, with or
/// without the leading `#`.
///
/// The eight-digit form is a GUI addition: the terminal has no per-colour alpha
/// so no bundled theme uses it, but a `gui` override block can, and dropping
/// the alpha silently would be worse than accepting it.
pub fn parse_hex(value: &str) -> Result<Srgb, ColorError> {
	let digits = value.strip_prefix('#').unwrap_or(value);
	let malformed = || ColorError::Malformed(value.to_owned());

	let byte = |at: usize| -> Result<u8, ColorError> {
		u8::from_str_radix(digits.get(at..at + 2).ok_or_else(malformed)?, 16).map_err(|_| malformed())
	};
	let nibble = |at: usize| -> Result<u8, ColorError> {
		let digit = u8::from_str_radix(digits.get(at..at + 1).ok_or_else(malformed)?, 16)
			.map_err(|_| malformed())?;
		Ok(digit * 17)
	};

	match digits.len() {
		3 => Ok(Srgb::opaque(nibble(0)?, nibble(1)?, nibble(2)?)),
		6 => Ok(Srgb::opaque(byte(0)?, byte(2)?, byte(4)?)),
		8 => Ok(Srgb { r: byte(0)?, g: byte(2)?, b: byte(4)?, a: byte(6)? }),
		_ => Err(malformed()),
	}
}

/// The xterm 256-colour palette.
///
/// 0..=15 are the fixed basic colours, 16..=231 a 6×6×6 cube, 232..=255 a
/// 24-step grey ramp. The channel values match `ansi256ToHex`, so a theme that
/// states `33` renders the same colour in both front ends.
pub fn ansi256(index: i64) -> Result<Srgb, ColorError> {
	const BASIC: [Srgb; 16] = [
		Srgb::opaque(0x00, 0x00, 0x00),
		Srgb::opaque(0x80, 0x00, 0x00),
		Srgb::opaque(0x00, 0x80, 0x00),
		Srgb::opaque(0x80, 0x80, 0x00),
		Srgb::opaque(0x00, 0x00, 0x80),
		Srgb::opaque(0x80, 0x00, 0x80),
		Srgb::opaque(0x00, 0x80, 0x80),
		Srgb::opaque(0xc0, 0xc0, 0xc0),
		Srgb::opaque(0x80, 0x80, 0x80),
		Srgb::opaque(0xff, 0x00, 0x00),
		Srgb::opaque(0x00, 0xff, 0x00),
		Srgb::opaque(0xff, 0xff, 0x00),
		Srgb::opaque(0x00, 0x00, 0xff),
		Srgb::opaque(0xff, 0x00, 0xff),
		Srgb::opaque(0x00, 0xff, 0xff),
		Srgb::opaque(0xff, 0xff, 0xff),
	];

	let level = |n: i64| -> u8 { if n == 0 { 0 } else { (55 + n * 40) as u8 } };

	match index {
		0..=15 => Ok(BASIC[index as usize]),
		16..=231 => {
			let n = index - 16;
			Ok(Srgb::opaque(level(n / 36), level((n / 6) % 6), level(n % 6)))
		},
		232..=255 => {
			let grey = (8 + (index - 232) * 10) as u8;
			Ok(Srgb::opaque(grey, grey, grey))
		},
		other => Err(ColorError::IndexOutOfRange(other)),
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn hex_parses_every_accepted_length() {
		assert_eq!(parse_hex("#fff").unwrap(), Srgb::WHITE);
		assert_eq!(parse_hex("#000").unwrap(), Srgb::BLACK);
		assert_eq!(parse_hex("#1e1e2e").unwrap(), Srgb::opaque(0x1e, 0x1e, 0x2e));
		assert_eq!(parse_hex("1e1e2e").unwrap(), Srgb::opaque(0x1e, 0x1e, 0x2e));
		assert_eq!(parse_hex("#12345678").unwrap(), Srgb { r: 0x12, g: 0x34, b: 0x56, a: 0x78 });
	}

	/// The short form expands by digit repetition, not by shifting: `#abc` is
	/// `#aabbcc`, so `#fff` is pure white rather than `#f0f0f0`.
	#[test]
	fn the_short_form_expands_by_repetition() {
		assert_eq!(parse_hex("#abc").unwrap(), Srgb::opaque(0xaa, 0xbb, 0xcc));
	}

	#[test]
	fn a_malformed_hex_is_reported_with_its_input() {
		for value in ["", "#", "#ff", "#ffff", "#fffff", "#fffffff", "#gggggg", "not a colour"] {
			let error = parse_hex(value).expect_err(&format!("{value:?} parsed"));
			assert_eq!(error, ColorError::Malformed(value.to_owned()));
		}
	}

	/// The palette's three regions, at each boundary.
	#[test]
	fn the_256_colour_palette_matches_its_three_regions() {
		assert_eq!(ansi256(0).unwrap(), Srgb::BLACK);
		assert_eq!(ansi256(15).unwrap(), Srgb::WHITE);
		// Cube corners: index 16 is the black corner, 231 the white one.
		assert_eq!(ansi256(16).unwrap(), Srgb::opaque(0, 0, 0));
		assert_eq!(ansi256(231).unwrap(), Srgb::opaque(255, 255, 255));
		// A cube interior colour: 33 = 16 + 17 -> (0, 2, 5).
		assert_eq!(ansi256(33).unwrap(), Srgb::opaque(0, 135, 255));
		// Grey ramp ends.
		assert_eq!(ansi256(232).unwrap(), Srgb::opaque(8, 8, 8));
		assert_eq!(ansi256(255).unwrap(), Srgb::opaque(238, 238, 238));
	}

	#[test]
	fn an_out_of_range_index_is_reported() {
		for index in [-1, 256, 1000] {
			assert_eq!(ansi256(index), Err(ColorError::IndexOutOfRange(index)));
		}
	}

	/// Every index in range resolves. The cube arithmetic divides and mods, so a
	/// boundary case landing outside the table would panic rather than return.
	#[test]
	fn every_index_in_range_resolves() {
		for index in 0..=255 {
			ansi256(index).unwrap_or_else(|error| panic!("index {index}: {error}"));
		}
	}

	/// The classification threshold. Black and white sit at the ends, and the
	/// weights are green-dominant, so pure green reads as light and pure blue as
	/// dark.
	#[test]
	fn luma_classifies_by_the_bt709_weights() {
		assert_eq!(Srgb::BLACK.luma(), 0.0);
		assert_eq!(Srgb::WHITE.luma(), 1.0);
		assert!(Srgb::opaque(0, 255, 0).luma() > 0.5, "green is light");
		assert!(Srgb::opaque(0, 0, 255).luma() < 0.5, "blue is dark");
		assert!(Srgb::opaque(255, 0, 0).luma() < 0.5, "red is dark");
	}

	/// Relative luminance linearizes first, so a mid-grey reads far darker than
	/// its luma. Confusing the two is what would put a light theme on the dark
	/// branch.
	#[test]
	fn relative_luminance_is_not_luma() {
		let grey = Srgb::opaque(128, 128, 128);
		assert!((grey.luma() - 0.502).abs() < 0.005, "luma was {}", grey.luma());
		assert!(
			(grey.relative_luminance() - 0.216).abs() < 0.005,
			"relative luminance was {}",
			grey.relative_luminance()
		);
		assert_eq!(Srgb::BLACK.relative_luminance(), 0.0);
		assert!((Srgb::WHITE.relative_luminance() - 1.0).abs() < 1e-5);
	}

	#[test]
	fn mixing_is_bounded_by_its_endpoints() {
		let a = Srgb::opaque(0, 0, 0);
		let b = Srgb::opaque(255, 255, 255);
		assert_eq!(a.mix(b, 0.0), a);
		assert_eq!(a.mix(b, 1.0), b);
		assert_eq!(a.mix(b, 0.5), Srgb::opaque(128, 128, 128));
		// Out of range is clamped, never extrapolated.
		assert_eq!(a.mix(b, -1.0), a);
		assert_eq!(a.mix(b, 2.0), b);
	}

	/// Tint goes toward the pole and shade away from it, and which direction
	/// that is depends on the ground. This is the whole reason a single
	/// derivation rule works for both light and dark themes.
	#[test]
	fn tint_and_shade_follow_the_ground() {
		let dark = Srgb::opaque(0x1e, 0x1e, 0x2e);
		assert!(dark.tint(0.1).luma() > dark.luma(), "tinting a dark ground lightens it");
		assert!(dark.shade(0.1).luma() < dark.luma(), "shading a dark ground darkens it");

		let light = Srgb::opaque(0xfa, 0xfa, 0xf8);
		assert!(light.tint(0.1).luma() < light.luma(), "tinting a light ground darkens it");
		assert!(light.shade(0.1).luma() > light.luma(), "shading a light ground lightens it");
	}

	/// A zero tint changes nothing, so a derivation that means "leave it alone"
	/// can say so.
	#[test]
	fn a_zero_tint_is_the_identity() {
		let color = Srgb::opaque(0x33, 0x44, 0x55);
		assert_eq!(color.tint(0.0), color);
		assert_eq!(color.shade(0.0), color);
	}

	/// Depth runs one way on both appearances: a lift is lighter, a sink is
	/// darker, on a light ground and a dark one. This is the property that
	/// separates depth from contrast, and getting it backwards on light themes
	/// is what made `alabaster`'s white-card-on-off-white-page read inverted.
	#[test]
	fn depth_runs_one_way_on_both_appearances() {
		for ground in [
			Srgb::opaque(0x1d, 0x20, 0x21),
			Srgb::opaque(0x28, 0x28, 0x28),
			Srgb::opaque(0x80, 0x80, 0x80),
			Srgb::opaque(0xf7, 0xf7, 0xf5),
		] {
			let hex = ground.to_hex();
			assert!(ground.lift(0.1).luma() > ground.luma(), "{hex} did not lift");
			assert!(ground.sink(0.1).luma() < ground.luma(), "{hex} did not sink");
		}
	}

	/// Contrast still runs the other way on a light ground. Both directions have
	/// to exist, because a hairline on a white page must darken while a card on
	/// the same page whitens.
	#[test]
	fn contrast_and_depth_disagree_on_a_light_ground() {
		let page = Srgb::opaque(0xf7, 0xf7, 0xf5);
		assert!(page.tint(0.1).luma() < page.luma(), "a hairline did not darken");
		assert!(page.lift(0.1).luma() > page.luma(), "a card did not whiten");
	}

	/// A ground near an extreme keeps the preferred direction, however small the
	/// step is. The rounding is what makes this a class rather than one input:
	/// any (ground, amount) pair whose product is under half a channel step used
	/// to read as "no room left" and reverse, so an off-white page derived a
	/// card darker than itself. Swept over the depth steps the palette actually
	/// uses.
	#[test]
	fn a_ground_near_an_extreme_still_moves_the_preferred_way() {
		let steps = [0.03, 0.04, 0.05, 0.07, 0.1];
		let near_white = [
			Srgb::opaque(0xfa, 0xfa, 0xf8),
			Srgb::opaque(0xfe, 0xfe, 0xfe),
			Srgb::opaque(0xff, 0xff, 0xfe),
		];
		let near_black = [
			Srgb::opaque(0x02, 0x02, 0x03),
			Srgb::opaque(0x01, 0x01, 0x01),
			Srgb::opaque(0x00, 0x00, 0x01),
		];
		for step in steps {
			for ground in near_white {
				let hex = ground.to_hex();
				assert!(ground.lift(step).luma() > ground.luma(), "{hex} did not lift at {step}");
			}
			for ground in near_black {
				let hex = ground.to_hex();
				assert!(ground.sink(step).luma() < ground.luma(), "{hex} did not sink at {step}");
			}
		}
	}

	/// A ground at an extreme still moves, in the only direction left. Three
	/// bundled themes are one flat colour at an extreme — `dark` at `#000000`,
	/// `light` at `#ffffff` — and a card that cannot separate from its page is a
	/// card with no edge.
	#[test]
	fn an_extreme_ground_still_separates() {
		let black = Srgb::BLACK;
		assert_eq!(black.mix(Srgb::BLACK, 0.25), black, "black found room it does not have");
		assert!(black.sink(0.25).luma() > black.luma(), "the well did not lighten off black");
		assert!(black.lift(0.25).luma() > black.luma(), "the card did not lighten off black");

		let white = Srgb::WHITE;
		assert!(white.lift(0.25).luma() < white.luma(), "the card did not darken off white");
		assert!(white.sink(0.25).luma() < white.luma(), "the well did not darken off white");
	}

	/// A zero step cannot move either way, and reporting that as "no room" would
	/// flip the direction. It stays the identity, at both extremes.
	#[test]
	fn a_zero_step_is_the_identity() {
		for ground in [Srgb::BLACK, Srgb::WHITE, Srgb::opaque(0x33, 0x44, 0x55)] {
			let hex = ground.to_hex();
			assert_eq!(ground.lift(0.0), ground, "{hex} lifted");
			assert_eq!(ground.sink(0.0), ground, "{hex} sank");
		}
	}

	/// Conversion into gpui's colour types preserves the channels: an opaque
	/// theme colour must not arrive at the GPU with alpha 0.
	#[test]
	fn conversion_to_gpui_preserves_the_channels() {
		let rgba: Rgba = Srgb::opaque(0xff, 0x80, 0x00).into();
		assert!((rgba.r - 1.0).abs() < 1e-6);
		assert!((rgba.g - 0.502).abs() < 0.005);
		assert_eq!(rgba.b, 0.0);
		assert_eq!(rgba.a, 1.0);

		let translucent: Rgba = Srgb::opaque(0, 0, 0).with_alpha(0.5).into();
		assert!((translucent.a - 0.5).abs() < 0.005);
	}

	/// A round trip through Hsla holds the colour. gpui stores Hsla, so every
	/// theme colour makes this trip and a lossy one shifts hues.
	#[test]
	fn a_round_trip_through_hsla_holds_the_colour() {
		for source in [
			Srgb::opaque(0x1e, 0x1e, 0x2e),
			Srgb::opaque(0xff, 0x00, 0x00),
			Srgb::opaque(0x00, 0xff, 0x00),
			Srgb::opaque(0x00, 0x00, 0xff),
			Srgb::opaque(0x80, 0x80, 0x80),
			Srgb::WHITE,
			Srgb::BLACK,
		] {
			let hsla: Hsla = source.into();
			let back: Rgba = hsla.into();
			let round_tripped = Srgb {
				r: (back.r * 255.0).round() as u8,
				g: (back.g * 255.0).round() as u8,
				b: (back.b * 255.0).round() as u8,
				a: (back.a * 255.0).round() as u8,
			};
			assert_eq!(round_tripped, source, "{} did not survive Hsla", source.to_hex());
		}
	}
}
