//! The peek preview: the last messages of a thread that is not open, drawn
//! under the list from the host's read-only transcript copy.

use gpui::{AnyElement, ClickEvent, Context, div, prelude::*};
use veyyon_desktop_model::{ContentBlock, MessageRole};
use veyyon_desktop_ui::{
	controls::IconButton,
	icons::IconName,
	theme::{ActiveTheme, TypeStyled, radius, space, text},
};

use super::Sidebar;

/// The most messages the preview draws, newest last.
const PREVIEW_MESSAGES: usize = 4;

impl Sidebar {
	pub(super) fn render_preview(&self, cx: &Context<Self>) -> Option<AnyElement> {
		let peek = self.peek.as_ref()?;
		let view = self.app.read(cx).store().domains.session_preview.as_ref()?;
		if &view.session != peek {
			return None;
		}
		let palette = cx.theme().palette;
		let entries = &view.transcript.value;
		let messages: Vec<(bool, String)> = entries
			.iter()
			.filter(|entry| matches!(entry.role, MessageRole::User | MessageRole::Assistant))
			.filter_map(|entry| {
				let line = entry.content.iter().find_map(|block| match block {
					ContentBlock::Text { text } => Some(text.lines().next().unwrap_or_default()),
					_ => None,
				})?;
				Some((entry.role == MessageRole::User, line.to_owned()))
			})
			.collect();
		let skip = messages.len().saturating_sub(PREVIEW_MESSAGES);
		let title = self
			.app
			.read(cx)
			.projects()
			.iter()
			.flat_map(|project| &project.sessions)
			.find(|row| &row.id == peek)
			.map_or_else(|| "Thread".to_owned(), |row| row.title.clone());
		Some(
			div()
				.flex()
				.flex_col()
				.gap(space::S1)
				.mx(space::S2)
				.mb(space::S2)
				.p(space::S2)
				.rounded(radius::LG)
				.border_1()
				.border_color(palette.border.subtle)
				.bg(palette.bg.surface)
				.type_style(text::SMALL)
				.child(
					div()
						.flex()
						.items_center()
						.gap(space::S1)
						.child(
							div()
								.flex_1()
								.min_w_0()
								.truncate()
								.type_style(text::UI_MEDIUM)
								.text_color(palette.text.primary)
								.child(title),
						)
						.child(
							div()
								.text_color(palette.text.muted)
								.child(format!("{} entries", entries.len())),
						)
						.child(
							IconButton::new("sidebar-preview-close", IconName::X)
								.tooltip("Close preview")
								.on_click(cx.listener(|this, _: &ClickEvent, _, cx| {
									this.peek = None;
									cx.notify();
								})),
						),
				)
				.children(messages.into_iter().skip(skip).map(|(user, line)| {
					div()
						.truncate()
						.text_color(if user {
							palette.text.primary
						} else {
							palette.text.secondary
						})
						.child(if user { format!("> {line}") } else { line })
				}))
				.into_any_element(),
		)
	}
}
