//! Drawing the review threads and the comment being written under a diff
//! line.

use veyyon_desktop_ui::{
	controls::{Button, ButtonSize, ButtonVariant},
	theme::{Palette, TypeStyled, radius, space, text},
};
use veyyon_gpui::{ClickEvent, Context, Div, ParentElement, SharedString, Styled, div, prelude::*};

use super::DiffView;

impl DiffView {
	pub(super) fn thread_row(
		&self,
		file: usize,
		thread: u64,
		palette: &Palette,
		cx: &Context<Self>,
	) -> Div {
		let app = self.app.read(cx);
		let Some(thread) = app.reviews().threads.iter().find(|t| t.id == thread) else {
			return div();
		};
		let (id, resolved, orphaned) = (thread.id, thread.resolved, thread.orphaned);
		let line = self
			.placements
			.at
			.iter()
			.find(|(_, ids)| ids.contains(&id))
			.map(|((_, line), _)| *line);
		div()
			.m(space::S2)
			.p(space::S2)
			.flex()
			.flex_col()
			.gap(space::S1)
			.rounded(radius::MD)
			.border_1()
			.border_color(palette.border.default)
			.bg(palette.bg.elevated)
			.type_style(text::UI)
			.when(orphaned || line.is_none(), |el| {
				el.child(
					div()
						.type_style(text::MICRO)
						.text_color(palette.status.waiting)
						.child(format!(
							"Outdated \u{00b7} line {} is no longer in the diff",
							thread.anchor.original_line
						)),
				)
			})
			.children(thread.comments.iter().map(|comment| {
				div()
					.text_color(palette.text.primary)
					.child(SharedString::from(comment.clone()))
			}))
			.child(
				div()
					.flex()
					.gap(space::S1)
					.children(line.map(|line| {
						Button::new(("review-reply", id), "Reply")
							.size(ButtonSize::Sm)
							.variant(ButtonVariant::Ghost)
							.on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
								this.start_draft(file, line, Some(id), window, cx);
							}))
					}))
					.child(
						Button::new(("review-resolve", id), if resolved { "Reopen" } else { "Resolve" })
							.size(ButtonSize::Sm)
							.variant(ButtonVariant::Ghost)
							.on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
								this.set_resolved(id, !resolved, cx);
							})),
					),
			)
	}

	pub(super) fn draft_row(&self, palette: &Palette, cx: &Context<Self>) -> Div {
		let Some(draft) = &self.draft else {
			return div();
		};
		div()
			.m(space::S2)
			.p(space::S2)
			.flex()
			.flex_col()
			.gap(space::S2)
			.rounded(radius::MD)
			.border_1()
			.border_color(palette.border.strong)
			.bg(palette.bg.elevated)
			.child(draft.editor.clone())
			.child(
				div()
					.flex()
					.justify_end()
					.gap(space::S1)
					.child(
						Button::new("review-cancel", "Cancel")
							.size(ButtonSize::Sm)
							.variant(ButtonVariant::Ghost)
							.on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.cancel_draft(cx))),
					)
					.child(
						Button::new("review-save", "Comment")
							.size(ButtonSize::Sm)
							.variant(ButtonVariant::Primary)
							.on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.submit_draft(cx))),
					),
			)
	}
}
