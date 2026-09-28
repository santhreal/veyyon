//! A command the host lists, from every source it can name, is a row that
//! runs the line it reads, and one that takes an argument runs with the text
//! typed after its name at the root.
//!
//! WHY: the palette is where a command a workspace installed is reached. A
//! source dropped on the way to a row, a row that runs another line than the
//! one it reads, or a message typed after a command's name that lists no row
//! (so `/btw why is this slow` answers nothing) leaves an installed command
//! unreachable. The sweep reads `CommandSource::iter()` at run time, so a
//! source added to the protocol is driven here the day it is added.
//!
//! Gap: what the host does with the `RunCommand` it receives is the
//! gui-host's suite; the composer's own `/name message` submit is the
//! composer suite's; a message over two lines cannot be typed into the
//! palette's single-line field.

use gpui::TestAppContext;
use strum::IntoEnumIterator;
use veyyon_desktop_app::palette::Hint;
use veyyon_desktop_model::{
	CommandSource, CommandSubcommandView, CommandView, HostAction, HostEvent, SnapshotSection,
};

use super::harness::{listed, seeded, sid, window};

/// The message written after a command's name, which the row must keep.
const MESSAGE: &str = "name one file this project builds";

fn slug(source: CommandSource) -> String {
	format!("{source:?}").to_lowercase()
}

fn view(
	name: String,
	aliases: Vec<String>,
	hint: Option<&str>,
	source: CommandSource,
) -> CommandView {
	CommandView {
		name,
		aliases,
		description: None,
		input_hint: hint.map(str::to_owned),
		source,
		subcommands: Vec::new(),
	}
}

/// Per source, `/ask-<source>` (alias `/a-<source>`) taking a message and
/// `/run-<source>` taking none; and `/mcp` with `list` and `add`.
pub fn catalogue() -> HostEvent {
	let mut commands: Vec<CommandView> = CommandSource::iter()
		.flat_map(|source| {
			let slug = slug(source);
			[
				view(format!("ask-{slug}"), vec![format!("a-{slug}")], Some("<message>"), source),
				view(format!("run-{slug}"), Vec::new(), None, source),
			]
		})
		.collect();
	let mut mcp = view("mcp".to_owned(), Vec::new(), None, CommandSource::Builtin);
	mcp.subcommands = ["list", "add"]
		.map(|name| CommandSubcommandView {
			name:        name.to_owned(),
			description: None,
			usage:       None,
		})
		.into();
	commands.push(mcp);
	HostEvent::Snapshot(SnapshotSection::Commands(commands))
}

fn run(text: &str) -> HostAction {
	HostAction::RunCommand { session: sid("a"), text: text.to_owned() }
}

#[gpui::test]
fn every_source_lists_its_commands_and_each_runs_the_line_it_names(app: &mut TestAppContext) {
	let mut events = seeded();
	events.push(catalogue());
	let mut w = window(app, events, true);
	for source in CommandSource::iter() {
		let slug = slug(source);
		let bare = format!("/run-{slug}");
		w.open();
		w.sent();
		w.query(&bare);
		let rows = w.rows();
		let row = rows
			.iter()
			.find(|item| item.label.as_ref() == bare)
			.unwrap_or_else(|| panic!("{source:?} lists {bare}: {:?}", w.labels()));
		assert!(
			matches!(&row.hint, Hint::Text(word) if word.as_ref() == source.label()),
			"{bare} states where it came from: {:?}",
			row.hint
		);
		w.pick(&bare);
		assert_eq!(w.sent(), vec![run(&bare)], "{source:?}");

		let line = format!("/ask-{slug} {MESSAGE}");
		for typed in [line.clone(), format!("/A-{} {MESSAGE}", slug.to_uppercase())] {
			w.open();
			w.sent();
			w.query(&typed);
			assert_eq!(w.row_of(&line), 0, "{typed:?} ranks the line first");
			w.keys("enter");
			assert_eq!(w.sent(), vec![run(&line)], "{typed:?} runs with the message");
			assert!(!w.is_open());
		}

		w.open();
		w.query(&format!("{bare} {MESSAGE}"));
		let labels = w.labels();
		assert!(
			labels.iter().all(|label| !label.starts_with(&bare)),
			"a command taking nothing is not reached by a message: {labels:?}"
		);
		w.keys("escape");
	}
}

#[gpui::test]
fn a_command_with_subcommands_runs_the_one_typed_after_its_name(app: &mut TestAppContext) {
	let mut events = seeded();
	events.push(catalogue());
	let mut w = window(app, events, true);
	for (typed, line) in [
		("/mcp list", "/mcp list"),
		("/MCP  add docs npx docs.server ", "/mcp add docs npx docs.server"),
	] {
		w.open();
		w.sent();
		w.query(typed);
		assert_eq!(w.row_of(line), 0, "{typed:?}");
		w.keys("enter");
		assert_eq!(w.sent(), vec![run(line)], "{typed:?}");
	}
}

#[gpui::test]
fn without_an_open_thread_a_typed_argument_is_drawn_blocked_and_runs_nothing(
	app: &mut TestAppContext,
) {
	let mut events = listed();
	events.push(catalogue());
	let mut w = window(app, events, true);
	w.open();
	w.sent();
	let line = format!("/ask-builtin {MESSAGE}");
	w.query(&line);
	let rows = w.rows();
	assert_eq!(rows.first().map(|row| row.label.to_string()), Some(line));
	assert_eq!(
		rows.first().and_then(|row| row.blocked.as_deref()),
		Some("Open a thread to run a command")
	);
	w.keys("enter");
	assert_eq!(w.sent(), Vec::<HostAction>::new());
	assert!(w.is_open());
}

const LINK: &str = "veyyon://room";

/// Joins [`LINK`] from a window over `events`, typed after `/join` at the
/// root and then through the row that asks for it, and returns what each
/// sent.
fn join(app: &mut TestAppContext, events: Vec<HostEvent>) -> [Vec<HostAction>; 2] {
	let mut w = window(app, events, true);
	w.open();
	w.sent();
	let line = format!("/join {LINK}");
	w.query(&line);
	assert_eq!(w.row_of(&line), 0);
	w.keys("enter");
	let typed = w.sent();
	assert!(!w.is_open());

	w.open();
	w.sent();
	w.query("/join");
	w.pick("Join a share…");
	w.keys("enter");
	assert!(w.is_open(), "an empty link joins nothing");
	w.typed(LINK);
	w.keys("enter");
	[typed, w.sent()]
}

#[gpui::test]
fn a_link_typed_after_join_joins_that_share_from_the_open_thread(app: &mut TestAppContext) {
	let joined = HostAction::JoinShare { session: Some(sid("a")), link: LINK.to_owned() };
	assert_eq!(join(app, seeded()), [vec![joined.clone()], vec![joined]]);
}

#[gpui::test]
fn a_link_typed_after_join_joins_that_share_without_an_open_thread(app: &mut TestAppContext) {
	let joined = HostAction::JoinShare { session: None, link: LINK.to_owned() };
	assert_eq!(join(app, listed()), [vec![joined.clone()], vec![joined]]);
}
