//! Tooltip wrapper primitive (§8.25).
//!
//! The tag stays invisible until the pointer rests on the anchor, which the
//! renderer tracks through a hover group named after the tooltip's identity.
//! Layout is unaffected: the tag is absolutely positioned below the anchor.

use veyyon_gpui::{
	AnyElement, App, IntoElement, RenderOnce, SharedString, Window, div, prelude::*,
};

use crate::token_set::{ColorRole, RadiusStep, SpacingStep, TextRamp, TokenSet};

/// Floating tooltip indicator tag element.
#[derive(IntoElement)]
pub struct Tooltip {
	text:   SharedString,
	anchor: AnyElement,
	group:  SharedString,
}

impl Tooltip {
	/// Creates a tooltip with text content and anchor element. Two tooltips
	/// with the same text share one hover group.
	#[must_use]
	pub fn new(text: impl Into<SharedString>, anchor: impl IntoElement) -> Self {
		let text = text.into();
		let group: SharedString = format!("tooltip:{text}").into();
		Self { text, anchor: anchor.into_any_element(), group }
	}

	/// Names the hover group, for a tooltip whose text is shared by others on
	/// the same surface.
	#[must_use]
	pub fn group(mut self, group: impl Into<SharedString>) -> Self {
		self.group = group.into();
		self
	}
}

impl RenderOnce for Tooltip {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let resolved_tokens = TokenSet::for_app(cx);
		let tokens: &TokenSet = &resolved_tokens;

		let bg = tokens.color(ColorRole::Float);
		let border_color = tokens.color(ColorRole::Hairline);
		let radius = tokens.radius(RadiusStep::Sm);
		let pad_x = tokens.spacing(SpacingStep::S2);
		let pad_y = tokens.spacing(SpacingStep::S1);
		let font_size = tokens.font_size(TextRamp::Small);

		let tag = div()
			.absolute()
			.top_full()
			.left_0()
			.mt(pad_y)
			.invisible()
			.group_hover(self.group.clone(), |s| s.visible())
			.bg(bg)
			.rounded(radius)
			.border_1()
			.border_color(border_color)
			.px(pad_x)
			.py(pad_y)
			.text_size(font_size)
			.text_color(tokens.color(ColorRole::Foreground))
			.shadow_md()
			.whitespace_nowrap()
			.child(self.text);

		div()
			.group(self.group)
			.relative()
			.max_w_full()
			.child(self.anchor)
			.child(tag)
	}
}
