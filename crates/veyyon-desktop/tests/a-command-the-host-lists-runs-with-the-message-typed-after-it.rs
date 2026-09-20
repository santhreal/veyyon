//! WHY: `/btw name one file this project builds` reached nothing. Two
//! separate faults sat between the keystroke and the host, and each on its
//! own emptied the surface:
//!
//! * the command surface was composed from the window's own table at the moment
//!   it opened, and the host's catalogue was added to it by the next store
//!   projection, which is driven by a host event — so a palette opened between
//!   two events listed what the binary was built knowing and nothing this
//!   workspace installed;
//! * the draft IS the query while a slash menu is open, and only the eight
//!   native `ComposerCommand` rows were ranked on their first word. A command
//!   the host listed was scored against the whole draft, so the message after
//!   its name lost it the row and Enter ran nothing.
//!
//! THE CLASS THIS CLOSES: a command the host lists that takes a message after
//! its name, from every source the protocol can name and under every spelling
//! that reaches it. The sweep is over `CommandSource::iter()` at run time, so
//! a source added to the protocol turns this red until it carries a message
//! too, and each arm drives the real window: the draft goes through the
//! composer's own editor, the palette is the one the keystroke opened, and
//! the intent is read off what the window hands the host.
//!
//! WHAT IT DOES NOT CATCH: what the host does with the `RunCommand` it
//! receives, which is the gui-host's own suite; the arguments a *subcommand*
//! takes, which the host states as free-form usage rather than as an input
//! hint, so `/secret add <value>` is still ranked on the whole draft; and the
//! rows a capability prunes, which
//! `a-command-this-workspace-installed-is-listed-and-runs` drives.

mod support;

use std::collections::HashMap;

use strum::IntoEnumIterator;
use support::{NOW_MS, memory::driven};
use veyyon_desktop::{SessionIndex, project};
use veyyon_desktop_model::{
	Capability, CapabilityStatus, CommandSource, CommandView, ConnectionState, HostEvent,
	QueuePartition, SnapshotSection, Store, reduce,
};
use veyyon_desktop_scene::HeadlessSession;
use veyyon_desktop_surface::{Intent, Overlay, PaletteState, ShellState, ShellView};

/// The message written after a command's name, which the row must keep.
const MESSAGE: &str = "name one file this project builds";

/// The command each source lists that takes a message, and the one that takes
/// none. A source names both, so every arm holds a row that must keep the
/// message beside a row that must not be reached by one.
fn carrying(source: CommandSource) -> CommandView {
	CommandView {
		name: format!("ask-{}", slug(source)),
		aliases: vec![format!("aside-{}", slug(source))],
		description: Some("Ask a question beside the work".to_owned()),
		input_hint: Some("<question>".to_owned()),
		source,
		subcommands: Vec::new(),
	}
}

fn bare(source: CommandSource) -> CommandView {
	CommandView {
		name: format!("show-{}", slug(source)),
		aliases: Vec::new(),
		description: Some("Show what this workspace holds".to_owned()),
		input_hint: None,
		source,
		subcommands: Vec::new(),
	}
}

fn slug(source: CommandSource) -> String {
	format!("{source:?}").to_lowercase()
}

/// An attached host offering everything, holding one session, having stated a
/// catalogue of two commands per source.
fn attached() -> Store {
	let mut store = Store {
		connection: ConnectionState::Connected { endpoint: "socket".to_owned(), protocol: 1 },
		..Store::default()
	};
	for capability in Capability::ALL {
		store
			.capabilities
			.set(capability, CapabilityStatus::Available);
	}
	let session = support::session("s1", QueuePartition::Live);
	let id = session.id.clone();
	store.sessions.insert(session);
	store.persisted.shell.active_session = Some(id);
	let listed: Vec<CommandView> = CommandSource::iter()
		.flat_map(|source| [carrying(source), bare(source)])
		.collect();
	// The catalogue arrives as the host states it, through the reducer that
	// files it.
	reduce(&mut store, HostEvent::Snapshot(SnapshotSection::Commands(listed)));
	store
}

/// The window's state after one projection, which is every projection the
/// suite makes: what the palette lists afterwards is what a keystroke can
/// reach without a further host event.
fn projected(store: &Store) -> ShellState {
	let mut state = ShellState::default();
	project(store, &mut SessionIndex::new(), &HashMap::new(), NOW_MS, &mut state);
	state
}

/// The draft written through the composer, which opens the slash menu by the
/// editor's own change event: the path a keystroke takes.
fn typed(window: &mut HeadlessSession<'_, ShellView>, draft: &str) {
	window
		.update(|view, _, cx| view.set_composed("", cx))
		.expect("the draft clears");
	window
		.update(|view, _, cx| view.set_composed(draft, cx))
		.expect("the draft reaches the composer");
}

/// The title of the row the palette would run, or `None` when the draft
/// opened no palette or ranked no row.
fn selected(window: &mut HeadlessSession<'_, ShellView>) -> Option<String> {
	window
		.update(|view, _, _| {
			view
				.state()
				.overlay
				.as_ref()
				.and_then(Overlay::as_palette)
				.and_then(PaletteState::selected_item)
				.map(|item| item.title.clone())
		})
		.expect("the palette answers what it would run")
}

/// The commands the window sends when the draft is submitted, and the draft
/// that is left behind.
fn submitted(window: &mut HeadlessSession<'_, ShellView>) -> (Vec<String>, String) {
	window
		.update(|view, _, cx| {
			view.drain_intents();
			view.submit_primary_turn_action(cx);
			let sent = view
				.drain_intents()
				.into_iter()
				.filter_map(|intent| match intent {
					Intent::RunCommand(text) => Some(text),
					_ => None,
				})
				.collect();
			(sent, view.composer_text().to_owned())
		})
		.expect("the draft submits")
}

/// The rows the surface the draft opened lists.
fn listed(window: &mut HeadlessSession<'_, ShellView>) -> Vec<String> {
	window
		.update(|view, _, _| {
			view
				.state()
				.overlay
				.as_ref()
				.and_then(Overlay::as_palette)
				.map(|palette| {
					palette
						.items()
						.iter()
						.map(|item| item.title.clone())
						.collect()
				})
				.unwrap_or_default()
		})
		.expect("the slash menu is open")
}

#[test]
fn a_command_surface_opened_between_host_events_lists_what_the_host_stated() {
	let store = attached();
	driven(projected(&store), |window| {
		typed(window, "/");
		let rows = listed(window);
		for source in CommandSource::iter() {
			let row = format!("/{} <question>", carrying(source).name);
			assert!(
				rows.contains(&row),
				"{row:?} must be listed the moment the surface opens, not at the next host event"
			);
		}
	});
}

#[test]
fn a_host_that_declines_commands_lists_none_of_them_on_the_surface_it_opens() {
	let mut store = attached();
	// §5.13: a command the host will not run is not listed rather than
	// listed and refused, and the surface a keystroke opens states that as
	// the projection does.
	store
		.capabilities
		.set(Capability::AgentCommands, CapabilityStatus::Unavailable {
			reason: "this host runs no commands".to_owned(),
		});
	driven(projected(&store), |window| {
		typed(window, "/");
		let rows = listed(window);
		for source in CommandSource::iter() {
			for command in [carrying(source), bare(source)] {
				assert!(
					!rows
						.iter()
						.any(|row| row.starts_with(&format!("/{}", command.name))),
					"a declined host lists no {:?} row: {rows:?}",
					command.name
				);
			}
		}
		assert!(
			rows.iter().any(|row| row == "/new"),
			"the window's own rows do not depend on what the host declined: {rows:?}"
		);
	});
}

#[test]
fn a_listed_command_that_takes_a_message_runs_with_the_one_written_after_it() {
	let store = attached();
	driven(projected(&store), |window| {
		for source in CommandSource::iter() {
			let command = carrying(source);
			let row = format!("/{} <question>", command.name);
			for spelling in std::iter::once(command.name.clone()).chain(command.aliases.clone()) {
				typed(window, &format!("/{spelling} {MESSAGE}"));
				assert_eq!(
					selected(window).as_deref(),
					Some(row.as_str()),
					"/{spelling} {MESSAGE} must reach the row the host listed"
				);
				let (sent, draft) = submitted(window);
				assert_eq!(
					sent,
					vec![format!("{spelling} {MESSAGE}")],
					"/{spelling} {MESSAGE} must run with the message written after it"
				);
				assert_eq!(draft, "", "the command took the whole draft, so none of it is left");
			}
		}
	});
}

#[test]
fn a_message_written_over_two_lines_reaches_the_command_whole() {
	let store = attached();
	driven(projected(&store), |window| {
		for source in CommandSource::iter() {
			let command = carrying(source);
			let message = format!("{MESSAGE}\nand say where it is written");
			typed(window, &format!("/{} {message}", command.name));
			let (sent, draft) = submitted(window);
			assert_eq!(
				sent,
				vec![format!("{} {message}", command.name)],
				"a question written over two lines is one question"
			);
			// The whole draft ran, so a second line of it is not left
			// behind to be sent again as a prompt of its own.
			assert_eq!(draft, "", "the command took every line it was written over");
		}
	});
}

#[test]
fn a_listed_command_reached_by_its_name_alone_runs_that_name() {
	let store = attached();
	driven(projected(&store), |window| {
		for source in CommandSource::iter() {
			let command = carrying(source);
			typed(window, &format!("/{}", command.name));
			assert_eq!(
				selected(window).as_deref(),
				Some(format!("/{} <question>", command.name).as_str()),
				"the name alone must reach the row"
			);
			let (sent, draft) = submitted(window);
			assert_eq!(
				sent,
				vec![command.name.clone()],
				"a row reached without arguments runs its own spelling"
			);
			assert_eq!(draft, "", "the spelling the row ran leaves nothing in the draft");
		}
	});
}

#[test]
fn a_listed_command_that_takes_nothing_is_not_reached_by_a_message() {
	let store = attached();
	driven(projected(&store), |window| {
		for source in CommandSource::iter() {
			let command = bare(source);
			let row = format!("/{}", command.name);
			typed(window, &row);
			assert_eq!(
				selected(window).as_deref(),
				Some(row.as_str()),
				"the name alone must reach a command that takes nothing"
			);
			// A row with nowhere to put a message must not be selected by
			// one: running it would drop what was typed after its name.
			typed(window, &format!("{row} {MESSAGE}"));
			assert_ne!(
				selected(window).as_deref(),
				Some(row.as_str()),
				"{row} takes no message, so a message must not reach it"
			);
		}
	});
}
