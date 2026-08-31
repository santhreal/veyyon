//! WHY THIS SUITE EXISTS. Desktop restart or machine reboot must restore
//! the user's open spaces, tabs, active selections, and independent panel
//! configurations without loss. If the persisted document version is stale
//! or references session identifiers that have since been deleted or moved,
//! the launch path must cleanly reject the payload with an explicit error
//! reason rather than silently crashing or loading dangling references.
//!
//! What this closes: session corruption on startup and stale schema crashes.
//! What it does not catch: disk hardware failures during filesystem rename.

#[cfg(test)]
mod tests {
	use std::path::PathBuf;

	use veyyon_gui_core::{
		Store, UiCommand,
		model::SessionId,
		navigation::{BottomTab, InspectorTab},
	};

	use crate::window_state::{
		PersistedSpacesSection, WINDOW_STATE_VERSION, WindowStateDocument, WindowStateError,
		load_window_state, restore_spaces_into_store, save_window_state,
	};

	fn sample_session(name: &str) -> SessionId {
		SessionId::new(name).unwrap()
	}

	fn test_temp_path(name: &str) -> PathBuf {
		let nanos = std::time::SystemTime::now()
			.duration_since(std::time::UNIX_EPOCH)
			.unwrap()
			.as_nanos();
		let unique = format!("target/test-spaces-{}-{}-{nanos}.json", name, std::process::id());
		PathBuf::from(unique)
	}

	#[test]
	fn relaunch_restores_spaces_tabs_and_layouts() {
		let path = test_temp_path("roundtrip");
		let _ = std::fs::remove_file(&path);

		let mut store = Store::detached();
		let s1 = sample_session("session-alpha");
		let s2 = sample_session("session-beta");

		// Space 1: Configure tabs and panels
		store.dispatch(UiCommand::OpenTab(s1.clone()));
		store.dispatch(UiCommand::ResizeSidebar { width_milli_px: 290_000 });
		store.dispatch(UiCommand::SetBottomTab(BottomTab::Problems));

		// Space 2: Configure tabs and panels
		store.dispatch(UiCommand::CreateSpace { name: "Second Space".to_owned() });
		store.dispatch(UiCommand::OpenTab(s2.clone()));
		store.dispatch(UiCommand::ResizeSidebar { width_milli_px: 380_000 });
		store.dispatch(UiCommand::SetBottomTab(BottomTab::Output));
		store.dispatch(UiCommand::SetInspectorTab(InspectorTab::Details));

		// Save window state document
		let doc = WindowStateDocument::with_spaces(&store.frontend.spaces);
		save_window_state(&path, &doc).expect("saving window state must succeed");

		// Read back
		let loaded = load_window_state(&path).expect("loading window state must succeed");
		assert_eq!(loaded.version, WINDOW_STATE_VERSION);

		// Restore into a fresh store
		let mut restored_store = Store::detached();
		let known_sessions = vec![s1.clone(), s2.clone()];
		let spaces_section = loaded.spaces.expect("spaces section must be present");

		restore_spaces_into_store(&mut restored_store, &spaces_section, &known_sessions)
			.expect("restoring spaces must succeed");

		// Verify Space 2 is active with s2 and restored layout
		assert_eq!(restored_store.frontend.selected_session, Some(s2.clone()));
		assert_eq!(restored_store.frontend.panels.sidebar_width, 380.0);
		assert_eq!(restored_store.frontend.bottom_tab, BottomTab::Output);
		assert_eq!(restored_store.frontend.inspector_tab, InspectorTab::Details);

		// Switch back to Space 1 and verify its layout restored
		let space_1_id = restored_store.frontend.spaces.spaces[0].id.clone();
		restored_store.dispatch(UiCommand::SelectSpace(space_1_id));
		assert_eq!(restored_store.frontend.selected_session, Some(s1));
		assert_eq!(restored_store.frontend.panels.sidebar_width, 290.0);
		assert_eq!(restored_store.frontend.bottom_tab, BottomTab::Problems);

		let _ = std::fs::remove_file(&path);
	}

	#[test]
	fn stale_document_version_is_rejected_with_reason() {
		let path = test_temp_path("stale-version");
		let _ = std::fs::remove_file(&path);

		let store = Store::detached();
		let mut doc = WindowStateDocument::with_spaces(&store.frontend.spaces);
		doc.version = 999; // Incompatible future/stale version

		save_window_state(&path, &doc).expect("save must succeed");

		let result = load_window_state(&path);
		match result {
			Err(WindowStateError::StaleVersion { expected, actual }) => {
				assert_eq!(expected, WINDOW_STATE_VERSION);
				assert_eq!(actual, 999);
			},
			other => panic!("expected StaleVersion error, got {other:?}"),
		}

		let _ = std::fs::remove_file(&path);
	}

	#[test]
	fn missing_session_reference_is_rejected_with_reason() {
		let mut store = Store::detached();
		let ghost_session = sample_session("ghost-session-99");
		store.dispatch(UiCommand::OpenTab(ghost_session.clone()));

		let spaces_section = PersistedSpacesSection::from(&store.frontend.spaces);

		// Attempt to restore when ghost_session is not in known_sessions list
		let mut fresh_store = Store::detached();
		let known_sessions = vec![sample_session("other-session-1")];

		let result = restore_spaces_into_store(&mut fresh_store, &spaces_section, &known_sessions);
		match result {
			Err(WindowStateError::MissingSession { session }) => {
				assert_eq!(session, ghost_session);
			},
			other => panic!("expected MissingSession error, got {other:?}"),
		}
	}
}
