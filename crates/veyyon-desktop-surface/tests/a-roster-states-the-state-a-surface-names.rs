//! WHY: the roster read a status word out of a table of words no host sends.
//! An agent stopped at an approval prompt drew as one grinding through a
//! build; the control that ends an agent was offered on `kind == "task"`, a
//! kind the registry has never had, so it was drawn on nothing and the window
//! could end no agent at all; and the extensions page offered `Revive` on
//! `error` and `failed`, words no host sends either, which had they arrived
//! would have named `aborted` -- the one state a revive always refuses.
//!
//! CLASS CLOSED: a control or a tint decided by guessing at the state word.
//! Every rule here reads `AgentState`, the states are swept from
//! `AgentState::iter()` rather than from a list written here, and each rule is
//! asserted over the whole sweep, so a state added to the protocol turns this
//! red until it is given a decision.
//!
//! NOT CAUGHT: that the host derives these states, which is
//! `packages/coding-agent/test/gui-host/
//! a-roster-states-what-an-agent-is-waiting-on.test.ts`; and which controls a
//! row draws once the availability of each is known,
//! which is `the-agent-dashboard-offers-only-what-an-agent-can-answer.rs`.

use strum::IntoEnumIterator;
use veyyon_desktop_kit::TintRole;
use veyyon_desktop_model::{AgentState, AgentView, SessionId};
use veyyon_desktop_surface::agents::live::{can_revive, can_terminate, roster_order, status_tint};

/// The kinds the registry carries, which are the kinds a host sends.
const KINDS: [&str; 3] = ["main", "sub", "advisor"];

/// The word a host sends for each state, which is the lowercase name.
fn word(state: AgentState) -> String {
	format!("{state:?}").to_lowercase()
}

/// Every state a host can send: the sweep excludes `Unknown`, which is what
/// this build calls a word it has never heard of rather than a word a host
/// sends.
fn sent_states() -> Vec<AgentState> {
	AgentState::iter()
		.filter(|state| *state != AgentState::Unknown)
		.collect()
}

fn agent(id: &str, kind: &str, status: &str) -> AgentView {
	AgentView {
		id:           id.to_owned(),
		call_sign:    id.to_owned(),
		display_name: "deep".to_owned(),
		kind:         kind.to_owned(),
		status:       status.to_owned(),
		parent:       None,
		scope:        "session-1".to_owned(),
		session:      Some(SessionId::from("session-1")),
		activity:     None,
		model:        None,
	}
}

#[test]
fn the_control_that_ends_an_agent_is_offered_on_one_the_host_can_end() {
	for kind in KINDS {
		for state in sent_states() {
			let row = agent("row", kind, &word(state));
			assert_eq!(
				can_terminate(&row),
				kind != "main" && state.is_mid_turn(),
				"a {state:?} {kind} agent"
			);
		}
	}
	assert!(
		sent_states().iter().any(|state| state.is_mid_turn()),
		"a sweep in which nothing is mid-turn would pass the assertion above while offering the \
		 control on nothing, which is the defect"
	);
}

#[test]
fn the_control_that_revives_an_agent_is_offered_on_the_one_state_it_works_on() {
	for kind in KINDS {
		for state in sent_states() {
			let row = agent("row", kind, &word(state));
			assert_eq!(can_revive(&row), state == AgentState::Parked, "a {state:?} {kind} agent");
		}
	}
	assert!(
		!can_revive(&agent("row", "sub", "aborted")),
		"an aborted agent is terminal: the host refuses the revive, so the control is not drawn"
	);
}

#[test]
fn an_agent_stopped_at_an_approval_is_ordered_as_one_that_is_working() {
	let ordered = roster_order(&[
		agent("parked", "sub", "parked"),
		agent("blocked", "sub", "blocked"),
		agent("waiting", "sub", "waiting"),
		agent("running", "sub", "running"),
	]);

	assert_eq!(
		ordered
			.iter()
			.map(|agent| agent.id.as_str())
			.collect::<Vec<_>>(),
		vec!["blocked", "running", "parked", "waiting"],
		"the agents in a turn draw above the ones that are not, each group in the order the host \
		 sent"
	);
}

#[test]
fn every_state_the_host_names_takes_a_tint_of_its_own_meaning() {
	let tints: Vec<(AgentState, TintRole)> = AgentState::iter()
		.map(|state| (state, status_tint(&word(state))))
		.collect();

	assert_eq!(
		tints,
		vec![
			// In a turn.
			(AgentState::Running, TintRole::Working),
			// Stopped at an approval prompt, which is a person's to answer.
			(AgentState::Blocked, TintRole::Approve),
			// Live and finished, waiting for work.
			(AgentState::Idle, TintRole::Done),
			// Stopped on a peer that may never answer.
			(AgentState::Waiting, TintRole::Due),
			// The session is disposed and the agent is revivable.
			(AgentState::Parked, TintRole::Plan),
			// Hard-killed, and terminal.
			(AgentState::Aborted, TintRole::Error),
			// A word this build does not know claims nothing.
			(AgentState::Unknown, TintRole::Plan),
		],
		"a state added to the protocol decides its tint here rather than arriving as Unknown"
	);
}

#[test]
fn a_state_the_roster_has_never_heard_of_is_read_as_unknown() {
	// A host on a newer protocol names a state this build does not know. The row
	// still draws, offering neither control and claiming nothing in its tint.
	for status in ["quiescing", "", "task", "active", "failed", "error"] {
		let row = agent("row", "sub", status);
		assert_eq!(row.state(), AgentState::Unknown, "`{status}` is not a state a host sends");
		assert!(!can_terminate(&row), "`{status}`");
		assert!(!can_revive(&row), "`{status}`");
		assert_eq!(status_tint(status), TintRole::Plan, "`{status}`");
	}
}

#[test]
fn a_state_is_read_however_the_host_cased_it() {
	for state in sent_states() {
		let cased = word(state).to_uppercase();
		assert_eq!(AgentState::from(cased.as_str()), state, "`{cased}` is the same state");
		assert_eq!(status_tint(&cased), status_tint(&word(state)), "`{cased}` takes one tint");
	}
	assert!(can_terminate(&agent("row", "sub", "RUNNING")), "a cased state still ends an agent");
}
