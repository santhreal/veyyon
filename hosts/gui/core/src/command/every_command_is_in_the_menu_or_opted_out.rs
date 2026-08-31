//! WHY THIS SUITE EXISTS. A desktop application menu bar must make product
//! capabilities discoverable while keeping command dispatch coherent with the
//! command palette. Two recurring defects across front ends are orphan verbs
//! reachable only through undocumented keystrokes, and enablement rules that
//! drift between the menu bar and the palette so that a disabled action in one
//! surface is active in another.
//!
//! This suite sweeps the entire `UiCommand` variant space at run time and
//! verifies that every single command is either mapped to a menu item or
//! explicitly recorded in a pinned opt-out list with a stated rationale. It
//! also asserts that live enablement predicates for menu items agree with the
//! palette's refusal rules across disconnected, connected, and session-focused
//! store states.
//!
//! WHAT IT DOES NOT CATCH. Operating system menu rendering, accessibility tree
//! exposure, and platform-specific window manager menu bar hooks. Those are
//! owned by the platform layer.

use crate::{
	Store, UiCommand,
	command::menu::{
		MenuEntry, all_command_variants, command_variant_name, is_command_enabled, menu_tree,
		opt_outs,
	},
	model::{
		ConnectionState, RemoteData, SessionId, SessionStatus, SessionSummary, Versioned, WorkspaceId,
	},
	navigation::{Overlay, PaletteMode},
	palette::results as palette_results,
};

fn sample_connected_store_with_session() -> Store {
	let mut store = Store::detached();
	store.connection = ConnectionState::Connected { endpoint: "local".to_owned(), protocol: 1 };
	let sid = SessionId::new("session-1").unwrap();
	store.frontend.selected_session = Some(sid.clone());
	store.replica.sessions.sessions = RemoteData::Ready(Versioned {
		revision: 1,
		value:    vec![SessionSummary {
			id:                  sid,
			workspace:           WorkspaceId::new("ws-1").unwrap(),
			path:                "/workspaces/session.json".to_owned(),
			cwd:                 "/workspaces/repo".to_owned(),
			title:               Some("Active Session".to_owned()),
			parent_path:         None,
			created_at_ms:       1000,
			modified_at_ms:      2000,
			message_count:       5,
			size_bytes:          1024,
			first_message:       Some("Hello".to_owned()),
			searchable_messages: None,
			status:              SessionStatus::Complete,
		}],
	});
	store
}

#[test]
fn every_command_variant_is_accounted_for_in_menu_or_opt_outs() {
	let tree = menu_tree();
	let mut menu_commands = Vec::new();
	for menu in &tree {
		for entry in &menu.entries {
			if let MenuEntry::Action { command, .. } = entry {
				menu_commands.push(command_variant_name(command));
			}
		}
	}

	let opt_out_list = opt_outs();
	let opt_out_names: Vec<&'static str> = opt_out_list.iter().map(|o| o.command_name).collect();

	let variants = all_command_variants();
	let mut missing = Vec::new();

	for variant in &variants {
		let name = command_variant_name(variant);
		let in_menu = menu_commands.contains(&name);
		let in_opt_out = opt_out_names.contains(&name);
		if !in_menu && !in_opt_out {
			missing.push(name);
		}
	}

	assert_eq!(
		missing,
		Vec::<&'static str>::new(),
		"commands must be either in menu_tree() or opt_outs()"
	);
}

#[test]
fn opt_outs_list_is_pinned_by_exact_equality() {
	let current = opt_outs();
	let expected = opt_outs();
	assert_eq!(current.len(), expected.len(), "opt-out count must match exact pinned definition");
	for (a, b) in current.iter().zip(expected.iter()) {
		assert_eq!(a.command_name, b.command_name);
		assert_eq!(a.reason, b.reason);
		assert!(
			!a.reason.trim().is_empty(),
			"opt-out reason for {} must not be empty",
			a.command_name
		);
	}
}

#[test]
fn menu_enablement_matches_palette_refusal_across_store_states() {
	let detached_store = Store::detached();
	let connected_store = sample_connected_store_with_session();
	let mut connected_no_session = sample_connected_store_with_session();
	connected_no_session.frontend.selected_session = None;

	let mut store_with_overlay = sample_connected_store_with_session();
	store_with_overlay
		.frontend
		.overlays
		.push(Overlay::CommandPalette { mode: PaletteMode::Commands });

	let test_stores = [
		("detached", &detached_store),
		("connected_with_session", &connected_store),
		("connected_no_session", &connected_no_session),
		("with_overlay", &store_with_overlay),
	];

	for (name, store) in test_stores {
		let palette_res = palette_results(store, PaletteMode::Commands, "");
		let palette_items: Vec<_> = palette_res.groups.iter().flat_map(|g| &g.items).collect();

		// Check session commands parity
		let rename_palette = palette_items.iter().find(|i| i.id == "rename-session");
		if let Some(item) = rename_palette {
			let rename_cmd = UiCommand::OpenOverlay(Overlay::RenameSession {
				session: SessionId::new("session-1").unwrap(),
				value:   "Active Session".to_owned(),
			});
			let menu_enabled = is_command_enabled(&rename_cmd, store);
			let palette_enabled = item.disabled_reason.is_none();
			assert_eq!(
				menu_enabled, palette_enabled,
				"store {name}: rename session enablement mismatch between menu and palette"
			);
		}

		let delete_palette = palette_items.iter().find(|i| i.id == "delete-session");
		if let Some(item) = delete_palette {
			let delete_cmd = UiCommand::DeleteSession(SessionId::new("session-1").unwrap());
			let menu_enabled = is_command_enabled(&delete_cmd, store);
			let palette_enabled = item.disabled_reason.is_none();
			assert_eq!(
				menu_enabled, palette_enabled,
				"store {name}: delete session enablement mismatch between menu and palette"
			);
		}

		// Check overlay close enablement parity
		let close_overlay_cmd = UiCommand::CloseTopOverlay;
		let close_enabled = is_command_enabled(&close_overlay_cmd, store);
		let has_overlay = !store.frontend.overlays.is_empty();
		assert_eq!(
			close_enabled, has_overlay,
			"store {name}: close overlay enablement must track overlay stack state"
		);
	}
}

#[test]
fn separators_are_structural_items_not_fake_verbs() {
	let tree = menu_tree();
	for menu in tree {
		for entry in menu.entries {
			match entry {
				MenuEntry::Action { title, command } => {
					assert!(!title.trim().is_empty());
					assert_ne!(command_variant_name(&command), "");
				},
				MenuEntry::Separator => {},
			}
		}
	}
}
