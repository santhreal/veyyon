//! Review thread popover composed from the shared editor, buttons and float
//! primitive.

use std::time::Instant;

use veyyon_desktop_kit::{
	AnchorCorner, Button, ButtonSize, ColorRole, Popover, SpacingStep, TextField, TextRamp,
};
use veyyon_desktop_model::{
	ChangeScope,
	review::{ReviewPlacement, ReviewSide},
};
use veyyon_gpui::{
	AnyElement, ClickEvent, Context, ElementId, InteractiveElement, IntoElement, ParentElement,
	Size, StatefulInteractiveElement, Styled, Window, div, px,
};

use crate::{ShellView, right_panel::review::placement};

impl ShellView {
	/// Draws the local review popover above panel content and below
	/// announcements.
	pub fn review_layer(
		&mut self,
		window: &mut Window,
		cx: &mut Context<Self>,
	) -> Option<AnyElement> {
		self.review.repository.as_ref()?;
		if !self.review.open
			&& let Some(focus) = self.review.return_focus.take()
		{
			window.focus(&focus, cx);
		}
		let frame = self.review.motion.sample(
			self.review.open,
			Instant::now(),
			&self.installed.motion,
			self.rail_motion.is_reduced_motion(),
		);
		if !self.review.open && frame.settled {
			return None;
		}
		if !frame.settled {
			let entity = cx.entity();
			window.on_next_frame(move |_, app| entity.update(app, |_, cx| cx.notify()));
		}
		let tokens = &self.installed.set;
		let palette = &self.installed.surface.palette;
		let margin = tokens.spacing(SpacingStep::S2);
		let inset = tokens.spacing(SpacingStep::S4) * 2.0 + px(2.0);
		let viewport = window.viewport_size();
		let size = Size {
			width:  px(palette.anchored_width_px).min(viewport.width - margin * 2.0),
			height: px(palette.max_height_px).min(viewport.height - margin * 2.0),
		};
		let mut list = div()
			.id("review-thread-list")
			.w_full()
			.min_w_0()
			.min_h_0()
			.overflow_y_scroll()
			.flex()
			.flex_col()
			.gap(tokens.spacing(SpacingStep::S3));
		let mut count = 0;
		for thread in &self.review.store.threads {
			if !self
				.review
				.repository
				.as_ref()
				.is_some_and(|(repository, scope)| {
					*repository == thread.anchor.repository && *scope == thread.anchor.scope
				}) || self
				.review
				.file
				.as_ref()
				.is_some_and(|file| *file != thread.anchor.file)
			{
				continue;
			}
			count += 1;
			let id = thread.id;
			let resolved = thread.resolved;
			let location = match placement(&self.state.panel, thread) {
				ReviewPlacement::Attached(line) => format!(
					"{} line {line} · {}",
					side_label(thread.anchor.side),
					if resolved { "Resolved" } else { "Unresolved" }
				),
				ReviewPlacement::Missing => {
					"Orphaned · line or context no longer in this diff".to_owned()
				},
				ReviewPlacement::Ambiguous => "Orphaned · duplicate contextual matches".to_owned(),
			};
			let mut row = div()
				.w_full()
				.min_w_0()
				.flex_shrink_0()
				.flex()
				.flex_col()
				.gap(tokens.spacing(SpacingStep::S1))
				.child(
					div()
						.w_full()
						.min_w_0()
						.truncate()
						.child(thread.anchor.file.clone()),
				)
				.child(div().w_full().min_w_0().truncate().child(location))
				.child(
					div()
						.w_full()
						.min_w_0()
						.truncate()
						.text_color(tokens.color(ColorRole::Muted))
						.child(thread.anchor.text.clone()),
				);
			for comment in &thread.comments {
				row = row.child(
					div()
						.w_full()
						.min_w_0()
						.overflow_hidden()
						.child(comment.clone()),
				);
			}
			row = row.child(
				div()
					.flex()
					.gap(tokens.spacing(SpacingStep::S2))
					.child(
						Button::new(ElementId::Name(format!("review-reply-{id}").into()), "Reply")
							.size(ButtonSize::Small)
							.on_click(cx.listener(move |view, _: &ClickEvent, window, cx| {
								view.reply_to_review(id, window, cx);
							})),
					)
					.child(
						Button::new(
							ElementId::Name(format!("review-resolve-{id}").into()),
							if resolved { "Reopen" } else { "Resolve" },
						)
						.size(ButtonSize::Small)
						.on_click(cx.listener(move |view, _: &ClickEvent, _, cx| {
							view.review.store.set_resolved(id, !resolved);
							cx.notify();
						})),
					),
			);
			list = list.child(row);
		}
		if count == 0 {
			list = list.child("No local review threads");
		}
		let mut body = div()
			.w(size.width - inset)
			.max_h(size.height - inset)
			.min_h_0()
			.flex()
			.flex_col()
			.gap(tokens.spacing(SpacingStep::S2))
			.text_size(tokens.font_size(TextRamp::Small))
			.line_height(tokens.line_height(TextRamp::Small))
			.text_color(tokens.color(ColorRole::Foreground))
			.child(div().flex_shrink_0().child("Local review"))
			.children(self.review.repository.as_ref().map(|(repository, scope)| {
				let scope = match scope {
					ChangeScope::WorkingTree => "Working tree",
					ChangeScope::Staged => "Staged",
				};
				div()
					.w_full()
					.min_w_0()
					.flex_shrink_0()
					.truncate()
					.child(format!("{repository} · {scope}"))
			}))
			.child(list);
		let mut footer = div()
			.w_full()
			.min_w_0()
			.flex_shrink_0()
			.flex()
			.flex_col()
			.gap(tokens.spacing(SpacingStep::S2));
		if let Some(anchor) = &self.review.draft {
			footer = footer.child(div().w_full().min_w_0().truncate().child(format!(
				"Comment on {} · {} line {}",
				anchor.file,
				side_label(anchor.side),
				anchor.original_line
			)));
		} else if let Some(id) = self.review.reply {
			footer = footer.child(format!("Reply to thread {id}"));
		}
		if self.review.draft.is_some() || self.review.reply.is_some() {
			footer = footer.children(
				self
					.review
					.editor
					.clone()
					.map(|editor| TextField::new("review-comment", editor)),
			);
			footer = footer.child(
				Button::new("review-post", "Post comment")
					.size(ButtonSize::Small)
					.on_click(cx.listener(|view, _: &ClickEvent, _, cx| view.post_review(cx))),
			);
		}
		if let Some(error) = &self.review.error {
			footer = footer.child(div().w_full().min_w_0().child(error.clone()));
		}
		footer = footer.child(
			Button::new("review-close", "Close")
				.size(ButtonSize::Small)
				.on_click(
					cx.listener(|view, _: &ClickEvent, window, cx| view.close_review(window, cx)),
				),
		);
		body = body.child(footer);
		let mut body =
			crate::right_panel::with_panel_keys(body.id("review-body"), &self.state.panel, cx);
		if let Some(focus) = &self.review.focus {
			body = body.track_focus(focus);
		}
		let entity = cx.weak_entity();
		let popover = Popover::new(self.review.origin, AnchorCorner::TopLeft, body)
			.id("review-popover")
			.size(size)
			.entrance(frame)
			.on_dismiss(move |window, app| {
				if let Some(entity) = entity.upgrade() {
					entity.update(app, |view, cx| view.close_review(window, cx));
				}
			});
		Some(popover.into_any_element())
	}
}

const fn side_label(side: ReviewSide) -> &'static str {
	match side {
		ReviewSide::Old => "Old",
		ReviewSide::New => "New",
	}
}
