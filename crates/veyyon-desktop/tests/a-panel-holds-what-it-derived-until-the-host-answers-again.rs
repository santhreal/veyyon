//! WHY: the window re-projects the whole shell on every host event batch, and
//! the right panel's two expensive derivations ran each time -- a repository's
//! unified diff parsed into rows, and the open file highlighted line by line.
//! A streaming turn delivers dozens of batches a second, so a session with a
//! large working tree open spent every one of them re-deriving content the
//! host had not restated. `benches/workspace_projection.rs` measures it:
//! 127ms per streamed delta on 40 changed files and one 4000-line file.
//!
//! CLASS CLOSED: a panel derivation reused when the domain behind it has been
//! answered again, and a derivation repeated when it has not. Each of the
//! three domains the panel derives from (`Changes`, `FileContent`, `Export`)
//! is checked in both directions, and every write goes through
//! `Answered::set`/`clear`, whose count is private -- a new write site cannot
//! forget to move it, because there is no way to write the value without it.
//!
//! What it does NOT catch: the cost itself, which is a timing property and
//! belongs to the bench above; whether the host restates a domain when the
//! working tree changes, which is
//! `a-workspace-tab-restates-the-domain-it-draws.rs`; and the projection of
//! the domains the panel does not memoize (`FileTree`, `Usage`), which are
//! cheap and rebuilt every projection by design.

mod support;

use std::collections::HashMap;

use support::session;
use veyyon_desktop::{SessionIndex, project};
use veyyon_desktop_model::{
	Answered, Capability, CapabilityStatus, ChangeScope, ChangeStatus, ChangedFile, ChangesView,
	ExportView, FileContentView, HostEvent, QueuePartition, SessionId, SnapshotSection, Store,
	reduce,
};
use veyyon_desktop_surface::{
	DiffFile, FileLine, FileView, PanelContent, PanelTab, ShellState, right_panel::highlight_source,
};

const SESSION: &str = "s";
const OPEN_FILE: &str = "src/project/panel.rs";
/// A path no answer in this file carries, so a row or a document naming it can
/// only be one the projection held rather than one it derived.
const HELD: &str = "held-by-the-window.rs";
const NOW_MS: u64 = 10_000;

/// A unified diff naming `path`, with one hunk replacing one line.
fn diff_for(path: &str) -> String {
	format!(
		"diff --git a/{path} b/{path}\n--- a/{path}\n+++ b/{path}\n@@ -1,1 +1,1 @@\n-fn old() \
		 {{}}\n+fn new() {{}}\n"
	)
}

fn changes_for(path: &str, revision: u64) -> ChangesView {
	ChangesView {
		revision,
		repository: Some("/repo".to_owned()),
		scope: ChangeScope::WorkingTree,
		files: vec![ChangedFile {
			path:          path.to_owned(),
			previous_path: None,
			status:        ChangeStatus::Modified,
			additions:     1,
			deletions:     1,
		}],
		diff: diff_for(path),
	}
}

fn file_for(path: &str, content: &str) -> FileContentView {
	FileContentView {
		path:       path.to_owned(),
		content:    content.to_owned(),
		size_bytes: u64::try_from(content.len()).unwrap_or(u64::MAX),
		truncated:  false,
		binary:     false,
	}
}

/// A store as the wire leaves it: an active session, both panel capabilities
/// available, and one answer for the changes and the open file.
fn attached() -> (Store, SessionIndex, ShellState) {
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
	reduce(&mut store, HostEvent::Snapshot(SnapshotSection::Changes(changes_for(OPEN_FILE, 1))));
	reduce(
		&mut store,
		HostEvent::Snapshot(SnapshotSection::FileContent(file_for(OPEN_FILE, "fn main() {}\n"))),
	);

	let mut state = ShellState::default();
	project(&store, &mut SessionIndex::new(), &HashMap::new(), NOW_MS, &mut state);
	(store, SessionIndex::new(), state)
}

fn reproject(store: &Store, index: &mut SessionIndex, state: &mut ShellState) {
	project(store, index, &HashMap::new(), NOW_MS, state);
}

/// Marks the rows and the document the window is holding, keeping the stamps
/// the projection wrote, so a later projection that reuses them is visible and
/// one that derives again is too.
fn mark_held(state: &mut ShellState) {
	state.panel.diff = vec![DiffFile {
		path:      HELD.to_owned(),
		old_path:  None,
		status:    ChangeStatus::Modified,
		additions: 0,
		deletions: 0,
		rows:      Vec::new(),
	}];
	state.panel.file = Some(FileView {
		path:      HELD.to_owned(),
		lines:     Vec::new(),
		truncated: false,
		binary:    false,
	});
}

fn diff_paths(panel: &PanelContent) -> Vec<&str> {
	panel.diff.iter().map(|file| file.path.as_str()).collect()
}

fn file_path(panel: &PanelContent) -> Option<&str> {
	panel.file.as_ref().map(|file| file.path.as_str())
}

#[test]
fn a_projection_the_host_answered_nothing_new_for_holds_what_it_derived() {
	let (store, mut index, mut state) = attached();
	mark_held(&mut state);

	reproject(&store, &mut index, &mut state);

	assert_eq!(
		diff_paths(&state.panel),
		vec![HELD],
		"the diff was parsed again although the host restated no changes"
	);
	assert_eq!(
		file_path(&state.panel),
		Some(HELD),
		"the open file was highlighted again although the host restated no file"
	);
}

#[test]
fn a_new_changes_answer_replaces_the_rows_the_window_was_holding() {
	let (mut store, mut index, mut state) = attached();
	mark_held(&mut state);

	reduce(&mut store, HostEvent::Snapshot(SnapshotSection::Changes(changes_for("ledger.rs", 2))));
	reproject(&store, &mut index, &mut state);

	assert_eq!(
		diff_paths(&state.panel),
		vec!["ledger.rs"],
		"the panel drew the diff it had parsed before the host answered again"
	);
	assert_eq!(
		state.panel.diff[0].rows.len(),
		3,
		"the replacement rows came from the answer's diff text rather than its file list"
	);
}

#[test]
fn a_new_file_answer_replaces_the_document_the_window_was_holding() {
	let (mut store, mut index, mut state) = attached();
	mark_held(&mut state);

	reduce(
		&mut store,
		HostEvent::Snapshot(SnapshotSection::FileContent(file_for("ledger.rs", "fn ledger() {}\n"))),
	);
	reproject(&store, &mut index, &mut state);

	assert_eq!(
		file_path(&state.panel),
		Some("ledger.rs"),
		"the panel drew the file it had highlighted before the host answered again"
	);
	assert!(
		diff_paths(&state.panel) == vec![HELD],
		"a file answer re-derived the diff, which no answer had replaced"
	);
}

#[test]
fn a_new_export_answer_replaces_the_document_when_no_file_is_open() {
	let mut store = Store::new();
	store
		.sessions
		.insert(session(SESSION, QueuePartition::Live));
	store.persisted.shell.active_session = Some(SessionId::from(SESSION));
	reduce(
		&mut store,
		HostEvent::Snapshot(SnapshotSection::Capabilities(vec![(
			Capability::Files,
			CapabilityStatus::Available,
		)])),
	);
	let mut state = ShellState::default();
	let mut index = SessionIndex::new();
	reproject(&store, &mut index, &mut state);
	mark_held(&mut state);

	reduce(
		&mut store,
		HostEvent::Snapshot(SnapshotSection::Export(ExportView {
			session: SessionId::from(SESSION),
			format:  "markdown".to_owned(),
			path:    Some("export.md".to_owned()),
			content: Some("# transcript\n".to_owned()),
		})),
	);
	reproject(&store, &mut index, &mut state);

	assert_eq!(
		file_path(&state.panel),
		Some("export.md"),
		"the export answer left the panel drawing the document it had held"
	);
}

#[test]
fn an_open_file_outranks_an_export_after_both_have_been_answered() {
	let (mut store, mut index, mut state) = attached();

	reduce(
		&mut store,
		HostEvent::Snapshot(SnapshotSection::Export(ExportView {
			session: SessionId::from(SESSION),
			format:  "markdown".to_owned(),
			path:    Some("export.md".to_owned()),
			content: Some("# transcript\n".to_owned()),
		})),
	);
	reproject(&store, &mut index, &mut state);

	assert_eq!(
		file_path(&state.panel),
		Some(OPEN_FILE),
		"an export took the tab from the file the operator has open"
	);
}

#[test]
fn a_cleared_domain_empties_the_pane_the_window_was_holding() {
	let (mut store, mut index, mut state) = attached();
	mark_held(&mut state);

	store.domains.changes.clear();
	store.domains.file_content.clear();
	reproject(&store, &mut index, &mut state);

	assert!(
		state.panel.diff.is_empty(),
		"a cleared changes domain left the panel drawing rows the store no longer holds"
	);
	assert_eq!(
		file_path(&state.panel),
		None,
		"a cleared file domain left the panel drawing a document the store no longer holds"
	);
	assert!(
		state.panel.tabs.contains(&PanelTab::Diff),
		"a tab is offered by the capability that fills it, so an emptied domain keeps it"
	);
}

#[test]
fn a_panel_whose_stamps_agree_but_whose_document_disagrees_derives_again() {
	// A panel content assembled anywhere other than a projection -- a restored
	// window, a fixture, a scene seed -- can carry stamps that agree with the
	// store while holding a document the store never answered. The projection
	// derives rather than trusting the stamp.
	let (store, mut index, mut state) = attached();
	let stamps = state.panel.derived_from;
	state.panel = PanelContent { derived_from: stamps, ..PanelContent::default() };

	reproject(&store, &mut index, &mut state);

	assert_eq!(
		file_path(&state.panel),
		Some(OPEN_FILE),
		"a panel holding no document kept drawing none while the store held one"
	);
}

#[test]
fn every_answer_moves_the_count_a_projection_keys_on() {
	let mut domain: Answered<FileContentView> = Answered::default();
	assert_eq!(domain.answers(), 0, "an unanswered domain has been answered nothing");

	domain.set(file_for(OPEN_FILE, "fn main() {}\n"));
	let after_first = domain.answers();
	assert_eq!(after_first, 1, "the first answer did not move the count");

	// The same value again is still an answer: the host read the repository
	// again and said what it found, and a projection keyed on equality would
	// hold content derived before an edit that changed nothing it compares.
	domain.set(file_for(OPEN_FILE, "fn main() {}\n"));
	assert_eq!(domain.answers(), after_first + 1, "an identical answer did not move the count");

	domain.clear();
	assert_eq!(domain.answers(), after_first + 2, "clearing the domain did not move the count");
	assert!(!domain.is_some(), "a cleared domain still held its value");
}

#[test]
fn a_restored_store_and_an_answered_store_describe_the_same_domain() {
	// The count states when an answer arrived, not what the domain holds, so a
	// store read back from disk equals one that received the answer live. The
	// domain-replacement sweep in `veyyon-desktop-model` compares whole
	// `Domains` values and depends on this.
	let live = {
		let mut domain: Answered<FileContentView> = Answered::default();
		domain.set(file_for(OPEN_FILE, "fn main() {}\n"));
		domain.set(file_for(OPEN_FILE, "fn main() {}\n"));
		domain
	};
	let restored: Answered<FileContentView> =
		Answered::from(Some(file_for(OPEN_FILE, "fn main() {}\n")));

	assert_eq!(live, restored, "two stores holding one answer compared unequal");
	assert_ne!(live.answers(), restored.answers(), "the counts were expected to differ");
}

#[test]
fn the_document_a_projection_holds_is_the_one_the_answer_produced() {
	// The reuse path must return the same content the derivation would, not a
	// cheaper approximation of it: the held document is compared against a
	// fresh highlight of the same answer.
	let (store, mut index, mut state) = attached();
	let derived = highlight_source(OPEN_FILE, "fn main() {}\n", false, false);

	reproject(&store, &mut index, &mut state);

	let held = state
		.panel
		.file
		.clone()
		.expect("the panel holds the open file");
	assert_eq!(held.path, derived.path);
	assert_eq!(
		held
			.lines
			.iter()
			.map(|line: &FileLine| line.line_number)
			.collect::<Vec<_>>(),
		derived
			.lines
			.iter()
			.map(|line: &FileLine| line.line_number)
			.collect::<Vec<_>>(),
		"the document the projection held is not the one the answer produces"
	);
}
