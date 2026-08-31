//! Fixed-height route and panel toolbar.
//!
//! Leading, center, and trailing slots keep titles optically centered while
//! actions appear or disappear. The caller supplies values and controls only.

use gpui::{AnyElement, App, IntoElement, ParentElement, RenderOnce, Styled, Window, div, px};

use crate::theme::{Theme, layout, space};

#[derive(IntoElement)]
pub struct Toolbar {
	leading:  Vec<AnyElement>,
	center:   Vec<AnyElement>,
	trailing: Vec<AnyElement>,
	raised:   bool,
}
impl Toolbar {
	pub fn new() -> Self {
		Self { leading: Vec::new(), center: Vec::new(), trailing: Vec::new(), raised: false }
	}

	pub fn leading(mut self, item: impl IntoElement) -> Self {
		self.leading.push(item.into_any_element());
		self
	}

	pub fn center(mut self, item: impl IntoElement) -> Self {
		self.center.push(item.into_any_element());
		self
	}

	pub fn trailing(mut self, item: impl IntoElement) -> Self {
		self.trailing.push(item.into_any_element());
		self
	}

	pub fn raised(mut self) -> Self {
		self.raised = true;
		self
	}
}
impl Default for Toolbar {
	fn default() -> Self {
		Self::new()
	}
}
impl RenderOnce for Toolbar {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let theme = Theme::get(cx);
		div()
			.relative()
			.flex()
			.items_center()
			.w_full()
			.h(px(layout::toolbar()))
			.px(px(space::X12))
			.bg(if self.raised {
				theme.raised
			} else {
				gpui::transparent_black()
			})
			.child(
				div()
					.flex()
					.items_center()
					.gap(px(space::X6))
					.min_w(px(0.0))
					.children(self.leading),
			)
			.child(
				div()
					.absolute()
					.inset_0()
					.flex()
					.items_center()
					.justify_center()
					.children(self.center),
			)
			.child(
				div()
					.ml_auto()
					.flex()
					.items_center()
					.justify_end()
					.gap(px(space::X4))
					.children(self.trailing),
			)
	}
}
