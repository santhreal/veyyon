//! WHY: a fan-out of one agent type drew rows nobody could tell apart. The
//! roster named an agent by the registry's label, which for a spawned agent is
//! the TYPE it was spawned from, so two `deep` subagents drew two rows reading
//! `deep (sub)` with identical controls beside them, and neither row named the
//! agent a person addresses.
//!
//! CLASS CLOSED: a roster row whose name is not the call sign, and a row whose
//! second phrase repeats what the name already said. The rows are read off the
//! drawn frame, so a name that never reaches a text run fails here. The
//! distinctness case derives its expectation from the roster it seeded rather
//! than from a written list, so a rule that folds two agents onto one phrase is
//! red whatever the roster holds.
//!
//! NOT CAUGHT: that the host assigns the call signs, which is
//! `packages/coding-agent/test/gui-host/
//! a-roster-row-is-named-the-same-in-both-hosts.test.ts`; and which controls a
//! row offers, which is
//! `the-agent-dashboard-offers-only-what-an-agent-can-answer.rs`.

use std::{collections::HashSet, path::Path};

use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_model::{AgentView, SessionId};
use veyyon_desktop_scene::{
	headless::{Captured, RenderOptions, headless_context},
	session::HeadlessSession,
};
use veyyon_desktop_surface::{
	AgentViewTab, AgentsState, Overlay, ShellState, ShellView,
	agents::live::{row_kind, row_name},
	fixture, install_tokens,
};
use veyyon_gpui::{App, AppContext};

const WIDTH: u32 = 1440;
const HEIGHT: u32 = 900;

/// An agent as the host sends it: the call sign a person reads, the type it was
/// spawned from, and the role it holds.
fn agent(call_sign: &str, spawned_from: &str, kind: &str) -> AgentView {
	AgentView {
		id:           format!("{call_sign}-id"),
		call_sign:    call_sign.to_owned(),
		display_name: spawned_from.to_owned(),
		kind:         kind.to_owned(),
		status:       "running".to_owned(),
		parent:       None,
		scope:        "session-1".to_owned(),
		session:      Some(SessionId::from("session-1")),
		activity:     None,
		model:        None,
	}
}

/// The frame the dashboard draws for `agents`, with `pending` asking to end
/// one.
fn roster_frame(agents: Vec<AgentView>, pending: Option<&str>) -> Captured {
	let mut dash = AgentsState::new();
	dash.active_tab = AgentViewTab::Live;
	dash.agents = agents;
	dash.pending_termination = pending.map(ToOwned::to_owned);
	let mut state: ShellState = fixture::populated();
	state.overlay = Some(Overlay::Agents(Box::new(dash)));

	let mut cx = headless_context().expect("headless context available");
	let tokens = load_bundled_tokens().expect("tokens load");
	let theme = load_bundled_theme("dark").expect("theme loads");
	let options =
		RenderOptions { width: WIDTH, height: HEIGHT, scale_factor: 1.0, ..RenderOptions::default() };
	let mut session = HeadlessSession::open(&mut cx, &options, move |_window, app: &mut App| {
		let installed = install_tokens(app, &tokens, &theme, Path::new("surface"))
			.expect("tokens and theme install");
		app.new(|_| ShellView::new(installed, state))
	})
	.expect("session opens");
	session.frame().expect("the dashboard renders")
}

/// The words the frame drew, trimmed, in the order it drew them.
fn words(captured: &Captured) -> Vec<String> {
	captured
		.text_runs
		.iter()
		.map(|run| run.text.as_ref().trim().to_owned())
		.filter(|text| !text.is_empty())
		.collect()
}

/// How many times the frame drew exactly `label`.
fn said_times(captured: &Captured, label: &str) -> usize {
	words(captured).iter().filter(|text| *text == label).count()
}

#[test]
fn every_agent_of_one_type_is_named_and_told_apart() {
	let roster: Vec<AgentView> = ["Kestrel", "Otter", "Juniper"]
		.into_iter()
		.map(|call_sign| agent(call_sign, "deep", "sub"))
		.collect();
	let captured = roster_frame(roster.clone(), None);

	// Derived from the roster, not written out: a rule that folds two agents
	// onto one phrase is red however many the host sent.
	let phrases: HashSet<String> = roster
		.iter()
		.map(|agent| format!("{} {}", row_name(agent), row_kind(agent)))
		.collect();
	assert_eq!(phrases.len(), roster.len(), "two rows of one type read the same: {phrases:?}");

	for agent in &roster {
		assert_eq!(
			said_times(&captured, &agent.call_sign),
			1,
			"the roster draws `{}` on its own row",
			agent.call_sign
		);
	}
	assert_eq!(
		said_times(&captured, "(sub · deep)"),
		roster.len(),
		"every spawned row states the role and the type it was spawned from"
	);
	assert_eq!(said_times(&captured, "deep"), 0, "the type is not a row's name");
}

#[test]
fn the_driving_agent_states_its_role_once() {
	let captured = roster_frame(vec![agent("Main", "main", "main")], None);

	assert_eq!(said_times(&captured, "Main"), 1, "the driving agent is drawn as `Main`");
	assert_eq!(said_times(&captured, "(main)"), 1, "its role is stated once");
	assert_eq!(said_times(&captured, "(main · main)"), 0, "and never twice over");
}

#[test]
fn a_row_the_host_sent_no_call_sign_for_is_still_named() {
	let mut nameless = agent("", "Reviewer", "advisor");
	nameless.id = "advisor-7".to_owned();
	let captured = roster_frame(vec![nameless.clone()], None);

	assert_eq!(row_name(&nameless), "Reviewer", "the row falls back to what the host did send");
	assert_eq!(said_times(&captured, "Reviewer"), 1, "and draws it");
	assert_eq!(said_times(&captured, "(advisor)"), 1, "with its role beside it");
	assert_eq!(said_times(&captured, "()"), 0, "an empty phrase is drawn nowhere");
}

#[test]
fn a_row_with_neither_call_sign_nor_label_is_named_by_its_id() {
	let bare = agent("", "", "");
	assert_eq!(row_name(&bare), "-id", "the id is the last name there is");
	assert_eq!(row_kind(&bare), "", "and nothing is stated beside it");
}

#[test]
fn ending_an_agent_asks_about_the_name_the_row_drew() {
	let one = agent("Kestrel", "deep", "sub");
	let captured = roster_frame(vec![one.clone()], Some(&one.id));

	assert_eq!(
		said_times(&captured, "Terminate agent Kestrel?"),
		1,
		"the confirmation names the agent the way the roster did"
	);
	assert_eq!(said_times(&captured, &format!("Terminate agent {}?", one.id)), 0);
}
