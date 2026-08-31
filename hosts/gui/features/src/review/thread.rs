//! Review thread card rendering.

use gpui::{AnyElement, App, InteractiveElement, IntoElement, ParentElement, Styled, div, px};
use veyyon_gui_core::{
	UiCommand,
	model::{ReviewComment, ReviewThread, ReviewThreadId},
};
use veyyon_gui_kit::{
	motion::{OwnerNamespace, control},
	theme::{Theme, space, weight},
	ui::{Badge, Button, Fill, Icon, Size, Tone, text},
};

use super::logic;
use crate::act;

const NS: OwnerNamespace = OwnerNamespace::Changes;

pub fn render_thread_card(
	thread: &ReviewThread,
	selected: bool,
	draft: Option<&str>,
	cx: &mut App,
) -> AnyElement {
	let theme = Theme::get(cx);
	let thread_id_str = thread.id.as_str();

	let mut header = div()
		.flex()
		.items_center()
		.justify_between()
		.gap(px(space::X8))
		.p(px(space::X8))
		.border_b_1()
		.border_color(theme.stroke);

	let location_text = logic::thread_location_label(&thread.path, &thread.range);
	let location_badge = Badge::new(location_text).tone(Tone::Plain);

	let status_tone = if thread.resolved {
		Tone::Ok
	} else if thread.is_orphaned() {
		Tone::Warn
	} else {
		Tone::Muted
	};
	let status_badge = Badge::new(logic::thread_status_label(thread)).tone(status_tone);

	let resolve_button = if thread.resolved {
		Button::labelled(
			format!("unresolve-thread-{}", thread_id_str),
			control(NS, "thread-resolve", thread_id_str, 0),
			"Unresolve",
		)
		.icon(Icon::Restore)
		.size(Size::Small)
		.tone(Tone::Muted)
		.fill(Fill::Ghost)
		.on_click(act::click(UiCommand::UnresolveReviewThread(thread.id.clone())))
	} else {
		Button::labelled(
			format!("resolve-thread-{}", thread_id_str),
			control(NS, "thread-resolve", thread_id_str, 0),
			"Resolve",
		)
		.icon(Icon::Check)
		.size(Size::Small)
		.tone(Tone::Accent)
		.fill(Fill::Ghost)
		.on_click(act::click(UiCommand::ResolveReviewThread(thread.id.clone())))
	};

	let delete_button = Button::new(
		format!("delete-thread-{}", thread_id_str),
		control(NS, "thread-delete", thread_id_str, 1),
		Icon::Delete,
	)
	.size(Size::Small)
	.fill(Fill::Ghost)
	.tip("Delete thread")
	.on_click(act::click(UiCommand::DeleteReviewThread(thread.id.clone())));

	header = header
		.child(
			div()
				.flex()
				.items_center()
				.gap(px(space::X6))
				.child(location_badge)
				.child(status_badge),
		)
		.child(
			div()
				.flex()
				.items_center()
				.gap(px(space::X4))
				.child(resolve_button)
				.child(delete_button),
		);

	let mut body = div().flex().flex_col().gap(px(space::X6)).p(px(space::X8));

	if let Some(orphan) = thread.orphan {
		body = body.child(
			div()
				.flex()
				.items_center()
				.gap(px(space::X6))
				.p(px(space::X6))
				.rounded_md()
				.bg(Tone::Warn.tint(&theme))
				.child(
					text::meta(format!("Orphaned: {}", orphan.label()), &theme)
						.text_color(Tone::Warn.ink(&theme)),
				),
		);
	}

	// Comments list
	for (idx, comment) in thread.comments.iter().enumerate() {
		let comment_elem = render_comment(comment, &thread.id, idx, &theme);
		body = body.child(comment_elem);
	}

	// Reply section
	let reply_section = render_reply_form(&thread.id, draft, &theme);
	body = body.child(reply_section);

	let root = div()
		.id(format!("review-thread-{}", thread_id_str))
		.flex()
		.flex_col()
		.rounded_lg()
		.border_1()
		.border_color(if selected { theme.ring } else { theme.stroke })
		.bg(theme.raised)
		.shadow_sm()
		.child(header)
		.child(body);

	root.into_any_element()
}

fn render_comment(
	comment: &ReviewComment,
	thread_id: &ReviewThreadId,
	idx: usize,
	theme: &Theme,
) -> impl IntoElement {
	let comment_id_str = comment.id.as_str();
	let delete_btn = Button::new(
		format!("delete-comment-{}", comment_id_str),
		control(NS, "comment-delete", comment_id_str, idx as u8),
		Icon::Close,
	)
	.size(Size::Small)
	.fill(Fill::Ghost)
	.tip("Delete comment")
	.on_click(act::click(UiCommand::DeleteReviewComment {
		thread_id:  thread_id.clone(),
		comment_id: comment.id.clone(),
	}));

	div()
		.flex()
		.flex_col()
		.gap(px(space::X4))
		.p(px(space::X6))
		.rounded_md()
		.bg(theme.raised)
		.child(
			div()
				.flex()
				.items_center()
				.justify_between()
				.child(
					text::body(comment.author.clone(), theme)
						.font_weight(weight::MEDIUM)
						.text_color(theme.text),
				)
				.child(delete_btn),
		)
		.child(text::note_wrapping(comment.text.clone(), theme).text_color(theme.text_muted))
}

fn render_reply_form(
	thread_id: &ReviewThreadId,
	draft: Option<&str>,
	theme: &Theme,
) -> impl IntoElement {
	let thread_id_str = thread_id.as_str();
	let draft_text = draft.unwrap_or("").to_string();

	let tid = thread_id.clone();
	let mut reply_btn = Button::labelled(
		format!("submit-reply-{}", thread_id_str),
		control(NS, "reply-submit", thread_id_str, 2),
		"Reply",
	)
	.icon(Icon::Send)
	.size(Size::Small)
	.tone(Tone::Accent)
	.fill(Fill::Solid);
	if draft_text.trim().is_empty() {
		reply_btn = reply_btn.disabled("Reply cannot be empty");
	} else {
		reply_btn = reply_btn.on_click(act::click(UiCommand::ReplyReviewThread {
			thread_id: tid,
			text:      draft_text.clone(),
		}));
	}

	div()
		.flex()
		.flex_col()
		.gap(px(space::X4))
		.pt(px(space::X4))
		.border_t_1()
		.border_color(theme.stroke)
		.child(div().flex().items_center().justify_end().child(reply_btn))
}
