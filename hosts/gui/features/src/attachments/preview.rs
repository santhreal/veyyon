//! Inline preview rendering for image, text, and binary attachments.

use std::sync::Arc;

use gpui::{
	App, Div, Image, ImageFormat, ObjectFit, ParentElement, Styled, StyledImage, div, img, px,
};
use veyyon_gui_core::{
	UiCommand,
	model::SessionId,
	navigation::{AttachmentKind, AttachmentState, LocalAttachment},
};
use veyyon_gui_kit::{
	theme::{Theme, layout, radius, row, space},
	ui::{Badge, Button, Icon, Tone, icon, text},
};

use super::state::{PreviewSlot, preview_control};
use crate::act;

pub fn render_attachment_preview(
	session: &SessionId,
	attachment: &LocalAttachment,
	theme: &Theme,
	cx: &mut App,
) -> Div {
	let remove_key = preview_control(&attachment.id, PreviewSlot::Remove);
	let retry_key = preview_control(&attachment.id, PreviewSlot::Retry);

	let header = div()
		.flex()
		.items_center()
		.gap(px(space::X6))
		.w_full()
		.min_w(px(0.0))
		.child(icon::base(attachment_icon(&attachment.kind), theme.text_muted))
		.child(
			text::line(attachment_label(&attachment.kind))
				.flex_1()
				.min_w(px(0.0)),
		)
		.child(text::meta(
			format!("{} • {}", attachment.display_type(), attachment.formatted_size()),
			theme,
		))
		.child(status_badge(&attachment.state))
		.children(action_buttons(session, attachment, remove_key, retry_key));

	let body = preview_body(attachment, theme, cx);

	let mut card = div()
		.flex()
		.flex_col()
		.gap(px(space::X6))
		.p(px(space::X8))
		.w_full()
		.min_w(px(0.0))
		.max_w(px(layout::measure()))
		.rounded(px(radius::CARD))
		.bg(theme.sunken)
		.border_1()
		.border_color(theme.stroke)
		.child(header)
		.child(body);

	if let Some(footer) = status_footer(&attachment.state, theme) {
		card = card.child(footer);
	}

	card
}

fn preview_body(attachment: &LocalAttachment, theme: &Theme, cx: &mut App) -> Div {
	if attachment.is_image() {
		render_image_preview(attachment, theme, cx)
	} else if attachment.is_text() {
		render_text_preview(attachment, theme)
	} else {
		render_binary_preview(attachment, theme)
	}
}

fn render_image_preview(attachment: &LocalAttachment, theme: &Theme, _cx: &mut App) -> Div {
	if let Some(bytes) = &attachment.preview_bytes {
		let format = match attachment.display_type().as_str() {
			"image/jpeg" | "image/jpg" => ImageFormat::Jpeg,
			"image/webp" => ImageFormat::Webp,
			"image/gif" => ImageFormat::Gif,
			"image/bmp" => ImageFormat::Bmp,
			"image/tiff" => ImageFormat::Tiff,
			"image/x-icon" | "image/vnd.microsoft.icon" => ImageFormat::Ico,
			"image/svg+xml" => ImageFormat::Svg,
			_ => ImageFormat::Png,
		};
		let image = Arc::new(Image::from_bytes(format, bytes.clone()));
		div()
			.flex()
			.items_center()
			.justify_center()
			.w_full()
			.min_w(px(0.0))
			.max_h(px(layout::composer_max_height()))
			.overflow_hidden()
			.rounded(px(radius::CONTROL))
			.bg(theme.raised)
			.child(
				img(image)
					.max_w(px(layout::SIDEBAR_MIN))
					.max_h(px(layout::composer_max_height()))
					.rounded(px(radius::CONTROL))
					.object_fit(ObjectFit::Contain),
			)
	} else {
		div()
			.flex()
			.items_center()
			.justify_center()
			.gap(px(space::X6))
			.w_full()
			.min_w(px(0.0))
			.h(px(row::two_line()))
			.rounded(px(radius::CONTROL))
			.bg(theme.raised)
			.child(icon::base(Icon::Image, theme.text_muted))
			.child(text::meta(attachment_label(&attachment.kind), theme))
	}
}

fn render_text_preview(attachment: &LocalAttachment, theme: &Theme) -> Div {
	let preview_lines = text_preview_lines(attachment);
	let mut container = div()
		.flex()
		.flex_col()
		.gap(px(space::X2))
		.p(px(space::X6))
		.w_full()
		.min_w(px(0.0))
		.max_h(px(layout::composer_max_height()))
		.overflow_hidden()
		.rounded(px(radius::CONTROL))
		.bg(theme.raised);

	for (line_num, line_text) in preview_lines.iter().enumerate() {
		let line_row = div()
			.flex()
			.items_center()
			.gap(px(space::X6))
			.w_full()
			.min_w(px(0.0))
			.child(text::meta(format!("{:>2}", line_num + 1), theme))
			.child(text::mono(line_text.clone(), theme).flex_1().min_w(px(0.0)));
		container = container.child(line_row);
	}
	container
}

fn text_preview_lines(attachment: &LocalAttachment) -> Vec<String> {
	if let Some(text) = &attachment.preview_text {
		text.lines().take(3).map(str::to_owned).collect()
	} else {
		match &attachment.kind {
			AttachmentKind::TextRange { text, .. }
			| AttachmentKind::TerminalSelection { text, .. }
			| AttachmentKind::ReviewComment { text, .. } => {
				text.lines().take(3).map(str::to_owned).collect()
			},
			AttachmentKind::File { path } => {
				vec![format!("Source file: {path}")]
			},
			AttachmentKind::Image { .. } => Vec::new(),
		}
	}
}

fn render_binary_preview(attachment: &LocalAttachment, theme: &Theme) -> Div {
	div()
		.flex()
		.items_center()
		.gap(px(space::X6))
		.p(px(space::X6))
		.w_full()
		.min_w(px(0.0))
		.h(px(row::normal()))
		.rounded(px(radius::CONTROL))
		.bg(theme.raised)
		.child(icon::base(Icon::Read, theme.text_muted))
		.child(
			text::line(format!(
				"Binary file • {} ({})",
				attachment.display_type(),
				attachment.formatted_size()
			))
			.flex_1()
			.min_w(px(0.0)),
		)
}

fn status_badge(state: &AttachmentState) -> Badge {
	match state {
		AttachmentState::Selected => Badge::new("Selected").tone(Tone::Muted).bare(),
		AttachmentState::Uploading { progress_milli } => {
			Badge::new(format!("Uploading {}%", (*progress_milli).min(1000) / 10))
				.tone(Tone::Warn)
				.bare()
		},
		AttachmentState::Ready => Badge::new("Ready").tone(Tone::Ok).bare(),
		AttachmentState::Failed { .. } => Badge::new("Failed").tone(Tone::Danger).bare(),
		AttachmentState::Refused { .. } => Badge::new("Refused").tone(Tone::Danger).bare(),
		AttachmentState::NeedsReattach { .. } => Badge::new("Attach again").tone(Tone::Warn).bare(),
	}
}

fn action_buttons(
	session: &SessionId,
	attachment: &LocalAttachment,
	remove_key: veyyon_gui_kit::motion::RetainedKey,
	retry_key: veyyon_gui_kit::motion::RetainedKey,
) -> Vec<Button> {
	let mut buttons = Vec::new();
	match &attachment.state {
		AttachmentState::Failed { message, retryable } => {
			let mut retry =
				Button::new(format!("retry-preview:{}", attachment.id), retry_key, Icon::Retry)
					.tip("Retry upload")
					.on_click(act::click(UiCommand::RetryAttachment {
						session:    session.clone(),
						attachment: attachment.id.clone(),
					}));
			if !retryable {
				retry = retry.disabled(message.clone());
			}
			buttons.push(retry);
		},
		AttachmentState::Refused { .. } => {
			let retry =
				Button::new(format!("retry-preview:{}", attachment.id), retry_key, Icon::Retry)
					.tip("Retry attachment")
					.on_click(act::click(UiCommand::RetryAttachment {
						session:    session.clone(),
						attachment: attachment.id.clone(),
					}));
			buttons.push(retry);
		},
		AttachmentState::NeedsReattach { .. } => {
			let reattach =
				Button::new(format!("reattach-preview:{}", attachment.id), retry_key, Icon::Attachment)
					.tip("Attach this file again")
					.on_click(act::click(UiCommand::ReattachAttachment {
						session:    session.clone(),
						attachment: attachment.id.clone(),
					}));
			buttons.push(reattach);
		},
		AttachmentState::Selected | AttachmentState::Uploading { .. } | AttachmentState::Ready => {},
	}
	buttons.push(
		Button::new(format!("remove-preview:{}", attachment.id), remove_key, Icon::Close)
			.tip("Remove from message")
			.on_click(act::click(UiCommand::RemoveAttachment {
				session:    session.clone(),
				attachment: attachment.id.clone(),
			})),
	);
	buttons
}

fn status_footer(state: &AttachmentState, theme: &Theme) -> Option<Div> {
	match state {
		AttachmentState::Failed { message, .. } => Some(
			div()
				.flex()
				.items_center()
				.gap(px(space::X4))
				.px(px(space::X4))
				.py(px(space::X2))
				.rounded(px(radius::CONTROL))
				.bg(theme.sunken)
				.child(icon::base(Icon::Close, theme.danger))
				.child(text::meta(message.clone(), theme)),
		),
		AttachmentState::Refused { reason } => Some(
			div()
				.flex()
				.items_center()
				.gap(px(space::X4))
				.px(px(space::X4))
				.py(px(space::X2))
				.rounded(px(radius::CONTROL))
				.bg(theme.sunken)
				.child(icon::base(Icon::Close, theme.danger))
				.child(text::meta(reason.reason_text(), theme)),
		),
		AttachmentState::NeedsReattach { reason } => Some(
			div()
				.flex()
				.items_center()
				.gap(px(space::X4))
				.px(px(space::X4))
				.py(px(space::X2))
				.rounded(px(radius::CONTROL))
				.bg(theme.sunken)
				.child(icon::base(Icon::Attachment, theme.text_muted))
				.child(text::meta(reason.clone(), theme)),
		),
		AttachmentState::Selected | AttachmentState::Uploading { .. } | AttachmentState::Ready => {
			None
		},
	}
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
