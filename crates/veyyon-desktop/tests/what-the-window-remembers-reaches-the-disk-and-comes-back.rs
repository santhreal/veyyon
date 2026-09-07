//! WHY: §8.10 states that everything the window remembers is read once at
//! startup and written debounced at 400ms and on a clean shutdown. The branch
//! had the shapes, the version rule and a test per shape, and no disk: nothing
//! read a document, nothing wrote one, and `PersistedState` lived and died
//! inside one process. A resized panel, a queue partition the operator
//! collapsed and a draft they had not sent were lost on every relaunch.
//!
//! The class this closes is a store that is remembered in memory and nowhere
//! else, and a write that is not safe to be killed in the middle of: the
//! debounce window, the shutdown flush, the temporary file, the missing
//! document that is a default rather than a refusal, and the unreadable one
//! that is a refusal naming its store. The sweep is over `StoreKind::iter()`,
//! so a store added to the table without a document turns this red.
//!
//! Time is a millisecond the test passes in. Nothing here sleeps, so a slow
//! machine cannot make the debounce window pass early or late.
//!
//! What it does not catch: whether the window snapshots the right value into a
//! store, or applies what it read to the surface. That is the window suite
//! over `project_persisted`.

use std::{collections::BTreeSet, fs};

use strum::IntoEnumIterator as _;
use veyyon_desktop::state::{DEBOUNCE_MS, StateDir, StateTracker, StateWriter};
use veyyon_desktop_model::{
	ComposerStore, PersistedState, PersistenceError, StoreKind, TranscriptAnchor,
	VersionedStore as _, composer::QueueMode, connection::SessionId,
};
use veyyon_test_scratch::{TempTree, scratch_dir};

/// A state directory under a scratch tree, removed with it.
fn state_dir(label: &str) -> (TempTree, StateDir) {
	let tree = scratch_dir(label);
	let dir = StateDir::at(tree.path().join("desktop"));
	(tree, dir)
}

/// A state that differs from the default in every store.
fn populated() -> PersistedState {
	let mut state = PersistedState::new();
	state.window.width = 1480;
	state.window.maximized = true;
	state.shell.queue_collapsed = true;
	state.shell.active_session = Some(SessionId::from("session-1"));
	state.queue.collapsed_sections.insert("parked".to_string());
	state.queue.parked_page = 3;
	let session = SessionId::from("session-1");
	let panels = state.panels.entry(session.clone()).or_default();
	panels.drawer_visible = true;
	panels.drawer_height = Some(320);
	panels.right_panel_width = Some(620);
	let transcript = state.transcripts.entry(session.clone()).or_default();
	transcript.expanded_call_ids.insert("call-3".to_string());
	transcript.scroll_anchor =
		Some(TranscriptAnchor { entry_id: "entry-8".to_string(), offset_px: 24 });
	state.composer.insert(session, ComposerStore {
		version:     ComposerStore::CURRENT_VERSION,
		draft_text:  "half a sentence the operator had not sent".to_string(),
		attachments: Vec::new(),
		queue_mode:  QueueMode::Queue,
	});
	state
}

#[test]
fn every_store_written_by_one_window_is_read_by_the_next() {
	let (_tree, dir) = state_dir("gui-state-round-trip");
	let mut writer = StateWriter::new(dir.clone());
	let mut tracker = StateTracker::new(PersistedState::new());
	let state = populated();

	assert!(
		tracker.sync(&state, &mut writer, 0).is_empty(),
		"a state the window holds could not be serialized"
	);
	assert!(writer.flush_all().is_empty(), "the flush did not write");

	for kind in StoreKind::iter() {
		assert!(
			dir.path(kind).is_file(),
			"{} was never written, so its store is remembered nowhere",
			kind.file_name()
		);
	}
	let (read_back, rejections) = dir.load();
	assert!(
		rejections.is_empty(),
		"a window refused the documents the previous one wrote: {rejections:?}"
	);
	assert_eq!(read_back, state, "what the next window read is not what this one wrote");
}

#[test]
fn a_change_waits_one_debounce_window_and_no_longer() {
	let (_tree, dir) = state_dir("gui-state-debounce");
	let mut writer = StateWriter::new(dir.clone());
	let mut tracker = StateTracker::new(PersistedState::new());
	let mut state = populated();

	tracker.sync(&state, &mut writer, 1_000);
	assert!(writer.flush_due(1_000 + DEBOUNCE_MS - 1).is_empty());
	assert!(
		!dir.path(StoreKind::Composer).exists(),
		"a change was written before its debounce window passed"
	);

	// A second change inside the window does not push the deadline out, so
	// text typed without a pause is still written every window.
	state
		.composer
		.values_mut()
		.for_each(|composer| composer.draft_text.push_str(" and one more clause"));
	tracker.sync(&state, &mut writer, 1_000 + DEBOUNCE_MS - 1);
	assert!(writer.flush_due(1_000 + DEBOUNCE_MS).is_empty());

	let written = fs::read_to_string(dir.path(StoreKind::Composer)).expect("the draft was written");
	assert!(
		written.contains("and one more clause"),
		"the write landed the value from the start of the window, not the end: {written}"
	);
	assert!(!writer.is_pending(), "a document stayed pending after its window passed");
}

#[test]
fn a_window_that_closes_inside_the_window_still_writes_what_it_held() {
	let (_tree, dir) = state_dir("gui-state-shutdown");
	let mut writer = StateWriter::new(dir.clone());
	let mut tracker = StateTracker::new(PersistedState::new());

	tracker.sync(&populated(), &mut writer, 5_000);
	assert!(!dir.path(StoreKind::Panels).exists(), "the debounce window was not honoured");
	assert!(writer.flush_all().is_empty(), "the shutdown flush failed");
	assert!(
		dir.path(StoreKind::Panels).is_file(),
		"a clean shutdown lost the layout the operator set"
	);
}

#[test]
fn only_a_store_that_changed_is_written_again() {
	let (_tree, dir) = state_dir("gui-state-narrow");
	let mut writer = StateWriter::new(dir.clone());
	let mut tracker = StateTracker::new(PersistedState::new());
	let mut state = PersistedState::new();

	state.window.width = 1600;
	tracker.sync(&state, &mut writer, 0);
	writer.flush_all();
	assert!(dir.path(StoreKind::Window).is_file());
	for kind in StoreKind::iter().filter(|kind| *kind != StoreKind::Window) {
		assert!(
			!dir.path(kind).exists(),
			"{} was written for a change that did not touch it",
			kind.file_name()
		);
	}

	tracker.sync(&state, &mut writer, DEBOUNCE_MS * 2);
	assert!(
		!writer.is_pending(),
		"a state identical to the one on disk was queued for writing again"
	);
}

#[test]
fn a_document_the_window_never_wrote_is_a_default_and_not_a_refusal() {
	let (_tree, dir) = state_dir("gui-state-first-launch");
	let (state, rejections) = dir.load();
	assert_eq!(
		state,
		PersistedState::new(),
		"a first launch started from something other than the defaults"
	);
	assert!(
		rejections.is_empty(),
		"a first launch reported a refusal it has no document for: {rejections:?}"
	);
}

#[test]
fn a_document_this_binary_cannot_read_names_its_store_and_keeps_the_rest() {
	let (_tree, dir) = state_dir("gui-state-stale");
	let mut writer = StateWriter::new(dir.clone());
	let mut tracker = StateTracker::new(PersistedState::new());
	tracker.sync(&populated(), &mut writer, 0);
	writer.flush_all();

	let path = dir.path(StoreKind::Panels);
	let stale = fs::read_to_string(&path)
		.expect("the panels document was written")
		.replace(&format!("\"version\":{}", StoreKind::Panels.current_version()), "\"version\":1");
	fs::write(&path, stale).expect("the stale document is written");

	let (state, rejections) = dir.load();
	assert_eq!(rejections.len(), 1, "a stale panels entry produced {rejections:?}");
	assert_eq!(rejections[0].kind, StoreKind::Panels);
	assert!(
		matches!(rejections[0].error, PersistenceError::VersionMismatch { found: 1, .. }),
		"the refusal does not state the version it found: {:?}",
		rejections[0].error
	);
	assert!(state.panels.is_empty(), "the stale panel shape was served rather than refused");
	assert_eq!(
		state.composer,
		populated().composer,
		"refusing one store took another store's document with it"
	);
}

#[test]
fn a_write_leaves_no_half_written_file_beside_the_one_it_replaced() {
	let (_tree, dir) = state_dir("gui-state-atomic");
	let mut writer = StateWriter::new(dir.clone());
	let mut tracker = StateTracker::new(PersistedState::new());
	tracker.sync(&populated(), &mut writer, 0);
	writer.flush_all();

	let names: BTreeSet<String> = fs::read_dir(dir.root())
		.expect("the state directory exists")
		.filter_map(Result::ok)
		.map(|entry| entry.file_name().to_string_lossy().into_owned())
		.collect();
	let expected: BTreeSet<String> = StoreKind::ALL
		.iter()
		.map(|kind| kind.file_name().to_string())
		.collect();
	assert_eq!(
		names, expected,
		"the state directory holds something other than one document per store"
	);
}

#[test]
fn the_state_directory_is_the_one_the_environment_names() {
	let (tree, _dir) = state_dir("gui-state-discover");
	let named = tree.path().join("elsewhere");
	// SAFETY: this is the only test in this binary that reads or writes the
	// environment, and it does so before any thread it starts.
	unsafe {
		std::env::set_var(veyyon_desktop::state::VEYYON_DESKTOP_STATE_DIR_ENV, &named);
	}
	let discovered = StateDir::discover().expect("an explicitly named directory is discovered");
	// SAFETY: the same single-threaded point in this test, unsetting what it
	// set so no later test in this binary reads it.
	unsafe {
		std::env::remove_var(veyyon_desktop::state::VEYYON_DESKTOP_STATE_DIR_ENV);
	}
	assert_eq!(
		discovered,
		StateDir::at(named),
		"a window told where to keep its state kept it somewhere else"
	);
}
