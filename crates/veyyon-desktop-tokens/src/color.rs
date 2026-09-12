use std::{collections::HashMap, fmt, path::Path};

use serde::{Deserialize, Serialize};

use crate::error::TokenError;

/// Semantic color roles defined across all surfaces and components.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ColorRole {
	Ground,
	Rail,
	Canvas,
	Inset,
	Float,
	Hairline,
	Foreground,
	Secondary,
	Muted,
	Placeholder,
	Accent,
	AccentForeground,
	Focus,
	WorkingFill,
	WorkingInk,
	AttentionFill,
	AttentionInk,
	ApproveFill,
	ApproveInk,
	InputFill,
	InputInk,
	PlanFill,
	PlanInk,
	DueFill,
	DueInk,
	DoneFill,
	DoneInk,
	ErrorFill,
	ErrorInk,
}

impl ColorRole {
	/// Returns all semantic color roles in canonical order.
	pub const fn all() -> [Self; 29] {
		[
			Self::Ground,
			Self::Rail,
			Self::Canvas,
			Self::Inset,
			Self::Float,
			Self::Hairline,
			Self::Foreground,
			Self::Secondary,
			Self::Muted,
			Self::Placeholder,
			Self::Accent,
			Self::AccentForeground,
			Self::Focus,
			Self::WorkingFill,
			Self::WorkingInk,
			Self::AttentionFill,
			Self::AttentionInk,
			Self::ApproveFill,
			Self::ApproveInk,
			Self::InputFill,
			Self::InputInk,
			Self::PlanFill,
			Self::PlanInk,
			Self::DueFill,
			Self::DueInk,
			Self::DoneFill,
			Self::DoneInk,
			Self::ErrorFill,
			Self::ErrorInk,
		]
	}

	/// Returns the role identifier string.
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::Ground => "ground",
			Self::Rail => "rail",
			Self::Canvas => "canvas",
			Self::Inset => "inset",
			Self::Float => "float",
			Self::Hairline => "hairline",
			Self::Foreground => "foreground",
			Self::Secondary => "secondary",
			Self::Muted => "muted",
			Self::Placeholder => "placeholder",
			Self::Accent => "accent",
			Self::AccentForeground => "accent_foreground",
			Self::Focus => "focus",
			Self::WorkingFill => "working_fill",
			Self::WorkingInk => "working_ink",
			Self::AttentionFill => "attention_fill",
			Self::AttentionInk => "attention_ink",
			Self::ApproveFill => "approve_fill",
			Self::ApproveInk => "approve_ink",
			Self::InputFill => "input_fill",
			Self::InputInk => "input_ink",
			Self::PlanFill => "plan_fill",
			Self::PlanInk => "plan_ink",
			Self::DueFill => "due_fill",
			Self::DueInk => "due_ink",
			Self::DoneFill => "done_fill",
			Self::DoneInk => "done_ink",
			Self::ErrorFill => "error_fill",
			Self::ErrorInk => "error_ink",
		}
	}
}

/// Why a colour value was rejected. A theme file is edited by hand, so each
/// case names what to correct rather than only reporting failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColorParseError {
	/// The value holds a character outside ASCII. Reported before length,
	/// because a byte count over a multi-byte string does not describe digits.
	NotAscii(char),
	/// The digit count is not 3, 6 or 8.
	Length(usize),
	/// A character is not a hexadecimal digit.
	Digit(char),
}

impl fmt::Display for ColorParseError {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Self::NotAscii(found) => write!(
				f,
				"'{found}' is not an ASCII hex digit; a colour value is ASCII digits, optionally \
				 prefixed with '#'"
			),
			Self::Length(found) => {
				write!(f, "a colour value has 3, 6 or 8 hex digits after '#', not {found}")
			},
			Self::Digit(found) => write!(f, "'{found}' is not a hexadecimal digit"),
		}
	}
}

impl std::error::Error for ColorParseError {}

/// Converts one ASCII hex digit to its value.
///
/// Takes a byte because the caller matches the value as a byte slice; a
/// non-ASCII value is rejected before this point, so the cast to `char` is
/// lossless here.
fn nibble(digit: u8) -> Result<u8, ColorParseError> {
	let as_char = char::from(digit);
	as_char
		.to_digit(16)
		.and_then(|value| u8::try_from(value).ok())
		.ok_or(ColorParseError::Digit(as_char))
}

/// Linear RGB color representation with alpha channel.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct RgbColor {
	pub r: f32,
	pub g: f32,
	pub b: f32,
	pub a: f32,
}

impl RgbColor {
	/// Creates an RGB color from floating-point components in 0.0..=1.0.
	pub const fn new(r: f32, g: f32, b: f32, a: f32) -> Self {
		Self { r, g, b, a }
	}

	/// Parses a hex colour string: `#rgb`, `#rrggbb` or `#rrggbbaa`, with the
	/// `#` optional.
	///
	/// Digits are matched as a slice pattern rather than sliced by index. The
	/// length test counts bytes, so on a multi-byte value a byte-indexed slice
	/// lands inside a character and panics. A colour arrives from a file an
	/// operator edits, and the token contract is that a malformed file reports
	/// a parse error and the last good set stays; a panic leaves neither.
	pub fn from_hex(hex: &str) -> Result<Self, ColorParseError> {
		let trimmed = hex.trim().trim_start_matches('#');
		if let Some(wide) = trimmed.chars().find(|c| !c.is_ascii()) {
			return Err(ColorParseError::NotAscii(wide));
		}

		let channel = |high: u8, low: u8| -> Result<f32, ColorParseError> {
			let high = nibble(high)?;
			let low = nibble(low)?;
			// Both nibbles are 0..=15, so the compose and the divide are exact
			// and cannot overflow a u8.
			Ok(f32::from((high << 4) | low) / 255.0)
		};

		match trimmed.as_bytes() {
			[r, g, b] => {
				// A short value repeats each digit: 0xF becomes 0xFF.
				Ok(Self::new(channel(*r, *r)?, channel(*g, *g)?, channel(*b, *b)?, 1.0))
			},
			[r1, r2, g1, g2, b1, b2] => {
				Ok(Self::new(channel(*r1, *r2)?, channel(*g1, *g2)?, channel(*b1, *b2)?, 1.0))
			},
			[r1, r2, g1, g2, b1, b2, a1, a2] => Ok(Self::new(
				channel(*r1, *r2)?,
				channel(*g1, *g2)?,
				channel(*b1, *b2)?,
				channel(*a1, *a2)?,
			)),
			other => Err(ColorParseError::Length(other.len())),
		}
	}

	/// Computes standard relative luminance per WCAG 2.1 / ITU-R BT.709.
	pub fn relative_luminance(self) -> f32 {
		fn to_linear(c: f32) -> f32 {
			if c <= 0.04045 {
				c / 12.92
			} else {
				((c + 0.055) / 1.055).powf(2.4)
			}
		}
		let r_lin = to_linear(self.r);
		let g_lin = to_linear(self.g);
		let b_lin = to_linear(self.b);
		0.0722_f32.mul_add(b_lin, 0.7152_f32.mul_add(g_lin, 0.2126 * r_lin))
	}

	/// Computes contrast ratio between two colors (range 1.0..=21.0).
	pub fn contrast_ratio(self, other: Self) -> f32 {
		let l1 = self.relative_luminance();
		let l2 = other.relative_luminance();
		let lighter = l1.max(l2);
		let darker = l1.min(l2);
		(lighter + 0.05) / (darker + 0.05)
	}
}

/// A parsed color theme with semantic role assignments.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Theme {
	pub name:       String,
	pub appearance: String,
	pub version:    u32,
	pub roles:      HashMap<ColorRole, RgbColor>,
}

impl Theme {
	/// Returns a role's colour, or reports the role as missing.
	///
	/// A theme declares every role in the role table, so an absent role is a
	/// malformed theme rather than a value to substitute. Defaulting an absent
	/// role to white or black made the contrast check pass on an incomplete
	/// theme: a missing `foreground` compared white against black and scored
	/// the maximum 21:1, so the one check that guards legibility passed
	/// precisely when the theme could not be rendered.
	pub fn role(&self, path: &Path, role: ColorRole) -> Result<RgbColor, TokenError> {
		self
			.roles
			.get(&role)
			.copied()
			.ok_or_else(|| TokenError::MissingKey {
				path:    path.to_path_buf(),
				section: "role".to_string(),
				key:     role.as_str().to_string(),
			})
	}

	/// Asserts contrast ratio between foreground and background meets WCAG
	/// thresholds.
	pub fn assert_contrast(
		&self,
		path: &Path,
		foreground_role: ColorRole,
		background_role: ColorRole,
		required: f32,
		line: usize,
		column: usize,
	) -> Result<(), TokenError> {
		let fg = self.role(path, foreground_role)?;
		let bg = self.role(path, background_role)?;
		let ratio = fg.contrast_ratio(bg);
		if ratio < required {
			return Err(TokenError::ContrastTooLow {
				path: path.to_path_buf(),
				line,
				column,
				foreground: foreground_role.as_str().to_string(),
				background: background_role.as_str().to_string(),
				ratio,
				required,
			});
		}
		Ok(())
	}
}
