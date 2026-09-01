use std::{collections::HashMap, path::Path};

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

	/// Parses a hex color string like "#1e1e2e" or "#fff".
	pub fn from_hex(hex: &str) -> Result<Self, String> {
		let hex_str = hex.trim().trim_start_matches('#');
		if hex_str.len() == 6 {
			let red = u8::from_str_radix(&hex_str[0..2], 16).map_err(|e| e.to_string())?;
			let green = u8::from_str_radix(&hex_str[2..4], 16).map_err(|e| e.to_string())?;
			let blue = u8::from_str_radix(&hex_str[4..6], 16).map_err(|e| e.to_string())?;
			Ok(Self::new(
				f32::from(red) / 255.0,
				f32::from(green) / 255.0,
				f32::from(blue) / 255.0,
				1.0,
			))
		} else if hex_str.len() == 8 {
			let red = u8::from_str_radix(&hex_str[0..2], 16).map_err(|e| e.to_string())?;
			let green = u8::from_str_radix(&hex_str[2..4], 16).map_err(|e| e.to_string())?;
			let blue = u8::from_str_radix(&hex_str[4..6], 16).map_err(|e| e.to_string())?;
			let alpha = u8::from_str_radix(&hex_str[6..8], 16).map_err(|e| e.to_string())?;
			Ok(Self::new(
				f32::from(red) / 255.0,
				f32::from(green) / 255.0,
				f32::from(blue) / 255.0,
				f32::from(alpha) / 255.0,
			))
		} else if hex_str.len() == 3 {
			let red = u8::from_str_radix(&hex_str[0..1], 16).map_err(|e| e.to_string())? * 17;
			let green = u8::from_str_radix(&hex_str[1..2], 16).map_err(|e| e.to_string())? * 17;
			let blue = u8::from_str_radix(&hex_str[2..3], 16).map_err(|e| e.to_string())? * 17;
			Ok(Self::new(
				f32::from(red) / 255.0,
				f32::from(green) / 255.0,
				f32::from(blue) / 255.0,
				1.0,
			))
		} else {
			Err(format!("invalid hex color length: {hex}"))
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
		let fg = self
			.roles
			.get(&foreground_role)
			.copied()
			.unwrap_or(RgbColor::new(1.0, 1.0, 1.0, 1.0));
		let bg = self
			.roles
			.get(&background_role)
			.copied()
			.unwrap_or(RgbColor::new(0.0, 0.0, 0.0, 1.0));
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
