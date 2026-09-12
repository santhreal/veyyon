//! WHY: every control the terminal drawer draws sends a request the host can
//! refuse, and the refusal lands on the control that sent it, carrying the
//! host's sentence and whether it may be sent again. Two defects, one class:
//!
//! 1. The drawer stated the failure of `TerminalCreateButton` alone -- the
//!    terminal its own opening creates -- so a refused `Start`, a line the host
//!    could not write and a process it could not stop landed on a surface
//!    nothing draws, and the press looked answered.
//! 2. `surface_for_action` resolved a drawer request from the intent, which
//!    names no target, so a `Close` registered under `TerminalCloseButton(row,
//!    "")` and a `Clear`, `Restart`, `Stop` or log open registered under the
//!    titlebar. Those are not the ids the chrome and the process rows read, so
//!    the press drew no pending mark either.
//!
//! CLASS CLOSED: the sweep is over every sample intent's actions, filtered at
//! run time to the drawer's own capabilities (`Terminals`,
//! `ProcessSupervisor`), so an action added to either family is covered by
//! what it is. Each one must land on a control `SurfaceId::in_terminal_drawer`
//! accepts, must name what the action acts on, and must be a control
//! `gated_controls` also projects -- which is the id the drawer's own render
//! reads. The actions no control presses are pinned by exact equality. A
//! failure on any other gated control is required NOT to be stated in the
//! drawer, and the statement is resolved every projection, so a dismissal
//! leaves it.
//!
//! NOT CAUGHT: where the row is drawn and what a press of its `Retry` sends,
//! which is `veyyon-desktop-surface`'s
//! `a-refusal-the-drawer-landed-is-drawn-in-the-drawer.rs`; and whether the
//! host refuses these requests, which is the gui-host's own suite.

mod support;

use std::collections::{BTreeSet, HashMap};

use support::{intent_samples::every_sample_intent, session, terminal};
use veyyon_desktop::{
	SessionIndex, actions_for, land_failure, project, project::gated_controls, project_controls,
	surface_for_action,
};
use veyyon_desktop_model::{
	BackendError, Capability, CapabilityStatus, ErrorScope, HostAction, HostActionKind, ProcessView,
	QueuePartition, RequestId, RequestRegistry, SessionId, Store, SurfaceId, TerminalStatus,
	action_to_capability,
};
use veyyon_desktop_surface::{Intent, ShellState};

const NOW_MS: u64 = 1_700_000_000_000;

/// The id the host knows the session by, and the row the window draws it as.
/// The projection numbers rows from one, so the first session's row is `1`.
fn wire() -> SessionId {
	SessionId::from("s1")
}

/// The row every drawer control is keyed under, which is the id the drawer
/// draws with and the id a request must register against.
fn row() -> SessionId {
	SessionId::from("1")
}

/// The actions of the drawer's capabilities that an intent sends and no
/// control presses: the grid's own keystrokes and the resize the layout
/// raises, whose failures are the connection's. `RefreshProcesses` is a third
/// of that kind and reaches no intent, so it is pinned by
/// `the_window_s_own_poll_is_nobody_s_press` instead.
const PINNED_NOT_A_PRESS: [HostActionKind; 2] =
	[HostActionKind::WriteTerminal, HostActionKind::ResizeTerminal];

/// A store with one session, one running terminal, one supervised process and
/// every capability available, plus the index that gives the row.
fn seeded() -> (Store, SessionIndex) {
	let mut store = Store::new();
	store.sessions.insert(session("s1", QueuePartition::Live));
	store.persisted.shell.active_session = Some(wire());
	for capability in Capability::ALL {
		store
			.capabilities
			.set(capability, CapabilityStatus::Available);
	}
	store.domains.terminals = vec![terminal("term-1", TerminalStatus::Running)];
	store.domains.processes = vec![ProcessView {
		name:          "server".to_string(),
		pid:           Some(4321),
		application:   "cargo".to_string(),
		args:          vec!["run".to_string()],
		cwd:           "/repo".to_string(),
		lifetime:      "short".to_string(),
		status:        "running".to_string(),
		exit_code:     None,
		started_at_ms: NOW_MS,
		terminated_by: None,
	}];
	let mut index = SessionIndex::new();
	let _ = index.row_of(&wire());
	(store, index)
}

/// Every action a sample intent sends that belongs to one of the drawer's
/// capabilities, with the control the window registers it under.
fn drawer_requests() -> Vec<(HostAction, SurfaceId)> {
	let mut requests = Vec::new();
	for intent in every_sample_intent() {
		let (mut store, index) = seeded();
		for action in actions_for(&intent, &index, &mut store) {
			let capability = action_to_capability(action.kind());
			if !matches!(capability, Capability::Terminals | Capability::ProcessSupervisor) {
				continue;
			}
			let surface = surface_for_action(&intent, &action, Some(&row()));
			requests.push((action, surface));
		}
	}
	assert!(
		requests.len() >= 8,
		"the drawer's intents reached {} actions, so the sweep is not driving them: {requests:?}",
		requests.len()
	);
	requests
}

/// What a drawer action acts on: a terminal by its id, a process by its name.
fn target_of_action(action: &HostAction) -> Option<&str> {
	match action {
		HostAction::AttachTerminal { terminal_id }
		| HostAction::WriteTerminal { terminal_id, .. }
		| HostAction::ResizeTerminal { terminal_id, .. }
		| HostAction::RestartTerminal { terminal_id }
		| HostAction::ClearTerminal { terminal_id }
		| HostAction::CloseTerminal { terminal_id } => Some(terminal_id),
		HostAction::ProcessLogs { process_id, .. }
		| HostAction::ProcessSend { process_id, .. }
		| HostAction::ProcessSignal { process_id, .. }
		| HostAction::ProcessStop { process_id }
		| HostAction::ProcessRestart { process_id } => Some(process_id),
		_ => None,
	}
}

/// The control family a drawer surface belongs to, and what it is keyed
/// under for the families that name something.
fn drawer_control(surface: &SurfaceId) -> (&'static str, Option<&str>) {
	match surface {
		SurfaceId::TerminalCreateButton(_) => ("TerminalCreateButton", None),
		SurfaceId::ProcessStartButton(_) => ("ProcessStartButton", None),
		SurfaceId::TerminalCloseButton(_, id) => ("TerminalCloseButton", Some(id)),
		SurfaceId::TerminalRestartButton(_, id) => ("TerminalRestartButton", Some(id)),
		SurfaceId::TerminalClearButton(_, id) => ("TerminalClearButton", Some(id)),
		SurfaceId::ProcessStopButton(_, id) => ("ProcessStopButton", Some(id)),
		SurfaceId::ProcessRestartButton(_, id) => ("ProcessRestartButton", Some(id)),
		SurfaceId::ProcessSignalButton(_, id) => ("ProcessSignalButton", Some(id)),
		SurfaceId::ProcessSendButton(_, id) => ("ProcessSendButton", Some(id)),
		SurfaceId::ProcessLogsTab(_, id) => ("ProcessLogsTab", Some(id)),
		_ => ("outside the drawer", None),
	}
}

/// A refusal of `request`, in the host's own words.
fn refusal(request: RequestId, retryable: bool) -> BackendError {
	BackendError {
		scope: ErrorScope::Terminal,
		code: Some("REFUSED".to_string()),
		message: "the host refused: no such command".to_string(),
		retryable,
		request: Some(request),
		occurred_at_ms: NOW_MS,
	}
}

/// Sends a request from `surface`, has the host refuse it, and projects: the
/// whole path from a registered request to what the drawer states, with
/// nothing written into `ShellState` by hand.
fn refused_on(kind: HostActionKind, surface: &SurfaceId, retryable: bool) -> ShellState {
	let (store, mut index) = seeded();
	let mut registry = RequestRegistry::new();
	let request = RequestId(1);
	registry.register(request, kind, surface.clone(), NOW_MS, 30_000);

	let mut state = ShellState { current_id: 1, ..ShellState::default() };
	project(&store, &mut index, &HashMap::new(), NOW_MS, &mut state);
	land_failure(&refusal(request, retryable), &registry, Some(&wire()), &mut state);
	// The window completes the request the moment it lands the failure, so
	// the projection reads a control at rest with an error rather than one
	// still in flight.
	registry.complete(&request);
	project_controls(&store, &registry, &index, &mut state);
	state
}

#[test]
fn a_request_the_drawer_sends_lands_on_a_control_the_drawer_draws() {
	let mut not_a_press = BTreeSet::new();
	for (action, surface) in drawer_requests() {
		if surface.in_terminal_drawer() {
			continue;
		}
		assert_eq!(
			surface,
			SurfaceId::GlobalTitlebarLine,
			"{:?} landed on {surface:?}, which is neither the drawer's nor the titlebar's",
			action.kind()
		);
		not_a_press.insert(action.kind());
	}
	assert_eq!(
		not_a_press,
		PINNED_NOT_A_PRESS.into_iter().collect::<BTreeSet<_>>(),
		"the actions of the drawer's capabilities that no control presses changed"
	);
}

#[test]
fn the_window_s_own_poll_is_nobody_s_press() {
	// The window asks the host what it supervises on its own account -- the
	// initial sync raises it from the capability, and no intent sends it --
	// so the answer belongs to the connection rather than to a control the
	// operator pressed. A drawer surface here would draw a refusal under a
	// button nobody touched.
	assert!(
		veyyon_desktop::initial_sync_actions(&[(
			Capability::ProcessSupervisor,
			CapabilityStatus::Available,
		)])
		.contains(&HostAction::RefreshProcesses),
		"the window no longer polls the supervisor on its own account"
	);
	let surface = surface_for_action(
		&Intent::SetDrawer { open: true },
		&HostAction::RefreshProcesses,
		Some(&row()),
	);
	assert!(
		!surface.in_terminal_drawer(),
		"the poll landed on {surface:?}, a control of the drawer nobody pressed"
	);
}

#[test]
fn a_control_a_request_lands_on_names_what_the_action_acts_on() {
	for (action, surface) in drawer_requests() {
		if !surface.in_terminal_drawer() {
			continue;
		}
		// The attach is the drawer's own opening rather than a press on the
		// terminal it names: it lands on the control that offers a terminal
		// where the strip has none, which is `New`.
		if !matches!(action, HostAction::AttachTerminal { .. })
			&& let Some(target) = target_of_action(&action)
		{
			assert_eq!(
				drawer_control(&surface).1,
				Some(target),
				"{:?} acts on {target}, and landed on {surface:?}",
				action.kind()
			);
		}
		let (SurfaceId::TerminalCreateButton(session)
		| SurfaceId::TerminalCloseButton(session, _)
		| SurfaceId::TerminalRestartButton(session, _)
		| SurfaceId::TerminalClearButton(session, _)
		| SurfaceId::ProcessStartButton(session)
		| SurfaceId::ProcessStopButton(session, _)
		| SurfaceId::ProcessRestartButton(session, _)
		| SurfaceId::ProcessSignalButton(session, _)
		| SurfaceId::ProcessSendButton(session, _)
		| SurfaceId::ProcessLogsTab(session, _)) = &surface
		else {
			unreachable!("in_terminal_drawer accepted {surface:?}")
		};
		assert_eq!(
			session,
			&row(),
			"{:?} landed under a row the drawer does not draw",
			action.kind()
		);
	}
}

#[test]
fn every_drawer_action_registers_under_the_control_that_sends_it() {
	// Pinned by exact equality, so an action of either family added to the
	// window is red here until the control it belongs to is recorded, and a
	// send that registers under the row's stop -- the same row, the same
	// name, the wrong press -- is red rather than plausible.
	let table: BTreeSet<(String, &'static str)> = drawer_requests()
		.iter()
		.filter(|(_, surface)| surface.in_terminal_drawer())
		.map(|(action, surface)| (format!("{:?}", action.kind()), drawer_control(surface).0))
		.collect();
	let pinned: BTreeSet<(String, &'static str)> = [
		("AttachTerminal", "TerminalCreateButton"),
		("CreateTerminal", "TerminalCreateButton"),
		("ClearTerminal", "TerminalClearButton"),
		("CloseTerminal", "TerminalCloseButton"),
		("RestartTerminal", "TerminalRestartButton"),
		("ProcessStart", "ProcessStartButton"),
		("ProcessSend", "ProcessSendButton"),
		("ProcessSignal", "ProcessSignalButton"),
		("ProcessStop", "ProcessStopButton"),
		("ProcessRestart", "ProcessRestartButton"),
		("ProcessLogs", "ProcessLogsTab"),
	]
	.map(|(kind, control)| (kind.to_owned(), control))
	.into();
	assert_eq!(table, pinned, "a drawer action changed the control it registers under");
}

#[test]
fn a_control_a_request_lands_on_is_one_the_projection_gates() {
	let (store, index) = seeded();
	let gated: BTreeSet<SurfaceId> = gated_controls(&store, &index, Some(1))
		.into_iter()
		.map(|(surface, _)| surface)
		.collect();
	for (action, surface) in drawer_requests() {
		if !surface.in_terminal_drawer() {
			continue;
		}
		assert!(
			gated.contains(&surface),
			"{:?} landed on {surface:?}, which no control reads its availability under",
			action.kind()
		);
	}
}

#[test]
fn the_refusal_of_a_drawer_control_is_stated_in_the_drawer() {
	for (action, surface) in drawer_requests() {
		if !surface.in_terminal_drawer() {
			continue;
		}
		let state = refused_on(action.kind(), &surface, true);
		let failure = state.drawer.failure.as_ref().unwrap_or_else(|| {
			panic!("{:?} refused on {surface:?} and the drawer states nothing", action.kind())
		});
		assert_eq!(failure.surface, surface, "the drawer states another control's refusal");
		assert_eq!(failure.error.message, "the host refused: no such command");
		assert!(failure.error.retryable, "the host offered to be asked again");
	}
}

#[test]
fn a_refusal_the_host_calls_final_offers_no_second_send() {
	let state =
		refused_on(HostActionKind::ProcessStart, &SurfaceId::ProcessStartButton(row()), false);
	let failure = state.drawer.failure.expect("the drawer states the refusal");
	assert!(!failure.error.retryable, "a refusal the host called final draws no Retry");
}

#[test]
fn a_refusal_of_another_surface_is_not_the_drawers() {
	let (store, index) = seeded();
	let elsewhere: Vec<SurfaceId> = gated_controls(&store, &index, Some(1))
		.into_iter()
		.map(|(surface, _)| surface)
		.filter(|surface| !surface.in_terminal_drawer())
		.collect();
	assert!(elsewhere.len() > 10, "the store gates {} controls outside the drawer", elsewhere.len());
	for surface in elsewhere {
		let state = refused_on(HostActionKind::SubmitPrompt, &surface, true);
		assert_eq!(
			state.drawer.failure, None,
			"a refusal on {surface:?} was stated in the drawer, which never sent it"
		);
	}
	let state = refused_on(HostActionKind::Attach, &SurfaceId::GlobalTitlebarLine, true);
	assert_eq!(state.drawer.failure, None, "the titlebar's own line is not the drawer's");
}

#[test]
fn a_refusal_the_operator_dismissed_leaves_the_drawer() {
	let surface = SurfaceId::ProcessSendButton(row(), "server".to_string());
	let (store, index) = seeded();
	let mut state = refused_on(HostActionKind::ProcessSend, &surface, true);
	assert!(state.drawer.failure.is_some(), "the refusal is stated before it is dismissed");

	// The dismissal path the row's own control takes: the error leaves the
	// control, and the next projection restates what is left.
	state.controls.clear_error(&surface);
	project_controls(&store, &RequestRegistry::new(), &index, &mut state);
	assert_eq!(
		state.drawer.failure, None,
		"the drawer held a failure the control no longer carries"
	);
}

#[test]
fn the_drawer_states_nothing_while_nothing_is_refused() {
	let (store, mut index) = seeded();
	let mut state = ShellState { current_id: 1, ..ShellState::default() };
	project(&store, &mut index, &HashMap::new(), NOW_MS, &mut state);
	project_controls(&store, &RequestRegistry::new(), &index, &mut state);
	assert_eq!(state.drawer.failure, None, "a drawer nothing refused states nothing");
	assert!(!state.drawer.tabs.is_empty(), "the drawer under test has tabs to draw");
}
