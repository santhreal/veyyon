//! The harness the agent dashboard suite draws through: a roster and a comms
//! stream built by hand, a headless shell that renders them, and the readers
//! that state what a frame said and what a press left behind.

use std::path::Path;

use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_model::{AgentMessageOutcome, AgentMessageView, AgentView, SessionId};
use veyyon_desktop_scene::{
	headless::{Captured, RenderOptions, headless_context},
	session::HeadlessSession,
};
use veyyon_desktop_surface::{
	AgentViewTab, AgentsState, Intent, Overlay, ShellState, ShellView, fixture, install_tokens,
};
use veyyon_gpui::{App, AppContext, Point, px};

pub const WIDTH: u32 = 1440;
pub const HEIGHT: u32 = 900;

/// The clock the shell holds while these frames are drawn, so every age the
/// comms view states is derived rather than read off the machine.
pub const NOW_MS: u64 = 1_000_000;

pub fn agent(id: &str, kind: &str, status: &str, session: Option<&str>) -> AgentView {
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

pub fn message(id: &str, outcome: AgentMessageOutcome, reply_to: Option<&str>) -> AgentMessageView {
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
pub fn dashboard(
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
pub fn driven<R>(
	state: ShellState,
	drive: impl FnOnce(&mut HeadlessSession<'_, ShellView>) -> R,
) -> R {
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
pub fn words(captured: &Captured) -> Vec<(f32, String)> {
	captured
		.text_runs
		.iter()
		.map(|run| (f32::from(run.bounds.origin.y), run.text.as_ref().trim().to_owned()))
		.filter(|(_, text)| !text.is_empty())
		.collect()
}

/// How many times the frame drew exactly `label`.
pub fn said_times(captured: &Captured, label: &str) -> usize {
	words(captured)
		.iter()
		.filter(|(_, text)| text == label)
		.count()
}

/// Whether the frame drew a run containing `fragment`.
pub fn mentioned(captured: &Captured, fragment: &str) -> bool {
	words(captured)
		.iter()
		.any(|(_, text)| text.contains(fragment))
}

/// Where the frame drew `label`, as the centre of the one run that is it.
pub fn drawn_word(captured: &Captured, label: &str) -> Point<f32> {
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
pub fn row_of(captured: &Captured, label: &str) -> f32 {
	words(captured)
		.into_iter()
		.find(|(_, text)| text == label)
		.map_or_else(|| panic!("the dashboard drew `{label}`"), |(y, _)| y)
}

/// The frame the dashboard draws for `state`.
pub fn frame_of(state: ShellState) -> Captured {
	driven(state, |session| session.frame().expect("the dashboard renders"))
}

/// What a press left behind: what the host was told, and the dashboard as the
/// press left it.
///
/// A control on this card lands in one column or the other. Opening a session
/// and reviving an agent are the host's to answer, so they are read off what
/// the window reported; moving between the two views and naming an agent for
/// termination are the window's own, reported to nobody, so they are read off
/// the dashboard the press changed. Reading only the reported column grades a
/// working local control as a dead one.
pub struct Pressed {
	pub reported: Vec<Intent>,
	pub agents:   AgentsState,
}

/// Presses `label` on the dashboard of `state` and hands back what it left.
pub fn press(state: ShellState, label: &str) -> Pressed {
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
			.update(|view, _window, _cx| {
				let reported = view.drain_intents();
				let Some(Overlay::Agents(agents)) = view.state().overlay.as_ref() else {
					panic!("the press leaves the dashboard open")
				};
				Pressed { reported, agents: (**agents).clone() }
			})
			.expect("read back what the press did")
	})
}
