//! WHY: The composer is the primary execution control surface. The defect class
//! closed here is a turn action becoming unreachable, miswired to the wrong
//! intent, or displaying an incorrect primary action, stop control, or model
//! trigger for the active turn phase.
//!
//! The suite defends:
//! 1. Every one of the 7 turn actions (Send, Steer, Queue, Answer, Approve,
//!    Accept, Refine) is reachable and dispatches its respective intent.
//! 2. `SetQueueMode` round-trips and flips the primary action between Steer and
//!    Queue in running turns.
//! 3. The composer footer renders the integrated model trigger and up-arrow
//!    primary action across breakpoints, and presents the separate stop control
//!    only when running.
//! 4. Submitting or clicking Send with an empty editor dispatches no intent.
//! 5. Composer float height respects rest height (70px) and growth cap (200px)
//!    in layout bounds.
//!
//! Gap left: Does not assert physical GPU texture presentation or font
//! rasterization.

#[path = "support/composer-layout/mod.rs"]
mod composer_layout;
#[path = "support/composer-submission.rs"]
mod composer_submission;

use std::path::Path;

use composer_layout::{TurnPhaseDiscriminant, build_state_for_phase};
use strum::IntoEnumIterator;
use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_model::QueueMode;
use veyyon_desktop_scene::{
	headless::{RenderOptions, headless_context},
	session::HeadlessSession,
};
use veyyon_desktop_surface::{
	Intent, Overlay, PaletteMode, ShellState, ShellView,
	composer::{PrimaryAction, SecondaryAction, TurnPhase, primary_action},
	fixture, install_tokens,
};
use veyyon_gpui::{App, AppContext, Pixels, Point};

pub(crate) fn render_session<R>(
	state: ShellState,
	seed_text: Option<&str>,
	width: u32,
	height: u32,
	test: impl FnOnce(&mut HeadlessSession<ShellView>) -> R,
) -> R {
	let mut cx = headless_context().expect("headless context available");
	let tokens = load_bundled_tokens().expect("tokens load");
	let theme = load_bundled_theme("dark").expect("theme loads");
	let options = RenderOptions { width, height, scale_factor: 1.0, ..RenderOptions::default() };

	let mut session = HeadlessSession::open(&mut cx, &options, move |_window, app: &mut App| {
		let installed = install_tokens(app, &tokens, &theme, Path::new("surface"))
			.expect("tokens and theme install");

		app.new(|_| ShellView::new(installed, state))
	})
	.expect("session opens");

	if let Some(text) = seed_text {
		session
			.update(|view, _window, cx| view.set_composed(text, cx))
			.expect("composed text set");
	}

	test(&mut session)
}

#[test]
fn every_turn_action_is_reachable_and_dispatches_expected_intent() {
	for phase_kind in TurnPhaseDiscriminant::iter() {
		let (state, has_text) = build_state_for_phase(phase_kind);
		let seed_text = if has_text {
			Some("test instructions")
		} else {
			None
		};

		render_session(state, seed_text, 1440, 900, |session| {
			let (primary, secondary) = session
				.update(|view, _win, _cx| primary_action(&view.state().turn, view.has_composer_text()))
				.expect("primary action resolves");

			match phase_kind {
				TurnPhaseDiscriminant::Idle => {
					assert_eq!(primary, PrimaryAction::Send);
					assert_eq!(secondary, None);
				},
				TurnPhaseDiscriminant::RunningSteer => {
					assert_eq!(primary, PrimaryAction::Steer);
					assert_eq!(secondary, Some(SecondaryAction::Queue));
				},
				TurnPhaseDiscriminant::RunningQueue => {
					assert_eq!(primary, PrimaryAction::Queue);
					assert_eq!(secondary, Some(SecondaryAction::Steer));
				},
				TurnPhaseDiscriminant::QuestionPending => {
					assert_eq!(primary, PrimaryAction::Answer);
				},
				TurnPhaseDiscriminant::ApprovalPending => {
					assert_eq!(primary, PrimaryAction::Approve);
					assert_eq!(secondary, Some(SecondaryAction::ApprovalChoices));
				},
				TurnPhaseDiscriminant::PlanPendingEmpty => {
					assert_eq!(primary, PrimaryAction::Accept);
					assert_eq!(secondary, Some(SecondaryAction::AcceptInNewSession));
				},
				TurnPhaseDiscriminant::PlanPendingWithText => {
					assert_eq!(primary, PrimaryAction::Refine);
					assert_eq!(secondary, None);
				},
			}

			// Trigger primary submission
			session
				.update(|view, _win, cx| view.submit_primary_turn_action(cx))
				.expect("primary action submits");

			let intents = session
				.update(|view, _win, _cx| view.pending().to_vec())
				.expect("pending intents read");

			assert!(
				!intents.is_empty(),
				"phase {phase_kind:?} did not dispatch any intent on primary action submission"
			);

			match phase_kind {
				TurnPhaseDiscriminant::Idle => {
					assert!(matches!(
						intents.first(),
						Some(Intent::Send { text, attachments })
							if text == "test instructions" && attachments.is_empty()
					));
				},
				TurnPhaseDiscriminant::RunningSteer => {
					assert!(
						matches!(intents.first(), Some(Intent::Steer(t)) if t == "test instructions")
					);
				},
				TurnPhaseDiscriminant::RunningQueue => {
					assert!(
						matches!(intents.first(), Some(Intent::Queue(t)) if t == "test instructions")
					);
				},
				TurnPhaseDiscriminant::QuestionPending => {
					assert!(matches!(intents.first(), Some(Intent::Answer { card: 0, option: 0 })));
				},
				TurnPhaseDiscriminant::ApprovalPending => {
					assert!(matches!(
						intents.first(),
						Some(Intent::Approval { card: 0, approved: true, .. })
					));
				},
				TurnPhaseDiscriminant::PlanPendingEmpty => {
					assert!(matches!(intents.first(), Some(Intent::Plan { card: 0, accepted: true })));
				},
				TurnPhaseDiscriminant::PlanPendingWithText => {
					assert!(matches!(intents.first(), Some(Intent::Plan { card: 0, accepted: false })));
				},
			}
		});
	}
}

#[test]
fn set_queue_mode_round_trips_and_moves_primary_slot() {
	let mut state = fixture::populated();
	state.turn = TurnPhase::Running { queue_mode: QueueMode::Steer };

	render_session(state, Some("payload"), 1440, 900, |session| {
		// Initial state: Steer is primary
		let (p1, s1) = session
			.update(|view, _win, _cx| primary_action(&view.state().turn, view.has_composer_text()))
			.expect("action resolves");
		assert_eq!(p1, PrimaryAction::Steer);
		assert_eq!(s1, Some(SecondaryAction::Queue));

		// Dispatch SetQueueMode(Queue)
		session
			.update(|view, _win, cx| {
				view.dispatch(Intent::SetQueueMode(QueueMode::Queue), cx);
			})
			.expect("set queue mode dispatches");

		let (p2, s2) = session
			.update(|view, _win, _cx| primary_action(&view.state().turn, view.has_composer_text()))
			.expect("action resolves");
		assert_eq!(p2, PrimaryAction::Queue);
		assert_eq!(s2, Some(SecondaryAction::Steer));

		// Dispatch SetQueueMode(Steer)
		session
			.update(|view, _win, cx| {
				view.dispatch(Intent::SetQueueMode(QueueMode::Steer), cx);
			})
			.expect("set queue mode dispatches");

		let (p3, s3) = session
			.update(|view, _win, _cx| primary_action(&view.state().turn, view.has_composer_text()))
			.expect("action resolves");
		assert_eq!(p3, PrimaryAction::Steer);
		assert_eq!(s3, Some(SecondaryAction::Queue));
	});
}

#[test]
fn empty_send_dispatches_no_intent() {
	let mut state = fixture::populated();
	state.turn = TurnPhase::Idle;

	render_session(state, Some("   \t\n "), 1440, 900, |session| {
		session
			.update(|view, _win, cx| view.submit_primary_turn_action(cx))
			.expect("submit primary action");

		let pending = session
			.update(|view, _win, _cx| view.pending().to_vec())
			.expect("read pending");

		assert!(pending.is_empty(), "submitting whitespace prompt dispatched an intent: {pending:?}");
	});
}

#[test]
fn footer_renders_integrated_model_trigger_and_up_arrow_action_across_breakpoints() {
	for width in [480, 600, 800, 1180] {
		// 1. Idle state: model trigger and primary up-arrow action are reachable; stop
		//    is absent
		let mut state = fixture::populated();
		state.keymap.panel_collapsed = true;
		render_session(state, Some("test message"), width, 900, |session| {
			let (f_left, _f_top, f_right, f_bottom) =
				composer_layout::composer_float_bounds(session, width, 900);
			let captured = session.frame().expect("frame renders");

			let model_hitbox = composer_layout::find_model_trigger_hitbox(
				&captured.hitboxes,
				f_left,
				f_right,
				f_bottom,
			)
			.expect("model trigger hitbox must exist in footer");

			let primary_hitbox =
				composer_layout::find_primary_action_hitbox(&captured.hitboxes, f_right, f_bottom)
					.unwrap_or_else(|| {
						panic!(
							"primary action absent at width {width}; \
							 float=({f_left},{f_right},{f_bottom}); hitboxes={:?}",
							captured.hitboxes
						)
					});

			let stop_hitbox =
				composer_layout::find_stop_control_hitbox(&captured.hitboxes, f_right, f_bottom);
			assert!(stop_hitbox.is_none(), "separate stop button must not render when idle");

			// Clicking model trigger opens model picker overlay
			let model_click = Point {
				x: model_hitbox.origin.x + model_hitbox.size.width / 2.0,
				y: model_hitbox.origin.y + model_hitbox.size.height / 2.0,
			};
			session.click(model_click).expect("click model selector");
			session
				.update(|view, _window, cx| {
					assert!(
						matches!(
							view.state().overlay.as_ref().and_then(Overlay::as_palette),
							Some(palette) if palette.mode == PaletteMode::Models
						),
						"clicking model trigger at width {width} must open model picker overlay"
					);
					// Close the opened palette overlay before subsequent primary action click
					view.close_palette(cx);
				})
				.expect("overlay verified and closed");

			// Clicking primary action submits the composed draft
			let primary_click = Point {
				x: primary_hitbox.origin.x + primary_hitbox.size.width / 2.0,
				y: primary_hitbox.origin.y + primary_hitbox.size.height / 2.0,
			};
			session.click(primary_click).expect("click primary action");
			session
				.update(|view, _window, _cx| {
					assert!(
						matches!(
							view.pending().first(),
							Some(Intent::Send { text, .. }) if text == "test message"
						),
						"clicking primary action at width {width} must dispatch Send intent"
					);
				})
				.expect("send intent verified");
		});

		// 2. Running state: separate stop control is present and active
		let mut running_state = fixture::populated();
		running_state.keymap.panel_collapsed = true;
		running_state.turn = TurnPhase::Running { queue_mode: QueueMode::Steer };
		render_session(running_state, Some("test message"), width, 900, |session| {
			let (_f_left, _f_top, f_right, f_bottom) =
				composer_layout::composer_float_bounds(session, width, 900);
			let captured = session.frame().expect("frame renders");

			let stop_hitbox =
				composer_layout::find_stop_control_hitbox(&captured.hitboxes, f_right, f_bottom)
					.expect("stop control hitbox must render when turn is running");

			let stop_click = Point {
				x: stop_hitbox.origin.x + stop_hitbox.size.width / 2.0,
				y: stop_hitbox.origin.y + stop_hitbox.size.height / 2.0,
			};
			session.click(stop_click).expect("click stop control");
			session
				.update(|view, _window, _cx| {
					assert!(
						matches!(view.pending().first(), Some(Intent::AbortTurn)),
						"clicking stop control at width {width} must dispatch AbortTurn intent"
					);
				})
				.expect("abort intent verified");
		});
	}
}

#[test]
fn composer_height_respects_rest_height_and_growth_cap() {
	let tokens = load_bundled_tokens().expect("tokens load");
	let rest_cap = tokens.surface.composer.rest_height_px;
	let growth_cap = tokens.surface.composer.growth_cap_px;

	let state = fixture::populated();
	render_session(state, Some("single line text"), 1440, 900, |session| {
		let (_f_left, f_top_rest, _f_right, f_bottom_rest) =
			composer_layout::composer_float_bounds(session, 1440, 900);
		let rest_layout_h = f_bottom_rest - f_top_rest;

		assert!(
			rest_layout_h >= rest_cap - 1.0,
			"rest layout height {rest_layout_h} must be at least rest height {rest_cap}"
		);

		let rest_content_h = session
			.update(|view, _win, cx| {
				view
					.composer()
					.map_or(Pixels::ZERO, |ed| ed.read(cx).content_height())
			})
			.expect("rest content height");

		// Seed multiline text
		let multiline = (0..20)
			.map(|i| format!("line {i}: long text content expanding height"))
			.collect::<Vec<_>>()
			.join("\n");

		session
			.update(|view, _win, cx| view.set_composed(multiline, cx))
			.expect("multiline set");

		let (_f_left, f_top_exp, _f_right, f_bottom_exp) =
			composer_layout::composer_float_bounds(session, 1440, 900);
		let exp_layout_h = f_bottom_exp - f_top_exp;

		let exp_content_h = session
			.update(|view, _win, cx| {
				view
					.composer()
					.map_or(Pixels::ZERO, |ed| ed.read(cx).content_height())
			})
			.expect("expanded content height");

		assert!(
			exp_content_h > rest_content_h,
			"expanded content height {exp_content_h:?} should exceed rest content height \
			 {rest_content_h:?}"
		);
		assert!(
			exp_layout_h >= rest_layout_h,
			"expanded layout height {exp_layout_h} must be >= rest layout height {rest_layout_h}"
		);
		assert!(
			exp_layout_h <= growth_cap + 1.0,
			"expanded layout height {exp_layout_h} must not exceed growth cap {growth_cap}"
		);
	});
}
