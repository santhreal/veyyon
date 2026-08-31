//! Status banners, jump controls, and empty or failure states.

use gpui::{AnyElement, IntoElement, ParentElement, Styled, div, px};
use veyyon_gui_core::{
	UiCommand,
	model::{CommandState, EntryId, SessionId, StaleReason},
};
use veyyon_gui_kit::{
	theme::space,
	ui::{Banner, Button, Empty, Fill, Icon, Size, Tone},
};

use super::logic;
use crate::{act, render::identity};

pub(super) fn earlier_entries_banner(
	session: SessionId,
	before: Option<EntryId>,
	load: &CommandState,
) -> Banner {
	match load {
		CommandState::Idle => Banner::notice("Earlier entries are available").child(
			Button::labelled(
				"load-earlier-transcript",
				identity::owner("load-earlier-transcript"),
				"Load earlier",
			)
			.icon(Icon::Return)
			.tone(Tone::Accent)
			.fill(Fill::Tinted)
			.size(Size::Base)
			.tip("Load earlier entries")
			.on_click(act::click(UiCommand::LoadTranscript { session, before })),
		),
		CommandState::Pending { .. } => Banner::notice("Loading earlier entries"),
		CommandState::Failed { message, .. } => Banner::failure("Earlier entries failed to load")
			.detail(message.clone())
			.child(
				Button::labelled(
					"retry-earlier-transcript",
					identity::owner("retry-earlier-transcript"),
					"Retry",
				)
				.icon(Icon::Return)
				.tone(Tone::Danger)
				.fill(Fill::Tinted)
				.size(Size::Base)
				.tip("Retry earlier entries")
				.on_click(act::click(UiCommand::RetryTranscript { session })),
			),
	}
}

pub(super) fn stale_banner(reason: &StaleReason) -> Banner {
	Banner::waiting("Showing a disconnected transcript").detail(format!("{reason:?}"))
}

pub(super) fn refresh_error_banner(message: &str) -> Banner {
	Banner::failure("Transcript refresh failed").detail(message.to_owned())
}

pub(super) fn jump_button(unseen: usize) -> AnyElement {
	div()
		.absolute()
		.right(px(space::LOOSE))
		.bottom(px(space::LOOSE))
		.child(
			Button::labelled(
				"jump-latest",
				identity::owner("jump-latest"),
				format!("Latest · {unseen} new"),
			)
			.icon(Icon::Return)
			.tone(Tone::Accent)
			.fill(Fill::Solid)
			.size(Size::Base)
			.tip("Jump to latest")
			.on_click(move |_, window, cx| act::run(UiCommand::JumpToLatest, window, cx)),
		)
		.into_any_element()
}

pub(super) fn loading(received: Option<u64>, expected: Option<u64>) -> AnyElement {
	Empty::new("Loading transcript")
		.icon(Icon::Running)
		.note(logic::loading_progress(received, expected))
		.filling()
		.into_any_element()
}

pub(super) fn empty_transcript() -> AnyElement {
	Empty::new("No transcript yet")
		.icon(Icon::Engine)
		.note("Messages appear here after a session is opened.")
		.filling()
		.into_any_element()
}

pub(super) fn empty_conversation(stale: bool, error: bool) -> AnyElement {
	let mut empty = Empty::new("Start the conversation")
		.icon(Icon::Engine)
		.note("The session has no transcript entries.")
		.filling();
	if stale || error {
		empty = empty.child(Banner::waiting("The empty transcript is stale."));
	}
	empty.into_any_element()
}

pub(super) fn unavailable(
	message: &str,
	retryable: bool,
	session: Option<SessionId>,
) -> AnyElement {
	let mut empty = Empty::new("Transcript unavailable")
		.icon(Icon::Failed)
		.note(message.to_owned())
		.filling();
	if retryable && let Some(session) = session {
		empty = empty.child(
			Button::labelled("retry-transcript", identity::owner("retry-transcript"), "Retry")
				.icon(Icon::Return)
				.tone(Tone::Danger)
				.fill(Fill::Tinted)
				.size(Size::Base)
				.tip("Retry transcript")
				.on_click(act::click(UiCommand::RetryTranscript { session })),
		);
	}
	empty.into_any_element()
}

pub(super) fn fatal(message: &str) -> AnyElement {
	Empty::new("Connection unavailable")
		.icon(Icon::Failed)
		.note(message.to_owned())
		.filling()
		.into_any_element()
}

pub(super) fn no_session() -> AnyElement {
	Empty::new("Select a session")
		.icon(Icon::Engine)
		.note("Choose a session to read its transcript.")
		.filling()
		.into_any_element()
}

/// The canvas with no host behind it.
///
/// The one place the window asks to be attached: this is the largest surface
/// on the route, so the button is where a reader is already looking. The
/// panels around it state the condition and offer nothing, because four
/// buttons for one condition read as four conditions.
pub(super) fn detached() -> AnyElement {
	Empty::new("No host is attached")
		.icon(Icon::Engine)
		.note("Attach a host to load conversations and send messages.")
		.filling()
		.child(
			Button::labelled("attach-transcript", identity::owner("attach-transcript"), "Attach")
				.icon(Icon::Engine)
				.tone(Tone::Accent)
				.fill(Fill::Solid)
				.size(Size::Base)
				.on_click(act::click(UiCommand::Attach { endpoint: None })),
		)
		.into_any_element()
}
