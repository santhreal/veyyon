//! The resolved scale: the pixel, weight and typographic values a step
//! names, as `scale.toml` authors them.

use serde::{Deserialize, Serialize};

use crate::schema::{
	IconSizeStep, MonoSizeStep, RadiusStep, SpacingStep, StrokeStep, TypeSizeStep, TypeWeightStep,
};

/// Resolved typographic properties.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct TypeSize {
	pub size:        f32,
	pub line_height: f32,
	pub tracking_em: f32,
}

/// Resolved scale token values.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ScaleTokens {
	pub spacing:      [f32; 14],
	pub radius:       [f32; 8],
	pub type_sizes:   [TypeSize; 6],
	pub type_weights: [u16; 3],
	pub mono_sizes:   [TypeSize; 2],
	/// The families monospace text is set in, most wanted first. Mono text
	/// carries column alignment, so a proportional substitute is a defect and
	/// not a cosmetic difference; the chain states which faces are acceptable
	/// and `mono_family` on the resolved set states which one the machine has.
	pub mono_family:  Vec<String>,
	/// The families every other text run is set in, most wanted first. An
	/// unstated family reaches GPUI as `.SystemUIFont`, which its Linux text
	/// system does not resolve, so the chain states the acceptable faces and
	/// `ui_family` on the resolved set states which one the machine has.
	pub ui_family:    Vec<String>,
	pub strokes:      [f32; 3],
	pub icon_sizes:   [f32; 4],
}

impl ScaleTokens {
	/// Resolves spacing in pixels for the given discrete step.
	pub const fn spacing(&self, step: SpacingStep) -> f32 {
		self.spacing[step as usize]
	}

	/// Resolves radius in pixels for the given discrete step.
	pub const fn radius(&self, step: RadiusStep) -> f32 {
		self.radius[step as usize]
	}

	/// Resolves typographic sizing and tracking for the given size step.
	pub const fn type_size(&self, step: TypeSizeStep) -> &TypeSize {
		&self.type_sizes[step as usize]
	}

	/// Resolves numeric font weight (e.g. 400, 500, 600).
	pub const fn type_weight(&self, step: TypeWeightStep) -> u16 {
		self.type_weights[step as usize]
	}

	/// Resolves monospace font sizing and line height.
	pub const fn mono_size(&self, step: MonoSizeStep) -> &TypeSize {
		&self.mono_sizes[step as usize]
	}

	/// The authored monospace family chain, most wanted first.
	pub fn mono_family_chain(&self) -> &[String] {
		&self.mono_family
	}

	/// The authored proportional family chain, most wanted first.
	pub fn ui_family_chain(&self) -> &[String] {
		&self.ui_family
	}

	/// Resolves stroke width in pixels.
	pub const fn stroke(&self, step: StrokeStep) -> f32 {
		self.strokes[step as usize]
	}

	/// Resolves an icon's bounding box in pixels.
	pub const fn icon_size(&self, step: IconSizeStep) -> f32 {
		self.icon_sizes[step as usize]
	}

	/// The authored box nearest `pixels`.
	///
	/// A surface measure is a free number and an icon is drawn at one of four
	/// boxes, so this is where the two meet. The candidates come from the
	/// authored ramp, so the sizes are stated once, in `scale.toml`.
	pub fn nearest_icon_size(&self, pixels: f32) -> IconSizeStep {
		IconSizeStep::all()
			.into_iter()
			.min_by(|left, right| {
				let left = (pixels - self.icon_size(*left)).abs();
				let right = (pixels - self.icon_size(*right)).abs();
				left.total_cmp(&right)
			})
			.unwrap_or_default()
	}
}
