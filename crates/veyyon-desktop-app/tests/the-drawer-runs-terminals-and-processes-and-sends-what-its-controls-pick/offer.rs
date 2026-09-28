//! What the drawer offers is decided by the host's capabilities, never by
//! what the host lists yet: the process list is a tab, with its Start field,
//! wherever the host has not declined to supervise, and an opened drawer
//! draws a terminal it asks for, the process list, or the sentence stating
//! the host offers neither, never an empty body.
//!
//! WHY: the retired window pushed the supervisor's tab only once the host
//! listed a process, and the tab is the only place a process is started, so a
//! host supervising nothing yet could not be asked to start its first one.
//! It also opened a blank grid for a host offering neither tenant. The class
//! is a drawer surface decided by its contents instead of its capability, or
//! drawn empty for want of one. The sweep is every `CapabilityStatus` of
//! `Terminals` crossed with every one of `ProcessSupervisor`, with the process
//! list empty and holding one process; `statuses` is exhaustive over the
//! protocol's enum, so a status added to it fails to compile until the drawer's
//! answer to it is stated.
//!
//! Gap: the rebuilt window keeps the drawer's toggle, chord and command for a
//! host offering neither and states why the drawer is empty
//! (`drawer/render.rs`); the retired window withheld them. Whether the host
//! states its capabilities truthfully is the host's suites'.

use gpui::TestAppContext;
use veyyon_desktop_app::drawer::DrawerTab;
use veyyon_desktop_model::{Capability, CapabilityStatus, HostAction, TerminalStatus};

use super::harness::{
	both, capabilities, opened, process, processes, succeeded, terminal, terminals, window,
};

const NEITHER: &str = "The host runs no terminals and supervises no processes.";
const START: &str = "Command to start, as `bun run dev`";

/// One value of every capability status.
///
/// Exhaustive over `CapabilityStatus`: a status added to the protocol fails
/// to compile here until it is listed, and the sweeps below then decide it.
fn statuses() -> Vec<CapabilityStatus> {
	let every = |status: &CapabilityStatus| match status {
		CapabilityStatus::Available
		| CapabilityStatus::UnknownUntilAttached
		| CapabilityStatus::Unavailable { .. } => (),
	};
	let list = vec![
		CapabilityStatus::Available,
		CapabilityStatus::UnknownUntilAttached,
		CapabilityStatus::Unavailable { reason: "declined".to_owned() },
	];
	list.iter().for_each(every);
	list
}

/// Whether the host takes a request of a capability in `status` now: only
/// once it said so. A drawer asks for no terminal the host has not offered.
const fn takes(status: &CapabilityStatus) -> bool {
	matches!(status, CapabilityStatus::Available)
}

/// Whether a capability in `status` fills a tab: every status but a refusal,
/// so a host that has not stated it draws the tab rather than reflowing the
/// strip when it does.
const fn fills(status: &CapabilityStatus) -> bool {
	!matches!(status, CapabilityStatus::Unavailable { .. })
}

#[gpui::test]
fn the_process_list_is_a_tab_with_its_start_field_before_the_host_supervises_anything(
	app: &mut TestAppContext,
) {
	let mut w = window(app, opened(both()));
	w.toggle();
	for terminals_status in statuses() {
		for supervisor in statuses() {
			for listed in [Vec::new(), vec![process("dev", "running", None)]] {
				let case = format!(
					"terminals {terminals_status:?}, supervisor {supervisor:?}, listed {}",
					listed.len()
				);
				w.apply(vec![
					capabilities(vec![
						(Capability::Terminals, terminals_status.clone()),
						(Capability::ProcessSupervisor, supervisor.clone()),
					]),
					terminals(vec![terminal("t1", TerminalStatus::Running)]),
					processes(listed),
				]);
				assert_eq!(
					w.strip().contains(&DrawerTab::Processes),
					fills(&supervisor),
					"the process list is a tab by its capability alone ({case}): {:?}",
					w.strip()
				);
				if fills(&supervisor) {
					w.click("drawer.tab:processes");
					assert_eq!(w.shown(), Some(DrawerTab::Processes), "{case}");
					assert!(w.draws(START), "its Start field is drawn ({case})");
				}
				w.requests();
			}
		}
	}
}

#[gpui::test]
fn an_opened_drawer_draws_what_the_host_offers_and_states_when_it_offers_neither(
	app: &mut TestAppContext,
) {
	let mut w = window(app, opened(both()));
	for terminals_status in statuses() {
		for supervisor in statuses() {
			let case = format!("terminals {terminals_status:?}, supervisor {supervisor:?}");
			w.apply(vec![
				capabilities(vec![
					(Capability::Terminals, terminals_status.clone()),
					(Capability::ProcessSupervisor, supervisor.clone()),
				]),
				terminals(Vec::new()),
				processes(Vec::new()),
			]);
			w.requests();
			w.toggle();
			let requests = w.requests();
			let create = requests
				.iter()
				.find(|request| matches!(request.action, HostAction::CreateTerminal { .. }));
			assert_eq!(
				create.is_some(),
				takes(&terminals_status),
				"a terminal is asked for ({case}): {requests:?}"
			);
			let expected = if takes(&terminals_status) {
				None
			} else if fills(&supervisor) {
				Some(DrawerTab::Processes)
			} else {
				None
			};
			assert_eq!(w.shown(), expected, "{case}");
			assert_eq!(
				w.draws(NEITHER),
				!takes(&terminals_status) && !fills(&supervisor),
				"the drawer states that the host offers neither, and only then ({case})"
			);
			assert!(
				takes(&terminals_status) || fills(&supervisor) || w.strip().is_empty(),
				"a drawer offering nothing lists no tab ({case}): {:?}",
				w.strip()
			);

			w.toggle();
			assert!(!w.layout().drawer_open, "the drawer closes ({case})");
			// A terminal still on its way is answered, so the next case opens
			// on a drawer that waits for nothing.
			if let Some(create) = create {
				w.apply(vec![
					terminals(vec![terminal("t1", TerminalStatus::Running)]),
					succeeded(create.id),
				]);
			}
		}
	}
}

#[gpui::test]
fn a_drawer_left_open_when_the_host_withdraws_both_states_it_rather_than_an_empty_grid(
	app: &mut TestAppContext,
) {
	let mut w = window(app, opened(both()));
	w.toggle();
	w.apply(vec![terminals(vec![terminal("t1", TerminalStatus::Running)])]);
	assert!(w.bounds("drawer.grid:terminal:t1").is_some(), "the terminal is drawn");

	let declined = |reason: &str| CapabilityStatus::Unavailable { reason: reason.to_owned() };
	w.apply(vec![
		capabilities(vec![
			(Capability::Terminals, declined("no pty")),
			(Capability::ProcessSupervisor, declined("no supervisor")),
		]),
		terminals(Vec::new()),
	]);
	assert_eq!(w.bounds("drawer.grid:terminal:t1"), None, "no grid stands without its terminal");
	assert!(w.draws(NEITHER), "the open drawer states why it is empty: {:?}", w.texts());
}
