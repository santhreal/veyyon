//! Global token set bridging `veyyon-desktop-tokens` to GPUI rendering types.
//!
//! Visual attributes are resolved through GPUI globals on `WindowContext` at
//! render time, ensuring primitives contain no hardcoded numeric style literals
//! (§8.24).

use std::{borrow::Cow, path::PathBuf};

pub use veyyon_desktop_tokens::{
	ColorRole, ElevationTokens, MonoSizeStep, RadiusStep, RgbColor, ScaleTokens, SpacingStep,
	StrokeStep, Theme, TokenError, Tokens, load_bundled_theme, load_bundled_tokens,
};
use veyyon_gpui::{App, FontWeight, Hsla, Pixels, SharedString, px};

use crate::families::{MonoMetrics, first_family, present_family};

/// Number of semantic colour roles defined in the system (§6.4).
pub const COLOR_ROLE_COUNT: usize = 29;

/// Text typography ramp selection.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TextRamp {
	Micro,
	Small,
	Body,
	Read,
	Head,
	Lead,
}

impl TextRamp {
	/// Maps typographic ramp to discrete size step index.
	#[must_use]
	pub const fn to_size_step(self) -> veyyon_desktop_tokens::TypeSizeStep {
		match self {
			Self::Micro => veyyon_desktop_tokens::TypeSizeStep::Micro,
			Self::Small => veyyon_desktop_tokens::TypeSizeStep::Small,
			Self::Body => veyyon_desktop_tokens::TypeSizeStep::Body,
			Self::Read => veyyon_desktop_tokens::TypeSizeStep::Read,
			Self::Head => veyyon_desktop_tokens::TypeSizeStep::Head,
			Self::Lead => veyyon_desktop_tokens::TypeSizeStep::Lead,
		}
	}
}

/// Text font weight selection.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum TextWeight {
	#[default]
	Regular,
	Medium,
	Semibold,
}

impl TextWeight {
	/// Maps typographic weight to discrete weight step index.
	#[must_use]
	pub const fn to_weight_step(self) -> veyyon_desktop_tokens::TypeWeightStep {
		match self {
			Self::Regular => veyyon_desktop_tokens::TypeWeightStep::Regular,
			Self::Medium => veyyon_desktop_tokens::TypeWeightStep::Medium,
			Self::Semibold => veyyon_desktop_tokens::TypeWeightStep::Semibold,
		}
	}
}

/// Semantic tint role for status, badges, and feedback indicators.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TintRole {
	Working,
	Attention,
	Approve,
	Input,
	Plan,
	Due,
	Done,
	Error,
}

/// Tint color pair consisting of a fill background and an ink foreground.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TintPair {
	pub fill: Hsla,
	pub ink:  Hsla,
}

/// Converts linear RGB color to GPUI HSLA representation.
fn rgb_to_hsla(rgb: RgbColor) -> Hsla {
	let red = rgb.r;
	let green = rgb.g;
	let blue = rgb.b;
	let min = red.min(green.min(blue));
	let max = red.max(green.max(blue));
	let delta = max - min;
	let luminance = f32::midpoint(max, min);
	let saturation = if delta == 0.0 {
		0.0
	} else if luminance < 0.5 {
		delta / (max + min)
	} else {
		delta / (2.0 - max - min)
	};
	let hue = if delta == 0.0 {
		0.0
	} else if (max - red).abs() < f32::EPSILON {
		let mut computed_hue = (green - blue) / delta;
		if computed_hue < 0.0 {
			computed_hue += 6.0;
		}
		computed_hue / 6.0
	} else if (max - green).abs() < f32::EPSILON {
		((blue - red) / delta + 2.0) / 6.0
	} else {
		((red - green) / delta + 4.0) / 6.0
	};
	Hsla { h: hue, s: saturation, l: luminance, a: rgb.a }
}

/// Resolved design token set stored in GPUI context.
#[derive(Debug, Clone)]
pub struct TokenSet {
	colors:       [Hsla; COLOR_ROLE_COUNT],
	row_hover:    Hsla,
	row_selected: Hsla,
	row_active:   Hsla,
	scrim:        Hsla,
	scale:        ScaleTokens,
	elevation:    Option<ElevationTokens>,
	mono_family:  SharedString,
	ui_family:    SharedString,
}

impl Default for TokenSet {
	fn default() -> Self {
		let tokens = load_bundled_tokens().expect("bundled tokens must load");
		let theme = load_bundled_theme("dark").expect("bundled dark theme must load");
		Self::from_tokens(&tokens, &theme).expect("bundled token set must be valid")
	}
}

impl TokenSet {
	/// Borrows installed tokens without loading the bundled files during
	/// rendering. Standalone kit contexts without installed tokens use the
	/// validated bundle.
	#[must_use]
	pub fn for_app(cx: &App) -> Cow<'_, Self> {
		match cx.try_global::<Self>() {
			Some(tokens) => Cow::Borrowed(tokens),
			None => Cow::Owned(Self::default()),
		}
	}

	/// Builds a token set from loaded `Tokens` and `Theme`.
	///
	/// Resolves every semantic color role once at construction time and fails
	/// closed if any role is absent (§6.4).
	pub fn from_tokens(tokens: &Tokens, theme: &Theme) -> Result<Self, TokenError> {
		let mut colors = [Hsla { h: 0.0, s: 0.0, l: 0.0, a: 0.0 }; COLOR_ROLE_COUNT];
		for role in ColorRole::all() {
			let rgb = theme
				.roles
				.get(&role)
				.copied()
				.ok_or_else(|| TokenError::MissingKey {
					path:    PathBuf::from(&theme.name),
					section: "role".to_string(),
					key:     role.as_str().to_string(),
				})?;
			colors[role as usize] = rgb_to_hsla(rgb);
		}

		let hairline = colors[ColorRole::Hairline as usize];
		let mut row_hover = hairline;
		row_hover.a = 0.50;
		let mut row_selected = hairline;
		row_selected.a = 0.70;
		let mut row_active = hairline;
		row_active.a = 0.80;
		// An overlay's scrim is the window's own ground at partial opacity, so
		// what it covers stays perceptible as shape without staying readable as
		// text. A separate opaque role would hide the surface instead, and an
		// operator cannot tell a covered panel from a closed one.
		let mut scrim = colors[ColorRole::Ground as usize];
		scrim.a = 0.60;

		let mono_family = first_family(tokens.scale.mono_family_chain(), "mono")?;
		let ui_family = first_family(tokens.scale.ui_family_chain(), "ui")?;

		Ok(Self {
			colors,
			row_hover,
			row_selected,
			row_active,
			scrim,
			scale: tokens.scale.clone(),
			elevation: Some(tokens.elevation.clone()),
			mono_family: SharedString::from(mono_family),
			ui_family: SharedString::from(ui_family),
		})
	}

	/// Selects the monospace family from the authored chain, given the families
	/// this machine has, and fails when it has none of them.
	///
	/// Monospace text carries column alignment: a terminal row, a diff hunk and
	/// a code line all read by column. A substituted proportional face still
	/// draws every character, so the result looks intentional and no error
	/// reaches the operator (§9.3). The chain states which faces are
	/// acceptable, this states which one is present, and an install with none
	/// of them stops here instead of drawing columns that do not line up.
	pub fn resolve_mono_family(&mut self, available: &[String]) -> Result<(), TokenError> {
		let family = present_family(self.scale.mono_family_chain(), available, "mono")?;
		self.mono_family = SharedString::from(family);
		Ok(())
	}

	/// Selects the proportional family from the authored chain, given the
	/// families this machine has, and fails when it has none of them.
	///
	/// A family the platform cannot resolve is not a cosmetic difference: GPUI
	/// walks its own ten-deep fallback stack per text run and builds an error
	/// for every miss, so a window drawing hundreds of runs a frame spends the
	/// frame in font resolution and stops answering the keyboard. Stating the
	/// family the machine has is what keeps every run a cache hit (§9.3).
	pub fn resolve_ui_family(&mut self, available: &[String]) -> Result<(), TokenError> {
		let family = present_family(self.scale.ui_family_chain(), available, "ui")?;
		self.ui_family = SharedString::from(family);
		Ok(())
	}

	/// Returns elevation tokens if configured.
	#[must_use]
	pub fn elevation(&self) -> Option<&ElevationTokens> {
		self.elevation.as_ref()
	}

	/// Resolves a color role to an HSLA color.
	#[must_use]
	pub const fn color(&self, role: ColorRole) -> Hsla {
		self.colors[role as usize]
	}

	/// Resolves transparent color.
	#[must_use]
	pub const fn transparent(&self) -> Hsla {
		Hsla { h: 0.0, s: 0.0, l: 0.0, a: 0.0 }
	}

	/// Resolves row hover background color.
	#[must_use]
	pub const fn row_hover(&self) -> Hsla {
		self.row_hover
	}

	/// Resolves row selected background color.
	#[must_use]
	pub const fn row_selected(&self) -> Hsla {
		self.row_selected
	}

	/// Resolves row active / dragging background color.
	#[must_use]
	pub const fn row_active(&self) -> Hsla {
		self.row_active
	}

	/// Resolves the background an overlay draws over what it covers.
	#[must_use]
	pub const fn scrim(&self) -> Hsla {
		self.scrim
	}

	/// Resolves tint pair for a semantic tint role.
	#[must_use]
	pub fn tint(&self, role: TintRole) -> TintPair {
		let (fill_role, ink_role) = match role {
			TintRole::Working => (ColorRole::WorkingFill, ColorRole::WorkingInk),
			TintRole::Attention => (ColorRole::AttentionFill, ColorRole::AttentionInk),
			TintRole::Approve => (ColorRole::ApproveFill, ColorRole::ApproveInk),
			TintRole::Input => (ColorRole::InputFill, ColorRole::InputInk),
			TintRole::Plan => (ColorRole::PlanFill, ColorRole::PlanInk),
			TintRole::Due => (ColorRole::DueFill, ColorRole::DueInk),
			TintRole::Done => (ColorRole::DoneFill, ColorRole::DoneInk),
			TintRole::Error => (ColorRole::ErrorFill, ColorRole::ErrorInk),
		};
		TintPair { fill: self.color(fill_role), ink: self.color(ink_role) }
	}

	/// Resolves discrete spacing step to pixels.
	#[must_use]
	pub fn spacing(&self, step: SpacingStep) -> Pixels {
		px(self.scale.spacing(step))
	}

	/// Resolves discrete radius step to pixels.
	#[must_use]
	pub fn radius(&self, step: RadiusStep) -> Pixels {
		px(self.scale.radius(step))
	}

	/// Resolves text font size in pixels for a ramp.
	#[must_use]
	pub fn font_size(&self, ramp: TextRamp) -> Pixels {
		px(self.scale.type_size(ramp.to_size_step()).size)
	}

	/// Resolves line height in pixels for a ramp.
	#[must_use]
	pub fn line_height(&self, ramp: TextRamp) -> Pixels {
		px(self.scale.type_size(ramp.to_size_step()).line_height)
	}

	/// Monospace size and line height in pixels, for the layout arithmetic a
	/// caller does around mono text: a key cap's padding, a pane's clip height.
	/// Styling the text itself goes through `MonoText::mono_text`, which sets
	/// the family with the size.
	#[must_use]
	pub fn mono_metrics(&self, step: MonoSizeStep) -> MonoMetrics {
		let size = self.scale.mono_size(step);
		MonoMetrics { size: px(size.size), line_height: px(size.line_height) }
	}

	/// The family monospace text is set in (§6.3), chosen from the authored
	/// chain by `resolve_mono_family` against the families this machine has.
	#[must_use]
	pub fn mono_family(&self) -> SharedString {
		self.mono_family.clone()
	}

	/// The family every other text run is set in (§6.3), chosen from the
	/// authored chain by `resolve_ui_family` against the families this machine
	/// has.
	#[must_use]
	pub fn ui_family(&self) -> SharedString {
		self.ui_family.clone()
	}

	/// Resolves font weight.
	#[must_use]
	pub fn font_weight(&self, weight: TextWeight) -> FontWeight {
		match weight {
			TextWeight::Regular => FontWeight::NORMAL,
			TextWeight::Medium => FontWeight::MEDIUM,
			TextWeight::Semibold => FontWeight::SEMIBOLD,
		}
	}

	/// Resolves stroke width in pixels.
	#[must_use]
	pub fn stroke(&self, step: StrokeStep) -> Pixels {
		px(self.scale.stroke(step))
	}
}

impl veyyon_gpui::Global for TokenSet {}
