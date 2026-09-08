//! WHY: three of the six palette modes could not be opened. `Files`,
//! `ContentSearch` and `Browse` had a title, a placeholder naming their keys
//! and a projection filling their rows, and no command, chord or control
//! constructed any of them: the only way in was a test. The two that the
//! contract can answer are now `/files` and `/project`, and every keystroke
//! reported a workspace file search from whatever mode was open, so typing a
//! command name asked the host to search the tree for it.
//!
//! THE CLASS THIS CLOSES: a palette mode nothing opens, and a command row
//! listed by a host that declines the action behind it. Both sweeps read their
//! variant space at run time -- `PaletteMode::iter()` and the rows of
//! `command_items()` -- and each row's declared capability is checked against
//! the capability of the host actions its intent actually reports, through
//! `actions_for` and `action_to_capability`. So a new mode with no opener, a
//! new command whose declaration drifts from what it asks the host for, and a
//! declared capability that does not prune the row all turn this red.
//!
//! WHAT IT DOES NOT CATCH: the keystrokes that reach `run_palette`, which
//! `a-palette-row-runs-from-the-keyboard-that-selected-it` drives per mode;
//! what a descent lists, which is
//! `a-browse-row-lists-the-directory-it-opened`; and the drawer's two tenants,
//! pinned by `a-drawer-the-host-does-not-offer-is-not-drawn-empty`.

#[path = "support/mod.rs"]
mod support;

use std::collections::HashMap;

use strum::IntoEnumIterator;
use support::NOW_MS;
use veyyon_desktop::{SessionIndex, actions_for, project};
use veyyon_desktop_model::{
	Capability, CapabilityStatus, ConnectionState, HostAction, QueuePartition, Store,
	gate::action_to_capability,
};
use veyyon_desktop_surface::{
	Intent, Overlay, PaletteItem, PaletteItemKind, PaletteMode, PaletteState, ShellState,
	palette::commands::command_items,
};

/// An attached host carrying everything, so one withdrawn capability is the
/// only reason a row can be missing.
fn attached() -> Store {
	let mut store = Store {
		connection: ConnectionState::Connected { endpoint: "socket".to_string(), protocol: 1 },
		..Store::default()
	};
	for capability in Capability::ALL {
		store
			.capabilities
			.set(capability, CapabilityStatus::Available);
	}
	let session = support::session("s1", QueuePartition::Live);
	let id = session.id.clone();
	store.sessions.insert(session);
	store.persisted.shell.active_session = Some(id);
	store
}

/// The command rows of the palette, which are the rows carrying an intent.
fn command_rows() -> Vec<PaletteItem> {
	command_items()
		.into_iter()
		.filter(|item| matches!(item.kind, PaletteItemKind::Command { .. }))
		.collect()
}

/// The intent a command row runs.
fn intent_of(item: &PaletteItem) -> Intent {
	match &item.kind {
		PaletteItemKind::Command { intent } => (**intent).clone(),
		other => panic!("{other:?} is not a command row"),
	}
}

/// The command rows the palette lists after a projection, by title.
fn listed(store: &Store) -> Vec<String> {
	let mut state = ShellState {
		overlay: Some(Overlay::Palette(PaletteState::commands())),
		..ShellState::default()
	};
	project(store, &mut SessionIndex::new(), &HashMap::new(), NOW_MS, &mut state);
	state
		.overlay_palette()
		.expect("the palette stays open across a projection")
		.items()
		.iter()
		.map(|item| item.title.clone())
		.collect()
}

/// The mode a command row's intent leaves open, if it opens one.
fn mode_opened_by(intent: &Intent) -> Option<PaletteMode> {
	let mut state = ShellState::default();
	intent.apply(&mut state);
	state.overlay_palette().map(|palette| palette.mode)
}

#[test]
fn every_mode_that_lists_the_host_s_answer_is_opened_by_a_command() {
	// `Commands` is the list these rows sit in, and a row that navigates
	// inside it stays there. `Models` is the composer's model control and
	// `Sessions` is the queue's own switcher, each reached by a control rather
	// than from the list it would replace. Every other mode is a surface of
	// the workspace, so a command opens it.
	const OPENED_BY_A_CONTROL: [PaletteMode; 3] =
		[PaletteMode::Commands, PaletteMode::Models, PaletteMode::Sessions];

	let openers: Vec<(PaletteMode, String)> = command_rows()
		.iter()
		.filter_map(|item| mode_opened_by(&intent_of(item)).map(|mode| (mode, item.title.clone())))
		.collect();

	for mode in PaletteMode::iter() {
		if OPENED_BY_A_CONTROL.contains(&mode) {
			continue;
		}
		let opened = openers.iter().filter(|(opened, _)| *opened == mode).count();
		assert_eq!(opened, 1, "{mode:?} is reached from the command list exactly once: {openers:?}");
	}
}

/// The capabilities the host actions an intent reports ride on.
fn capabilities_of(intent: &Intent, store: &mut Store) -> Vec<Capability> {
	actions_for(intent, &SessionIndex::new(), store)
		.iter()
		.map(|action| action_to_capability(HostAction::kind(action)))
		.collect()
}

#[test]
fn a_command_row_states_the_capability_of_what_it_asks_the_host_for() {
	// The declaration is checked against the actions the intent reports, so a
	// row cannot claim a capability it does not use, or ride on one it does
	// not name. The drawer is the exception: its two tenants are resolved by
	// the projection, and it is pinned by exact equality here.
	let rows = command_rows();
	let mut undeclared: Vec<&str> = Vec::new();
	for item in &rows {
		let intent = intent_of(item);
		let mut store = attached();
		let mut needed: Vec<Capability> = capabilities_of(&intent, &mut store);
		// A row that opens a mode whose rows are the host's answer rides on
		// what that lookup asks for, even when opening the mode asks for
		// nothing: Content Search has no whole-workspace listing to open on,
		// and its first keystroke is the first thing the host is asked.
		if let Some(mode) = mode_opened_by(&intent) {
			needed.extend(capabilities_of(&mode.query_intent("probe".to_owned()), &mut store));
		}
		match item.capability {
			Some(declared) => assert!(
				needed.contains(&declared),
				"{} states {} and asks the host for {needed:?}",
				item.title,
				declared.as_str()
			),
			None if needed.is_empty() => {},
			None => undeclared.push(item.title.as_str()),
		}
	}
	assert_eq!(
		undeclared,
		vec!["/terminal"],
		"a row that asks the host for something and states no capability is a decision to record"
	);
}

#[test]
fn a_row_whose_capability_the_host_declines_leaves_the_list() {
	let every = listed(&attached());
	for item in &command_rows() {
		let Some(capability) = item.capability else {
			continue;
		};
		assert!(
			every.contains(&item.title),
			"{} is listed by a host carrying {}: {every:?}",
			item.title,
			capability.as_str()
		);

		let mut store = attached();
		store
			.capabilities
			.set(capability, CapabilityStatus::Unavailable {
				reason: format!("{} is not available on this host", capability.as_str()),
			});
		let remaining = listed(&store);
		assert!(
			!remaining.contains(&item.title),
			"{} needs {}, which the host declined, so it is not listed: {remaining:?}",
			item.title,
			capability.as_str()
		);
		for other in &command_rows() {
			if other.capability == Some(capability) {
				continue;
			}
			assert!(
				remaining.contains(&other.title),
				"withdrawing {} took {} with it: {remaining:?}",
				capability.as_str(),
				other.title
			);
		}
	}
}

#[test]
fn a_lookup_reaches_the_host_and_ranking_the_rows_at_hand_does_not() {
	// §5.8: the rows of Files are the host's answer to what was typed, so
	// that mode's query is a lookup; every other mode ranks rows the window
	// already holds, and a keystroke there asks the host for nothing.
	let mut store = attached();
	let index = SessionIndex::new();
	let state = ShellState::default();

	assert_eq!(
		actions_for(&Intent::FindFile("lib".to_owned()), &index, &mut store),
		vec![HostAction::SearchFiles { query: "lib".to_owned() }],
		"a lookup is the host's search for what was typed"
	);
	assert_eq!(
		actions_for(&Intent::FindFile(String::new()), &index, &mut store),
		vec![HostAction::LoadFileTree { root: None }],
		"the mode opens on the workspace tree, which is where its rows start"
	);
	assert!(
		actions_for(&Intent::PaletteQuery("lib".to_owned()), &index, &mut store).is_empty(),
		"ranking the rows at hand asks the host for nothing"
	);
	assert!(
		Intent::PaletteQuery("lib".to_owned()).is_local(),
		"a query the window answers itself is local"
	);
	assert!(
		!Intent::FindFile("lib".to_owned()).is_local(),
		"a lookup the host answers is not local"
	);

	// The mode each intent opens, so a lookup run from the command list lands
	// in the list that draws its rows.
	assert_eq!(
		mode_opened_by(&Intent::FindFile(String::new())),
		Some(PaletteMode::Files),
		"a lookup opens the mode that lists files"
	);
	assert_eq!(
		mode_opened_by(&Intent::BrowseTo { path: None }),
		Some(PaletteMode::Browse),
		"a listing opens the mode that lists directories"
	);
	let _ = state;
}

#[test]
fn a_file_row_follows_the_query_rather_than_the_tree_it_opened_on() {
	use veyyon_desktop_model::{FileKind, FileNode, FileTreeView, SearchResultsView};

	let mut store = attached();
	store.domains.file_tree = Some(FileTreeView {
		root:      "/repo".to_owned(),
		entries:   vec![
			FileNode {
				path:  "src/lib.rs".to_owned(),
				name:  "lib.rs".to_owned(),
				kind:  FileKind::File,
				depth: 1,
			},
			FileNode {
				path:  "src/main.rs".to_owned(),
				name:  "main.rs".to_owned(),
				kind:  FileKind::File,
				depth: 1,
			},
		],
		truncated: false,
	});

	let rows = |store: &Store, query: &str| -> Vec<String> {
		let mut palette = PaletteState::new(PaletteMode::Files);
		palette.set_query(query.to_owned());
		let mut state =
			ShellState { overlay: Some(Overlay::Palette(palette)), ..ShellState::default() };
		project(store, &mut SessionIndex::new(), &HashMap::new(), NOW_MS, &mut state);
		state
			.overlay_palette()
			.expect("the palette stays open across a projection")
			.items()
			.iter()
			.map(|item| item.title.clone())
			.collect()
	};

	assert_eq!(
		rows(&store, ""),
		["src/lib.rs", "src/main.rs"],
		"with nothing typed the rows are the workspace tree's files"
	);

	store.domains.search = Some(SearchResultsView {
		query:     "main".to_owned(),
		paths:     vec!["src/main.rs".to_owned()],
		truncated: false,
	});
	assert_eq!(
		rows(&store, "main"),
		["src/main.rs"],
		"a typed query is answered by the host's search, not by the tree"
	);

	store.domains.search = Some(SearchResultsView {
		query:     "zzz".to_owned(),
		paths:     Vec::new(),
		truncated: false,
	});
	assert!(
		rows(&store, "zzz").is_empty(),
		"a lookup that matches nothing states that rather than leaving the tree drawn"
	);
}
