//! Semantic status mark.
//!
//! The dot never relies on hue alone when paired with text; callers supply the
//! readable label through adjacent content or the tooltip phrase.

use gpui::{
	App, ElementId, InteractiveElement, IntoElement, RenderOnce, SharedString,
	StatefulInteractiveElement, Styled, Window, div, px,
};

use crate::theme::{StatusRole, Theme, space};

#[derive(IntoElement)]
pub struct StatusDot {
	role:  StatusRole,
	label: SharedString,
}
impl StatusDot {
	pub fn new(role: StatusRole, label: impl Into<SharedString>) -> Self {
		Self { role, label: label.into() }
	}
}
impl RenderOnce for StatusDot {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let theme = Theme::get(cx);
		let label = self.label;
		div()
			.id(ElementId::from(label.clone()))
			.size(px(space::X8))
			.rounded_full()
			.bg(theme.status(self.role))
			.tooltip(move |_window, cx| super::Tip::view(label.clone(), cx))
	}
}
