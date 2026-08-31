//! Composer chrome shared by conversation, review, terminal, and overlays.
//!
//! Pending context strips, required-decision banners, the editor, and action
//! rows form one clipped silhouette. The editor entity remains a caller value;
//! this primitive does not read drafts, attachments, or runtime state.

use gpui::{AnyElement, App, IntoElement, ParentElement, RenderOnce, Styled, Window, div, px};

use crate::theme::{Theme, layout, radius, space};

#[derive(IntoElement)]
pub struct ComposerChrome {
	banners:  Vec<AnyElement>,
	editor:   Option<AnyElement>,
	context:  Vec<AnyElement>,
	toolbar:  Vec<AnyElement>,
	footer:   Vec<AnyElement>,
	expanded: bool,
}
impl ComposerChrome {
	pub fn new(editor: impl IntoElement) -> Self {
		Self {
			banners:  Vec::new(),
			editor:   Some(editor.into_any_element()),
			context:  Vec::new(),
			toolbar:  Vec::new(),
			footer:   Vec::new(),
			expanded: false,
		}
	}

	pub fn banner(mut self, banner: impl IntoElement) -> Self {
		self.banners.push(banner.into_any_element());
		self
	}

	pub fn context(mut self, item: impl IntoElement) -> Self {
		self.context.push(item.into_any_element());
		self
	}

	pub fn toolbar(mut self, item: impl IntoElement) -> Self {
		self.toolbar.push(item.into_any_element());
		self
	}

	pub fn footer(mut self, item: impl IntoElement) -> Self {
		self.footer.push(item.into_any_element());
		self
	}

	pub fn expanded(mut self, expanded: bool) -> Self {
		self.expanded = expanded;
		self
	}
}
impl ParentElement for ComposerChrome {
	fn extend(&mut self, items: impl IntoIterator<Item = AnyElement>) {
		self.context.extend(items);
	}
}
impl RenderOnce for ComposerChrome {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let theme = Theme::get(cx);
		div()
			.w_full()
			.min_h(px(layout::composer_min_height()))
			.max_h(px(layout::composer_max_height()))
			.flex()
			.flex_col()
			.overflow_hidden()
			.rounded(px(radius::COMPOSER))
			.bg(theme.raised)
			.border_1()
			.border_color(theme.stroke)
			.shadow(theme.shadow_card())
			.children(self.banners)
			.children((!self.context.is_empty()).then(|| {
				div()
					.flex()
					.flex_wrap()
					.gap(px(space::X4))
					.px(px(space::X10))
					.pt(px(space::X8))
					.children(self.context)
			}))
			.children(self.expanded.then(|| {
				div()
					.flex()
					.items_center()
					.gap(px(space::X4))
					.px(px(space::X10))
					.pt(px(space::X6))
					.children(self.toolbar)
			}))
			.children(self.editor.map(|editor| {
				div()
					.flex_1()
					.min_h(px(0.0))
					.min_h(px(layout::editor_single_line()))
					.px(px(space::X10))
					.py(px(space::X8))
					.child(editor)
			}))
			.children((!self.footer.is_empty()).then(|| {
				div()
					.flex()
					.items_center()
					.gap(px(space::X4))
					.px(px(space::X8))
					.pb(px(space::X8))
					.children(self.footer)
			}))
	}
}
