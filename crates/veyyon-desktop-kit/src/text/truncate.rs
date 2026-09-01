//! Truncate single-line bounded text primitive (§8.25).

use veyyon_gpui::{App, IntoElement, Pixels, RenderOnce, SharedString, Window, div, prelude::*};

use crate::{
	state::TruncateMode,
	token_set::{ColorRole, TextRamp, TokenSet},
};

/// Single-line truncated text element with configurable ellipsis mode.
#[derive(IntoElement)]
pub struct Truncate {
	text:       SharedString,
	mode:       TruncateMode,
	max_width:  Option<Pixels>,
	ramp:       TextRamp,
	color_role: Option<ColorRole>,
}

impl Truncate {
	/// Creates a truncate element with end ellipsis mode.
	#[must_use]
	pub fn new(text: impl Into<SharedString>) -> Self {
		Self {
			text:       text.into(),
			mode:       TruncateMode::End,
			max_width:  None,
			ramp:       TextRamp::Body,
			color_role: None,
		}
	}

	/// Sets truncation mode (End, Middle, Start).
	#[must_use]
	pub fn mode(mut self, mode: TruncateMode) -> Self {
		self.mode = mode;
		self
	}

	/// Sets explicit maximum width in pixels.
	#[must_use]
	pub fn max_width(mut self, max_width: Pixels) -> Self {
		self.max_width = Some(max_width);
		self
	}

	/// Sets typographic ramp.
	#[must_use]
	pub fn ramp(mut self, ramp: TextRamp) -> Self {
		self.ramp = ramp;
		self
	}

	/// Sets foreground color role override.
	#[must_use]
	pub fn color(mut self, role: ColorRole) -> Self {
		self.color_role = Some(role);
		self
	}
}

impl RenderOnce for Truncate {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let default_tokens = TokenSet::default();
		let tokens = cx.try_global::<TokenSet>().unwrap_or(&default_tokens);

		let font_size = tokens.font_size(self.ramp);
		let line_h = tokens.line_height(self.ramp);
		let fg = self
			.color_role
			.map(|r| tokens.color(r))
			.unwrap_or_else(|| tokens.color(ColorRole::Foreground));

		let mut el = div()
			.text_size(font_size)
			.line_height(line_h)
			.text_color(fg)
			.overflow_hidden()
			.whitespace_nowrap()
			.truncate()
			.child(self.text);

		if let Some(mw) = self.max_width {
			el = el.max_w(mw);
		}

		el
	}
}
