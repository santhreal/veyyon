//! Typed file read errors and route-level state indicators.

use gpui::{ParentElement, Styled, div, px};
use veyyon_gui_core::{
	Store, UiCommand,
	model::{FileReadError, FileReadErrorKind},
};
use veyyon_gui_kit::{
	motion::{OwnerNamespace, RetainedKey},
	theme::space,
	ui::{Button, Empty, Fill, Icon, Row, Tone, text},
};

use crate::act;

const STATE_ACTION_OWNER: RetainedKey = RetainedKey::semantic(OwnerNamespace::Files, 35);
const LOADING_PRIMARY_OWNER: RetainedKey = RetainedKey::semantic(OwnerNamespace::Files, 36);
const LOADING_SECONDARY_OWNER: RetainedKey = RetainedKey::semantic(OwnerNamespace::Files, 37);

pub fn render_file_read_error(error: &FileReadError, store: &Store) -> gpui::Div {
	let retry_command = error
		.retryable
		.then(|| {
			store
				.frontend
				.selected_file
				.clone()
				.map(|file| UiCommand::ReadFile { file, range: None })
		})
		.flatten();

	match error.kind {
		FileReadErrorKind::NotFound => state_empty(
			"File not found",
			if error.message.is_empty() {
				"The file was not found or has been deleted."
			} else {
				&error.message
			},
			Icon::Search,
			retry_command,
		),
		FileReadErrorKind::PermissionDenied => state_empty(
			"Permission denied",
			if error.message.is_empty() {
				"You do not have permission to read this file."
			} else {
				&error.message
			},
			Icon::Secret,
			retry_command,
		),
		FileReadErrorKind::Binary => state_empty(
			"Binary file",
			if error.message.is_empty() {
				"Binary contents are not shown."
			} else {
				&error.message
			},
			Icon::Read,
			None,
		),
		FileReadErrorKind::TooLarge => state_empty(
			"File too large",
			if error.message.is_empty() {
				"The file exceeds the host preview size limit."
			} else {
				&error.message
			},
			Icon::Notice,
			None,
		),
		FileReadErrorKind::Transport => state_empty(
			"Transport error",
			if error.message.is_empty() {
				"Failed to transfer file contents from host."
			} else {
				&error.message
			},
			Icon::Disconnected,
			retry_command,
		),
		FileReadErrorKind::Other => {
			state_empty("Unable to read file", &error.message, Icon::Failed, retry_command)
		},
	}
}

pub fn loading(label: &str) -> gpui::Div {
	div()
		.flex()
		.flex_col()
		.size_full()
		.p(px(space::WIDE))
		.child(
			text::stack(space::ROWS)
				.child(
					Row::new("file-loading-primary", LOADING_PRIMARY_OWNER, label.to_owned())
						.icon(Icon::Running)
						.tone(Tone::Muted),
				)
				.child(
					Row::new("file-loading-secondary", LOADING_SECONDARY_OWNER, "Waiting for host data")
						.tone(Tone::Muted),
				),
		)
}

pub fn stale_reason(reason: &veyyon_gui_core::model::StaleReason) -> String {
	match reason {
		veyyon_gui_core::model::StaleReason::Disconnected => "disconnected".to_owned(),
		veyyon_gui_core::model::StaleReason::Reconnecting => "reconnecting".to_owned(),
		veyyon_gui_core::model::StaleReason::RevisionGap { expected, received } => {
			format!("revision gap (expected {expected}, received {received})")
		},
		veyyon_gui_core::model::StaleReason::RefreshFailed(message) => message.clone(),
	}
}

pub fn state_empty(title: &str, note: &str, icon: Icon, action: Option<UiCommand>) -> gpui::Div {
	let mut empty = Empty::new(title.to_owned())
		.icon(icon)
		.note(note.to_owned())
		.filling();
	if let Some(action) = action {
		let label = match &action {
			UiCommand::Attach { .. } => "Attach",
			_ => "Retry",
		};
		empty = empty.child(
			Button::labelled("files-state-action", STATE_ACTION_OWNER, label)
				.fill(Fill::Tinted)
				.tone(Tone::Accent)
				.on_click(act::click(action)),
		);
	}
	div().size_full().child(empty)
}
