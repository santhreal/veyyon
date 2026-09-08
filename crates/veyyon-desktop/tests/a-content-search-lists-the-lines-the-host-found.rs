//! WHY THIS SUITE EXISTS: Content Search was a mode with a title, a
//! placeholder and no contract. Its rows were projected from the file-name
//! search domain, so it listed paths with no line and no matched text, the
//! keystrokes in it reported a file-name lookup, and no host action searched
//! file contents at all. An operator who opened it saw the answer to a
//! different question.
//!
//! THE CLASS THIS CLOSES: a palette mode whose keystroke reports the wrong
//! lookup, and a lookup whose rows outlive the query that fetched them. The
//! mode-to-lookup sweep reads `PaletteMode::iter()` at run time and checks
//! each mode's `query_intent` against the host action `actions_for` reports
//! for it, so a mode added to the palette turns this red until its lookup is
//! recorded, and a lookup rewired to another action turns it red too. The
//! row projection is driven through the real reducer and `project`, so a row
//! that stops stating where its match is fails here.
//!
//! WHAT IT DOES NOT CATCH: what the host's search finds, which
//! `packages/coding-agent/test/gui-host/` owns; the keystroke that carries
//! the query out of the editor, which is one `query_intent` call inside a
//! GPUI subscription; and the pixels of a row, which the scene catalogue
//! owns.

#[path = "support/mod.rs"]
mod support;

use std::collections::HashMap;

use strum::IntoEnumIterator as _;
use support::NOW_MS;
use veyyon_desktop::{SessionIndex, actions_for, project};
use veyyon_desktop_model::{
	Capability, CapabilityStatus, ConnectionState, ContentMatch, ContentMatchesView, HostAction,
	HostEvent, QueuePartition, SnapshotSection, Store, reduce,
};
use veyyon_desktop_surface::{
	Intent, Overlay, PaletteItem, PaletteItemKind, PaletteMode, PaletteState, ShellState,
};

/// An attached host carrying everything, so a missing row is never a withheld
/// capability.
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

/// The palette's rows for one mode and one query, after a projection.
fn rows(store: &Store, mode: PaletteMode, query: &str) -> Vec<PaletteItem> {
	let mut palette = PaletteState::new(mode);
	palette.set_query(query.to_owned());
	let mut state = ShellState { overlay: Some(Overlay::Palette(palette)), ..ShellState::default() };
	project(store, &mut SessionIndex::new(), &HashMap::new(), NOW_MS, &mut state);
	state
		.overlay_palette()
		.expect("the palette stays open across a projection")
		.filtered_items()
		.into_iter()
		.cloned()
		.collect()
}

/// The section the host answers a content search with.
fn found(query: &str, lines: &[(&str, u32, &str)]) -> SnapshotSection {
	SnapshotSection::ContentMatches(ContentMatchesView {
		query:     query.to_owned(),
		matches:   lines
			.iter()
			.map(|(path, line, preview)| ContentMatch {
				path:    (*path).to_owned(),
				line:    *line,
				preview: (*preview).to_owned(),
			})
			.collect(),
		truncated: false,
	})
}

#[test]
fn every_mode_states_the_lookup_its_keystrokes_report() {
	let mut store = attached();
	let index = SessionIndex::new();

	for mode in PaletteMode::iter() {
		let intent = mode.query_intent("todo".to_owned());
		let reported = actions_for(&intent, &index, &mut store);
		let expected = match mode {
			PaletteMode::Files => vec![HostAction::SearchFiles { query: "todo".to_owned() }],
			PaletteMode::ContentSearch => {
				vec![HostAction::SearchContent { query: "todo".to_owned() }]
			},
			PaletteMode::Commands
			| PaletteMode::Sessions
			| PaletteMode::Browse
			| PaletteMode::Models => Vec::new(),
		};
		assert_eq!(
			reported, expected,
			"{mode:?} reported {reported:?} for a keystroke, and its rows come from {expected:?}"
		);
		assert_eq!(
			intent.is_local(),
			expected.is_empty(),
			"{mode:?}: a lookup the host answers is not local, and one the window answers is"
		);
	}
}

#[test]
fn nothing_typed_asks_for_nothing_and_lists_nothing() {
	let mut store = attached();
	let index = SessionIndex::new();

	// There is no listing of every line of the workspace, so the empty field
	// is not a search for one: `Files` opens on the tree, this mode opens on
	// nothing.
	assert!(
		actions_for(&Intent::FindText(String::new()), &index, &mut store).is_empty(),
		"the empty query asks the host for nothing"
	);

	reduce(&mut store, HostEvent::Snapshot(found("todo", &[("src/app.ts", 12, "// todo")])));
	assert!(
		rows(&store, PaletteMode::ContentSearch, "").is_empty(),
		"an emptied field lists nothing rather than the matches of the query before it"
	);
}

#[test]
fn a_match_row_states_the_line_it_found_and_opens_the_file_it_is_in() {
	let mut store = attached();
	reduce(
		&mut store,
		HostEvent::Snapshot(found("todo", &[
			("src/app.ts", 12, "// todo: name the error"),
			("src/lib.rs", 3, "// todo: bound the queue"),
		])),
	);

	let found_rows = rows(&store, PaletteMode::ContentSearch, "todo");
	assert_eq!(found_rows.len(), 2, "both matches are listed: {found_rows:?}");

	let first = &found_rows[0];
	assert_eq!(first.title, "// todo: name the error", "the row draws the line the search matched");
	assert_eq!(
		first.subtitle.as_deref(),
		Some("src/app.ts:12"),
		"the row states which file and which line the match is in"
	);
	assert_eq!(
		first.kind,
		PaletteItemKind::ContentMatch { path: "src/app.ts".to_owned(), line: Some(12) },
		"the row carries the place it found, not only the text"
	);
	assert_eq!(
		first.capability,
		Some(Capability::Files),
		"the row is pruned by the capability that answered it"
	);

	// Running the row is what the operator pressed Enter for.
	let mut palette = PaletteState::new(PaletteMode::ContentSearch);
	palette.set_items(found_rows.clone());
	palette.set_query("todo".to_owned());
	assert_eq!(
		palette.run_intent(),
		Some(Intent::OpenFile("src/app.ts".to_owned())),
		"the highlighted match opens the file it is in"
	);
}

#[test]
fn a_row_is_found_by_the_place_it_matched_as_well_as_the_line() {
	let mut store = attached();
	reduce(
		&mut store,
		HostEvent::Snapshot(found("queue", &[
			("src/app.ts", 12, "let pending = queue.len();"),
			("src/lib.rs", 3, "// bound the queue"),
		])),
	);

	// Every row holds the text that was typed, so the file name is what
	// distinguishes one from another once the list is drawn.
	let narrowed = rows(&store, PaletteMode::ContentSearch, "lib.rs");
	assert_eq!(
		narrowed
			.iter()
			.map(|item| item.subtitle.clone().unwrap_or_default())
			.collect::<Vec<String>>(),
		["src/lib.rs:3"],
		"typing part of a path narrows the matches to that file: {narrowed:?}"
	);
}

#[test]
fn a_host_that_declines_files_lists_no_matches() {
	let mut store = attached();
	store
		.capabilities
		.set(Capability::Files, CapabilityStatus::Unavailable {
			reason: "this host serves no workspace".to_owned(),
		});
	reduce(&mut store, HostEvent::Snapshot(found("todo", &[("src/app.ts", 12, "// todo")])));

	assert!(
		rows(&store, PaletteMode::ContentSearch, "todo").is_empty(),
		"a row whose capability the host declines is not listed to run"
	);
}
