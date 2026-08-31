//! Session search, shelves, rows, and remote states.

use gpui::{
	AnyElement, App, Div, Entity, InteractiveElement, IntoElement, ParentElement, Styled, Window,
	div, px,
};
use veyyon_gui_core::{
	Store, UiCommand,
	model::{
		Capability, CapabilityStatus, ConnectionState, RemoteData, SessionStatus, SessionSummary,
		StaleReason, Versioned,
	},
	navigation::Overlay,
};
use veyyon_gui_kit::{
	input::Editor,
	motion::{OwnerNamespace, RetainedKey, owner},
	theme::{Elevation, Theme, layout, space},
	ui::{
		Badge, Banner, Button, EdgeFade, Empty, Fill, Icon, Row, Scrolls, SearchField, Tone, text,
	},
};

use super::{
	logic,
	state::{ControlSlot, SessionShelfState},
};
use crate::act;

/// What a fixture of the sidebar is, in the namespace's table of names.
const CHROME: &str = "sidebar";

pub(super) fn load_owner() -> RetainedKey {
	owner(OwnerNamespace::Conversation, CHROME, "load")
}

pub(super) fn create_owner() -> RetainedKey {
	owner(OwnerNamespace::Conversation, CHROME, "create")
}

pub(super) fn search_owner() -> RetainedKey {
	owner(OwnerNamespace::Conversation, CHROME, "search")
}

pub fn sync_session_shelf(store: &Store, state: &mut SessionShelfState) {
	let sessions = store
		.replica
		.sessions
		.sessions
		.readable()
		.map_or(&[][..], |version| version.value.as_slice());
	state.reconcile(sessions, store.frontend.selected_session.as_ref());
}

/// The conversation sidebar. The search editor and retained list state are
/// created by the app and survive sheet/attached presentation changes.
pub fn session_shelf(
	store: &Store,
	state: &SessionShelfState,
	search: &Entity<Editor>,
	_window: &mut Window,
	cx: &mut App,
) -> Div {
	let theme = Theme::get(cx);
	let shelf = div()
		.flex()
		.flex_col()
		.size_full()
		.min_h(px(0.0))
		.bg(theme.chrome)
		.child(shelf_header(store, search, &theme));

	match &store.replica.sessions.sessions {
		RemoteData::Unrequested => shelf.child(unrequested(store, &theme)),
		RemoteData::Loading { .. } => shelf.child(remote_message(
			"Loading conversations",
			"Session metadata is being synchronized",
			&theme,
		)),
		RemoteData::Empty => shelf.child(empty_sessions(store)),
		RemoteData::Ready(version) => shelf.child(session_rows(store, state, version, None, &theme)),
		RemoteData::Stale { value, reason } => shelf
			.child(Banner::notice("Conversation list is offline").detail(stale_reason_label(reason)))
			.child(session_rows(store, state, value, None, &theme)),
		RemoteData::Error { message, retryable, stale } => {
			if let Some(version) = stale {
				shelf
					.child(error_banner(message, *retryable))
					.child(session_rows(store, state, version, Some(message), &theme))
			} else {
				shelf.child(load_error(message, *retryable))
			}
		},
	}
}

fn shelf_header(store: &Store, search: &Entity<Editor>, theme: &Theme) -> Div {
	div()
		.flex()
		.flex_col()
		.gap(px(space::X8))
		.p(px(space::X12))
		.child(
			div()
				.flex()
				.items_center()
				.child(text::heading("Conversations", theme))
				.child(text::spacer())
				.child(new_session_button(store)),
		)
		.child(SearchField::new("session-filter", search_owner(), search.clone()))
}

fn new_session_button(store: &Store) -> Button {
	let mut button = Button::new("new-session", create_owner(), Icon::New)
		.tip("New conversation")
		.on_click(act::click(UiCommand::CreateSession { workspace: None, parent: None }));
	if let Some(reason) = capability_reason(store, Capability::Sessions) {
		button = button.disabled(reason);
	}
	button
}

fn unrequested(store: &Store, theme: &Theme) -> AnyElement {
	match &store.connection {
		ConnectionState::Detached => Empty::new("No host is attached")
			.icon(Icon::Engine)
			.note("Attach a host to load conversations")
			.filling()
			.into_any_element(),
		ConnectionState::Fatal { message } => {
			remote_message("Host unavailable", message, theme).into_any_element()
		},
		_ => {
			remote_message("Waiting for conversations", "The host has not sent a session index", theme)
				.into_any_element()
		},
	}
}

fn empty_sessions(store: &Store) -> AnyElement {
	let mut action = Button::labelled("create-first-session", create_owner(), "New conversation")
		.icon(Icon::New)
		.fill(Fill::Solid)
		.tone(Tone::Accent)
		.on_click(act::click(UiCommand::CreateSession { workspace: None, parent: None }));
	if let Some(reason) = capability_reason(store, Capability::Sessions) {
		action = action.disabled(reason);
	}
	Empty::new("No conversations yet")
		.icon(Icon::Conversation)
		.note("Start a conversation in the current workspace")
		.filling()
		.child(action)
		.into_any_element()
}

fn session_rows(
	store: &Store,
	state: &SessionShelfState,
	version: &Versioned<Vec<SessionSummary>>,
	command_error: Option<&str>,
	theme: &Theme,
) -> EdgeFade {
	let query = store.frontend.session_filter.trim();
	let mut list = div()
		.flex()
		.flex_col()
		.flex_1()
		.min_h(px(0.0))
		.id("conversation-sessions-scroll-1")
		.gap(px(space::ROWS))
		.px(px(space::X8))
		.pb(px(space::X12));
	if let Some(message) = command_error {
		list = list.child(Banner::failure("A session action failed").detail(message.to_owned()));
	}
	if !query.is_empty() {
		list = list.child(section_label("Search results", theme));
		let mut count = 0;
		for session in version
			.value
			.iter()
			.filter(|session| logic::matches_filter(session, query))
		{
			list = list.child(session_row(store, session));
			count += 1;
		}
		if count == 0 {
			list = list.child(Empty::new("No matching conversations").icon(Icon::Search));
		}
		return list.scrolls_y(&state.scroll, Elevation::Chrome);
	}
	for (section, label) in [
		(logic::Shelf::Pinned, "Pinned"),
		(logic::Shelf::Active, "Active"),
		(logic::Shelf::History, "History"),
	] {
		let mut count = 0;
		let mut hidden = 0;
		let mut section_rows = div().flex().flex_col().gap(px(space::ROWS));
		for session in &version.value {
			let pinned = store.frontend.pinned_sessions.contains(&session.id);
			if logic::shelf_for(session, pinned, store.frontend.selected_session.as_ref()) != section {
				continue;
			}
			if section == logic::Shelf::History && count >= state.history_visible() {
				hidden += 1;
				continue;
			}
			section_rows = section_rows.child(session_row(store, session));
			count += 1;
		}
		if count > 0 {
			list = list.child(section_label(label, theme)).child(section_rows);
		}
		if hidden > 0 {
			list = list.child(Badge::new(format!("{hidden} more in history")).bare());
		}
	}
	for unreadable in &store.replica.sessions.unreadable {
		let row = owner(OwnerNamespace::Conversation, "unreadable", &unreadable.path);
		list = list.child(
			Row::new(format!("unreadable:{}", unreadable.path), row, unreadable.path.clone())
				.icon(Icon::Failed)
				.note(unreadable.reason.clone())
				.tone(Tone::Danger)
				.disabled(unreadable.reason.clone()),
		);
	}
	list.scrolls_y(&state.scroll, Elevation::Chrome)
}

fn session_row(store: &Store, session: &SessionSummary) -> Row {
	let owner = SessionShelfState::owner(&session.id);
	let pinned = store.frontend.pinned_sessions.contains(&session.id);
	let open_reason = capability_reason(store, Capability::Sessions);
	let pin_command = if pinned {
		UiCommand::UnpinSession(session.id.clone())
	} else {
		UiCommand::PinSession(session.id.clone())
	};
	let pin = Button::new(
		format!("pin:{}", session.id),
		SessionShelfState::control_owner(&session.id, ControlSlot::Pin),
		Icon::Pin,
	)
	.tip(if pinned {
		"Unpin conversation"
	} else {
		"Pin conversation"
	})
	.on(pinned)
	.on_click(act::click(pin_command));
	let mut delete = Button::new(
		format!("delete:{}", session.id),
		SessionShelfState::control_owner(&session.id, ControlSlot::RowDelete),
		Icon::Delete,
	)
	.tip("Delete conversation")
	.tone(Tone::Danger)
	.on_click(act::click(UiCommand::OpenOverlay(Overlay::Confirmation {
		title:   "Delete conversation?".to_owned(),
		body:    logic::row_title(session).to_owned(),
		confirm: Box::new(UiCommand::DeleteSession(session.id.clone())),
	})));
	if let Some(reason) = capability_reason(store, Capability::SessionDeletion) {
		delete = delete.disabled(reason);
	}
	let actions = div().flex().items_center().child(pin).child(delete);
	let mut row =
		Row::new(format!("session:{}", session.id), owner, logic::row_title(session).to_owned())
			.note(session.cwd.clone())
			.active(store.frontend.selected_session.as_ref() == Some(&session.id))
			.hover_actions(layout::control_height() * 2.0, actions)
			.child(
				Badge::new(logic::status_label(session.status))
					.tone(status_tone(session.status))
					.bare(),
			)
			.on_click(act::click(UiCommand::OpenSession(session.id.clone())));
	if let Some(reason) = open_reason {
		row = row.disabled(reason);
	}
	row
}

fn status_tone(status: SessionStatus) -> Tone {
	match status {
		SessionStatus::Complete | SessionStatus::Unknown => Tone::Muted,
		SessionStatus::Pending => Tone::Accent,
		SessionStatus::Interrupted | SessionStatus::Aborted => Tone::Warn,
		SessionStatus::Error => Tone::Danger,
	}
}

fn section_label(label: &str, theme: &Theme) -> Div {
	div()
		.pt(px(space::X8))
		.px(px(space::X10))
		.child(text::overline(label.to_owned(), theme))
}

fn capability_reason(store: &Store, capability: Capability) -> Option<String> {
	if !store.connection.is_connected() {
		return Some("Reconnect to use this action".to_owned());
	}
	match store.replica.capabilities.get(&capability) {
		Some(CapabilityStatus::Available) => None,
		Some(CapabilityStatus::Unavailable { reason }) => Some(reason.clone()),
		Some(CapabilityStatus::UnknownUntilAttached) | None => {
			Some("The attached host has not advertised this capability".to_owned())
		},
	}
}

fn remote_message(title: impl Into<String>, detail: impl Into<String>, theme: &Theme) -> Div {
	div()
		.flex()
		.flex_col()
		.items_center()
		.justify_center()
		.flex_1()
		.min_h(px(0.0))
		.gap(px(space::X8))
		.p(px(space::X20))
		.child(text::heading(title.into(), theme))
		.child(text::note_wrapping(detail.into(), theme))
}

fn error_banner(message: &str, retryable: bool) -> Banner {
	let mut banner =
		Banner::failure("Conversation list could not refresh").detail(message.to_owned());
	if retryable {
		banner = banner.child(
			Button::labelled("retry-sessions", load_owner(), "Retry")
				.icon(Icon::Retry)
				.on_click(act::click(UiCommand::LoadSessions)),
		);
	}
	banner
}

fn load_error(message: &str, retryable: bool) -> AnyElement {
	let mut empty = Empty::new("Conversations are unavailable")
		.icon(Icon::Failed)
		.note(message.to_owned())
		.filling();
	if retryable {
		empty = empty.child(
			Button::labelled("retry-session-load", load_owner(), "Retry")
				.icon(Icon::Retry)
				.on_click(act::click(UiCommand::LoadSessions)),
		);
	}
	empty.into_any_element()
}

fn stale_reason_label(reason: &StaleReason) -> &'static str {
	match reason {
		StaleReason::Disconnected => "Disconnected from host",
		StaleReason::Reconnecting => "Reconnecting to host",
		StaleReason::RevisionGap { .. } => "Synchronization gap detected",
		StaleReason::RefreshFailed(_) => "Failed to refresh conversations",
	}
}
