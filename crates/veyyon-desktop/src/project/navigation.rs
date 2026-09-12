//! Navigation changes window membership; opening always uses the existing host
//! action.

use veyyon_desktop_model::{HostAction, SessionId, Store};
use veyyon_desktop_surface::{Intent, ShellState};

/// The displayed session is the selected tab only while the host confirms that
/// identity.
pub fn active_session(store: &Store) -> Option<&SessionId> {
	if !store.persisted.shell.navigation.is_initialized() {
		return store.persisted.shell.active_session.as_ref();
	}
	store
		.persisted
		.shell
		.navigation
		.active()
		.selected
		.as_ref()
		.filter(|selected| store.persisted.shell.active_session.as_ref() == Some(*selected))
}

pub fn navigation_actions(intent: &Intent, store: &mut Store) -> Vec<HostAction> {
	let host_active = store.persisted.shell.active_session.clone();
	let navigation = &mut store.persisted.shell.navigation;
	let target = match intent {
		Intent::OpenSession(session) => Some(session.clone()),
		Intent::CloseSessionTab(session) => {
			let selected = navigation.active().selected.as_ref() == Some(session);
			let next = navigation.close(session);
			if !selected {
				return Vec::new();
			}
			next
		},
		Intent::ReorderSessionTab { session, target } => {
			navigation.reorder(session, target);
			return Vec::new();
		},
		Intent::CreateSpace(name) => {
			if let Some(id) = navigation.create(name) {
				navigation.switch(id);
			}
			return Vec::new();
		},
		Intent::RenameSpace { id, name } => {
			navigation.rename(*id, name);
			return Vec::new();
		},
		Intent::SwitchSpace(id) => {
			if !navigation.switch(*id) {
				return Vec::new();
			}
			navigation.active().selected.clone()
		},
		_ => return Vec::new(),
	};
	let Some(session) = target else {
		return Vec::new();
	};
	if host_active.as_ref() == Some(&session) {
		navigation.opened(session);
		Vec::new()
	} else {
		vec![HostAction::OpenSession { session }, HostAction::RefreshChanges]
	}
}

pub fn project_navigation(store: &Store, state: &mut ShellState) {
	state
		.navigation
		.clone_from(&store.persisted.shell.navigation);
	state.session_tabs = state
		.navigation
		.active()
		.tabs
		.iter()
		.map(|id| {
			let title = store
				.sessions
				.get(id)
				.map_or_else(|| id.0.clone(), |session| session.title.clone());
			let dirty = store
				.persisted
				.composer
				.get(id)
				.is_some_and(|draft| !draft.draft_text.is_empty() || !draft.attachments.is_empty());
			(id.clone(), title, dirty)
		})
		.collect();
}
