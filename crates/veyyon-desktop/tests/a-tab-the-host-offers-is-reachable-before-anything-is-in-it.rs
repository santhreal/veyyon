//! WHY: the drawer's supervisor tab was pushed only when the host already
//! listed a process, and the tab is the only place the window offers `Start`.
//! A host that supervises processes but runs none yet drew no tab, so the
//! first process could not be started from the window, and the capability the
//! host declared was reachable only after something else had used it.
//!
//! CLASS CLOSED: a tab whose presence is decided by its contents rather than
//! by the capability that fills it. The sweep drives the real projection over
//! every `CapabilityStatus` of `ProcessSupervisor` and `Terminals`, with the
//! process list empty and with one process in it, and pins which pairs draw
//! the tab. A status added to the protocol fails to compile in `offers` until
//! it is decided, and a projection that goes back to reading the list turns
//! the empty-list rows red.
//!
//! GAPS: it pins which tabs the projection produces, not what they draw once
//! selected, nor that pressing `Start` sends a usable command --
//! `the-supervisor-starts-the-command-its-field-states` in the surface crate
//! owns that. Whether the host declares the capability truthfully is the
//! gui-host suites' subject.

mod support;

use support::{session, terminal};
use veyyon_desktop::project;
use veyyon_desktop_model::{
	Capability, CapabilityStatus, ProcessView, QueuePartition, SessionId, Store, TerminalStatus,
};
use veyyon_desktop_surface::{DrawerTab, ShellState};

/// Whether a capability in this state fills a tab.
///
/// Exhaustive over `CapabilityStatus`: a fourth status fails to compile here
/// until somebody decides whether the surface it fills is offered.
const fn offers(status: &CapabilityStatus) -> bool {
	match status {
		CapabilityStatus::Available => true,
		CapabilityStatus::Unavailable { .. } | CapabilityStatus::UnknownUntilAttached => false,
	}
}

/// One value of every capability status.
fn statuses() -> Vec<CapabilityStatus> {
	vec![
		CapabilityStatus::Available,
		CapabilityStatus::Unavailable { reason: "the host runs none".to_owned() },
		CapabilityStatus::UnknownUntilAttached,
	]
}

fn process(name: &str) -> ProcessView {
	ProcessView {
		name:          name.to_owned(),
		pid:           Some(4242),
		application:   "bun".to_owned(),
		args:          vec!["run".to_owned(), "dev".to_owned()],
		cwd:           "/repo".to_owned(),
		lifetime:      "short".to_owned(),
		status:        "running".to_owned(),
		exit_code:     None,
		started_at_ms: 1_000,
		terminated_by: None,
	}
}

/// The tabs the projection produces for a host in this state.
fn tabs(
	terminals: &CapabilityStatus,
	supervisor: &CapabilityStatus,
	running: &[ProcessView],
) -> Vec<DrawerTab> {
	let mut store = Store::new();
	let id = SessionId::from("s1");
	store.sessions.insert(session("s1", QueuePartition::Live));
	store.persisted.shell.active_session = Some(id.clone());
	store
		.capabilities
		.set(Capability::Terminals, terminals.clone());
	store
		.capabilities
		.set(Capability::ProcessSupervisor, supervisor.clone());
	if offers(terminals) {
		store.domains.terminals = vec![terminal("term-1", TerminalStatus::Running)];
	}
	store.domains.processes = running.to_vec();

	let mut state = ShellState::default();
	let mut index = veyyon_desktop::SessionIndex::new();
	let _ = index.row_of(&id);
	let emulators = std::collections::HashMap::new();
	project(&store, &mut index, &emulators, 2_000, &mut state);
	state.drawer.tabs
}

#[test]
fn the_supervisor_tab_is_offered_on_the_capability_not_on_the_list() {
	for supervisor in statuses() {
		for terminals in statuses() {
			let empty = tabs(&terminals, &supervisor, &[]);
			let drawn = empty.contains(&DrawerTab::Processes);
			assert_eq!(
				drawn,
				offers(&supervisor),
				"supervisor {supervisor:?} with terminals {terminals:?} and nothing running drew tabs \
				 {empty:?}"
			);
		}
	}
}

#[test]
fn a_running_process_adds_its_own_tab_beside_the_list() {
	for supervisor in statuses() {
		let with_one = tabs(&CapabilityStatus::UnknownUntilAttached, &supervisor, &[process("web")]);
		assert_eq!(
			with_one.contains(&DrawerTab::Processes),
			offers(&supervisor),
			"supervisor {supervisor:?} decides the list tab, not the process: {with_one:?}"
		);
		assert!(
			with_one.contains(&DrawerTab::Process { name: "web".to_owned() }),
			"a process the host lists is reachable on its own tab: {with_one:?}"
		);
	}
}

#[test]
fn a_supervisor_the_host_does_not_offer_draws_no_tab_for_it() {
	// The negative control for the fix: the tab follows the capability in both
	// directions, so a host that supervises nothing draws no supervisor tab
	// even while it lists processes from a previous attach.
	let withdrawn = CapabilityStatus::Unavailable { reason: "no supervisor".to_owned() };
	let tabs = tabs(&CapabilityStatus::Available, &withdrawn, &[process("web")]);
	assert!(
		!tabs.contains(&DrawerTab::Processes),
		"a withdrawn supervisor draws no list tab: {tabs:?}"
	);
}
