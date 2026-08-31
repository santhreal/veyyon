//! Inspectable, removable context and attachment chips.

use gpui::{App, Div, ParentElement, Styled, div, px};
use veyyon_gui_core::{
	Store, UiCommand,
	navigation::{AttachmentKind, AttachmentState, LocalAttachment},
};
use veyyon_gui_kit::{
	theme::{Theme, radius, space},
	ui::{Badge, Button, Icon, Tone, icon, text},
};

use super::{
	logic,
	state::{ChipSlot, attachment_control},
};
use crate::act;

pub fn context_chips(store: &Store, cx: &mut App) -> Div {
	let theme = Theme::get(cx);
	let mut chips = div().flex().flex_wrap().gap(px(space::X8));
	let Some((session, draft)) = logic::selected_draft(store) else {
		return chips;
	};
	for attachment in &draft.attachments {
		chips = chips.child(chip(session, attachment, &theme));
	}
	chips
}

fn chip(
	session: &veyyon_gui_core::model::SessionId,
	attachment: &LocalAttachment,
	theme: &Theme,
) -> Div {
	let remove_owner = attachment_control(&attachment.id, ChipSlot::Remove);
	let retry_owner = attachment_control(&attachment.id, ChipSlot::Retry);
	let mut row = div()
		.flex()
		.items_center()
		.gap(px(space::X6))
		.max_w(px(veyyon_gui_kit::theme::layout::measure()))
		.px(px(space::X8))
		.py(px(space::X4))
		.rounded(px(radius::CONTROL))
		.bg(theme.sunken)
		.child(icon::base(attachment_icon(&attachment.kind), theme.text_muted))
		.child(
			text::line(attachment_label(&attachment.kind))
				.flex_1()
				.min_w(px(0.0)),
		);
	match &attachment.state {
		AttachmentState::Selected => {
			row = row.child(Badge::new("Selected").tone(Tone::Muted).bare());
		},
		AttachmentState::Uploading { progress_milli } => {
			row = row.child(
				Badge::new(format!("Uploading {}%", (*progress_milli).min(1000) / 10))
					.tone(Tone::Warn)
					.bare(),
			);
		},
		AttachmentState::Ready => {
			row = row.child(Badge::new("Ready").tone(Tone::Ok).bare());
		},
		AttachmentState::Failed { message, retryable } => {
			row = row.child(Badge::new("Upload failed").tone(Tone::Danger).bare());
			let mut retry =
				Button::new(format!("retry-attachment:{}", attachment.id), retry_owner, Icon::Retry)
					.tip("Retry upload")
					.on_click(act::click(UiCommand::RetryAttachment {
						session:    session.clone(),
						attachment: attachment.id.clone(),
					}));
			if !retryable {
				retry = retry.disabled(message.clone());
			}
			row = row.child(retry);
		},
		AttachmentState::NeedsReattach { reason } => {
			row = row
				.child(Badge::new("Attach again").tone(Tone::Warn).bare())
				.child(text::meta(reason.clone(), theme))
				.child(
					Button::new(format!("reattach:{}", attachment.id), retry_owner, Icon::Attachment)
						.tip("Attach this file again")
						.on_click(act::click(UiCommand::ReattachAttachment {
							session:    session.clone(),
							attachment: attachment.id.clone(),
						})),
				);
		},
	}
	row.child(
		Button::new(format!("remove-attachment:{}", attachment.id), remove_owner, Icon::Close)
			.tip("Remove from message")
			.on_click(act::click(UiCommand::RemoveAttachment {
				session:    session.clone(),
				attachment: attachment.id.clone(),
			})),
	)
}

fn attachment_icon(kind: &AttachmentKind) -> Icon {
	match kind {
		AttachmentKind::File { .. } | AttachmentKind::TextRange { .. } => Icon::Read,
		AttachmentKind::Image { .. } => Icon::Image,
		AttachmentKind::TerminalSelection { .. } => Icon::Ran,
		AttachmentKind::ReviewComment { .. } => Icon::Review,
	}
}

fn attachment_label(kind: &AttachmentKind) -> String {
	match kind {
		AttachmentKind::File { path } => path.clone(),
		AttachmentKind::Image { path, .. } => path.clone(),
		AttachmentKind::TextRange { path, start_line, end_line, .. } => {
			format!("{path}:{start_line}-{end_line}")
		},
		AttachmentKind::TerminalSelection { terminal, .. } => {
			format!("Terminal {terminal} selection")
		},
		AttachmentKind::ReviewComment { path, start_line, end_line, .. } => {
			format!("Review {path}:{start_line}-{end_line}")
		},
	}
}
