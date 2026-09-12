//! Standard text display primitive (§8.25).

use veyyon_gpui::{App, IntoElement, RenderOnce, SharedString, Window, div, prelude::*};

use crate::token_set::{ColorRole, TextRamp, TextWeight, TokenSet};

/// Visual typography text primitive element.
#[derive(IntoElement)]
pub struct Text {
	content:    SharedString,
	ramp:       TextRamp,
	weight:     TextWeight,
	color_role: ColorRole,
	italic:     bool,
}

impl Text {
	/// Creates text element with content string.
	#[must_use]
	pub fn new(content: impl Into<SharedString>) -> Self {
		Self {
			content:    content.into(),
			ramp:       TextRamp::Body,
			weight:     TextWeight::default(),
			color_role: ColorRole::Foreground,
			italic:     false,
		}
	}

	/// Sets typography ramp step.
	#[must_use]
	pub fn ramp(mut self, ramp: TextRamp) -> Self {
		self.ramp = ramp;
		self
	}

	/// Sets typography weight.
	#[must_use]
	pub fn weight(mut self, weight: TextWeight) -> Self {
		self.weight = weight;
		self
	}

	/// Sets color role.
	#[must_use]
	pub fn color(mut self, role: ColorRole) -> Self {
		self.color_role = role;
		self
	}

	/// Sets italic style.
	#[must_use]
	pub fn italic(mut self, italic: bool) -> Self {
		self.italic = italic;
		self
	}
}

impl RenderOnce for Text {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let resolved_tokens = TokenSet::for_app(cx);
		let tokens: &TokenSet = &resolved_tokens;

		let font_size = tokens.font_size(self.ramp);
		let line_h = tokens.line_height(self.ramp);
		let fg = tokens.color(self.color_role);
		let weight = tokens.font_weight(self.weight);

		let mut el = div()
			.text_size(font_size)
			.line_height(line_h)
			.text_color(fg)
			.font_weight(weight)
			.child(self.content);

		if self.italic {
			el = el.italic();
		}

		el
	}
}
