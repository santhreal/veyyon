//! Control metrics shared by every control primitive (§6.10).
//!
//! A control is exactly as tall as its size says, whatever its padding, edge or
//! type, so two controls that sit side by side share a height and a baseline.
//! The three heights are authored in `controls.toml` under `[height]`: small
//! for a chip, medium for the composer action row and the run bar, large for
//! a line row.

use veyyon_gpui::Pixels;

use crate::{
	controls::ButtonSize,
	token_set::{RadiusStep, SpacingStep, TextRamp, TokenSet},
};

/// The metrics one control size resolves to.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ControlMetrics {
	/// The control's exact height.
	pub height:           Pixels,
	/// Horizontal inset from the control's edge to its content.
	pub inset:            Pixels,
	/// Corner radius.
	pub radius:           Pixels,
	/// Type ramp the label is set in.
	pub ramp:             TextRamp,
	/// Width and height of a square control at this size.
	pub square:           Pixels,
	/// Gap between a control's icon and its label.
	pub gap:              Pixels,
	/// Opacity a disabled control renders at, which is the same strength an
	/// unavailable capability renders at: both stand for a control the
	/// operator can see and cannot activate.
	pub disabled_opacity: f32,
}

/// The exact height of a control at `size`, in pixels, as authored in
/// `controls.toml`.
#[must_use]
pub fn control_height_px(size: ButtonSize, tokens: &TokenSet) -> f32 {
	let controls = tokens.controls();
	match size {
		ButtonSize::Small => controls.height_small_px,
		ButtonSize::Medium => controls.height_medium_px,
		ButtonSize::Large => controls.height_large_px,
	}
}

/// Resolves the metrics of a control at `size` against `tokens`.
#[must_use]
pub fn control_metrics(size: ButtonSize, tokens: &TokenSet) -> ControlMetrics {
	let height = veyyon_gpui::px(control_height_px(size, tokens));
	let (inset, radius, ramp) = match size {
		ButtonSize::Small => (SpacingStep::S4, RadiusStep::Sm, TextRamp::Small),
		ButtonSize::Medium => (SpacingStep::S6, RadiusStep::Md, TextRamp::Body),
		ButtonSize::Large => (SpacingStep::S8, RadiusStep::Md, TextRamp::Read),
	};
	ControlMetrics {
		height,
		inset: tokens.spacing(inset),
		radius: tokens.radius(radius),
		ramp,
		square: height,
		gap: tokens.spacing(SpacingStep::S2),
		disabled_opacity: tokens.gate().unavailable,
	}
}
