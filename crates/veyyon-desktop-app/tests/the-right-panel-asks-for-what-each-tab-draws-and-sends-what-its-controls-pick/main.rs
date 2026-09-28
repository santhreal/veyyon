//! The right panel asks the host for what each tab draws on every visit,
//! reopens a session on the tab it was left on, draws the working tree's
//! changes file by file, sends what the diff and agents controls pick, and
//! renders nothing while a turn streams.
//!
//! WHY: a tab that asks again while its answer is due floods the host, a tab
//! that never asks draws an empty panel, a closed panel that asks spends the
//! host on a surface nobody sees, a panel that keeps focus as it closes leaves
//! the window's bindings reaching nothing, and a panel that redraws per
//! streamed token costs every frame of a turn. The suite drives the real
//! `RightPanel` inside the real `Workspace` over an `AppState` fed host events,
//! clicks its tabs, controls and fields, and reads the drawn text, the requests
//! queued, the layout and the render counts.
//!
//! Gap: the diagnostics tab is reached and its load asserted, but its rows are
//! not driven; the split diff layout is proven
//! by the row pairing tests in the crate, not drawn here. Horizontal scroll
//! of the diff with wrapping off is not offered: its rows clip.

mod browse;
mod cuts;
mod declined;
mod derived;
mod gated;
mod harness;
mod long_lines;
mod refusals;
mod restate;
mod search;
mod usage;

use gpui::TestAppContext;
use veyyon_desktop_app::panel::PanelTab;
use veyyon_desktop_model::{
	ChangeScope, ChangeStatus, ChangedFile, ChangesView, HostAction, HostEvent, SessionId,
	SnapshotSection,
};

use self::harness::{SESSION, agent, delta, opened, window};

/// What showing `tab` asks the host for while nothing is held or due. A new
/// tab fails to compile here until its load is decided.
fn loads(tab: PanelTab) -> Vec<HostAction> {
	let session = SessionId::from(SESSION);
	match tab {
		PanelTab::Diff => vec![HostAction::RefreshChanges],
		PanelTab::Files => vec![HostAction::LoadFileTree { root: None }],
		PanelTab::Agents => vec![HostAction::RefreshAgents],
		PanelTab::Todo => Vec::new(),
		PanelTab::Diagnostics => vec![HostAction::RefreshDiagnostics],
		PanelTab::Usage => vec![
			HostAction::GetUsage { session: Some(session.clone()) },
			HostAction::GetContextBreakdown { session },
		],
	}
}

/// The header of a hunk taking `old` lines from line `from` to `new` lines.
fn hunk(from: u32, old: u32, new: u32) -> String {
	let at = "@".repeat(2);
	format!("{at} -{from},{old} +{},{new} {at}", from.max(1))
}

/// `src/lib.rs` with one line replaced by two, and a new `README.md`.
fn diff() -> String {
	[
		"diff --git a/src/lib.rs b/src/lib.rs",
		"index 1111111..2222222 100644",
		"--- a/src/lib.rs",
		"+++ b/src/lib.rs",
		&hunk(1, 3, 4),
		" fn keep() {}",
		"-fn old() {}",
		"+fn new_one() {}",
		"+fn added() {}",
		" fn tail() {}",
		"diff --git a/README.md b/README.md",
		"new file mode 100644",
		"--- /dev/null",
		"+++ b/README.md",
		&hunk(0, 0, 1),
		"+# Title",
		"",
	]
	.join("\n")
}

/// One changed file.
fn changed(path: &str, status: ChangeStatus, additions: u64, deletions: u64) -> ChangedFile {
	ChangedFile { path: path.to_owned(), previous_path: None, status, additions, deletions }
}

/// The working tree's `files`, changed by `diff`.
fn changes_of(files: Vec<ChangedFile>, diff: String) -> HostEvent {
	HostEvent::Snapshot(SnapshotSection::Changes(ChangesView {
		revision: 1,
		repository: Some("/w/s".to_owned()),
		scope: ChangeScope::WorkingTree,
		files,
		diff,
		diff_truncated: false,
		files_withheld: 0,
	}))
}

fn changes() -> HostEvent {
	changes_of(
		vec![
			changed("src/lib.rs", ChangeStatus::Modified, 2, 1),
			changed("README.md", ChangeStatus::Added, 1, 0),
		],
		diff(),
	)
}

#[gpui::test]
fn each_tab_asks_the_host_for_what_it_draws_and_the_session_reopens_on_it(
	app: &mut TestAppContext,
) {
	let mut w = window(app, opened(SESSION));
	assert_eq!(w.sent(), Vec::<HostAction>::new(), "a closed panel asks the host for nothing");

	w.open(PanelTab::Diff);
	assert_eq!(w.sent(), loads(PanelTab::Diff));
	for tab in PanelTab::ALL.into_iter().skip(1) {
		w.click(&format!("panel.tab:{}", tab.name()));
		assert_eq!(w.active(), tab);
		assert_eq!(w.sent(), loads(tab), "{tab:?} asks for what it draws");
		assert_eq!(w.layout().panel_tab.as_ref(), tab.name(), "the layout names the shown tab");
		assert_eq!(w.persisted().as_deref(), Some(tab.name()), "the session reopens on {tab:?}");
	}
	for tab in PanelTab::ALL {
		w.click(&format!("panel.tab:{}", tab.name()));
		assert_eq!(
			w.sent(),
			Vec::<HostAction>::new(),
			"{tab:?} asks nothing while its answer is due"
		);
	}

	w.toggle();
	w.toggle();
	assert_eq!(w.sent(), Vec::<HostAction>::new(), "a reopened panel asks nothing already due");
	assert_eq!(w.active(), PanelTab::Usage);

	w.apply(opened("other"));
	assert_eq!(w.active(), PanelTab::Diff, "a session never shown opens on the diff");
	w.click("panel.tab:todo");
	w.apply(opened(SESSION));
	assert_eq!(w.active(), PanelTab::Usage, "each session reopens on its own tab");
}

#[gpui::test]
fn the_diff_tab_draws_each_changed_file_and_sends_the_scope_it_picks(app: &mut TestAppContext) {
	let mut w = window(app, opened(SESSION));
	w.open(PanelTab::Diff);
	w.sent();
	w.apply(vec![changes()]);
	for drawn in ["Diff +3 \u{2212}1", "src/lib.rs", "README.md", "fn new_one() {}", "# Title"] {
		assert!(w.draws(drawn), "{drawn:?} is drawn in {:?}", w.texts());
	}

	w.click_text("Staged");
	assert_eq!(w.sent(), vec![HostAction::SelectChangeScope { scope: ChangeScope::Staged }]);

	w.click_text("src/lib.rs");
	assert!(w.draws("src/lib.rs"), "a collapsed file keeps its header");
	assert!(!w.draws("fn new_one() {}"), "and draws none of its lines");
	assert!(w.draws("# Title"), "the other file stays open");
	w.click_text("src/lib.rs");
	assert!(w.draws("fn new_one() {}"));
}

#[gpui::test]
fn the_agents_tab_counts_ends_revives_previews_and_opens_an_agent(app: &mut TestAppContext) {
	let mut w = window(app, opened(SESSION));
	w.apply(vec![HostEvent::Snapshot(SnapshotSection::Agents(vec![
		agent("adv", "Advisor-2", "advisor", "parked", None),
		agent("k", "Kestrel", "sub", "running", Some("k-1")),
	]))]);
	w.open(PanelTab::Agents);
	assert_eq!(w.sent(), Vec::<HostAction>::new(), "a roster the host sent is not asked for");
	assert!(w.draws("Kestrel") && w.draws("Advisor-2"));
	assert!(w.draws("Agents 1"), "the strip counts the spawn mid-turn: {:?}", w.texts());

	w.click_text("End");
	assert!(w.draws("End Kestrel?"), "ending an agent asks first");
	assert_eq!(w.sent(), Vec::<HostAction>::new());
	w.click_text("End agent");
	assert_eq!(w.sent(), vec![HostAction::CancelTask { task_id: "k".to_owned() }]);

	w.click_text("Revive");
	assert_eq!(w.sent(), vec![HostAction::ReviveAgent { agent_id: "adv".to_owned() }]);

	w.click_text("Preview");
	assert_eq!(w.sent(), vec![HostAction::PreviewSessionTranscript {
		session: SessionId::from("k-1"),
	}]);

	w.click_text("Open");
	assert_eq!(w.sent().first(), Some(&HostAction::OpenSession { session: SessionId::from("k-1") }));

	w.apply(vec![HostEvent::Snapshot(SnapshotSection::Agents(vec![
		agent("main", "Main", "main", "running", Some(SESSION)),
		agent("k", "Kestrel", "sub", "blocked", Some("k-1")),
		agent("w", "Wren", "sub", "idle", None),
		agent("h", "Heron", "sub", "running", None),
	]))]);
	assert!(
		w.draws("Agents 2"),
		"the main agent and an idle spawn are not counted: {:?}",
		w.texts()
	);
	w.apply(vec![HostEvent::Snapshot(SnapshotSection::Agents(vec![agent(
		"w", "Wren", "sub", "idle", None,
	)]))]);
	assert!(
		w.texts().iter().any(|drawn| drawn.trim() == "Agents"),
		"no spawn mid-turn draws no count: {:?}",
		w.texts()
	);
}

#[gpui::test]
fn a_streamed_turn_renders_no_tab(app: &mut TestAppContext) {
	let mut w = window(app, opened(SESSION));
	w.apply(vec![changes()]);
	w.open(PanelTab::Diff);
	let mut revision = 0;
	for tab in PanelTab::ALL {
		w.click(&format!("panel.tab:{}", tab.name()));
		let before = w.renders();
		let turn = (0..40)
			.map(|_| {
				revision += 1;
				delta(revision)
			})
			.collect();
		w.apply(turn);
		assert_eq!(w.renders(), before, "a streamed turn redraws nothing on {tab:?}");
	}
}

#[gpui::test]
fn closing_the_panel_while_its_field_holds_focus_keeps_the_bindings_reaching_the_window(
	app: &mut TestAppContext,
) {
	let mut w = window(app, opened(SESSION));
	w.open(PanelTab::Files);
	w.click_text("Search files and contents");
	w.toggle();
	assert!(!w.layout().panel_open, "the binding closes the panel from its field");
	assert_eq!(w.bounds("panel"), None);

	w.toggle();
	assert!(w.layout().panel_open, "the same binding opens it again once the field is gone");
	assert!(w.bounds("panel").is_some());
}
