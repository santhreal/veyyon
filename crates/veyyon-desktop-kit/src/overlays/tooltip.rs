//! Tooltip wrapper primitive (§8.25).

use veyyon_gpui::{
	AnyElement, App, IntoElement, RenderOnce, SharedString, Window, div, prelude::*,
};

use crate::token_set::{ColorRole, RadiusStep, SpacingStep, TextRamp, TokenSet};

/// Floating tooltip indicator tag element.
#[derive(IntoElement)]
pub struct Tooltip {
	text:   SharedString,
	anchor: AnyElement,
}

impl Tooltip {
	/// Creates a tooltip with text content and anchor element.
	#[must_use]
	pub fn new(text: impl Into<SharedString>, anchor: impl IntoElement) -> Self {
		Self { text: text.into(), anchor: anchor.into_any_element() }
	}
}

impl RenderOnce for Tooltip {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let default_tokens = TokenSet::default();
		let tokens = cx.try_global::<TokenSet>().unwrap_or(&default_tokens);

		let bg = tokens.color(ColorRole::Float);
		let border_color = tokens.color(ColorRole::Hairline);
		let radius = tokens.radius(RadiusStep::Sm);
		let pad_x = tokens.spacing(SpacingStep::S2);
		let pad_y = tokens.spacing(SpacingStep::S1);
		let font_size = tokens.font_size(TextRamp::Small);

		let tag = div()
			.bg(bg)
			.rounded(radius)
			.border_1()
			.border_color(border_color)
			.px(pad_x)
			.py(pad_y)
			.text_size(font_size)
			.text_color(tokens.color(ColorRole::Foreground))
			.shadow_md()
			.max_w_full()
			.overflow_hidden()
			.whitespace_nowrap()
			.truncate()
			.child(self.text);

		div()
			.relative()
			.max_w_full()
			.overflow_hidden()
			.child(self.anchor)
			.child(tag)
	}
}
