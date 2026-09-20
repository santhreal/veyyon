//! WHY: the palette listed sixteen commands compiled into the binary, so a
//! skill, an extension command, a project command file and an MCP prompt —
//! everything the terminal lists under `/` — were unreachable from the
//! window. §5.8 gives the host the catalogue: a workspace that installs a
//! command gets a row for it without a release.
//!
//! THE CLASS THIS CLOSES: a command the host advertises that the window drops
//! on the way to a row, or lists and cannot run. The sweep is over
//! `CommandSource::iter()` at run time, so a source added to the protocol
//! turns this red until it is given a row, and the run path is asserted
//! through `actions_for`, which is what the window sends.
//!
//! WHAT IT DOES NOT CATCH: what the host does with a `RunCommand` it receives,
//! which is the gui-host's own suite, and the ranking of one row against
//! another, which
//! `a-slash-command-reaches-its-row-and-keeps-the-message-after-it` drives.

#[path = "support/mod.rs"]
mod support;

use std::collections::HashMap;

use strum::IntoEnumIterator;
use support::NOW_MS;
use veyyon_desktop::{SessionIndex, actions_for, project, project_controls};
use veyyon_desktop_model::{
	Capability, CapabilityStatus, CommandSource, CommandSubcommandView, CommandView,
	ConnectionState, HostAction, HostActionKind, HostEvent, QueuePartition, RequestId,
	RequestRegistry, SessionId, SnapshotSection, Store, SurfaceId, reduce,
};
use veyyon_desktop_surface::{
	Intent, Overlay, PaletteItem, PaletteItemKind, PaletteState, ShellState,
	composer::actions::request_surface, controls::Availability,
};

/// An attached host offering everything, holding one session.
fn attached() -> Store {
	let mut store = Store {
		connection: ConnectionState::Connected { endpoint: "socket".to_string(), protocol: 1 },
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
	store
}

fn command(name: &str, source: CommandSource) -> CommandView {
	CommandView {
		name: name.to_owned(),
		aliases: Vec::new(),
		description: Some(format!("what {name} does")),
		input_hint: None,
		source,
		subcommands: Vec::new(),
	}
}

/// The host stating its catalogue, through the reducer that files it.
fn lists(store: &mut Store, commands: Vec<CommandView>) {
	reduce(store, HostEvent::Snapshot(SnapshotSection::Commands(commands)));
}

/// The rows the palette holds after a projection of `store`.
fn rows(store: &Store) -> Vec<PaletteItem> {
	let mut state = ShellState {
		overlay: Some(Overlay::Palette(PaletteState::commands())),
		..ShellState::default()
	};
	project(store, &mut SessionIndex::new(), &HashMap::new(), NOW_MS, &mut state);
	let Some(Overlay::Palette(palette)) = &state.overlay else {
		panic!("the palette stays open across a projection");
	};
	palette.items().to_vec()
}

/// The command each row runs, for the rows that run one.
fn runs(items: &[PaletteItem]) -> Vec<String> {
	items
		.iter()
		.filter_map(|item| match &item.kind {
			PaletteItemKind::Command { intent } => match &**intent {
				Intent::RunCommand(text) => Some(text.clone()),
				_ => None,
			},
			_ => None,
		})
		.collect()
}

#[test]
fn a_command_from_every_source_the_host_can_name_becomes_a_row() {
	let mut store = attached();
	let listed: Vec<CommandView> = CommandSource::iter()
		.enumerate()
		.map(|(index, source)| command(&format!("installed{index}"), source))
		.collect();
	lists(&mut store, listed.clone());

	let items = rows(&store);
	let ran = runs(&items);
	for advertised in &listed {
		assert!(
			ran.contains(&advertised.name),
			"the host listed {} and the palette does not run it: {ran:?}",
			advertised.name
		);
		let row = items
			.iter()
			.find(|item| item.title == format!("/{}", advertised.name))
			.unwrap_or_else(|| panic!("no row spelled /{}", advertised.name));
		assert_eq!(
			row.subtitle, advertised.description,
			"a row states what the host said the command does"
		);
		assert_eq!(
			row.capability,
			Some(Capability::AgentCommands),
			"a host command rides on the capability that answers for it"
		);
	}
}

#[test]
fn a_host_command_the_window_already_draws_a_surface_for_is_listed_once() {
	let mut store = attached();
	// `/compact` is one of the window's own rows: it opens the surface the
	// window draws for it rather than asking the host to run the text.
	lists(&mut store, vec![
		command("compact", CommandSource::Builtin),
		command("brainstorm", CommandSource::Custom),
	]);

	let items = rows(&store);
	let spelled: Vec<&str> = items.iter().map(|item| item.title.as_str()).collect();
	assert_eq!(
		spelled.iter().filter(|title| **title == "/compact").count(),
		1,
		"one command is one row: {spelled:?}"
	);
	assert!(runs(&items).contains(&"brainstorm".to_owned()), "{spelled:?}");
	assert!(
		!runs(&items).contains(&"compact".to_owned()),
		"the native row runs /compact, so the host row is the duplicate that goes"
	);
}

#[test]
fn a_subcommand_and_an_alias_reach_the_command_that_owns_them() {
	let mut store = attached();
	let mut review = command("review", CommandSource::Extension);
	review.aliases = vec!["pr".to_owned()];
	review.input_hint = Some("<path>".to_owned());
	review.subcommands = vec![CommandSubcommandView {
		name:        "staged".to_owned(),
		description: Some("only what is staged".to_owned()),
		usage:       None,
	}];
	lists(&mut store, vec![review]);

	let items = rows(&store);
	let row = items
		.iter()
		.find(|item| item.title == "/review <path>")
		.expect("the hint the host stated is drawn on the row");
	assert_eq!(
		row.search.as_deref(),
		Some("pr"),
		"an alias reaches the row without being drawn on it"
	);
	assert!(
		runs(&items).contains(&"review staged".to_owned()),
		"a subcommand is its own row: {:?}",
		runs(&items)
	);
}

#[test]
fn a_host_that_lists_no_command_leaves_the_native_rows_alone() {
	let bare = rows(&attached());
	assert!(runs(&bare).is_empty(), "nothing runs a host command before the host lists one");
	assert!(
		bare.iter().any(|item| item.title == "/compact"),
		"the window's own rows do not depend on the host's catalogue"
	);
}

#[test]
fn running_a_row_sends_the_command_to_the_open_session() {
	let mut store = attached();
	let mut index = SessionIndex::new();
	let mut state = ShellState::default();
	project(&store, &mut index, &HashMap::new(), NOW_MS, &mut state);

	let sent =
		actions_for(&Intent::RunCommand("brainstorm two options".to_owned()), &index, &mut store);
	assert_eq!(
		sent,
		vec![HostAction::RunCommand {
			session: store
				.persisted
				.shell
				.active_session
				.clone()
				.expect("a session is open"),
			text:    "brainstorm two options".to_owned(),
		}],
		"the arguments travel with the command, in the one string the host parses"
	);
}

#[test]
fn a_command_without_a_session_open_is_sent_nowhere() {
	let mut store = attached();
	store.persisted.shell.active_session = None;
	let sent =
		actions_for(&Intent::RunCommand("brainstorm".to_owned()), &SessionIndex::new(), &mut store);
	assert!(sent.is_empty(), "a command runs in a session and there is none: {sent:?}");
}

/// The availability the palette's rows read, for a store and an in-flight set.
fn row_gate(store: &Store, registry: &RequestRegistry) -> Availability {
	let mut state = ShellState::default();
	project_controls(store, registry, &SessionIndex::new(), &mut state);
	let surface = request_surface(&Intent::RunCommand("review".to_owned()), &SessionId::from("1"))
		.expect("a command row reads a control");
	assert_eq!(
		surface,
		SurfaceId::PaletteInput,
		"one request runs a command, so the field it is spelled in is its control"
	);
	state.controls.availability(&surface)
}

#[test]
fn a_command_in_flight_holds_the_rows_that_would_run_another() {
	let mut store = attached();
	lists(&mut store, vec![command("review", CommandSource::Custom)]);
	let mut registry = RequestRegistry::new();
	assert_eq!(
		row_gate(&store, &registry),
		Availability::Enabled,
		"a host that runs commands offers its rows at rest"
	);

	registry.register(
		RequestId(1),
		HostActionKind::RunCommand,
		SurfaceId::PaletteInput,
		NOW_MS,
		30_000,
	);
	assert_eq!(
		row_gate(&store, &registry),
		Availability::Pending,
		"a second command is not taken while the first is still being answered"
	);

	registry.complete(&RequestId(1));
	assert_eq!(
		row_gate(&store, &registry),
		Availability::Enabled,
		"the row is offered again on the projection after the host answered"
	);
}
