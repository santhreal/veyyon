//! WHY: §8.10 states one rule for everything the window remembers — a shape
//! this binary does not write is rejected and replaced by the default, never
//! migrated and never partially read — and the branch had that rule for five
//! of its six stores, in five copies of the same four assertions, with
//! `QueueStore` covered by none of them.
//!
//! The class this closes is a store whose stale copy is served: a version
//! below or above the one this binary writes, a truncated file, a file holding
//! a key the store no longer has, and, for a per-session store, one session's
//! stale entry costing another session its own. The sweep is over
//! `StoreKind::iter()`, so a store added to §8.10's table without a decision
//! turns this red rather than passing unnoticed, and the populated state is
//! built through an exhaustive match, so a new store fails to compile here
//! before it fails to persist.
//!
//! What it does not catch: whether the document reaches the disk, and whether
//! the surface applies what it read. That is `state::StateDir` in the binary
//! crate and the window suite over it.

use std::collections::{BTreeSet, HashMap};

use strum::IntoEnumIterator as _;
use veyyon_desktop_model::{
	ComposerStore, DiffMode, PanelsStore, PersistedState, PersistenceError, QueueStore, ShellStore,
	StoreKind, TranscriptAnchor, TranscriptStore, VersionedStore as _, WindowStore,
	composer::QueueMode,
	connection::SessionId,
	review::{ReviewAnchor, ReviewLine, ReviewSide},
};

/// The two sessions a per-session document is written for.
const FIRST: &str = "session-first";
const SECOND: &str = "session-second";

/// A state where every store differs from its default, so a store replaced by
/// its default is visible as such.
fn populated() -> PersistedState {
	let mut state = PersistedState::new();
	state.window = WindowStore {
		version:    WindowStore::CURRENT_VERSION,
		x:          220,
		y:          140,
		width:      1480,
		height:     920,
		maximized:  true,
		display_id: Some("display-2".to_string()),
	};
	state.shell = ShellStore {
		version:         ShellStore::CURRENT_VERSION,
		queue_collapsed: true,
		appearance:      Some("light".to_string()),
		active_session:  Some(SessionId::from(FIRST)),
		navigation:      veyyon_desktop_model::persistence::NavigationStore::default(),
	};
	state.queue = QueueStore {
		version:            QueueStore::CURRENT_VERSION,
		collapsed_sections: BTreeSet::from(["deferred".to_string(), "parked".to_string()]),
		parked_page:        3,
	};
	let anchor = ReviewAnchor::capture(
		"/repo",
		"src/app.rs",
		veyyon_desktop_model::ChangeScope::WorkingTree,
		ReviewSide::New,
		1,
		&[ReviewLine { number: 1, text: "source" }],
	)
	.expect("source line");
	state
		.reviews
		.create(anchor, "Review comment")
		.expect("thread");
	for session in [FIRST, SECOND] {
		state.panels.insert(SessionId::from(session), PanelsStore {
			version:             PanelsStore::CURRENT_VERSION,
			right_panel_visible: true,
			right_panel_width:   Some(620),
			drawer_visible:      true,
			drawer_height:       Some(320),
			active_right_tab:    Some("file".to_string()),
			active_drawer_tab:   Some("terminal:pty-1".to_string()),
			diff_mode:           DiffMode::Split,
		});
		state
			.transcripts
			.insert(SessionId::from(session), TranscriptStore {
				version:           TranscriptStore::CURRENT_VERSION,
				expanded_call_ids: BTreeSet::from(["call-3".to_string()]),
				scroll_anchor:     Some(TranscriptAnchor {
					entry_id:  "entry-8".to_string(),
					offset_px: 24,
				}),
			});
		state
			.composer
			.insert(SessionId::from(session), ComposerStore {
				version:     ComposerStore::CURRENT_VERSION,
				draft_text:  "the draft the operator was typing".to_string(),
				attachments: vec!["/repo/src/app.ts".to_string()],
				queue_mode:  QueueMode::Queue,
			});
	}
	state
}

/// Whether one store in `state` still holds what `populated` put there.
///
/// Exhaustive, so a store added to §8.10's table does not silently stop being
/// swept.
fn holds_populated(state: &PersistedState, kind: StoreKind) -> bool {
	let want = populated();
	match kind {
		StoreKind::Window => state.window == want.window,
		StoreKind::Shell => state.shell == want.shell,
		StoreKind::Queue => state.queue == want.queue,
		StoreKind::Panels => state.panels == want.panels,
		StoreKind::Transcript => state.transcripts == want.transcripts,
		StoreKind::Composer => state.composer == want.composer,
		StoreKind::Reviews => state.reviews == want.reviews,
	}
}

/// Whether one store in `state` is at its default.
fn holds_default(state: &PersistedState, kind: StoreKind) -> bool {
	let fresh = PersistedState::new();
	match kind {
		StoreKind::Window => state.window == fresh.window,
		StoreKind::Shell => state.shell == fresh.shell,
		StoreKind::Queue => state.queue == fresh.queue,
		StoreKind::Panels => state.panels.is_empty(),
		StoreKind::Transcript => state.transcripts.is_empty(),
		StoreKind::Composer => state.composer.is_empty(),
		StoreKind::Reviews => state.reviews == fresh.reviews,
	}
}

/// The document for one store, with its version rewritten.
fn document_at_version(kind: StoreKind, version: u32) -> String {
	let text = populated()
		.write_document(kind)
		.expect("the populated state serializes");
	let current = kind.current_version();
	text.replace(&format!("\"version\":{current}"), &format!("\"version\":{version}"))
}

/// A fresh state with every store populated except the one under test, which
/// is read from `text`.
fn read_into_populated(kind: StoreKind, text: &str) -> (PersistedState, Vec<PersistenceError>) {
	let mut state = populated();
	let refused = state.read_document(kind, text);
	let errors = refused.into_iter().map(|r| r.error).collect();
	(state, errors)
}

#[test]
fn every_store_in_the_table_round_trips_through_its_own_document() {
	for kind in StoreKind::iter() {
		let text = populated()
			.write_document(kind)
			.expect("the populated state serializes");
		let mut state = PersistedState::new();
		let refused = state.read_document(kind, &text);
		assert!(
			refused.is_empty(),
			"{}: a document this binary wrote was refused: {refused:?}",
			kind.file_name()
		);
		assert!(
			holds_populated(&state, kind),
			"{}: the round trip did not restore what was written",
			kind.file_name()
		);
	}
}

#[test]
fn every_store_refuses_a_version_below_and_above_the_one_it_writes() {
	for kind in StoreKind::iter() {
		let current = kind.current_version();
		for found in [current - 1, current + 1] {
			let text = document_at_version(kind, found);
			let (state, errors) = read_into_populated(kind, &text);
			// A host-scope document is one store; a per-session document is
			// one store per session, and each entry is refused on its own.
			let expected_refusals = if kind.per_session() { 2 } else { 1 };
			assert_eq!(
				errors.len(),
				expected_refusals,
				"{} at version {found}: expected {expected_refusals} refusal(s), got {errors:?}",
				kind.file_name()
			);
			assert!(
				errors.iter().all(|error| matches!(
					error,
					PersistenceError::VersionMismatch { expected, found: seen }
						if *expected == current && *seen == found
				)),
				"{} at version {found}: a refusal does not state both versions: {errors:?}",
				kind.file_name(),
			);
			assert!(
				holds_default(&state, kind),
				"{} at version {found}: a stale copy was served instead of the default",
				kind.file_name()
			);
			for other in StoreKind::iter().filter(|other| *other != kind) {
				assert!(
					holds_populated(&state, other),
					"{} at version {found}: refusing it also reset {}",
					kind.file_name(),
					other.file_name()
				);
			}
		}
	}
}

#[test]
fn every_store_refuses_a_truncated_document() {
	for kind in StoreKind::iter() {
		let mut text = populated()
			.write_document(kind)
			.expect("the populated state serializes");
		text.truncate(text.len() - 1);
		let (state, errors) = read_into_populated(kind, &text);
		assert_eq!(
			errors.len(),
			1,
			"{}: a truncated document was not refused once: {errors:?}",
			kind.file_name()
		);
		assert!(
			matches!(errors[0], PersistenceError::TruncatedPayload),
			"{}: a truncated document was refused as {:?}, so a half-written file would be read as a \
			 shape mismatch and could be mistaken for a stale one",
			kind.file_name(),
			errors[0]
		);
		assert!(
			holds_default(&state, kind),
			"{}: half a document was read instead of none of it",
			kind.file_name()
		);
	}
}

#[test]
fn every_store_refuses_a_document_holding_a_key_it_does_not_write() {
	for kind in StoreKind::iter() {
		let text = with_unknown_key(kind);
		let (state, errors) = read_into_populated(kind, &text);
		assert!(
			!errors.is_empty(),
			"{}: an unknown key was read rather than refused",
			kind.file_name()
		);
		assert!(
			holds_default(&state, kind),
			"{}: a document with an unknown key was served",
			kind.file_name()
		);
	}
}

/// The document for one store with a key this binary does not write, placed
/// inside the store rather than beside it.
///
/// A per-session document is a map of sessions, so an extra key at its top
/// level is an unknown session and not an unknown field: the key goes into
/// every entry, which is where a later build's field would arrive.
fn with_unknown_key(kind: StoreKind) -> String {
	let text = populated()
		.write_document(kind)
		.expect("the populated state serializes");
	if !kind.per_session() {
		return text.replacen('{', "{\"a_key_from_a_later_build\":1,", 1);
	}
	let mut map: HashMap<String, serde_json::Value> =
		serde_json::from_str(&text).expect("a per-session document is a map of sessions");
	for entry in map.values_mut() {
		if let Some(object) = entry.as_object_mut() {
			object.insert("a_key_from_a_later_build".to_string(), serde_json::json!(1));
		}
	}
	serde_json::to_string(&map).expect("the map serializes")
}

#[test]
fn one_session_stale_entry_does_not_cost_another_session_its_own() {
	for kind in StoreKind::iter().filter(|kind| kind.per_session()) {
		let current = kind.current_version();
		let map: HashMap<String, serde_json::Value> = serde_json::from_str(
			&populated()
				.write_document(kind)
				.expect("the populated state serializes"),
		)
		.expect("a per-session document is a map of sessions");
		let mut stale = map.clone();
		let entry = stale
			.get_mut(FIRST)
			.and_then(serde_json::Value::as_object_mut)
			.expect("the first session has an entry");
		entry.insert("version".to_string(), serde_json::json!(current - 1));
		let text = serde_json::to_string(&stale).expect("the map serializes");

		let mut state = PersistedState::new();
		let refused = state.read_document(kind, &text);
		assert_eq!(refused.len(), 1, "{}: one stale entry produced {refused:?}", kind.file_name());
		assert_eq!(
			refused[0].session.as_ref(),
			Some(&SessionId::from(FIRST)),
			"{}: the refusal does not name the session it dropped",
			kind.file_name()
		);
		assert!(
			!session_present(&state, kind, FIRST),
			"{}: the stale entry was served",
			kind.file_name()
		);
		assert!(
			session_present(&state, kind, SECOND),
			"{}: one session's stale entry dropped another session's own",
			kind.file_name()
		);
	}
}

#[test]
fn a_document_that_is_not_a_map_of_sessions_keeps_no_entry() {
	for kind in StoreKind::iter().filter(|kind| kind.per_session()) {
		let mut state = populated();
		let refused = state.read_document(kind, "[]");
		assert_eq!(
			refused.len(),
			1,
			"{}: a document that is not a map produced {refused:?}",
			kind.file_name()
		);
		assert!(
			holds_default(&state, kind),
			"{}: entries survived a document with no map in it",
			kind.file_name()
		);
	}
}

#[test]
fn every_store_the_table_names_is_in_the_sweep_and_has_its_own_file() {
	let iterated: Vec<StoreKind> = StoreKind::iter().collect();
	assert_eq!(
		iterated,
		StoreKind::ALL.to_vec(),
		"a store was added to the enum without being added to StoreKind::ALL, so the window would \
		 neither read nor write it"
	);
	let files: BTreeSet<&str> = StoreKind::ALL.iter().map(|kind| kind.file_name()).collect();
	assert_eq!(
		files.len(),
		StoreKind::ALL.len(),
		"two stores share one file, so one would overwrite the other: {files:?}"
	);
	let fsynced: Vec<&str> = StoreKind::ALL
		.iter()
		.filter(|kind| kind.fsync())
		.map(|kind| kind.file_name())
		.collect();
	assert_eq!(fsynced, vec!["composer.json", "reviews.json"], "authored text is fsynced");
}

/// Whether a per-session store holds an entry for `session`.
fn session_present(state: &PersistedState, kind: StoreKind, session: &str) -> bool {
	let id = SessionId::from(session);
	match kind {
		StoreKind::Panels => state.panels.contains_key(&id),
		StoreKind::Transcript => state.transcripts.contains_key(&id),
		StoreKind::Composer => state.composer.contains_key(&id),
		StoreKind::Window | StoreKind::Shell | StoreKind::Queue | StoreKind::Reviews => false,
	}
}
