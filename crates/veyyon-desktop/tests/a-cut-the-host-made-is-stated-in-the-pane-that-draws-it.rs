//! WHY: a working tree has no size limit and a frame does. The host now cuts
//! a changes snapshot at a byte budget for the diff and a count for the files
//! (`packages/coding-agent/src/gui-host/actions/changes.ts`) rather than
//! sending a frame the window's decoder rejects as fatal. A cut the window
//! does not draw is worse than the crash it replaced: the pane shows a diff
//! that stops at an arbitrary file and a file list that ends early, and reads
//! as a complete statement of the working tree.
//!
//! CLASS CLOSED: the pane states what the host held back, from the answer the
//! host sent, on every projection. Both cuts are covered in both directions --
//! stated when the host cut, and gone the moment an answer arrives that did
//! not -- including across the projection's held rows, where the notice is
//! restated while the parse is reused, and including the case where the cut
//! left no rows at all, which otherwise draws as a clean working tree.
//!
//! What it does NOT catch: the pixels. `withheld_notice` is the one text the
//! pane draws for a cut and it is asserted here, but that the notice row is
//! laid out above the first file is the scene pair's reading, not this
//! suite's. The host's side of the budget -- that the diff is cut on a hunk
//! boundary and no frame outgrows the cap -- is
//! `packages/coding-agent/test/gui-host/
//! no-view-the-host-builds-outgrows-the-frame-it-crosses-in.test.ts`.

mod support;

use std::collections::HashMap;

use support::session;
use veyyon_desktop::{SessionIndex, project};
use veyyon_desktop_model::{
	Capability, CapabilityStatus, ChangeScope, ChangeStatus, ChangedFile, ChangesView, HostEvent,
	QueuePartition, SessionId, SnapshotSection, Store, reduce,
};
use veyyon_desktop_surface::{DiffFile, ShellState, right_panel::diff_rows::withheld_notices};

const SESSION: &str = "s";
const OPEN_FILE: &str = "src/project/panel.rs";
/// A path no answer here carries, so a row naming it is one the projection
/// held rather than one it derived.
const HELD: &str = "held-by-the-window.rs";
const NOW_MS: u64 = 10_000;

fn diff_for(path: &str) -> String {
	format!(
		"diff --git a/{path} b/{path}\n--- a/{path}\n+++ b/{path}\n@@ -1,1 +1,1 @@\n-fn old() \
		 {{}}\n+fn new() {{}}\n"
	)
}

/// A changes answer, stating what the host cut from it.
fn changes(revision: u64, diff: String, diff_truncated: bool, files_withheld: u64) -> ChangesView {
	ChangesView {
		revision,
		repository: Some("/repo".to_owned()),
		scope: ChangeScope::WorkingTree,
		files: vec![ChangedFile {
			path:          OPEN_FILE.to_owned(),
			previous_path: None,
			status:        ChangeStatus::Modified,
			additions:     1,
			deletions:     1,
		}],
		diff,
		diff_truncated,
		files_withheld,
	}
}

/// A store the wire has attached and answered once.
fn attached(view: ChangesView) -> (Store, ShellState) {
	let mut store = Store::new();
	store
		.sessions
		.insert(session(SESSION, QueuePartition::Live));
	store.persisted.shell.active_session = Some(SessionId::from(SESSION));
	reduce(
		&mut store,
		HostEvent::Snapshot(SnapshotSection::Capabilities(vec![
			(Capability::Changes, CapabilityStatus::Available),
			(Capability::Files, CapabilityStatus::Available),
		])),
	);
	reduce(&mut store, HostEvent::Snapshot(SnapshotSection::Changes(view)));

	let mut state = ShellState::default();
	project(&store, &mut SessionIndex::new(), &HashMap::new(), NOW_MS, &mut state);
	(store, state)
}

fn reproject(store: &Store, state: &mut ShellState) {
	project(store, &mut SessionIndex::new(), &HashMap::new(), NOW_MS, state);
}

#[test]
fn a_whole_snapshot_states_no_cut() {
	let (_store, state) = attached(changes(1, diff_for(OPEN_FILE), false, 0));

	assert!(!state.panel.withheld.diff_truncated);
	assert_eq!(state.panel.withheld.files_withheld, 0);
	assert_eq!(state.panel.withheld.diff_bytes, diff_for(OPEN_FILE).len());
	assert!(withheld_notices(state.panel.withheld).is_empty());
}

#[test]
fn a_cut_diff_is_stated_with_the_size_the_window_received() {
	let diff = diff_for(OPEN_FILE);
	let (_store, state) = attached(changes(1, diff.clone(), true, 0));

	assert!(state.panel.withheld.diff_truncated);
	assert_eq!(state.panel.withheld.diff_bytes, diff.len());
	let notices = withheld_notices(state.panel.withheld);
	assert_eq!(notices.len(), 1, "one cut is one line: {notices:?}");
	assert!(notices[0].contains("first"), "{notices:?}");
	assert!(notices[0].contains("KiB"), "{notices:?}");
	assert!(!notices[0].contains("files"), "{notices:?}");
}

#[test]
fn withheld_files_are_stated_by_count() {
	let (_store, state) = attached(changes(1, diff_for(OPEN_FILE), false, 108));

	assert_eq!(state.panel.withheld.files_withheld, 108);
	assert_eq!(withheld_notices(state.panel.withheld), vec![
		"108 more changed files are not listed".to_owned()
	]);
}

#[test]
fn both_cuts_are_stated_one_line_each() {
	let (_store, state) = attached(changes(1, diff_for(OPEN_FILE), true, 3));

	// One line per fact: joined, the two run wider than the pane, and the pane
	// truncates a notice rather than carrying it past its own edge.
	let notices = withheld_notices(state.panel.withheld);
	assert_eq!(notices.len(), 2, "two cuts are two lines: {notices:?}");
	assert!(notices[0].contains("first"), "{notices:?}");
	assert_eq!(notices[1], "3 more changed files are not listed");
}

#[test]
fn a_notice_is_restated_while_the_rows_are_held() {
	let (store, mut state) = attached(changes(1, diff_for(OPEN_FILE), true, 7));
	// Mark the parse, so a projection that reuses it is visible.
	state.panel.diff = vec![DiffFile {
		path:      HELD.to_owned(),
		old_path:  None,
		status:    ChangeStatus::Modified,
		additions: 0,
		deletions: 0,
		rows:      Vec::new(),
	}];

	reproject(&store, &mut state);

	assert_eq!(state.panel.diff.len(), 1, "the projection derived the diff again");
	assert_eq!(state.panel.diff[0].path, HELD, "the projection derived the diff again");
	assert!(state.panel.withheld.diff_truncated);
	assert_eq!(state.panel.withheld.files_withheld, 7);
}

#[test]
fn a_whole_answer_clears_the_notice_the_cut_one_left() {
	let (mut store, mut state) = attached(changes(1, diff_for(OPEN_FILE), true, 40));
	assert!(state.panel.withheld.diff_truncated);

	reduce(
		&mut store,
		HostEvent::Snapshot(SnapshotSection::Changes(changes(2, diff_for(OPEN_FILE), false, 0))),
	);
	reproject(&store, &mut state);

	assert!(!state.panel.withheld.diff_truncated);
	assert_eq!(state.panel.withheld.files_withheld, 0);
	assert!(withheld_notices(state.panel.withheld).is_empty());
}

#[test]
fn a_cut_that_left_no_rows_still_says_so() {
	// The host cut the diff before the first file's body, so the pane has
	// nothing to draw and must not report a clean working tree.
	let (_store, state) = attached(changes(1, String::new(), true, 12));

	assert!(state.panel.diff.iter().all(|file| file.rows.is_empty()));
	let notices = withheld_notices(state.panel.withheld);
	assert_eq!(notices.len(), 2, "an empty cut states both facts: {notices:?}");
	assert!(notices[0].contains("0.0 KiB"), "{notices:?}");
	assert_eq!(notices[1], "12 more changed files are not listed");
}

#[test]
fn a_domain_the_host_never_answered_states_no_cut() {
	let mut store = Store::new();
	store
		.sessions
		.insert(session(SESSION, QueuePartition::Live));
	store.persisted.shell.active_session = Some(SessionId::from(SESSION));
	reduce(
		&mut store,
		HostEvent::Snapshot(SnapshotSection::Capabilities(vec![(
			Capability::Changes,
			CapabilityStatus::Available,
		)])),
	);

	let mut state = ShellState::default();
	project(&store, &mut SessionIndex::new(), &HashMap::new(), NOW_MS, &mut state);

	assert!(withheld_notices(state.panel.withheld).is_empty());
}

#[test]
fn a_refused_capability_states_no_cut_either() {
	let (mut store, mut state) = attached(changes(1, diff_for(OPEN_FILE), true, 5));

	reduce(
		&mut store,
		HostEvent::Snapshot(SnapshotSection::Capabilities(vec![(
			Capability::Changes,
			CapabilityStatus::Unavailable { reason: "no repository".to_owned() },
		)])),
	);
	store.domains.changes.clear();
	reproject(&store, &mut state);

	// The pane is Failed, and a notice about a cut it can no longer show would
	// be a claim about a snapshot that is gone.
	assert!(withheld_notices(state.panel.withheld).is_empty());
}
