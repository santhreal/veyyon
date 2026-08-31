//! Static product destinations and palette mode entry points.

use crate::{
	Store, UiCommand,
	navigation::{Overlay, PaletteMode, Route, SettingsPage},
	palette::{
		types::{Group, Item, Results, SourceState},
		verbs,
	},
};

pub(super) fn commands(store: &Store) -> Results {
	let routes = vec![
		item("route-conversation", "Conversation", None, UiCommand::Navigate(Route::Conversation)),
		item("route-changes", "Changes", None, UiCommand::Navigate(Route::Changes)),
		item("route-files", "Files", None, UiCommand::Navigate(Route::Files)),
		item("route-agents", "Agents", None, UiCommand::Navigate(Route::Agents)),
	];
	let mut modes = vec![
		mode("open-quick", "Quick open", PaletteMode::QuickOpen),
		mode("open-sessions", "Search sessions", PaletteMode::Sessions),
		mode("open-messages", "Search messages", PaletteMode::Messages),
		mode("open-files", "Search files", PaletteMode::Files),
		item("open-models", "Choose model", None, UiCommand::OpenOverlay(Overlay::ModelPicker)),
		mode("open-providers", "Search providers", PaletteMode::Providers),
		mode("open-settings", "Search settings", PaletteMode::Settings),
		mode("open-agents", "Search agents", PaletteMode::Agents),
		item(
			"switch-session",
			"Switch session",
			Some("Open a recent session"),
			UiCommand::OpenOverlay(Overlay::SessionSwitcher),
		),
	];

	if let Some(session_id) = &store.frontend.selected_session {
		let title = selected_session_title(store).unwrap_or_default();
		modes.push(Item {
			id:              "rename-session".to_owned(),
			title:           "Rename session".to_owned(),
			detail:          Some("Rename current session".to_owned()),
			disabled_reason: disconnected(store),
			current:         false,
			commands:        vec![
				UiCommand::CloseTopOverlay,
				UiCommand::OpenOverlay(Overlay::RenameSession {
					session: session_id.clone(),
					value:   title.clone(),
				}),
			],
		});
		modes.push(Item {
			id:              "delete-session".to_owned(),
			title:           "Delete session".to_owned(),
			detail:          Some("Delete current session".to_owned()),
			disabled_reason: disconnected(store),
			current:         false,
			commands:        vec![
				UiCommand::CloseTopOverlay,
				UiCommand::OpenOverlay(Overlay::Confirmation {
					title:   "Delete conversation?".to_owned(),
					body:    title,
					confirm: Box::new(UiCommand::DeleteSession(session_id.clone())),
				}),
			],
		});
	} else {
		modes.push(Item {
			id:              "rename-session".to_owned(),
			title:           "Rename session".to_owned(),
			detail:          Some("Rename current session".to_owned()),
			disabled_reason: Some("No session selected".to_owned()),
			current:         false,
			commands:        Vec::new(),
		});
		modes.push(Item {
			id:              "delete-session".to_owned(),
			title:           "Delete session".to_owned(),
			detail:          Some("Delete current session".to_owned()),
			disabled_reason: Some("No session selected".to_owned()),
			current:         false,
			commands:        Vec::new(),
		});
	}

	let mut groups = vec![
		Group { id: "routes", label: "Go to", items: routes },
		Group { id: "open", label: "Open", items: modes },
		verbs::view(store),
		verbs::appearance(store),
	];
	groups.extend(verbs::content(store));
	Results { groups, state: SourceState::Ready }
}

pub(super) fn settings() -> Results {
	let items = SettingsPage::ALL
		.into_iter()
		.map(|page| {
			item(
				format!("settings:{page:?}"),
				page.label(),
				None,
				UiCommand::Navigate(Route::Settings(page)),
			)
		})
		.collect();
	Results {
		groups: vec![Group { id: "settings", label: "Settings", items }],
		state:  SourceState::Ready,
	}
}

fn mode(id: &'static str, label: &'static str, mode: PaletteMode) -> Item {
	item(id, label, None, UiCommand::OpenOverlay(Overlay::CommandPalette { mode }))
}

fn item(
	id: impl Into<String>,
	title: impl Into<String>,
	detail: Option<&str>,
	command: UiCommand,
) -> Item {
	Item {
		id:              id.into(),
		title:           title.into(),
		detail:          detail.map(str::to_owned),
		disabled_reason: None,
		current:         false,
		commands:        vec![UiCommand::CloseTopOverlay, command],
	}
}

fn selected_session_title(store: &Store) -> Option<String> {
	let selected = store.frontend.selected_session.as_ref()?;
	if let Some(header) = store.replica.active_session.readable()
		&& &header.value.id == selected
	{
		if let Some(title) = header
			.value
			.title
			.as_deref()
			.filter(|t| !t.trim().is_empty())
		{
			return Some(title.to_owned());
		}
		return Some(header.value.cwd.clone());
	}
	if let Some(sessions) = store.replica.sessions.sessions.readable()
		&& let Some(session) = sessions.value.iter().find(|s| &s.id == selected)
	{
		if let Some(title) = session.title.as_deref().filter(|t| !t.trim().is_empty()) {
			return Some(title.to_owned());
		}
		if let Some(first_msg) = session.first_message.as_deref()
			&& let Some(line) = first_msg.lines().find(|l| !l.trim().is_empty())
		{
			return Some(line.to_owned());
		}
		return Some(session.path.clone());
	}
	Some(selected.as_str().to_owned())
}

fn disconnected(store: &Store) -> Option<String> {
	(!store.connection.is_connected()).then(|| "Reconnect to make this change".to_owned())
}
