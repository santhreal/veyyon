//! WHY: the desktop client ran every session in whatever mode the host had put
//! it in and said nothing about it. Plan mode was reachable only from the
//! terminal's `/plan`, so a desktop operator could neither enter it nor leave
//! it, and a session the host HAD placed in plan mode -- which the host does at
//! launch when `plan.defaultOnStartup` is set -- drew a composer identical to
//! an unrestricted one. The agent held a plan tool set the window never
//! mentioned, and the only evidence was a plan card arriving later.
//!
//! CLASS CLOSED: a session-scoped mode the window neither states nor sets. The
//! sweep reads the mode vocabulary out of `SessionMode` at run time, so a mode
//! added to the client is red here until someone decides its wire name, its
//! label and whether the header carrying it reaches the composer. The
//! reachability half is pinned the same way: the palette is asked for the rows
//! that carry `Intent::SetPlanMode`, and each is dispatched through
//! `actions_for` to the action the host answers, so a row that stops producing
//! an action, or produces one naming the wrong mode, fails.
//!
//! NOT CAUGHT: whether the host honours the action -- that plan mode restricts
//! the tool set and restores it on exit is
//! `packages/coding-agent/test/gui-host/
//! a-mode-the-operator-set-is-the-mode-the-agent-runs-in.test.ts`. It also says
//! nothing about how the chip reads on screen, which is a capture's business,
//! and nothing about `Goal` or `Vibe`, which no operator gesture sets: the
//! tools that own them do.

mod support;

use std::collections::HashMap;

use strum::IntoEnumIterator;
use support::{NOW_MS, session};
use veyyon_desktop::{SessionIndex, actions_for, project};
use veyyon_desktop_model::{
	Capability, CapabilityStatus, ConnectionState, HostAction, HostEvent, PROTOCOL_VERSION,
	QueuePartition, SessionHeaderView, SessionId, SessionMode, SessionModeKind, SettableMode,
	SnapshotSection, Store, Versioned, reduce,
};
use veyyon_desktop_surface::{
	Intent, ShellState,
	palette::{PaletteItemKind, commands::command_items},
};

/// One mode of each kind this client spells, built from the discriminant so a
/// new variant arrives here without a list to update.
fn sample(kind: SessionModeKind) -> SessionMode {
	match kind {
		SessionModeKind::Plan => SessionMode::Plan,
		SessionModeKind::PlanPaused => SessionMode::PlanPaused,
		SessionModeKind::Goal => SessionMode::Goal,
		SessionModeKind::Vibe => SessionMode::Vibe,
		SessionModeKind::Other => SessionMode::Other("rehearsal".to_owned()),
	}
}

/// An attached store holding one open session, which is the only state in which
/// a mode is anything at all.
fn attached_store() -> (Store, SessionId) {
	let mut store = Store::new();
	let id = SessionId::from("s1");
	store.sessions.insert(session("s1", QueuePartition::Live));
	store.persisted.shell.active_session = Some(id.clone());
	store.connection = ConnectionState::Connected {
		endpoint: "unix:/run/veyyon.sock".to_owned(),
		protocol: PROTOCOL_VERSION,
	};
	store
		.capabilities
		.set(Capability::Sessions, CapabilityStatus::Available);
	store
		.capabilities
		.set(Capability::TurnControl, CapabilityStatus::Available);
	(store, id)
}

/// The header the host states when the operator opens the session, in the mode
/// the host says it is in.
fn header(id: &SessionId, mode: Option<&str>, revision: u64) -> SnapshotSection {
	SnapshotSection::ActiveSession(Versioned {
		revision,
		value: SessionHeaderView {
			id:             id.clone(),
			schema_version: 3,
			title:          Some("Rewrite the walker cache".to_owned()),
			title_source:   None,
			parent:         None,
			created_at_ms:  NOW_MS - 600_000,
			cwd:            "/repo".to_owned(),
			mode:           mode.map(str::to_owned),
		},
	})
}

fn composer_mode(store: &Store) -> Option<SessionMode> {
	let mut state = ShellState::default();
	let mut index = SessionIndex::new();
	project(store, &mut index, &HashMap::new(), NOW_MS, &mut state);
	state.composer.mode
}

#[test]
fn every_mode_the_client_spells_round_trips_through_its_wire_name() {
	let kinds: Vec<SessionModeKind> = SessionModeKind::iter().collect();
	assert_eq!(
		kinds.len(),
		5,
		"a mode added to the client decides its wire name and label here: {kinds:?}"
	);

	for kind in kinds {
		let mode = sample(kind);
		let wire = mode.wire_name();
		assert!(!wire.is_empty(), "{mode:?} states no name for the host to read");
		assert_eq!(
			SessionMode::from_wire(wire),
			Some(mode.clone()),
			"{mode:?} does not survive the name it is sent under"
		);
		assert!(
			!mode.label().is_empty(),
			"{mode:?} draws no label, so the chip would be an empty box"
		);
	}
}

#[test]
fn the_absence_of_a_mode_is_the_absence_of_a_mode() {
	// Both spellings the host uses for a session running with everything it
	// has. `Other` swallowing either would draw a chip reading `none`.
	assert_eq!(SessionMode::from_wire("none"), None);
	assert_eq!(SessionMode::from_wire(""), None);
}

#[test]
fn the_mode_on_the_header_reaches_the_composer_and_leaves_with_it() {
	let (mut store, id) = attached_store();

	assert_eq!(
		composer_mode(&store),
		None,
		"a session the host reported no header for is in no mode"
	);

	for kind in SessionModeKind::iter() {
		let mode = sample(kind);
		reduce(&mut store, HostEvent::Snapshot(header(&id, Some(mode.wire_name()), 2)));
		assert_eq!(store.modes.get(&id), Some(&mode), "the header's mode is the session's: {mode:?}");
		assert_eq!(
			composer_mode(&store),
			Some(mode.clone()),
			"the composer states the mode the host reported: {mode:?}"
		);

		// The same session, out of the mode again. A mode that survives its own
		// exit is the defect this half catches: the chip would outlive the
		// restriction it announces.
		reduce(&mut store, HostEvent::Snapshot(header(&id, Some("none"), 3)));
		assert_eq!(store.modes.get(&id), None, "leaving {mode:?} leaves the session in no mode");
		assert_eq!(composer_mode(&store), None, "no mode, no chip");
	}
}

#[test]
fn the_palette_offers_both_directions_and_each_reaches_the_host() {
	let (mut store, id) = attached_store();
	let mut state = ShellState::default();
	let mut index = SessionIndex::new();
	project(&store, &mut index, &HashMap::new(), NOW_MS, &mut state);

	let rows: Vec<(String, Intent)> = command_items()
		.into_iter()
		.filter_map(|item| match item.kind {
			PaletteItemKind::Command { intent }
				if matches!(intent.as_ref(), Intent::SetPlanMode { .. }) =>
			{
				Some((item.title, *intent))
			},
			_ => None,
		})
		.collect();

	// Exact equality, not a count: a toggling row replacing the pair would
	// leave a press whose outcome the list cannot state.
	assert_eq!(
		rows
			.iter()
			.map(|(title, _)| title.as_str())
			.collect::<Vec<_>>(),
		vec!["/plan", "/plan off"],
		"both directions are offered by name"
	);
	assert_eq!(rows[0].1, Intent::SetPlanMode { on: true });
	assert_eq!(rows[1].1, Intent::SetPlanMode { on: false });

	for (title, intent) in &rows {
		let actions = actions_for(intent, &index, &mut store);
		let on = matches!(intent, Intent::SetPlanMode { on: true });
		assert_eq!(
			actions,
			vec![HostAction::SetSessionMode {
				session: id.clone(),
				mode:    if on {
					SettableMode::Plan
				} else {
					SettableMode::None
				},
			}],
			"{title} reaches the host as the mode it names"
		);
	}
}

#[test]
fn a_mode_request_with_no_open_session_reaches_nothing() {
	// The action names the session it sets, so there is nothing to send before
	// one is open; sending a mode for a session id the window invented is worse
	// than sending none.
	let mut store = Store::new();
	store.connection = ConnectionState::Connected {
		endpoint: "unix:/run/veyyon.sock".to_owned(),
		protocol: PROTOCOL_VERSION,
	};
	let index = SessionIndex::new();

	assert!(actions_for(&Intent::SetPlanMode { on: true }, &index, &mut store).is_empty());
	assert!(actions_for(&Intent::SetPlanMode { on: false }, &index, &mut store).is_empty());
}
