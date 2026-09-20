//! WHY: `/pause` freezes every agent in the host process, not the turn of the
//! session the window has open. A window that read the freeze off its own
//! press would draw the strip for the operator who typed it and nothing for
//! the second window, for the terminal running in the same process, or for
//! the window that attached while the freeze was already in force — three
//! operators watching agents that will not move, with nothing on screen
//! saying why, and no control that ends it.
//!
//! CLASS CLOSED: process-wide host state that reaches only the surface that
//! asked for it. The freeze arrives as a snapshot section like any other, so
//! this drives the section through the reducer into the projection and out to
//! the strip's own label, for a window that engaged it and one that did not.
//! Both verbs are swept from the command list and through `actions_for` with
//! no session open, because the freeze belongs to no session and a row that
//! needs one would be dead in exactly the window that is worst off: the one
//! showing nothing while agents run behind it.
//!
//! The clock is asserted for termination as well as value: the duration moves
//! on the tick rather than on a host frame, so a freeze that holds states a
//! number that grows, and one the host released states nothing even when the
//! mark it was engaged on is still on the wire.
//!
//! NOT CAUGHT: whether the host's gate actually parks the agent loops, which
//! `packages/coding-agent/test/gui-host/
//! a-freeze-holds-every-agent-until-one-window-releases-it.test.ts` owns
//! against the real gate, and the pixels of the strip, which the scene
//! catalogue owns.

mod support;

use std::collections::HashMap;

use support::{NOW_MS, session};
use veyyon_desktop::{SessionIndex, actions_for, project, project_clock, project_controls};
use veyyon_desktop_model::{
	AgentPauseView, Capability, CapabilityMap, CapabilityStatus, ConnectionState, Damage,
	HostAction, HostActionKind, HostEvent, QueuePartition, RequestRegistry, SessionId,
	SnapshotSection, Store, SurfaceId, reduce,
};
use veyyon_desktop_surface::{
	Availability, Intent, ShellState,
	palette::{PaletteItemKind, commands::command_items},
};

/// The section the host sends when the gate closes at `since_ms`.
const fn frozen_since(since_ms: u64) -> HostEvent {
	HostEvent::Snapshot(SnapshotSection::AgentPause(AgentPauseView {
		paused:   true,
		since_ms: Some(since_ms),
	}))
}

/// The section the host sends when the gate opens again.
const fn released() -> HostEvent {
	HostEvent::Snapshot(SnapshotSection::AgentPause(AgentPauseView::RUNNING))
}

/// A store with one session open and every capability granted.
fn attached() -> (Store, SessionIndex) {
	let mut store = Store::new();
	let mut capabilities = CapabilityMap::new();
	for capability in Capability::ALL {
		capabilities.set(capability, CapabilityStatus::Available);
	}
	store.capabilities = capabilities;
	store.sessions.insert(session("s", QueuePartition::Live));
	store.persisted.shell.active_session = Some(SessionId::from("s"));
	(store, SessionIndex::new())
}

/// The window's state after one projection of `store` at `now_ms`.
fn drawn(store: &Store, index: &mut SessionIndex, now_ms: u64) -> ShellState {
	let mut state = ShellState::default();
	project(store, index, &HashMap::new(), now_ms, &mut state);
	state
}

/// The command rows the palette offers, as label and intent.
fn command_rows() -> Vec<(String, Intent)> {
	command_items()
		.into_iter()
		.filter_map(|item| match item.kind {
			PaletteItemKind::Command { intent } => Some((item.title, *intent)),
			_ => None,
		})
		.collect()
}

#[test]
fn a_freeze_the_window_never_asked_for_reaches_its_strip() {
	let (mut store, mut index) = attached();
	assert_eq!(drawn(&store, &mut index, NOW_MS).paused, None, "nothing is frozen yet");

	let damage = reduce(&mut store, frozen_since(NOW_MS - 12_000));

	assert!(
		damage.contains(&Damage::FullWindow),
		"the strip takes a band off the top, so it moves every region under it: {damage:?}"
	);
	assert_eq!(
		drawn(&store, &mut index, NOW_MS).paused,
		Some("12s".to_owned()),
		"the strip states how long the host has held the freeze"
	);
}

#[test]
fn a_release_takes_the_strip_off_even_with_the_old_mark_still_on_the_wire() {
	let (mut store, mut index) = attached();
	reduce(&mut store, frozen_since(NOW_MS - 12_000));

	reduce(&mut store, released());

	assert_eq!(drawn(&store, &mut index, NOW_MS).paused, None);
	assert_eq!(store.paused, AgentPauseView::RUNNING, "the section replaces rather than merges");
}

#[test]
fn a_second_freeze_replaces_the_first_rather_than_stacking() {
	let (mut store, mut index) = attached();
	reduce(&mut store, frozen_since(NOW_MS - 12_000));

	reduce(&mut store, frozen_since(NOW_MS - 3_000));

	assert_eq!(
		drawn(&store, &mut index, NOW_MS).paused,
		Some("3s".to_owned()),
		"the mark the host last stated is the one the clock runs from"
	);
}

#[test]
fn the_clock_moves_the_freeze_without_a_frame_from_the_host() {
	let (mut store, mut index) = attached();
	reduce(&mut store, frozen_since(NOW_MS));
	let mut state = drawn(&store, &mut index, NOW_MS);
	assert_eq!(state.paused, Some("0s".to_owned()));

	let changed = project_clock(&store, &index, NOW_MS + 61_000, &mut state);

	assert!(changed, "a freeze whose clock moved is a repaint the window owes");
	assert_eq!(state.paused, Some("1m".to_owned()));
}

#[test]
fn the_clock_reports_no_change_while_the_second_holds() {
	let (mut store, mut index) = attached();
	reduce(&mut store, frozen_since(NOW_MS));
	let mut state = drawn(&store, &mut index, NOW_MS);

	let changed = project_clock(&store, &index, NOW_MS + 400, &mut state);

	assert!(!changed, "a tick inside the same second repaints nothing");
	assert_eq!(state.paused, Some("0s".to_owned()));
}

#[test]
fn a_running_host_states_no_clock_however_long_the_window_is_up() {
	// No session, so the freeze is the only clock in the window: a repaint
	// here is one the strip asked for rather than a row counting up.
	let store = Store::new();
	let mut index = SessionIndex::new();
	let mut state = drawn(&store, &mut index, NOW_MS);

	let changed = project_clock(&store, &index, NOW_MS + 3_600_000, &mut state);

	assert!(!changed);
	assert_eq!(state.paused, None, "a window that is not frozen never grows a clock");
}

#[test]
fn both_verbs_are_typed_as_the_commands_the_terminal_spells_them() {
	let rows = command_rows();
	assert!(
		rows.contains(&("/pause".to_owned(), Intent::PauseAgents)),
		"/pause is not a command row that freezes every agent: {rows:?}"
	);
	assert!(
		rows.contains(&("/unpause".to_owned(), Intent::ResumeAgents)),
		"/unpause is not a command row that wakes them: {rows:?}"
	);
}

#[test]
fn the_release_does_not_take_the_spelling_the_terminal_gives_another_verb() {
	// `/resume` opens a different session in the terminal. A desktop row of
	// that name waking agents is the same word doing two jobs across the two
	// front ends, which is typed from memory and lands on the wrong one.
	let collisions: Vec<(String, Intent)> = command_rows()
		.into_iter()
		.filter(|(title, _)| title == "/resume")
		.collect();
	assert_eq!(collisions, [], "the desktop spells the freeze's release `/unpause`");
}

#[test]
fn neither_verb_needs_a_session_to_be_open() {
	let mut store = Store::new();
	let index = SessionIndex::new();

	assert_eq!(actions_for(&Intent::PauseAgents, &index, &mut store), [HostAction::PauseAgents]);
	assert_eq!(actions_for(&Intent::ResumeAgents, &index, &mut store), [HostAction::ResumeAgents]);
}

#[test]
fn the_open_session_changes_neither_request() {
	let (mut store, index) = attached();

	assert_eq!(actions_for(&Intent::PauseAgents, &index, &mut store), [HostAction::PauseAgents]);
	assert_eq!(actions_for(&Intent::ResumeAgents, &index, &mut store), [HostAction::ResumeAgents]);
}

#[test]
fn both_controls_are_gated_on_the_capability_the_host_withholds() {
	assert_eq!(
		veyyon_desktop_model::action_to_capability(HostActionKind::PauseAgents),
		Capability::Lifecycle
	);
	assert_eq!(
		veyyon_desktop_model::action_to_capability(HostActionKind::ResumeAgents),
		Capability::Lifecycle
	);
	assert_eq!(
		veyyon_desktop::surface_for_action(&Intent::PauseAgents, &HostAction::PauseAgents, None),
		SurfaceId::AgentsPauseButton,
		"a refusal of the freeze lands on no control the window draws"
	);
	assert_eq!(
		veyyon_desktop::surface_for_action(&Intent::ResumeAgents, &HostAction::ResumeAgents, None),
		SurfaceId::AgentsResumeButton
	);
}

#[test]
fn the_freeze_is_gated_in_a_window_with_nothing_open() {
	let mut store = Store::new();
	store.connection = ConnectionState::Connected { endpoint: "socket".to_owned(), protocol: 1 };
	let registry = RequestRegistry::new();
	let index = SessionIndex::new();
	let mut state = ShellState::default();

	store
		.capabilities
		.set(Capability::Lifecycle, CapabilityStatus::Unavailable {
			reason: "this host runs no agents".to_owned(),
		});
	project_controls(&store, &registry, &index, &mut state);
	assert!(
		matches!(
			state.controls.availability(&SurfaceId::AgentsResumeButton),
			Availability::Unavailable { .. }
		),
		"a host that withholds the lifecycle capability leaves the control live"
	);

	store
		.capabilities
		.set(Capability::Lifecycle, CapabilityStatus::Available);
	project_controls(&store, &registry, &index, &mut state);

	assert_eq!(
		state.controls.availability(&SurfaceId::AgentsResumeButton),
		Availability::Enabled,
		"a window showing no session is the one that most needs the way out of a freeze"
	);
	assert_eq!(state.controls.availability(&SurfaceId::AgentsPauseButton), Availability::Enabled);
}
