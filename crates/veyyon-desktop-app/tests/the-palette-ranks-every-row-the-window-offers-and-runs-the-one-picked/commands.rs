//! The host's slash commands: a command with subcommands lists them, one
//! that takes an argument asks for it, any other runs as chosen, and none
//! runs without a thread to run in. The requests the palette sends itself
//! reach the host under the terminal's spelling for them, each state-bound
//! pair listed only the way that applies. The files the host matched for the
//! query open in the panel.

use std::{cell::RefCell, rc::Rc};

use gpui::TestAppContext;
use veyyon_desktop_app::{actions::panel, palette::Scope};
use veyyon_desktop_model::{
	CommandSource, CommandSubcommandView, CommandView, HostAction, HostEvent, SearchResultsView,
	SnapshotSection,
	domain::{AgentPauseView, ShareRole, ShareView},
};

use super::harness::{Win, listed, seeded, sid, window};

fn command(
	name: &str,
	input_hint: Option<&str>,
	subcommands: &[(&str, Option<&str>)],
) -> CommandView {
	CommandView {
		name:        name.to_owned(),
		aliases:     Vec::new(),
		description: Some(format!("the {name} command")),
		input_hint:  input_hint.map(str::to_owned),
		source:      CommandSource::Builtin,
		subcommands: subcommands
			.iter()
			.map(|(name, usage)| CommandSubcommandView {
				name:        (*name).to_owned(),
				description: None,
				usage:       usage.map(str::to_owned),
			})
			.collect(),
	}
}

/// `/mcp` with `list` and `add <name> <command>`, `/compact` taking nothing
/// and `/rename <title>`.
fn commands() -> HostEvent {
	HostEvent::Snapshot(SnapshotSection::Commands(vec![
		command("mcp", None, &[("list", None), ("add", Some("<name> <command>"))]),
		command("compact", None, &[]),
		command("rename", Some("<title>"), &[]),
	]))
}

fn run(text: &str) -> HostAction {
	HostAction::RunCommand { session: sid("a"), text: text.to_owned() }
}

#[gpui::test]
fn a_command_lists_its_subcommands_asks_for_an_argument_and_runs_the_line_it_built(
	app: &mut TestAppContext,
) {
	let mut events = seeded();
	events.push(commands());
	let mut w = window(app, events, true);
	w.open();
	assert_eq!(w.sent(), Vec::<HostAction>::new(), "the host already sent its commands");

	w.query("/mcp");
	assert_eq!(w.row_of("/mcp"), 0, "the command outranks the page it shares a word with");
	w.keys("enter");
	assert!(w.is_open(), "a command with subcommands keeps the palette open");
	assert_eq!(w.labels(), vec!["/mcp list", "/mcp add"]);
	w.keys("escape");
	assert!(w.is_open(), "escape leaves the subcommands for the root");
	assert_eq!(
		w.palette
			.read_with(&*w.cx, |palette, _| palette.scope().clone()),
		Scope::Root
	);

	w.query("/mcp");
	w.keys("enter");
	w.pick("/mcp add");
	assert!(w.is_open(), "a subcommand with arguments asks for them");
	assert!(
		w.texts()
			.iter()
			.any(|text| text == "Enter runs /mcp add …  Escape goes back")
	);
	w.typed(" docs npx docs.server ");
	w.keys("enter");
	assert_eq!(w.sent(), vec![run("/mcp add docs npx docs.server")]);
	assert!(!w.is_open());

	w.open();
	w.query("/compact");
	w.keys("enter");
	assert_eq!(w.sent(), vec![run("/compact")], "a command taking nothing runs as chosen");

	w.open();
	w.query("/rename");
	w.keys("enter");
	w.typed("a better title");
	w.keys("enter");
	assert_eq!(w.sent(), vec![run("/rename a better title")]);
}

/// Each request the palette sends itself, the spelling that reaches it and
/// what it sends while thread `a` is open, nothing shared and nothing paused.
fn requests() -> [(&'static str, &'static str, HostAction); 9] {
	[
		("/pause", "Pause agents", HostAction::PauseAgents),
		("/reload-transcript", "Reload the transcript", HostAction::LoadTranscript {
			session: sid("a"),
			before:  None,
		}),
		("/clear", "Clear the conversation", HostAction::ClearOutput { session: sid("a") }),
		("/retry", "Retry the last turn", HostAction::RetryTurn { session: sid("a") }),
		("/rephrase", "Rephrase the last reply", HostAction::RephraseReply { session: sid("a") }),
		("/branch", "Branch this thread", HostAction::BranchSession {
			session: sid("a"),
			entry:   None,
		}),
		("/fork", "Branch this thread", HostAction::BranchSession {
			session: sid("a"),
			entry:   None,
		}),
		("/collab", "Share thread", HostAction::StartShare { read_only: false }),
		("/collab view", "Share a read-only link", HostAction::StartShare { read_only: true }),
	]
}

#[gpui::test]
fn each_request_the_palette_sends_itself_reaches_the_host_and_closes_it(app: &mut TestAppContext) {
	let mut w = window(app, seeded(), true);
	for (typed, label, action) in requests() {
		w.open();
		w.sent();
		w.query(typed);
		w.pick(label);
		assert_eq!(w.sent(), vec![action], "{typed:?} picks {label:?}");
		assert!(!w.is_open(), "{label:?} closes the palette");
	}
}

#[gpui::test]
fn a_request_bound_to_state_is_listed_only_the_way_that_applies(app: &mut TestAppContext) {
	let mut w = window(app, seeded(), true);
	w.open();
	let has = |w: &Win<'_>, label: &str| w.labels().iter().any(|drawn| drawn == label);
	w.query("/pause");
	assert!(has(&w, "Pause agents") && !has(&w, "Resume agents"), "{:?}", w.labels());
	w.query("/collab");
	assert!(has(&w, "Share thread") && !has(&w, "Stop sharing"), "{:?}", w.labels());
	w.apply(vec![
		HostEvent::Snapshot(SnapshotSection::AgentPause(AgentPauseView {
			paused:   true,
			since_ms: Some(1),
		})),
		HostEvent::Snapshot(SnapshotSection::Share(ShareView {
			state:         "hosting".to_owned(),
			role:          ShareRole::Hosting,
			relay_url:     None,
			link:          Some("veyyon://room".to_owned()),
			web_link:      None,
			view_link:     None,
			web_view_link: None,
			participants:  Vec::new(),
			guest:         None,
			error:         None,
		})),
	]);
	w.query("/unpause");
	assert!(has(&w, "Resume agents") && !has(&w, "Pause agents"), "{:?}", w.labels());
	w.query("/collab stop");
	assert!(
		has(&w, "Stop sharing") && !has(&w, "Share thread") && !has(&w, "Share a read-only link"),
		"{:?}",
		w.labels()
	);
	w.sent();
	w.pick("Stop sharing");
	assert_eq!(w.sent(), vec![HostAction::StopShare]);
}

#[gpui::test]
fn without_an_open_thread_only_the_requests_for_the_host_are_listed(app: &mut TestAppContext) {
	let mut w = window(app, listed(), true);
	w.open();
	for (typed, label, _) in requests() {
		w.query(typed);
		let drawn = w.labels().iter().any(|drawn| drawn == label);
		assert_eq!(drawn, label == "Pause agents", "{label:?} without an open thread");
	}
}

#[gpui::test]
fn without_an_open_thread_every_command_is_drawn_blocked_and_runs_nothing(
	app: &mut TestAppContext,
) {
	let mut events = listed();
	events.push(commands());
	let mut w = window(app, events, true);
	w.open();
	w.sent();
	w.query("/");
	let rows = w.rows();
	let commands: Vec<_> = rows
		.iter()
		.filter(|item| item.label.starts_with('/'))
		.collect();
	assert_eq!(commands.len(), 3, "every command is listed: {:?}", w.labels());
	for item in commands {
		assert_eq!(
			item.blocked.as_deref(),
			Some("Open a thread to run a command"),
			"{} is blocked",
			item.label
		);
	}
	w.query("/compact");
	w.keys("enter");
	assert_eq!(w.sent(), Vec::<HostAction>::new());
	assert!(w.is_open());
}

#[gpui::test]
fn a_typed_query_asks_for_matching_files_and_a_file_row_opens_it_in_the_panel(
	app: &mut TestAppContext,
) {
	let mut w = window(app, seeded(), true);
	// The last listener registered runs first and stops the action there, so
	// this one is registered after the panel's.
	let opened: Rc<RefCell<Vec<panel::OpenFile>>> = Rc::default();
	let record = opened.clone();
	w.cx.update(|_, cx| {
		cx.on_action(move |action: &panel::OpenFile, _| record.borrow_mut().push(action.clone()));
	});
	w.open();
	w.outbox();
	w.query("main");
	let searched: Vec<HostAction> = ["m", "ma", "mai", "main"]
		.map(|query| HostAction::SearchFiles { query: query.to_owned() })
		.into();
	assert_eq!(w.outbox(), searched, "each keystroke asks for the files its query matches");

	let results = |query: &str, paths: &[&str]| {
		HostEvent::Snapshot(SnapshotSection::SearchResults(SearchResultsView {
			query:     query.to_owned(),
			paths:     paths.iter().map(|path| (*path).to_owned()).collect(),
			truncated: false,
		}))
	};
	w.apply(vec![results("mai", &["src/maintenance.rs"])]);
	assert!(
		!w.labels().iter().any(|label| label == "maintenance.rs"),
		"an older query's files are not listed"
	);
	w.apply(vec![results("main", &["src/main.rs", "docs/main.md"])]);
	let files: Vec<String> = w
		.rows()
		.iter()
		.filter(|item| item.group == veyyon_desktop_app::palette::Group::Files)
		.map(|item| item.label.to_string())
		.collect();
	assert_eq!(files, vec!["main.rs", "main.md"]);

	w.pick("main.md");
	assert_eq!(opened.borrow().as_slice(), &[panel::OpenFile {
		path: "docs/main.md".to_owned(),
		line: None,
	}]);
	assert!(!w.is_open());
}
