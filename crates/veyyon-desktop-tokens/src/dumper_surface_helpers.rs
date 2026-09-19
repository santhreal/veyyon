use crate::{
	scale::{InlineType, ScaleTokens, TypeSize},
	schema::{RadiusStep, SpacingStep, StrokeStep, TypeSizeStep},
};

pub fn step_spacing(scale: &ScaleTokens, val: f32) -> &'static str {
	for step in SpacingStep::all() {
		if (scale.spacing(step) - val).abs() < 1e-4 {
			return step.as_token();
		}
	}
	"s4"
}

pub fn step_radius(scale: &ScaleTokens, val: f32) -> &'static str {
	for step in RadiusStep::all() {
		if (scale.radius(step) - val).abs() < 1e-4 {
			return step.as_token();
		}
	}
	"none"
}

pub fn step_stroke(scale: &ScaleTokens, val: f32) -> &'static str {
	for step in StrokeStep::all() {
		if (scale.stroke(step) - val).abs() < 1e-4 {
			return step.as_token();
		}
	}
	"hairline"
}

pub fn step_type_size(scale: &ScaleTokens, ts: &TypeSize) -> &'static str {
	for step in TypeSizeStep::all() {
		let s = scale.type_size(step);
		if (s.size - ts.size).abs() < 1e-4 && (s.line_height - ts.line_height).abs() < 1e-4 {
			return step.as_token();
		}
	}
	"read"
}

pub fn step_inline_type(scale: &ScaleTokens, it: &InlineType) -> &'static str {
	for step in TypeSizeStep::all() {
		let s = scale.type_size(step);
		if (s.size - it.size).abs() < 1e-4 && (s.tracking_em - it.tracking_em).abs() < 1e-4 {
			return step.as_token();
		}
	}
	"read"
}

pub const fn weight_str(weight: u16) -> &'static str {
	match weight {
		500 => "medium",
		600 => "semibold",
		_ => "regular",
	}
}
