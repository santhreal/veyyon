//! WHY: the control that moves a waiting command drew in the window and the
//! press reached nothing. Every part in isolation was covered — the surface
//! dispatches the intent, the host resolves the wait — and the window between
//! them was not: the section the host sends has to reach the composer as a
//! command, the control has to be gated as reachable, and the intent has to
//! map to the action for the session the window is on. A break in any of the
//! three draws a control that does nothing.
//!
//! CLASS CLOSED: a composer control drawn from a host section whose intent
//! reaches no action. The sweep is over the composer's own gated controls
//! read from `gated_controls` at run time, so a control added there is
//! carried, and the pin is by exact equality so one leaving is a decision.
//!
//! WHAT IT DOES NOT CATCH: the keystroke that raises the intent, which is the
//! surface's suite, and the host's own resolution of the wait, which is
//! `a-command-a-window-waits-on-is-moved-to-the-background.test.ts`.

use std::collections::HashMap;

use veyyon_desktop::{
	SessionIndex, actions_for, gated_controls, project, project_controls, scene::seed::Seed,
};
use veyyon_desktop_model::{
	Capability, CapabilityStatus, ConnectionState, ForegroundCommandView, HostAction,
	HostActionKind, PROTOCOL_VERSION, QueuePartition, SessionId, SurfaceId,
};
use veyyon_desktop_surface::{Availability, Intent, ShellState};

/// The clock the projection measures elapsed labels against, pinned so the
/// suite does not read the wall.
const CLOCK_MS: u64 = 1_700_000_000_000;

/// The command the window is waiting on, named so a control stating anything
/// else is stating its own text.
const WAITING_ON: &str = "sleep 240";

/// A connected window on one session, with every capability available and the
/// store told what that session is waiting on.
fn waiting_window() -> (Seed, SessionIndex, ShellState, SessionId) {
	let mut seed = Seed::connection(ConnectionState::Connected {
		endpoint: "127.0.0.1:47000".to_string(),
		protocol: PROTOCOL_VERSION,
	});
	for capability in Capability::ALL {
		seed
			.store
			.capabilities
			.set(capability, CapabilityStatus::Available);
	}
	let session = seed.session(QueuePartition::Live);
	seed
		.store
		.domains
		.foreground
		.insert(session.clone(), ForegroundCommandView {
			command:   WAITING_ON.to_string(),
			truncated: false,
		});
	let mut index = SessionIndex::new();
	let mut shell = ShellState::default();
	project(&seed.store, &mut index, &HashMap::new(), CLOCK_MS, &mut shell);
	project_controls(&seed.store, &seed.registry, &index, &mut shell);
	(seed, index, shell, session)
}

/// The row the composer's controls are gated under, which is the row id of
/// the active session and not its own id.
fn composer_row(index: &SessionIndex, session: &SessionId) -> SessionId {
	SessionId::from(
		index
			.row_id(session)
			.expect("the session listed holds a row id")
			.to_string(),
	)
}

#[test]
fn the_command_the_session_waits_on_reaches_the_composer() {
	let (_seed, _index, shell, _session) = waiting_window();
	let waiting = shell
		.composer
		.foreground
		.as_ref()
		.expect("the composer draws the command the session is waiting on");
	assert_eq!(waiting.command, WAITING_ON, "the composer states the command the host named");
	assert_eq!(
		waiting.label(),
		format!("Background {WAITING_ON}"),
		"the control names the command it would move"
	);
}

#[test]
fn the_control_that_moves_it_is_reachable_while_the_wait_is_open() {
	let (_seed, index, shell, session) = waiting_window();
	let row = composer_row(&index, &session);
	assert_eq!(
		shell
			.controls
			.availability(&SurfaceId::ComposerBackgroundButton(row)),
		Availability::Enabled,
		"a window whose host offers the capability reaches the control that moves the command"
	);
}

#[test]
fn the_control_is_gated_by_the_action_that_moves_the_command() {
	let (seed, index, _shell, session) = waiting_window();
	let row = composer_row(&index, &session);
	let gated = gated_controls(&seed.store, &index, index.row_id(&session));
	let found = gated
		.iter()
		.find(|(surface, _)| matches!(surface, SurfaceId::ComposerBackgroundButton(id) if *id == row))
		.map(|(_, action)| *action);
	assert_eq!(
		found,
		Some(HostActionKind::BackgroundCommand),
		"the control reads the gate of the action it sends, so a refused capability greys it"
	);
}

#[test]
fn the_intent_reaches_the_host_for_the_session_the_window_is_on() {
	let (mut seed, index, _shell, session) = waiting_window();
	assert_eq!(
		actions_for(&Intent::BackgroundCommand, &index, &mut seed.store),
		vec![HostAction::BackgroundCommand { session }],
		"the press sends one action, naming the session whose command is waited on"
	);
}

#[test]
fn a_window_on_no_session_sends_nothing_rather_than_another_windows_command() {
	let (mut seed, index, _shell, _session) = waiting_window();
	seed.store.persisted.shell.active_session = None;
	assert!(
		actions_for(&Intent::BackgroundCommand, &index, &mut seed.store).is_empty(),
		"with no session open there is no command of this window's to move"
	);
}
