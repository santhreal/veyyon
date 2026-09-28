//! Moving to a tab, reopening the panel on one and showing another session
//! ask the host to state again what the tab draws, and the answer the panel
//! holds stays drawn until the new one lands. One ask per domain is in
//! flight: a visit while it is due sends nothing, and a visit to a tab that
//! states a refusal sends nothing over it. The agent roster, which the host
//! sends on every change, is asked for only while none is held.
//!
//! WHY: the host restates the working tree, the project tree and the usage
//! only when a turn ends or the directory changes, and the diagnostics and
//! the context window only when asked. A tree changed by a command in the
//! drawer, a file edited by hand or a commit made outside the window reached
//! no tab that asked once, so the panel drew the diff of the handshake until
//! it was closed and reopened. The sweeps read `PanelTab::ALL`, hold what
//! every tab draws, answer every ask and visit each tab again: a tab that
//! asks only while its domain is absent turns them red, as does one that asks
//! a second time while the first is due, drops what it holds while it waits,
//! or sends again what the host refused.
//!
//! Gap: whether the host's answer is fresh is the host's own read of the
//! repository, and how a refusal is drawn is the refusal suite's.

use gpui::TestAppContext;
use veyyon_desktop_app::{actions::panel::OpenFile, panel::PanelTab};
use veyyon_desktop_model::{
	ContextBreakdownView, ContextCategory, FileContentView, FileKind, FileNode, FileTreeView,
	HostAction, HostEvent, HostRequest, SessionId, SnapshotSection, UsageTotals, UsageView,
};

use super::{
	changes,
	harness::{SESSION, Win, agent, opened, refused, window},
	loads,
};

/// What a visit to `tab` asks the host to state again while the panel holds
/// every domain the tab draws. A new tab fails to compile here until it is
/// decided.
fn restated(tab: PanelTab) -> Vec<HostAction> {
	match tab {
		// The host sends the roster on every change of it.
		PanelTab::Agents => Vec::new(),
		PanelTab::Diff
		| PanelTab::Files
		| PanelTab::Todo
		| PanelTab::Diagnostics
		| PanelTab::Usage => loads(tab),
	}
}

/// A line each tab draws from the answer it holds.
const fn held_line(tab: PanelTab) -> Option<&'static str> {
	match tab {
		PanelTab::Diff => Some("fn new_one() {}"),
		PanelTab::Files => Some("held-dir"),
		PanelTab::Agents => Some("Kestrel"),
		PanelTab::Todo => None,
		PanelTab::Diagnostics => Some("The host names no source"),
		PanelTab::Usage => Some("1,200"),
	}
}

/// The host's answer for every domain the panel draws.
fn held() -> Vec<HostEvent> {
	let session = SessionId::from(SESSION);
	vec![
		changes(),
		HostEvent::Snapshot(SnapshotSection::FileTree(FileTreeView {
			root:      "/w/s".to_owned(),
			entries:   vec![FileNode {
				path:  "held-dir".to_owned(),
				name:  "held-dir".to_owned(),
				kind:  FileKind::Directory,
				depth: 0,
			}],
			truncated: false,
		})),
		HostEvent::Snapshot(SnapshotSection::Agents(vec![agent(
			"k", "Kestrel", "sub", "running", None,
		)])),
		HostEvent::Snapshot(SnapshotSection::Diagnostics(serde_json::json!({}))),
		HostEvent::Snapshot(SnapshotSection::Usage(UsageView {
			session: session.clone(),
			totals:  UsageTotals {
				input_tokens:         1_200,
				output_tokens:        340,
				cache_read_tokens:    0,
				cache_write_tokens:   0,
				orchestration_tokens: 0,
				premium_requests:     0,
				cost_microusd:        None,
			},
		})),
		HostEvent::Snapshot(SnapshotSection::ContextBreakdown(ContextBreakdownView {
			session,
			total_tokens: 900,
			limit_tokens: Some(200_000),
			categories: vec![ContextCategory { name: "messages".to_owned(), tokens: 900 }],
		})),
	]
}

/// A window over a session whose every domain the host has answered.
fn holding(app: &mut TestAppContext) -> Win<'_> {
	let mut events = opened(SESSION);
	events.extend(held());
	window(app, events)
}

/// The host taking every request in `asked`.
fn answer(w: &mut Win<'_>, asked: Vec<HostRequest>) {
	w.apply(
		asked
			.into_iter()
			.map(|request| HostEvent::RequestSucceeded { request: request.id })
			.collect(),
	);
}

fn actions(asked: &[HostRequest]) -> Vec<HostAction> {
	asked.iter().map(|request| request.action.clone()).collect()
}

/// Opens `path` the way a link in the transcript does.
fn open_file(w: &mut Win<'_>, path: &str) {
	w.cx
		.dispatch_action(OpenFile { path: path.to_owned(), line: None });
	w.cx.run_until_parked();
}

#[gpui::test]
fn every_visit_restates_what_the_tab_draws_and_holds_the_old_answer_until_the_new_one(
	app: &mut TestAppContext,
) {
	let mut w = holding(app);
	w.open(PanelTab::Diff);
	let mut asked = w.requests();
	assert_eq!(actions(&asked), restated(PanelTab::Diff), "opening the panel restates the diff");

	for round in 0..2 {
		for tab in PanelTab::ALL.into_iter().skip(usize::from(round == 0)) {
			w.click(&format!("panel.tab:{}", tab.name()));
			let visit = w.requests();
			assert_eq!(actions(&visit), restated(tab), "visit {round} to {tab:?} restates it");
			asked.extend(visit);
		}
		for tab in PanelTab::ALL {
			w.click(&format!("panel.tab:{}", tab.name()));
			assert_eq!(w.sent(), Vec::<HostAction>::new(), "{tab:?} asks nothing while it is due");
			if let Some(line) = held_line(tab) {
				assert!(w.draws(line), "{tab:?} draws what it holds while it waits: {:?}", w.texts());
			}
		}
		answer(&mut w, std::mem::take(&mut asked));
	}

	w.toggle();
	assert_eq!(w.sent(), Vec::<HostAction>::new(), "a closed panel asks nothing");
	w.toggle();
	assert_eq!(w.sent(), restated(PanelTab::Usage), "reopening on a tab restates it");
}

#[gpui::test]
fn showing_another_session_restates_the_tab_it_reopens_on(app: &mut TestAppContext) {
	let mut w = holding(app);
	w.open(PanelTab::Files);
	let asked = w.requests();
	assert_eq!(actions(&asked), restated(PanelTab::Files));
	answer(&mut w, asked);

	w.apply(opened("other"));
	assert_eq!(w.active(), PanelTab::Diff, "a session never shown opens on the diff");
	assert_eq!(w.sent(), restated(PanelTab::Diff), "and restates the working tree it draws");
}

#[gpui::test]
fn the_files_tab_restates_the_file_it_views_and_a_link_reads_only_the_file_it_names(
	app: &mut TestAppContext,
) {
	let mut w = holding(app);
	w.open(PanelTab::Files);
	let asked = w.requests();
	answer(&mut w, asked);

	open_file(&mut w, "src/a.rs");
	let asked = w.requests();
	assert_eq!(actions(&asked), vec![HostAction::ReadFile { path: "src/a.rs".to_owned() }]);
	answer(&mut w, asked);
	w.apply(vec![HostEvent::Snapshot(SnapshotSection::FileContent(FileContentView {
		path:       "src/a.rs".to_owned(),
		content:    "fn held() {}\n".to_owned(),
		size_bytes: 13,
		truncated:  false,
		binary:     false,
	}))]);

	w.click("panel.tab:diff");
	let asked = w.requests();
	answer(&mut w, asked);
	w.click("panel.tab:files");
	let asked = w.requests();
	assert_eq!(
		actions(&asked),
		vec![HostAction::ReadFile { path: "src/a.rs".to_owned() }],
		"the viewer restates the file it shows, not the tree behind it"
	);
	assert!(w.draws("fn held() {}"), "and draws the text it holds meanwhile: {:?}", w.texts());
	answer(&mut w, asked);

	open_file(&mut w, "src/b.rs");
	assert_eq!(
		w.sent(),
		vec![HostAction::ReadFile { path: "src/b.rs".to_owned() }],
		"a link reads the file it names and not the one the viewer held"
	);
}

#[gpui::test]
fn a_visit_sends_nothing_over_a_refusal_its_tab_states(app: &mut TestAppContext) {
	let mut w = holding(app);
	let mut refusing = Vec::new();
	for (ix, tab) in PanelTab::ALL.into_iter().enumerate() {
		w.open(tab);
		let mut asked = w.requests();
		assert_eq!(actions(&asked), restated(tab), "{tab:?} restates what it draws");
		// The host refuses the last ask of the visit, the usage tab's context
		// window among them, final and retryable in turn.
		let Some(last) = asked.pop() else { continue };
		answer(&mut w, asked);
		w.apply(vec![refused(last.id, &format!("{} refused", tab.name()), ix % 2 == 0)]);
		refusing.push(tab);
	}
	assert_eq!(
		refusing,
		PanelTab::ALL
			.into_iter()
			.filter(|tab| !matches!(tab, PanelTab::Agents | PanelTab::Todo))
			.collect::<Vec<_>>(),
		"every tab but the roster and the plan restated something to refuse"
	);

	for tab in PanelTab::ALL {
		w.click(&format!("panel.tab:{}", tab.name()));
		assert_eq!(w.sent(), Vec::<HostAction>::new(), "{tab:?} sends nothing over its refusal");
	}
	w.toggle();
	w.toggle();
	assert_eq!(w.sent(), Vec::<HostAction>::new(), "reopening sends nothing over a refusal");
}
