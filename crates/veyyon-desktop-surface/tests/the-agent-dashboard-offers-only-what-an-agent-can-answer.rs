//! WHY: `/agents` opened the extensions page, so the roster the host sends was
//! drawn nowhere and the traffic between agents was drawn nowhere at all. The
//! dashboard that replaces it draws controls per row, and a control drawn on a
//! row the host cannot answer is a press that can only come back refused: the
//! main agent is not a row of the task runner, so `CancelTask` cannot end it,
//! and an agent holding no session has nothing to open.
//!
//! CLASS CLOSED: the frame is read for the words each view draws and the
//! presses are the drawn words rather than a dispatch, so a control wired to
//! nothing fails here. Which rows offer which control is asserted over a
//! roster carrying every combination that reaches the surface -- main, running
//! task, stopped task, session and no session -- and the comms view is
//! asserted over every `AgentMessageOutcome` the model carries, swept through
//! `strum::IntoEnumIterator` so a fifth outcome is red until it states how it
//! draws.
//!
//! NOT CAUGHT: which states count as mid-turn and what each one is tinted,
//! which is `a-roster-states-the-state-a-surface-names.rs`; whether the host
//! answers `CancelTask` or `RefreshAgents`, which
//! is the gui-host's own suite; that the roster is scoped to the conversation,
//! which is
//! `the-agent-roster-and-comms-stream-reach-the-desktop-scoped-and-live.test.
//! ts`; and that each authored measure reaches a pixel, which is the scene
//! crate's `a-floating-overlay-surface-draws-every-measure-it-authors.rs`.

use std::path::Path;

use strum::IntoEnumIterator;
use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_model::{
	AgentMessageOutcome, AgentMessageView, AgentView, SessionId, SurfaceId,
};
use veyyon_desktop_scene::{
	headless::{Captured, RenderOptions, headless_context},
	session::HeadlessSession,
};
use veyyon_desktop_surface::{
	AgentViewTab, AgentsState, Intent, Overlay, ShellState, ShellView, agents::comms::outcome_badge,
	fixture, install_tokens,
};
use veyyon_gpui::{App, AppContext, Point, px};

const WIDTH: u32 = 1440;
const HEIGHT: u32 = 900;

/// The clock the shell holds while these frames are drawn, so every age the
/// comms view states is derived rather than read off the machine.
const NOW_MS: u64 = 1_000_000;

fn agent(id: &str, kind: &str, status: &str, session: Option<&str>) -> AgentView {
	AgentView {
		id:           id.to_owned(),
		call_sign:    id.to_owned(),
		display_name: id.to_owned(),
		kind:         kind.to_owned(),
		status:       status.to_owned(),
		parent:       None,
		scope:        "session-1".to_owned(),
		session:      session.map(SessionId::from),
		activity:     Some(format!("{id} is at work")),
		model:        Some("anthropic/claude".to_owned()),
	}
}

fn message(id: &str, outcome: AgentMessageOutcome, reply_to: Option<&str>) -> AgentMessageView {
	AgentMessageView {
		id: id.to_owned(),
		from: "Alpha".to_owned(),
		to: "Beta".to_owned(),
		body: format!("body of {id}"),
		at_ms: NOW_MS - 60_000,
		reply_to: reply_to.map(ToOwned::to_owned),
		outcome,
		error: match outcome {
			AgentMessageOutcome::Failed => Some("the recipient was gone".to_owned()),
			AgentMessageOutcome::Injected
			| AgentMessageOutcome::Woken
			| AgentMessageOutcome::Revived => None,
		},
	}
}

/// The window with the dashboard open on `tab`, holding `agents` and `comms`.
fn dashboard(
	tab: AgentViewTab,
	agents: Vec<AgentView>,
	comms: Vec<AgentMessageView>,
) -> ShellState {
	let mut dash = AgentsState::new();
	dash.active_tab = tab;
	dash.agents = agents;
	dash.agent_comms = comms;
	let mut state = fixture::populated();
	state.overlay = Some(Overlay::Agents(Box::new(dash)));
	state
}

/// Opens a window on `state` and runs `drive`.
fn driven<R>(state: ShellState, drive: impl FnOnce(&mut HeadlessSession<'_, ShellView>) -> R) -> R {
	let mut cx = headless_context().expect("headless context available");
	let tokens = load_bundled_tokens().expect("tokens load");
	let theme = load_bundled_theme("dark").expect("theme loads");
	let options =
		RenderOptions { width: WIDTH, height: HEIGHT, scale_factor: 1.0, ..RenderOptions::default() };

	let mut session = HeadlessSession::open(&mut cx, &options, move |_window, app: &mut App| {
		let installed = install_tokens(app, &tokens, &theme, Path::new("surface"))
			.expect("tokens and theme install");
		app.new(|_| {
			let mut view = ShellView::new(installed, state);
			view.set_clock_ms(NOW_MS);
			view
		})
	})
	.expect("session opens");
	drive(&mut session)
}

/// The words the frame drew, top to bottom, with the row each sits on.
fn words(captured: &Captured) -> Vec<(f32, String)> {
	captured
		.text_runs
		.iter()
		.map(|run| (f32::from(run.bounds.origin.y), run.text.as_ref().trim().to_owned()))
		.filter(|(_, text)| !text.is_empty())
		.collect()
}

/// How many times the frame drew exactly `label`.
fn said_times(captured: &Captured, label: &str) -> usize {
	words(captured)
		.iter()
		.filter(|(_, text)| text == label)
		.count()
}

/// Whether the frame drew a run containing `fragment`.
fn mentioned(captured: &Captured, fragment: &str) -> bool {
	words(captured)
		.iter()
		.any(|(_, text)| text.contains(fragment))
}

/// Where the frame drew `label`, as the centre of the one run that is it.
fn drawn_word(captured: &Captured, label: &str) -> Point<f32> {
	let runs: Vec<Point<f32>> = captured
		.text_runs
		.iter()
		.filter(|run| run.text.as_ref().trim() == label)
		.map(|run| Point {
			x: f32::from(run.bounds.origin.x) + f32::from(run.bounds.size.width) / 2.0,
			y: f32::from(run.bounds.origin.y) + f32::from(run.bounds.size.height) / 2.0,
		})
		.collect();
	assert_eq!(runs.len(), 1, "the dashboard draws `{label}` exactly once, drew {}", runs.len());
	runs[0]
}

/// The top of the one run whose text is `label`.
fn row_of(captured: &Captured, label: &str) -> f32 {
	words(captured)
		.into_iter()
		.find(|(_, text)| text == label)
		.map_or_else(|| panic!("the dashboard drew `{label}`"), |(y, _)| y)
}

/// The frame the dashboard draws for `state`.
fn frame_of(state: ShellState) -> Captured {
	driven(state, |session| session.frame().expect("the dashboard renders"))
}

/// Presses `label` on the dashboard of `state` and hands back what it raised.
fn press(state: ShellState, label: &str) -> Vec<Intent> {
	let label = label.to_owned();
	driven(state, |session| {
		let captured = session.frame().expect("the dashboard renders");
		session
			.update(|view, _window, _cx| view.drain_intents())
			.expect("the opening frame's intents are dropped");
		let at = drawn_word(&captured, &label);
		session
			.click(Point { x: px(at.x), y: px(at.y) })
			.expect("press the drawn control");
		session
			.update(|view, _window, _cx| view.drain_intents())
			.expect("read back what the press did")
	})
}

#[test]
fn a_running_agent_is_drawn_above_one_that_is_not() {
	let captured = frame_of(dashboard(
		AgentViewTab::Live,
		vec![
			agent("parked-first", "sub", "parked", Some("s-1")),
			agent("running-last", "sub", "running", Some("s-2")),
			agent("parked-second", "sub", "idle", Some("s-3")),
		],
		Vec::new(),
	));

	let running = row_of(&captured, "running-last");
	assert!(
		running < row_of(&captured, "parked-first"),
		"the running agent draws above the first parked one"
	);
	assert!(
		running < row_of(&captured, "parked-second"),
		"the running agent draws above the second parked one"
	);
	assert!(
		row_of(&captured, "parked-first") < row_of(&captured, "parked-second"),
		"two agents that are not running keep the order the host sent"
	);
}

#[test]
fn an_agent_holding_no_session_offers_nothing_to_open() {
	let roster = vec![
		agent("with-session", "sub", "running", Some("session-7")),
		agent("without-session", "sub", "running", None),
	];
	let captured = frame_of(dashboard(AgentViewTab::Live, roster.clone(), Vec::new()));

	assert_eq!(
		said_times(&captured, "Open"),
		1,
		"only the agent holding a session offers to open it"
	);
	assert_eq!(
		press(dashboard(AgentViewTab::Live, roster, Vec::new()), "Open"),
		vec![Intent::OpenSession(SessionId::from("session-7"))],
		"the open control carries the session of the row it sits on"
	);
}

#[test]
fn only_an_agent_the_host_can_end_offers_to_be_ended() {
	let roster = vec![
		agent("the-main-agent", "main", "running", Some("session-1")),
		agent("a-stopped-agent", "sub", "parked", Some("session-2")),
		agent("a-running-agent", "sub", "running", Some("session-3")),
	];
	let captured = frame_of(dashboard(AgentViewTab::Live, roster.clone(), Vec::new()));

	assert_eq!(
		said_times(&captured, "Terminate"),
		1,
		"neither the driving agent nor one that already stopped offers a control CancelTask cannot \
		 answer"
	);
	assert_eq!(
		press(dashboard(AgentViewTab::Live, roster, Vec::new()), "Terminate"),
		vec![Intent::ConfirmTermination(Some("a-running-agent".to_owned()))],
		"the control that ends an agent carries that agent's own id"
	);
}

#[test]
fn a_parked_agent_offers_the_one_control_that_brings_it_back() {
	// A parked agent holds no session, so Open is not drawn on it: before Revive
	// was drawn here the row carried no control at all and the transcript on
	// disk was reachable from nowhere on this surface.
	let roster = vec![
		agent("a-parked-agent", "sub", "parked", None),
		agent("a-running-agent", "sub", "running", Some("session-3")),
	];
	let captured = frame_of(dashboard(AgentViewTab::Live, roster.clone(), Vec::new()));

	assert_eq!(
		said_times(&captured, "Revive"),
		1,
		"the control is drawn on the parked row and on no other"
	);
	assert_eq!(
		press(dashboard(AgentViewTab::Live, roster, Vec::new()), "Revive"),
		vec![Intent::RetryControl(SurfaceId::AgentReviveButton("a-parked-agent".to_owned()))],
		"the control that brings an agent back carries that agent's own id"
	);
}

#[test]
fn a_reply_states_what_it_answers_and_a_failure_states_why() {
	let captured = frame_of(dashboard(AgentViewTab::Comms, Vec::new(), vec![
		message("m-1", AgentMessageOutcome::Injected, None),
		message("m-2", AgentMessageOutcome::Injected, Some("m-1")),
		message("m-3", AgentMessageOutcome::Failed, None),
	]));

	assert_eq!(
		said_times(&captured, "re: m-1"),
		1,
		"the line answering another states which one, and the first line states nothing"
	);
	assert_eq!(
		said_times(&captured, "failed"),
		1,
		"the line that never landed says so, and the two that landed say nothing"
	);
	assert!(
		mentioned(&captured, "the recipient was gone"),
		"a failed line states the reason it failed"
	);
	assert!(mentioned(&captured, "1m 0s ago"), "a line states how long ago it landed");
}

#[test]
fn every_outcome_states_how_it_landed_or_states_nothing() {
	let drawn: Vec<(AgentMessageOutcome, Option<&'static str>)> = AgentMessageOutcome::iter()
		.map(|outcome| (outcome, outcome_badge(outcome).map(|(word, _)| word)))
		.collect();

	assert_eq!(
		drawn,
		vec![
			(AgentMessageOutcome::Injected, None),
			(AgentMessageOutcome::Woken, Some("woken")),
			(AgentMessageOutcome::Revived, Some("revived")),
			(AgentMessageOutcome::Failed, Some("failed")),
		],
		"every outcome the model carries states how it landed, and the ordinary one states nothing; \
		 a new outcome is red here until it decides"
	);

	for outcome in AgentMessageOutcome::iter() {
		let captured =
			frame_of(dashboard(AgentViewTab::Comms, Vec::new(), vec![message("m-1", outcome, None)]));
		match outcome_badge(outcome) {
			Some((word, _)) => assert_eq!(
				said_times(&captured, word),
				1,
				"the comms view draws `{word}` for {outcome:?}"
			),
			None => assert!(
				mentioned(&captured, "body of m-1"),
				"an ordinary delivery draws its body and no badge"
			),
		}
	}
}

#[test]
fn an_empty_roster_and_an_empty_stream_each_state_their_condition() {
	let roster = frame_of(dashboard(AgentViewTab::Live, Vec::new(), Vec::new()));
	assert!(
		mentioned(&roster, "No agent is running in this session"),
		"an empty roster states that nothing is running"
	);
	assert!(
		mentioned(&roster, "it appears here the moment it starts"),
		"an empty roster states what fills it"
	);

	let stream = frame_of(dashboard(AgentViewTab::Comms, Vec::new(), Vec::new()));
	assert!(
		mentioned(&stream, "No agent has spoken"),
		"an empty stream states that nothing has been said"
	);
	assert!(mentioned(&stream, "every line lands here"), "an empty stream states what fills it");
}

#[test]
fn each_view_states_how_much_it_holds_and_the_other_one_opens_on_a_press() {
	let roster = vec![agent("a-running-agent", "sub", "running", Some("session-3"))];
	let comms = vec![
		message("m-1", AgentMessageOutcome::Injected, None),
		message("m-2", AgentMessageOutcome::Injected, None),
	];
	let captured = frame_of(dashboard(AgentViewTab::Live, roster.clone(), comms.clone()));

	assert_eq!(
		said_times(&captured, "Live (1)"),
		1,
		"the view in front states how many agents it lists"
	);
	assert_eq!(
		said_times(&captured, "Comms (2)"),
		1,
		"the view behind states how many lines it holds before it is opened"
	);
	assert_eq!(
		press(dashboard(AgentViewTab::Live, roster.clone(), comms.clone()), "Comms (2)"),
		vec![Intent::SetAgentsTab(AgentViewTab::Comms)],
		"pressing the stream opens the stream"
	);
	assert_eq!(
		press(dashboard(AgentViewTab::Comms, roster, comms), "Live (1)"),
		vec![Intent::SetAgentsTab(AgentViewTab::Live)],
		"pressing the roster from the stream opens the roster"
	);
}
