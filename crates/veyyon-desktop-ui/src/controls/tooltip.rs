//! The label shown beside a hovered control.

use veyyon_gpui::{
	AnyView, App, Context, IntoElement, Render, SharedString, Window, div, prelude::*,
};

use super::Kbd;
use crate::theme::{ActiveTheme, TypeStyled, radius, space, text};

/// A small raised label with the name of an action and, optionally, its
/// keyboard shortcut.
///
/// An element shows one while hovered through
/// `.tooltip(Tooltip::text("Search"))`.
pub struct Tooltip {
	text:     SharedString,
	shortcut: Option<Kbd>,
}

impl Tooltip {
	/// Builds a tooltip that shows `text`.
	pub fn text(
		text: impl Into<SharedString>,
	) -> impl Fn(&mut Window, &mut App) -> AnyView + 'static {
		Self::builder(text, None)
	}

	/// Builds a tooltip that shows `text` followed by `shortcut`.
	pub fn with_shortcut(
		text: impl Into<SharedString>,
		shortcut: Kbd,
	) -> impl Fn(&mut Window, &mut App) -> AnyView + 'static {
		Self::builder(text, Some(shortcut))
	}

	/// Builds a tooltip that shows `text` followed by `shortcut` when one is
	/// given.
	pub fn builder(
		text: impl Into<SharedString>,
		shortcut: Option<Kbd>,
	) -> impl Fn(&mut Window, &mut App) -> AnyView + 'static {
		let text = text.into();
		move |_window, cx| {
			cx.new(|_| Self { text: text.clone(), shortcut: shortcut.clone() })
				.into()
		}
	}
}

impl Render for Tooltip {
	fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
		let palette = cx.theme().palette;
		div()
			.flex()
			.items_center()
			.gap(space::S2)
			.px(space::S2)
			.py(space::S1)
			.rounded(radius::MD)
			.border_1()
			.border_color(palette.border.default)
			.bg(palette.bg.elevated)
			.shadow_md()
			.type_style(text::SMALL)
			.text_color(palette.text.primary)
			.child(self.text.clone())
			.children(self.shortcut.clone())
	}
}
