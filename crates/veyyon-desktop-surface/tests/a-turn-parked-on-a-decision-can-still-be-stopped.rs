//! WHY: a turn waiting for an approval could not be stopped from the window at
//! all. The composer drew its stop control only while the phase was `Running`,
//! and the composer-scope chord checked the same thing before dispatching, so
//! the one state where an operator most needs the stop -- the agent parked on a
//! card, unable to proceed and unable to end -- offered neither the control nor
//! the keystroke. The card had to be answered to get out of it.
//!
//! CLASS CLOSED: a stop is offered for every phase that is not `Idle`. The
//! phase distinguishes what the primary arrow means (§5.4); it does not
//! distinguish whether a turn exists to stop. All three routes are pinned
//! here: the composer control the pointer reaches, the chord the keyboard
//! reaches, and the run bar's own `Stop`, which stated the word beside the
//! running turn and answered no click at all. Each sweeps every variant of
//! `TurnPhase`, with the expectation per variant coming from an exhaustive
//! `match`, so a new phase fails to compile until someone records whether it
//! is stoppable, and `Idle` carries the negative control on all three.
//!
//! GAPS: whether the host can act on the stop it receives is not this suite's
//! subject -- that is the coding-agent suites
//! `a-decision-a-turn-is-blocked-on-does-not-outlive-the-stop` and
//! `an-approval-nobody-answered-ends-with-the-turn`. The `/abort` palette row
//! reaches the same intent and is gated by capability rather than by phase, so
//! it is unaffected either way.

#[path = "support/composer-layout/mod.rs"]
mod composer_layout;

use std::path::Path;

use composer_layout::composer_float_bounds;
use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_model::{InteractionId, QueueMode};
use veyyon_desktop_scene::{
	headless::{Captured, RenderOptions, headless_context},
	session::HeadlessSession,
};
use veyyon_desktop_surface::{
	Intent, Keymap, ShellState, ShellView, composer::TurnPhase, fixture, install_tokens,
	resolve_chord,
};
use veyyon_gpui::{App, AppContext, Point, px};

const WIDTH: u32 = 1440;
const HEIGHT: u32 = 900;

/// The composer's action controls are 28px square (§5.4), so a footer control
/// is identified by that measure rather than by the order it was built in.
const CONTROL_PX: f32 = 28.0;

/// Every phase the composer can be in, and whether a stop has something to
/// reach in it.
///
/// The `match` is exhaustive on purpose: a new phase does not compile until it
/// is listed, which is what keeps this sweep from going stale in silence.
const fn stoppable(phase: &TurnPhase) -> bool {
	match phase {
		TurnPhase::Idle => false,
		TurnPhase::Running { .. }
		| TurnPhase::QuestionPending { .. }
		| TurnPhase::ApprovalPending { .. }
		| TurnPhase::PlanPending { .. } => true,
	}
}

fn every_phase() -> Vec<TurnPhase> {
	vec![
		TurnPhase::Idle,
		TurnPhase::Running { queue_mode: QueueMode::Steer },
		TurnPhase::Running { queue_mode: QueueMode::Queue },
		TurnPhase::QuestionPending { interaction: InteractionId::from("question-1"), options: 3 },
		TurnPhase::ApprovalPending { interaction: InteractionId::from("approval-1") },
		TurnPhase::PlanPending { interaction: InteractionId::from("plan-1") },
	]
}

fn state_in(phase: TurnPhase) -> ShellState {
	let mut state = fixture::populated();
	state.keymap.panel_collapsed = true;
	state.turn = phase;
	state
}

fn render_session<R>(
	state: ShellState,
	test: impl FnOnce(&mut HeadlessSession<ShellView>) -> R,
) -> R {
	let mut cx = headless_context().expect("headless context available");
	let tokens = load_bundled_tokens().expect("tokens load");
	let theme = load_bundled_theme("dark").expect("theme loads");
	let options =
		RenderOptions { width: WIDTH, height: HEIGHT, scale_factor: 1.0, ..RenderOptions::default() };

	let mut session = HeadlessSession::open(&mut cx, &options, move |_window, app: &mut App| {
		let installed = install_tokens(app, &tokens, &theme, Path::new("surface"))
			.expect("tokens and theme install");
		app.bind_keys(Keymap::default().bindings());
		veyyon_desktop_kit::input::ensure_editor_bindings_registered(app);
		app.new(|_| ShellView::new(installed, state))
	})
	.expect("session opens");

	test(&mut session)
}

/// The 28px controls in the composer's action row, left to right.
///
/// Bounded to the float's own band so a 28px control anywhere else on the
/// surface -- a rail row's mark, a titlebar button -- cannot be counted as one
/// of the composer's.
fn footer_controls(captured: &Captured, top: f32, bottom: f32) -> Vec<Point<f32>> {
	let mut found: Vec<Point<f32>> = captured
		.hitboxes
		.iter()
		.filter(|rect| {
			let y = f32::from(rect.origin.y);
			let w = f32::from(rect.size.width);
			let h = f32::from(rect.size.height);
			(w - CONTROL_PX).abs() < 1.0
				&& (h - CONTROL_PX).abs() < 1.0
				&& y >= top
				&& y + h <= bottom + 1.0
		})
		.map(|rect| Point {
			x: f32::from(rect.origin.x) + f32::from(rect.size.width) / 2.0,
			y: f32::from(rect.origin.y) + f32::from(rect.size.height) / 2.0,
		})
		.collect();
	found.sort_by(|a, b| a.x.total_cmp(&b.x));
	found
}

/// How many of the composer's action controls dispatch a stop, one fresh
/// session per click so no click can be answered by the state a previous one
/// left behind.
///
/// Counted by outcome rather than by position or by how many controls the row
/// happens to hold: the footer carries other 28px controls, and a test that
/// counted them would pass for the wrong reason the moment one is added.
fn stop_controls_in(phase: &TurnPhase) -> usize {
	let count = render_session(state_in(phase.clone()), |session| {
		let (_, top, _, bottom) = composer_float_bounds(session, WIDTH, HEIGHT);
		let captured = session.frame().expect("frame renders");
		footer_controls(&captured, top, bottom).len()
	});
	(0..count)
		.filter(|index| {
			let at = *index;
			let intents = render_session(state_in(phase.clone()), |session| {
				let (_, top, _, bottom) = composer_float_bounds(session, WIDTH, HEIGHT);
				let captured = session.frame().expect("frame renders");
				let control = footer_controls(&captured, top, bottom)[at];
				session
					.click(Point { x: px(control.x), y: px(control.y) })
					.expect("click a composer action control");
				session
					.update(|view, _window, _cx| view.drain_intents())
					.expect("drain intents")
			});
			intents.contains(&Intent::AbortTurn)
		})
		.count()
}

#[test]
fn the_composer_offers_one_stop_control_in_every_phase_but_idle() {
	for phase in every_phase() {
		let wanted = usize::from(stoppable(&phase));
		let label = format!("{phase:?}");

		assert_eq!(
			stop_controls_in(&phase),
			wanted,
			"{label} must offer {wanted} control(s) that stop the turn"
		);
	}
}

#[test]
fn the_stop_chord_reaches_a_turn_parked_on_a_decision_and_nothing_at_rest() {
	for phase in every_phase() {
		let expected = stoppable(&phase);
		let label = format!("{phase:?}");
		let (handled, intents) = render_session(state_in(phase), |session| {
			session
				.frame()
				.expect("the first frame focuses the composer");
			let handled = session
				.keystroke(&resolve_chord("primary-."))
				.expect("the chord dispatches");
			let intents = session
				.update(|view, _window, _cx| view.drain_intents())
				.expect("drain intents");
			(handled, intents)
		});

		if expected {
			assert!(handled, "{label} must handle the stop chord rather than typing it");
			assert_eq!(
				intents,
				vec![Intent::AbortTurn],
				"{label} must raise AbortTurn from the composer's stop chord"
			);
		} else {
			// At rest the chord is text, not a stop: the composer propagates it
			// so the editor receives the keystroke.
			assert!(
				!intents
					.iter()
					.any(|intent| matches!(intent, Intent::AbortTurn)),
				"{label} must not raise AbortTurn, because no turn is running"
			);
		}
	}
}

/// The hitboxes below the composer float, which is where the run bar sits.
///
/// Located by band rather than by id because a hitbox carries no id in a
/// captured frame, and read by outcome below so a hitbox that is not the stop
/// cannot be counted as one.
fn below_float_hitboxes(captured: &Captured, float_bottom: f32) -> Vec<Point<f32>> {
	let mut found: Vec<Point<f32>> = captured
		.hitboxes
		.iter()
		.filter(|rect| f32::from(rect.origin.y) >= float_bottom)
		.map(|rect| Point {
			x: f32::from(rect.origin.x) + f32::from(rect.size.width) / 2.0,
			y: f32::from(rect.origin.y) + f32::from(rect.size.height) / 2.0,
		})
		.collect();
	found.sort_by(|a, b| a.x.total_cmp(&b.x));
	found
}

/// How many controls in the run bar's band stop the turn, one fresh session per
/// click.
fn run_bar_stops_in(phase: &TurnPhase) -> usize {
	let count = render_session(state_in(phase.clone()), |session| {
		let (_, _, _, bottom) = composer_float_bounds(session, WIDTH, HEIGHT);
		let captured = session.frame().expect("frame renders");
		below_float_hitboxes(&captured, bottom).len()
	});
	(0..count)
		.filter(|index| {
			let at = *index;
			let intents = render_session(state_in(phase.clone()), |session| {
				let (_, _, _, bottom) = composer_float_bounds(session, WIDTH, HEIGHT);
				let captured = session.frame().expect("frame renders");
				let control = below_float_hitboxes(&captured, bottom)[at];
				session
					.click(Point { x: px(control.x), y: px(control.y) })
					.expect("click a run bar control");
				session
					.update(|view, _window, _cx| view.drain_intents())
					.expect("drain intents")
			});
			intents.contains(&Intent::AbortTurn)
		})
		.count()
}

#[test]
fn the_run_bar_states_a_stop_only_when_it_is_one() {
	for phase in every_phase() {
		let wanted = usize::from(stoppable(&phase));
		let label = format!("{phase:?}");

		assert_eq!(
			run_bar_stops_in(&phase),
			wanted,
			"{label} must offer {wanted} run bar control(s) that stop the turn"
		);
	}
}
