//! Acceptance and regression tests for palette row resolution and cursor
//! arithmetic.

use super::*;
use crate::{
	Store, UiCommand,
	model::*,
	navigation::{Overlay, PaletteMode, Route, SettingsPage},
};

fn seeded_store() -> Store {
	let mut store = Store::detached();
	store.connection = ConnectionState::Connected { endpoint: "local".to_owned(), protocol: 1 };

	let session_id = SessionId::new("session-1").unwrap();
	store.frontend.selected_session = Some(session_id.clone());

	store.replica.sessions.sessions = RemoteData::Ready(Versioned {
		revision: 1,
		value:    vec![SessionSummary {
			id:                  session_id,
			workspace:           WorkspaceId::new("ws-1").unwrap(),
			path:                "/tmp/session-1.json".to_owned(),
			cwd:                 "/workspaces/project".to_owned(),
			title:               Some("Active Session".to_owned()),
			parent_path:         None,
			created_at_ms:       1000,
			modified_at_ms:      2000,
			message_count:       10,
			size_bytes:          5000,
			first_message:       Some("Hello world".to_owned()),
			searchable_messages: None,
			status:              SessionStatus::Complete,
		}],
	});

	store.replica.transcript = RemoteData::Ready(Versioned {
		revision: 1,
		value:    vec![TranscriptEntry {
			id:                EntryId::new("entry-1").unwrap(),
			parent:            None,
			revision:          1,
			timestamp_ms:      1000,
			role:              MessageRole::User,
			content:           vec![ContentBlock::Text {
				text: "First user query in transcript".to_owned(),
			}],
			meta:              None,
			raw_discriminator: "user".to_owned(),
			raw:               Value::Null,
		}],
	});

	store.replica.files = RemoteData::Ready(Versioned {
		revision: 1,
		value:    FileWorkspaceState {
			roots:         vec![WorkspaceId::new("ws-1").unwrap()],
			nodes:         vec![FileNode {
				id:             FileId::new("file-1").unwrap(),
				workspace:      WorkspaceId::new("ws-1").unwrap(),
				parent:         None,
				name:           "main.rs".to_owned(),
				path:           "src/main.rs".to_owned(),
				kind:           FileKind::Text,
				size_bytes:     Some(1024),
				ignored:        false,
				symlink_target: None,
				modified_at_ms: Some(1500),
				children:       RemoteData::Empty,
			}],
			selected_read: RemoteData::Empty,
			read_error:    None,
			search:        RemoteData::Empty,
		},
	});

	let provider_id = ProviderId::new("anthropic").unwrap();
	let model_id = ModelId::new("claude-3-5-sonnet").unwrap();

	store.replica.models = RemoteData::Ready(Versioned {
		revision: 1,
		value:    ModelCatalogState {
			models:   RemoteData::Ready(vec![ModelOption {
				id:                   model_id.clone(),
				provider:             provider_id.clone(),
				name:                 "Claude 3.5 Sonnet".to_owned(),
				context_window:       Some(200_000),
				max_attachment_bytes: Some(10_000_000),
				reasoning:            true,
				thinking_mode:        None,
				supported_efforts:    vec!["low".to_owned(), "high".to_owned()],
				default_effort:       Some("high".to_owned()),
				input_modalities:     vec!["text".to_owned(), "image".to_owned()],
				tool_support:         Some(true),
				availability:         Availability::Available,
			}]),
			selected: Some((provider_id.clone(), model_id)),
			thinking: ThinkingSelection {
				configured:        None,
				effective:         None,
				supported_efforts: Vec::new(),
				default:           None,
			},
			refresh:  CommandState::Idle,
		},
	});

	store.replica.providers = RemoteData::Ready(Versioned {
		revision: 1,
		value:    vec![ProviderView {
			id:            provider_id,
			name:          "Anthropic".to_owned(),
			available:     true,
			authenticated: true,
			status:        Some("Operational".to_owned()),
			error:         None,
		}],
	});

	store.replica.agents = RemoteData::Ready(Versioned {
		revision: 1,
		value:    AgentRosterState {
			agents:       RemoteData::Ready(vec![AgentView {
				id:                     AgentId::new("agent-1").unwrap(),
				display_name:           "Build Engineer".to_owned(),
				kind:                   AgentKind::Subagent,
				parent:                 None,
				status:                 AgentStatus::Idle,
				scope:                  Some("build".to_owned()),
				activity:               Some("Standing by".to_owned()),
				model:                  None,
				started_at_ms:          Some(1000),
				updated_at_ms:          Some(1100),
				session_file_available: true,
				pending_approval:       None,
				waiting_on_peer:        None,
				progress:               None,
				participants:           Vec::new(),
				transcript_read_only:   false,
			}]),
			subscription: None,
			transcripts:  Vec::new(),
		},
	});

	store
}

#[test]
fn rendered_row_is_the_executed_row_for_every_mode_and_every_index() {
	for mode in PaletteMode::ALL {
		let mut store = seeded_store();
		store.frontend.overlays = vec![Overlay::CommandPalette { mode }];
		let results = results(&store, mode, "");
		assert!(
			!results.groups.is_empty(),
			"Mode {mode:?} should have non-empty results with seeded replica"
		);

		let items: Vec<_> = results
			.groups
			.iter()
			.flat_map(|g| &g.items)
			.cloned()
			.collect();
		assert!(!items.is_empty(), "Mode {mode:?} has groups but 0 items");

		for (idx, item) in items.iter().enumerate() {
			let mut test_store = seeded_store();
			test_store.frontend.overlays = vec![Overlay::CommandPalette { mode }];
			test_store.frontend.palette_cursor = idx;

			let accepted = accept(&test_store);
			if item.disabled_reason.is_none() {
				assert_eq!(
					accepted, item.commands,
					"Row {idx} ({}) in mode {mode:?} executed different commands than rendered",
					item.title
				);

				test_store.dispatch(UiCommand::AcceptPalette);
				assert!(
					test_store.frontend.overlays.is_empty()
						|| !matches!(test_store.frontend.overlays.last(), Some(Overlay::CommandPalette { mode: m }) if *m == mode),
					"Accepting row {idx} ({}) in mode {mode:?} should dismiss current palette overlay",
					item.title
				);
			} else {
				assert!(
					accepted.is_empty(),
					"Disabled row {idx} ({}) in mode {mode:?} returned commands",
					item.title
				);

				test_store.dispatch(UiCommand::AcceptPalette);
				assert_eq!(
					test_store.frontend.overlays.last(),
					Some(&Overlay::CommandPalette { mode }),
					"Disabled row {idx} ({}) in mode {mode:?} should leave overlay open",
					item.title
				);
			}
		}
	}
}

#[test]
fn fail_by_default_on_new_palette_mode_or_settings_page() {
	let empty_modes: Vec<PaletteMode> = Vec::new();
	let store = seeded_store();

	for mode in PaletteMode::ALL {
		assert!(!mode.title().trim().is_empty(), "PaletteMode {mode:?} must have a non-empty title");
		let res = results(&store, mode, "");
		if res.groups.is_empty() {
			assert!(empty_modes.contains(&mode), "Unexpected empty mode {mode:?}");
		}
	}
	assert_eq!(empty_modes, Vec::<PaletteMode>::new());

	let commands_results = results(&store, PaletteMode::Commands, "");
	let group_ids: Vec<_> = commands_results.groups.iter().map(|g| g.id).collect();
	// The verb groups are part of the Commands palette. "content" is absent
	// here because this store holds no plan approval and no image; the sweep
	// below seeds both and pins it.
	assert_eq!(group_ids, vec!["routes", "open", "view", "appearance"]);

	let commands_list: Vec<_> = commands_results
		.groups
		.iter()
		.flat_map(|g| &g.items)
		.flat_map(|i| &i.commands)
		.collect();
	for route in [Route::Conversation, Route::Changes, Route::Files, Route::Agents] {
		assert!(
			commands_list.contains(&&UiCommand::Navigate(route)),
			"Route {route:?} missing from Commands palette"
		);
	}
	for mode in [
		PaletteMode::QuickOpen,
		PaletteMode::Sessions,
		PaletteMode::Messages,
		PaletteMode::Files,
		PaletteMode::Providers,
		PaletteMode::Settings,
		PaletteMode::Agents,
	] {
		assert!(
			commands_list.contains(&&UiCommand::OpenOverlay(Overlay::CommandPalette { mode })),
			"PaletteMode {mode:?} missing from Commands palette"
		);
	}

	let settings_results = results(&store, PaletteMode::Settings, "");
	let settings_commands: Vec<_> = settings_results
		.groups
		.iter()
		.flat_map(|g| &g.items)
		.flat_map(|i| &i.commands)
		.collect();

	for page in SettingsPage::ALL {
		assert!(!page.label().trim().is_empty(), "SettingsPage {page:?} must have a non-empty label");
		assert!(
			settings_commands.contains(&&UiCommand::Navigate(Route::Settings(page))),
			"Settings page {page:?} missing from Settings palette results"
		);
	}
}

#[test]
fn cursor_bound_clamps_to_last_row_and_enters_last_row() {
	let mut store = seeded_store();
	store.frontend.overlays = vec![Overlay::CommandPalette { mode: PaletteMode::Commands }];
	let res = results(&store, PaletteMode::Commands, "");
	let total_items = cursor::item_count(&res.groups);
	assert!(total_items > 1);

	for _ in 0..total_items + 20 {
		store.dispatch(UiCommand::MovePaletteCursor { down: true });
	}
	assert_eq!(store.frontend.palette_cursor, total_items - 1);

	let last_item = res
		.groups
		.iter()
		.flat_map(|g| &g.items)
		.nth(total_items - 1)
		.unwrap();
	let accepted = accept(&store);
	assert_eq!(accepted, last_item.commands);

	for _ in 0..total_items + 20 {
		store.dispatch(UiCommand::MovePaletteCursor { down: false });
	}
	assert_eq!(store.frontend.palette_cursor, 0);
	let first_item = res.groups.iter().flat_map(|g| &g.items).next().unwrap();
	assert_eq!(accept(&store), first_item.commands);
}

#[test]
fn vanished_row_runs_nothing_and_overlay_stays_open() {
	let mut store = seeded_store();
	store.frontend.overlays = vec![Overlay::CommandPalette { mode: PaletteMode::Commands }];
	store.frontend.palette_cursor = 10;

	store.frontend.palette_query = "nonexistent_query_that_matches_nothing".to_owned();

	let accepted = accept(&store);
	assert!(accepted.is_empty());

	store.dispatch(UiCommand::AcceptPalette);
	assert_eq!(
		store.frontend.overlays.last(),
		Some(&Overlay::CommandPalette { mode: PaletteMode::Commands })
	);
}

#[test]
fn rename_and_delete_session_rows_present_in_commands_catalogue() {
	let store_with_session = seeded_store();
	let res = results(&store_with_session, PaletteMode::Commands, "");
	let items: Vec<_> = res.groups.iter().flat_map(|g| &g.items).collect();

	let rename_item = items
		.iter()
		.find(|i| i.id == "rename-session")
		.expect("rename-session row missing");
	assert_eq!(rename_item.title, "Rename session");
	assert!(rename_item.disabled_reason.is_none());
	assert!(
		rename_item
			.commands
			.iter()
			.any(|c| matches!(c, UiCommand::OpenOverlay(Overlay::RenameSession { .. })))
	);

	let delete_item = items
		.iter()
		.find(|i| i.id == "delete-session")
		.expect("delete-session row missing");
	assert_eq!(delete_item.title, "Delete session");
	assert!(delete_item.disabled_reason.is_none());
	assert!(delete_item.commands.iter().any(|c| matches!(c, UiCommand::OpenOverlay(Overlay::Confirmation { title, .. }) if title == "Delete conversation?")));

	let mut store_without_session = seeded_store();
	store_without_session.frontend.selected_session = None;
	let res_no_session = results(&store_without_session, PaletteMode::Commands, "");
	let items_no_session: Vec<_> = res_no_session
		.groups
		.iter()
		.flat_map(|g| &g.items)
		.collect();

	let rename_disabled = items_no_session
		.iter()
		.find(|i| i.id == "rename-session")
		.expect("rename-session row missing");
	assert!(rename_disabled.disabled_reason.is_some());

	let delete_disabled = items_no_session
		.iter()
		.find(|i| i.id == "delete-session")
		.expect("delete-session row missing");
	assert!(delete_disabled.disabled_reason.is_some());
}
