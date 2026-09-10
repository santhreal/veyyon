//! WHY: the right panel's tabs draw domains the host answers only when it is
//! asked, and the window asks once, when the panel opens. A working tree that
//! changed for any reason other than a turn -- a command run in the terminal
//! drawer, a file edited by hand, a commit made outside the window -- reached
//! no client at all: `republishWorkspace` covers what a turn changed, and
//! nothing covers what changed while the agent was idle. Moving to the
//! Changes tab drew the diff the panel had been holding since the handshake,
//! and the only way to see the working tree as it was now was to close the
//! panel and open it again, which is the one path that re-asks.
//!
//! CLASS CLOSED: a workspace tab whose domain is never re-stated when the
//! operator moves to it. The sweep enumerates `PanelTab` at run time, so a tab
//! added to the panel fails to compile here until someone states what it asks
//! for, and each tab is checked in three states: the capability available, the
//! capability refused, and the capability unanswered.
//!
//! What it does NOT catch: whether the host's answer is fresh -- that is the
//! host's own read of the repository, held by
//! `a-domain-a-turn-changes-is-restated-when-the-agent-goes-idle.test.ts` --
//! and whether the tab strip wires its click to this intent, which is
//! `a-click-lands-on-the-row-tab-card-or-drawer-it-named.rs` in the surface
//! crate.

mod support;

use std::collections::HashMap;

use strum::IntoEnumIterator;
use support::session;
use veyyon_desktop::{SessionIndex, actions_for};
use veyyon_desktop_model::{
	Capability, CapabilityStatus, ChangeScope, ChangesView, FileContentView, FileKind, FileNode,
	FileTreeView, HostAction, HostEvent, QueuePartition, SessionId, SnapshotSection, Store,
	UsageTotals, UsageView, reduce,
};
use veyyon_desktop_surface::{Intent, PanelTab};

/// The session every tab is read against.
const SESSION: &str = "s";
/// The directory the client loaded its tree at, which is not the workspace
/// root: a re-statement that forgets it resets the pane the operator is on.
const TREE_ROOT: &str = "src/project";
/// The file the panel's File tab is holding.
const OPEN_FILE: &str = "src/project/panel.rs";

/// The capability that fills each tab, and what moving to the tab asks the
/// host for. The match is exhaustive: a tab added to the panel does not
/// compile until it is stated here.
fn expected(tab: PanelTab) -> (Capability, Vec<HostAction>) {
	match tab {
		PanelTab::Diff => (Capability::Changes, vec![HostAction::RefreshChanges]),
		PanelTab::File => {
			(Capability::Files, vec![HostAction::ReadFile { path: OPEN_FILE.to_owned() }])
		},
		PanelTab::Tree => {
			(Capability::Files, vec![HostAction::LoadFileTree { root: Some(TREE_ROOT.to_owned()) }])
		},
		PanelTab::Usage => {
			(Capability::Usage, vec![HostAction::GetUsage { session: Some(SessionId::from(SESSION)) }])
		},
	}
}

/// A store holding what a client has been sent: an active session, the four
/// domains the panel draws, and every capability behind them available.
///
/// Everything arrives through `reduce` as a host snapshot, so the store under
/// test is the one the wire produces rather than one assembled by hand.
fn attached() -> (Store, SessionIndex) {
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
			(Capability::Usage, CapabilityStatus::Available),
		])),
	);
	reduce(
		&mut store,
		HostEvent::Snapshot(SnapshotSection::Changes(ChangesView {
			revision:       1,
			repository:     Some("/repo".to_owned()),
			scope:          ChangeScope::WorkingTree,
			files:          Vec::new(),
			diff:           String::new(),
			diff_truncated: false,
			files_withheld: 0,
		})),
	);
	reduce(
		&mut store,
		HostEvent::Snapshot(SnapshotSection::FileTree(FileTreeView {
			root:      TREE_ROOT.to_owned(),
			entries:   vec![FileNode {
				path:  OPEN_FILE.to_owned(),
				name:  "panel.rs".to_owned(),
				kind:  FileKind::File,
				depth: 0,
			}],
			truncated: false,
		})),
	);
	reduce(
		&mut store,
		HostEvent::Snapshot(SnapshotSection::FileContent(FileContentView {
			path:       OPEN_FILE.to_owned(),
			content:    "fn main() {}\n".to_owned(),
			size_bytes: 13,
			truncated:  false,
			binary:     false,
		})),
	);
	reduce(
		&mut store,
		HostEvent::Snapshot(SnapshotSection::Usage(UsageView {
			session: SessionId::from(SESSION),
			totals:  UsageTotals {
				input_tokens:         120,
				output_tokens:        34,
				cache_read_tokens:    0,
				cache_write_tokens:   0,
				orchestration_tokens: 0,
				premium_requests:     0,
				cost_microusd:        Some(3_000),
			},
		})),
	);

	(store, SessionIndex::new())
}

#[test]
fn every_tab_asks_the_host_to_state_the_domain_it_draws() {
	let (mut store, index) = attached();
	let mut reached: Vec<PanelTab> = Vec::new();

	for tab in PanelTab::iter() {
		let (_, wanted) = expected(tab);
		assert_eq!(
			actions_for(&Intent::SelectTab(tab), &index, &mut store),
			wanted,
			"moving to {tab:?} did not ask the host to state what the tab draws"
		);
		reached.push(tab);
	}

	// The sweep read the tab list off the enum, so a tab added to the panel
	// arrives here rather than being covered by a list written down once.
	assert_eq!(reached, PanelTab::iter().collect::<Vec<_>>());
}

#[test]
fn a_tab_selection_is_reported_rather_than_finished_by_the_window() {
	for tab in PanelTab::iter() {
		assert!(
			!Intent::SelectTab(tab).is_local(),
			"{tab:?} is finished by the window alone, so the domain behind it is never re-stated"
		);
	}
}

#[test]
fn a_capability_the_host_refused_or_has_not_answered_is_asked_for_nothing() {
	for tab in PanelTab::iter() {
		let (capability, wanted) = expected(tab);
		for status in [
			CapabilityStatus::Unavailable { reason: "git is not installed".to_owned() },
			CapabilityStatus::UnknownUntilAttached,
		] {
			let (mut store, index) = attached();
			reduce(
				&mut store,
				HostEvent::Snapshot(SnapshotSection::Capabilities(vec![(capability, status.clone())])),
			);
			assert!(
				actions_for(&Intent::SelectTab(tab), &index, &mut store).is_empty(),
				"{tab:?} asked for {wanted:?} against a host whose {capability:?} is {status:?}"
			);
		}
	}
}

#[test]
fn the_tree_is_restated_at_the_root_the_client_loaded() {
	let (mut store, index) = attached();
	assert_eq!(
		actions_for(&Intent::SelectTab(PanelTab::Tree), &index, &mut store),
		[HostAction::LoadFileTree { root: Some(TREE_ROOT.to_owned()) }],
		"the tree was re-stated at a root the client is not drawing"
	);

	// A client that never loaded a tree has no root to name, and asks for the
	// one the host chooses.
	let mut fresh = Store::new();
	fresh
		.sessions
		.insert(session(SESSION, QueuePartition::Live));
	fresh.persisted.shell.active_session = Some(SessionId::from(SESSION));
	reduce(
		&mut fresh,
		HostEvent::Snapshot(SnapshotSection::Capabilities(vec![(
			Capability::Files,
			CapabilityStatus::Available,
		)])),
	);
	assert_eq!(
		actions_for(&Intent::SelectTab(PanelTab::Tree), &index, &mut fresh),
		[HostAction::LoadFileTree { root: None }],
		"a tree nothing has loaded asked for a root the client invented"
	);
}

#[test]
fn a_tab_with_nothing_open_and_a_window_with_no_session_ask_for_nothing() {
	// The File tab holds one file. With none open there is no path to read
	// again, and an export drawn in its place is not a file the host holds.
	let (mut store, index) = attached();
	store.domains.file_content.clear();
	assert!(
		actions_for(&Intent::SelectTab(PanelTab::File), &index, &mut store).is_empty(),
		"the File tab asked the host to read a file nothing had opened"
	);

	// The totals are a session's, so a window on no session asks for none.
	let (mut no_session, index) = attached();
	no_session.persisted.shell.active_session = None;
	assert!(
		actions_for(&Intent::SelectTab(PanelTab::Usage), &index, &mut no_session).is_empty(),
		"the Usage tab asked for the totals of no session"
	);
}

#[test]
fn the_panel_state_the_window_owns_survives_the_request_it_sends() {
	// The selection is still the window's: the intent is reported for the
	// domain, and the tab the operator clicked is the one drawn, taken from
	// the panel's own tab list.
	let mut state = veyyon_desktop_surface::ShellState::default();
	state.panel.tabs = vec![PanelTab::Diff, PanelTab::Tree];
	state.keymap.panel_collapsed = true;

	Intent::SelectTab(PanelTab::Tree).apply(&mut state);
	assert_eq!(state.panel.active_tab, PanelTab::Tree);
	assert!(!state.keymap.panel_collapsed, "moving to a tab left the panel collapsed");

	Intent::SelectTab(PanelTab::Usage).apply(&mut state);
	assert_eq!(
		state.panel.active_tab,
		PanelTab::Tree,
		"a tab this panel does not offer became the active one"
	);

	// The projection is what fills the tab list, and it is the same list the
	// apply reads, so the two cannot disagree about which tabs exist.
	let (store, _) = attached();
	let mut projected = veyyon_desktop_surface::ShellState::default();
	veyyon_desktop::project(
		&store,
		&mut SessionIndex::new(),
		&HashMap::new(),
		support::NOW_MS,
		&mut projected,
	);
	assert_eq!(projected.panel.tabs, vec![
		PanelTab::Diff,
		PanelTab::File,
		PanelTab::Tree,
		PanelTab::Usage
	]);
}
