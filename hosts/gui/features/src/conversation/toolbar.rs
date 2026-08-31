//! Selected-session title and actions.

use gpui::{App, Div, ParentElement, Styled, div, px};
use veyyon_gui_core::{
	Store, UiCommand,
	model::{Capability, CapabilityStatus, ErrorScope, SessionId},
	navigation::Overlay,
};
use veyyon_gui_kit::{
	motion::{OwnerNamespace, RetainedKey},
	theme::{Theme, layout, space},
	ui::{Banner, Button, Icon, text},
};

use super::{logic, state::SessionShelfState};
use crate::act;

const TOOLBAR_OWNER: RetainedKey = RetainedKey::semantic(OwnerNamespace::Conversation, 102);

pub fn route_toolbar(store: &Store, state: &SessionShelfState, cx: &mut App) -> Div {
	let theme = Theme::get(cx);
	let selected = store.frontend.selected_session.as_ref();
	let title = selected_title(store, selected).unwrap_or("Conversation");
	let mut toolbar = div().flex().flex_col().flex_none().bg(theme.canvas).child(
		div()
			.flex()
			.items_center()
			.gap(px(space::X8))
			.h(px(layout::toolbar()))
			.px(px(space::X12))
			.child(text::line(title.to_owned()).flex_1().min_w(px(0.0)))
			.children(selected.map(|session| actions(store, state, session))),
	);
	if let Some(error) = store
		.replica
		.errors
		.iter()
		.rev()
		.find(|error| error.scope == ErrorScope::Session)
	{
		toolbar = toolbar.child(
			Banner::failure("The session action did not complete").detail(error.message.clone()),
		);
	}
	toolbar
}

fn selected_title<'a>(store: &'a Store, selected: Option<&SessionId>) -> Option<&'a str> {
	if let Some(header) = store.replica.active_session.readable()
		&& selected == Some(&header.value.id)
	{
		return header
			.value
			.title
			.as_deref()
			.filter(|title| !title.trim().is_empty())
			.or(Some(header.value.cwd.as_str()));
	}
	let selected = selected?;
	store
		.replica
		.sessions
		.sessions
		.readable()?
		.value
		.iter()
		.find(|session| session.id == *selected)
		.map(logic::row_title)
}

fn actions(store: &Store, state: &SessionShelfState, session: &SessionId) -> Div {
	let current_name = selected_title(store, Some(session))
		.unwrap_or_default()
		.to_owned();
	let rename = action(
		state,
		session,
		1,
		Icon::Rename,
		"Rename conversation",
		Some(UiCommand::OpenOverlay(Overlay::RenameSession {
			session: session.clone(),
			value:   current_name,
		})),
		capability_reason(store, Capability::Sessions),
	);
	let branch_command = store
		.frontend
		.selected_entry
		.as_ref()
		.map(|entry| UiCommand::BranchSession { session: session.clone(), entry: entry.clone() });
	let branch = action(
		state,
		session,
		2,
		Icon::BranchFrom,
		"Branch from selected entry",
		branch_command.clone(),
		branch_command
			.is_none()
			.then(|| "Select a transcript entry to branch from".to_owned())
			.or_else(|| capability_reason(store, Capability::SessionTreeNavigation)),
	);
	let export = action(
		state,
		session,
		3,
		Icon::Export,
		"Export conversation",
		Some(UiCommand::ExportSession { session: session.clone(), output_path: None }),
		capability_reason(store, Capability::Sessions),
	);
	let compact = action(
		state,
		session,
		4,
		Icon::Compact,
		"Compact context",
		Some(UiCommand::CompactSession { session: session.clone(), instructions: None }),
		capability_reason(store, Capability::Sessions),
	);
	let handoff = action(
		state,
		session,
		5,
		Icon::Handoff,
		"Handoff conversation",
		Some(UiCommand::HandoffSession { session: session.clone(), instructions: None }),
		capability_reason(store, Capability::Sessions),
	);
	let delete = action(
		state,
		session,
		6,
		Icon::Delete,
		"Delete conversation",
		Some(UiCommand::OpenOverlay(Overlay::Confirmation {
			title:   "Delete conversation?".to_owned(),
			body:    selected_title(store, Some(session))
				.unwrap_or_default()
				.to_owned(),
			confirm: Box::new(UiCommand::DeleteSession(session.clone())),
		})),
		capability_reason(store, Capability::SessionDeletion),
	);
	div()
		.flex()
		.items_center()
		.gap(px(space::X4))
		.child(rename)
		.child(branch)
		.child(export)
		.child(compact)
		.child(handoff)
		.child(delete)
}

fn action(
	state: &SessionShelfState,
	session: &SessionId,
	slot: u8,
	icon: Icon,
	label: &'static str,
	command: Option<UiCommand>,
	disabled: Option<String>,
) -> Button {
	let owner = state.control_owner(session, slot).unwrap_or(TOOLBAR_OWNER);
	let mut button = Button::new(format!("session-action-{slot}:{session}"), owner, icon).tip(label);
	if let Some(command) = command {
		button = button.on_click(act::click(command));
	}
	if let Some(reason) = disabled {
		button = button.disabled(reason);
	}
	button
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
