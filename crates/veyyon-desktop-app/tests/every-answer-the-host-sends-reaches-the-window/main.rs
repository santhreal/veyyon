//! Every snapshot section the host sends changes what the window draws once
//! the surface it lands on is shown.
//!
//! WHY: a section the reducer stores and no region reads reaches no pixel.
//! The host answers the control the operator pressed, the store holds the
//! answer, and nothing happens on screen. The reducer's suites pass because
//! the store changed, and each region's suite passes because it never asks
//! what fills the field. The sweep reads the shared corpus
//! (`veyyon-desktop-model/tests/fixtures/snapshot-sections.json`, one entry
//! per `SnapshotSectionKind`, which the count assertion pins), opens a whole
//! window at rest on an attached host, shows the surface `destination` names
//! for the section, and compares the text the frame draws before and after
//! the section arrives. `destination` matches the kind exhaustively, so a
//! section added to the protocol does not compile until its surface is
//! stated, and `NOT_DRAWN` is pinned by exact equality in both directions.
//!
//! Gap: only drawn text is compared. A section that changes a colour, a
//! disabled control or a hitbox and no word reads as silent and must be
//! recorded. It does not prove the section reaches the right surface or
//! reaches it legibly; each region's suite owns that. It does not prove the
//! host sends the section; the gui-host suites own that.

mod harness;

use std::{fs, path::PathBuf, time::Duration};

use serde_json::json;
use strum::IntoEnumIterator as _;
use veyyon_desktop_app::{
	actions::{composer, panel::OpenFile, thread, workspace as act},
	drawer::DrawerTab,
};
use veyyon_desktop_model::{
	Capability, CapabilityStatus, ComposerRequest, ConnectionState, HostAction, HostEvent,
	PROTOCOL_VERSION, SnapshotSection, SnapshotSectionKind as Kind,
};

use self::harness::{Win, install, window};

/// Sections the window stores and draws nowhere, with the reason.
const NOT_DRAWN: &[Kind] = &[];

/// The surface a section is drawn on, reached the way the operator reaches
/// it.
enum Prepare {
	/// The window at rest on the open thread.
	Rest,
	/// Settings, open on a page by its stable name and anchor.
	Settings(&'static str),
	/// The right panel, open on a tab by its stable name.
	Panel(&'static str),
	/// The files tab, viewing a file.
	File(&'static str),
	/// The files tab, having searched for a query.
	FileSearch(&'static str),
	/// The palette, open on a query.
	Palette(&'static str),
	/// The drawer, showing a terminal.
	Terminal(&'static str),
	/// The drawer, listing the processes.
	Processes,
	/// The drawer, following a process's output.
	Process(&'static str),
	/// The sidebar, searching the threads for a query once typing pauses.
	ThreadSearch(&'static str),
	/// The agents tab, previewing the session of the agent the roster lists.
	Preview,
	/// The composer's history menu, searched for the draft typed.
	HistorySearch(&'static str),
	/// The composer, with an extension completing the draft typed.
	Completion(&'static str),
	/// The thread column, showing the open thread's session tree.
	Tree,
}

/// Where `kind` is drawn, and the corpus sections of other kinds that
/// surface draws it beside. Exhaustive: a new kind does not compile until
/// its surface is stated.
const fn destination(kind: Kind) -> (Prepare, &'static [Kind]) {
	match kind {
		Kind::Sessions
		| Kind::ActiveSession
		| Kind::Transcript
		| Kind::Interactions
		| Kind::Models
		| Kind::Share
		| Kind::Profiles
		| Kind::Export
		| Kind::QueuedPrompts
		| Kind::AgentPause
		| Kind::Goal
		| Kind::Dictation
		| Kind::ForegroundCommand
		| Kind::AutoswarmConsole
		| Kind::Host
		| Kind::Checkout
		| Kind::Pace
		| Kind::ServingAccount
		| Kind::ExtensionUi
		| Kind::ComposerEdit
		| Kind::ExtensionNotice => (Prepare::Rest, &[]),
		Kind::Settings => (Prepare::Settings("general"), &[]),
		Kind::Themes => (Prepare::Settings("appearance"), &[]),
		Kind::Keybindings => (Prepare::Settings("keybindings"), &[]),
		Kind::Providers => (Prepare::Settings("providers"), &[]),
		// A login and a sign-in are drawn under the provider they belong to.
		Kind::Accounts | Kind::AuthFlow => (Prepare::Settings("providers"), &[Kind::Providers]),
		Kind::Mcp => (Prepare::Settings("mcp"), &[]),
		// A probe and a catalog are drawn beside the server they describe.
		Kind::McpCatalog | Kind::McpProbe => (Prepare::Settings("mcp"), &[Kind::Mcp]),
		Kind::McpRegistry => (Prepare::Settings("mcp#registry"), &[]),
		Kind::Extensions => (Prepare::Settings("extensions"), &[]),
		Kind::Capabilities | Kind::Changes => (Prepare::Panel("diff"), &[]),
		Kind::FileTree => (Prepare::Panel("files"), &[]),
		Kind::Agents | Kind::AgentComms => (Prepare::Panel("agents"), &[]),
		Kind::Todo => (Prepare::Panel("todo"), &[]),
		Kind::Diagnostics => (Prepare::Panel("diagnostics"), &[]),
		Kind::Usage | Kind::ContextBreakdown | Kind::Quota => (Prepare::Panel("usage"), &[]),
		Kind::FileContent => (Prepare::File("src/app.ts"), &[]),
		Kind::SearchResults => (Prepare::FileSearch("app"), &[]),
		Kind::ContentMatches => (Prepare::FileSearch("todo"), &[]),
		// The root lists more window actions than the card holds; a slash
		// ranks the commands into view, the way the operator asks for them.
		Kind::Commands => (Prepare::Palette("/"), &[]),
		Kind::Terminals | Kind::TerminalOutput => (Prepare::Terminal("term-1"), &[]),
		Kind::Processes => (Prepare::Processes, &[]),
		Kind::ProcessLogs => (Prepare::Process("web"), &[]),
		Kind::SessionSearch => (Prepare::ThreadSearch("needle"), &[]),
		Kind::SessionTranscript => (Prepare::Preview, &[]),
		Kind::PromptHistory => (Prepare::HistorySearch("refactor"), &[]),
		Kind::ComposerCompletions => (Prepare::Completion("fix #is"), &[]),
		Kind::SessionTree => (Prepare::Tree, &[]),
	}
}

fn section(value: serde_json::Value) -> SnapshotSection {
	serde_json::from_value(value).expect("a fixture section decodes")
}

/// A host the window is attached to that takes every request, with the
/// thread `sess-1` open, terminal `term-1` running, process `web` running
/// and an agent working in session `history-1`, each with values the corpus
/// replaces, so a section that lands is a section that changes something.
fn attached() -> Vec<HostEvent> {
	let every = Capability::iter()
		.map(|capability| (capability, CapabilityStatus::Available))
		.collect();
	let sections = [
		SnapshotSection::Capabilities(every),
		section(json!({ "Sessions": [{ "revision": 1, "value": [{
			"id": "sess-1", "workspace": "repo", "path": "/repo/.veyyon/sessions/sess-1.jsonl",
			"cwd": "/repo", "title": "First thread", "parent_path": null,
			"created_at_ms": 1_600_000_000_000_u64, "modified_at_ms": 1_600_000_000_000_u64,
			"message_count": 1, "size_bytes": 1, "first_message": null,
			"searchable_messages": null, "status": "Complete"
		}] }, []] })),
		section(json!({ "ActiveSession": { "revision": 1, "value": {
			"id": "sess-1", "schema_version": 1, "title": "First thread", "title_source": null,
			"parent": null, "created_at_ms": 1_600_000_000_000_u64, "cwd": "/repo", "mode": null
		} } })),
		section(json!({ "Transcript": { "revision": 1, "value": [{
			"id": "entry-0", "parent": null, "revision": 1, "timestamp_ms": 1_600_000_000_000_u64,
			"role": "User", "content": [{ "Text": { "text": "first words" } }], "meta": null,
			"raw_discriminator": "message", "raw": { "type": "message" }
		}] } })),
		section(json!({ "Terminals": [{
			"id": "term-1", "cwd": "/repo", "shell": "/bin/zsh", "cols": 80, "rows": 24,
			"status": "Running"
		}] })),
		section(json!({ "Processes": [{
			"name": "web", "pid": 1, "status": "running", "application": "sh", "args": [],
			"cwd": "/repo", "lifetime": "last-client-exit",
			"started_at_ms": 1_600_000_000_000_u64, "exit_code": null, "terminated_by": null
		}] })),
		section(json!({ "Agents": [{
			"id": "agent-0", "call_sign": "Wren", "display_name": "Reader", "kind": "sub",
			"status": "running", "parent": "main", "scope": "/repo", "session": "history-1",
			"activity": null, "model": null
		}] })),
	];
	let mut events = vec![HostEvent::ConnectionChanged(ConnectionState::Connected {
		endpoint: "gui-host".to_owned(),
		protocol: PROTOCOL_VERSION,
	})];
	events.extend(sections.into_iter().map(HostEvent::Snapshot));
	events
}

/// Every section of the shared corpus, in the order the corpus lists them.
fn corpus() -> Vec<SnapshotSection> {
	let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
		.join("../veyyon-desktop-model/tests/fixtures/snapshot-sections.json");
	let raw = fs::read_to_string(&path)
		.unwrap_or_else(|error| panic!("read the corpus at {}: {error}", path.display()));
	serde_json::from_str(&raw).expect("the corpus decodes into every section")
}

/// Shows the surface `prepare` names.
fn prepare(w: &mut Win<'_>, prepare: &Prepare) {
	match *prepare {
		Prepare::Rest => {},
		Prepare::Settings(page) => w.dispatch(act::OpenSettings { page: Some(page.into()) }),
		Prepare::Panel(tab) => w.dispatch(act::ShowPanelTab { tab: tab.into() }),
		Prepare::File(path) => {
			w.dispatch(act::ShowPanelTab { tab: "files".into() });
			w.dispatch(OpenFile { path: path.to_owned(), line: None });
		},
		Prepare::FileSearch(query) => {
			w.dispatch(act::ShowPanelTab { tab: "files".into() });
			w.search_files(query);
		},
		Prepare::Palette(query) => {
			w.dispatch(act::TogglePalette);
			if !query.is_empty() {
				w.typed(query);
			}
		},
		Prepare::Terminal(id) => show(w, DrawerTab::Terminal(id.to_owned())),
		Prepare::Processes => show(w, DrawerTab::Processes),
		Prepare::Process(name) => show(w, DrawerTab::Process(name.to_owned())),
		Prepare::ThreadSearch(query) => {
			w.dispatch(act::SearchThreads);
			w.typed(query);
			w.wait(Duration::from_secs(1));
		},
		Prepare::Preview => {
			w.dispatch(act::ShowPanelTab { tab: "agents".into() });
			w.click_text("Preview");
		},
		Prepare::HistorySearch(draft) => {
			w.dispatch(act::FocusComposer);
			w.typed(draft);
			w.dispatch(composer::SearchHistory);
		},
		Prepare::Completion(draft) => {
			w.apply(vec![HostEvent::Snapshot(section(json!({ "ExtensionUi": {
				"session": "sess-1",
				"ui": { "statuses": [], "working_message": null, "widgets": [], "completes": true }
			} })))]);
			w.dispatch(act::FocusComposer);
			w.typed(draft);
		},
		// The chord reaches the active window's column; the sweep activates none.
		Prepare::Tree => {
			w.cx.update(|window, _| window.activate_window());
			w.dispatch(thread::ToggleSessionTree);
		},
	}
}

fn show(w: &mut Win<'_>, tab: DrawerTab) {
	w.dispatch(act::ToggleDrawer);
	let drawer = w.drawer.clone();
	drawer.update(w.cx, |drawer, cx| drawer.show(tab, cx));
	w.cx.run_until_parked();
}

/// `section` as the host sends it in answer to what the window asked while
/// its surface was shown.
fn answer(section: SnapshotSection, asked: &[HostAction]) -> SnapshotSection {
	match section {
		// The host answers the query number the composer sent.
		SnapshotSection::ComposerCompletions { session, mut completions } => {
			completions.query = asked
				.iter()
				.rev()
				.find_map(|action| match action {
					HostAction::Composer(ComposerRequest::CompleteComposer { query, .. }) => {
						Some(*query)
					},
					_ => None,
				})
				.expect("the composer asked the extensions to complete its draft");
			SnapshotSection::ComposerCompletions { session, completions }
		},
		// The corpus answers the search with no match, which the sidebar
		// draws as nothing; the sweep answers with one.
		SnapshotSection::SessionSearch(mut found) => {
			found.sessions.push(
				serde_json::from_value(json!({
					"id": "sess-9", "workspace": "repo", "path": "/repo/.veyyon/sessions/sess-9.jsonl",
					"cwd": "/repo", "title": "Where the needle went", "parent_path": null,
					"created_at_ms": 1, "modified_at_ms": 1, "message_count": 1, "size_bytes": 1,
					"first_message": null, "searchable_messages": "needle", "status": "Complete"
				}))
				.expect("a session summary decodes"),
			);
			SnapshotSection::SessionSearch(found)
		},
		other => other,
	}
}

#[gpui::test]
fn every_section_the_store_keeps_is_one_the_window_draws(app: &mut gpui::TestAppContext) {
	let sections = corpus();
	assert_eq!(sections.len(), Kind::iter().count(), "the corpus holds one entry per kind");
	install(app);

	let mut silent = Vec::new();
	for section in &sections {
		let kind = Kind::from(section);
		let (surface, beside) = destination(kind);
		let mut w = window(app, attached());
		let needed = sections
			.iter()
			.filter(|other| beside.contains(&Kind::from(*other)))
			.cloned()
			.map(HostEvent::Snapshot)
			.collect();
		w.apply(needed);
		prepare(&mut w, &surface);
		let asked = w.outbox();
		let before = w.texts();
		w.apply(vec![HostEvent::Snapshot(answer(section.clone(), &asked))]);
		if w.texts() == before {
			silent.push(kind);
		}
	}
	assert_eq!(silent, NOT_DRAWN, "sections the window stores and draws nowhere");
}

/// The host's answer to an export that wrote the file.
fn written() -> HostEvent {
	HostEvent::Snapshot(section(json!({ "Export": {
		"session": "sess-1", "format": "html",
		"path": "/repo/.veyyon/exports/sess-1.html", "content": null
	} })))
}

const WRITTEN: &str = "Exported to /repo/.veyyon/exports/sess-1.html";

fn count(drawn: &[String], text: &str) -> usize {
	drawn.iter().filter(|run| *run == text).count()
}

/// An export is announced by the file the host wrote, once however often it
/// is written, and its toast opens that file; a document the host answered
/// with is announced by its format and offers nothing to open.
#[gpui::test]
fn an_export_is_announced_by_the_file_it_wrote_and_opens_it(app: &mut gpui::TestAppContext) {
	install(app);
	let mut w = window(app, attached());
	w.apply(vec![written(), written()]);
	let drawn = w.texts();
	assert_eq!(count(&drawn, WRITTEN), 1, "drew {drawn:?}");
	assert_eq!(count(&drawn, "Open"), 1, "drew {drawn:?}");
	w.outbox();
	w.click_text("Open");
	let path = "/repo/.veyyon/exports/sess-1.html".to_owned();
	assert_eq!(w.outbox(), vec![HostAction::OpenExternal { path }]);

	w.apply(vec![HostEvent::Snapshot(section(json!({ "Export": {
		"session": "sess-1", "format": "json", "path": null, "content": "[]"
	} })))]);
	let drawn = w.texts();
	assert_eq!(count(&drawn, "Exported the thread as JSON"), 1, "drew {drawn:?}");
	assert_eq!(count(&drawn, WRITTEN), 1, "the file stays announced: {drawn:?}");
	assert_eq!(count(&drawn, "Open"), 1, "only the file offers to open: {drawn:?}");
}

/// The capability map that sets Files to `status` and leaves the rest.
fn files(status: CapabilityStatus) -> HostEvent {
	HostEvent::Snapshot(SnapshotSection::Capabilities(
		std::iter::once((Capability::Files, status)).collect(),
	))
}

/// An export's toast offers Open only while the host takes the request: not
/// while the host refuses files, from the start or once the toast is drawn,
/// not while the link is lost, and again once both are back.
#[gpui::test]
fn an_export_offers_no_open_the_host_refuses(app: &mut gpui::TestAppContext) {
	install(app);
	let refused = || files(CapabilityStatus::Unavailable { reason: "Files are off".to_owned() });
	let mut events = attached();
	events.push(refused());
	let mut w = window(app, events);
	w.apply(vec![written()]);
	let opens = |w: &mut Win<'_>| {
		let drawn = w.texts();
		assert_eq!(count(&drawn, WRITTEN), 1, "drew {drawn:?}");
		count(&drawn, "Open")
	};
	assert_eq!(opens(&mut w), 0, "a refused host is offered nothing to open");
	w.apply(vec![files(CapabilityStatus::Available)]);
	assert_eq!(opens(&mut w), 1, "a granted host is offered the file");
	w.apply(vec![refused()]);
	assert_eq!(opens(&mut w), 0, "a drawn toast drops Open the host withdraws");
	w.apply(vec![files(CapabilityStatus::Available)]);
	let lost = ConnectionState::Reconnecting {
		attempt:     1,
		retry_at_ms: 1_600_000_000_000,
		message:     "socket closed".to_owned(),
	};
	w.apply(vec![HostEvent::ConnectionChanged(lost)]);
	assert_eq!(opens(&mut w), 0, "a lost link carries no Open");
	w.apply(attached());
	assert_eq!(opens(&mut w), 1, "a restored link offers it again");
}
