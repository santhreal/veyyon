//! Truncate single-line bounded text primitive (§8.25).
//!
//! One line that gives way with an ellipsis rather than wrapping, at a text
//! ramp or a mono size. It fills the width it is given, so a caller that wants
//! it to yield inside a row puts it in a `flex_1().min_w_0()` slot.

use veyyon_gpui::{App, IntoElement, Pixels, RenderOnce, SharedString, Window, div, prelude::*};

use crate::token_set::{ColorRole, MonoSizeStep, TextRamp, TokenSet};

/// The size a truncated line is set at.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TruncateSize {
	Ramp(TextRamp),
	Mono(MonoSizeStep),
}

/// Single-line text that ends in an ellipsis where it runs out of width.
#[derive(IntoElement)]
pub struct Truncate {
	text:       SharedString,
	max_width:  Option<Pixels>,
	size:       TruncateSize,
	color_role: ColorRole,
}

impl Truncate {
	/// One line of `text`.
	#[must_use]
	pub fn new(text: impl Into<SharedString>) -> Self {
		Self {
			text:       text.into(),
			max_width:  None,
			size:       TruncateSize::Ramp(TextRamp::Body),
			color_role: ColorRole::Foreground,
		}
	}

	/// Sets explicit maximum width in pixels.
	#[must_use]
	pub const fn max_width(mut self, max_width: Pixels) -> Self {
		self.max_width = Some(max_width);
		self
	}

	/// Sets typographic ramp.
	#[must_use]
	pub const fn ramp(mut self, ramp: TextRamp) -> Self {
		self.size = TruncateSize::Ramp(ramp);
		self
	}

	/// Sets the line in the mono family at a mono size.
	#[must_use]
	pub const fn mono(mut self, size: MonoSizeStep) -> Self {
		self.size = TruncateSize::Mono(size);
		self
	}

	/// Sets the ink.
	#[must_use]
	pub const fn color(mut self, role: ColorRole) -> Self {
		self.color_role = role;
		self
	}
}

impl RenderOnce for Truncate {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let resolved_tokens = TokenSet::for_app(cx);
		let tokens: &TokenSet = &resolved_tokens;

		let mut el = div()
			.w_full()
			.min_w_0()
			.overflow_hidden()
			.whitespace_nowrap()
			.truncate()
			.text_color(tokens.color(self.color_role));

		el = match self.size {
			TruncateSize::Ramp(ramp) => el
				.text_size(tokens.font_size(ramp))
				.line_height(tokens.line_height(ramp)),
			TruncateSize::Mono(size) => el
				.font_family(tokens.mono_family())
				.text_size(tokens.mono_font_size(size))
				.line_height(tokens.mono_line_height(size)),
		};

		if let Some(mw) = self.max_width {
			el = el.max_w(mw);
		}

		el.child(self.text)
	}
}
