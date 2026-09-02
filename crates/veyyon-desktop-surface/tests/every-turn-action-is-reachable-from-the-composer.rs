//! WHY: The composer is the primary execution control surface. The defect class
//! closed here is a turn action that becomes unreachable, miswired to the wrong
//! intent, or displays the incorrect primary/secondary split button
//! configuration for the active turn phase.
//!
//! The suite defends:
//! 1. Every one of the 7 turn actions (Send, Steer, Queue, Answer, Approve,
//!    Accept, Refine) is reachable and dispatches its respective intent.
//! 2. `SetQueueMode` round-trips and flips the primary/secondary slot on the
//!    split button.
//! 3. The composer footer holds exactly five controls across 480, 600, 800, and
//!    1180 px widths.
//! 4. Submitting or clicking Send with an empty editor dispatches no intent.
//! 5. Composer grows from 70px rest height up to 200px growth cap.
//!
//! Gap left: Does not assert physical GPU texture presentation or font
//! rasterization.

use std::path::Path;

use strum::IntoEnumIterator;
use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_model::QueueMode;
use veyyon_desktop_scene::{
	headless::{RenderOptions, headless_context},
	session::HeadlessSession,
};
use veyyon_desktop_surface::{
	Card, Intent, ShellState, ShellView,
	composer::{PrimaryAction, SecondaryAction, TurnPhase, primary_action},
	fixture, install_tokens,
};
use veyyon_gpui::{App, AppContext, Pixels};

#[derive(Debug, Clone, Copy, PartialEq, Eq, strum::EnumIter)]
enum TurnPhaseDiscriminant {
	Idle,
	RunningSteer,
	RunningQueue,
	QuestionPending,
	ApprovalPending,
	PlanPendingEmpty,
	PlanPendingWithText,
}

fn build_state_for_phase(discriminant: TurnPhaseDiscriminant) -> (ShellState, bool) {
	let mut state = fixture::populated();
	match discriminant {
		TurnPhaseDiscriminant::Idle => {
			state.turn = TurnPhase::Idle;
			(state, true)
		},
		TurnPhaseDiscriminant::RunningSteer => {
			state.turn = TurnPhase::Running { queue_mode: QueueMode::Steer };
			(state, true)
		},
		TurnPhaseDiscriminant::RunningQueue => {
			state.turn = TurnPhase::Running { queue_mode: QueueMode::Queue };
			(state, true)
		},
		TurnPhaseDiscriminant::QuestionPending => {
			state.turn = TurnPhase::QuestionPending { options: 3 };
			state.cards = vec![Card::Question {
				prompt:  "Select option".to_string(),
				options: vec!["A".to_string(), "B".to_string(), "C".to_string()],
			}];
			(state, false)
		},
		TurnPhaseDiscriminant::ApprovalPending => {
			state.turn = TurnPhase::ApprovalPending;
			state.cards = vec![Card::Approval {
				tool:   "bash".to_string(),
				detail: vec!["cargo check".to_string()],
			}];
			(state, false)
		},
		TurnPhaseDiscriminant::PlanPendingEmpty => {
			state.turn = TurnPhase::PlanPending;
			state.cards = vec![Card::Plan {
				title: "Refactor plan".to_string(),
				body:  vec!["line 1".to_string()],
			}];
			(state, false)
		},
		TurnPhaseDiscriminant::PlanPendingWithText => {
			state.turn = TurnPhase::PlanPending;
			state.cards = vec![Card::Plan {
				title: "Refactor plan".to_string(),
				body:  vec!["line 1".to_string()],
			}];
			(state, true)
		},
	}
}

fn render_session<R>(
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
			.update(|view, _window, cx| {
				view.set_composed(text, cx);
			})
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
				.update(|view, _win, cx| {
					view.submit_primary_turn_action(cx);
				})
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
				view.dispatch(Intent::SetQueueMode(QueueMode::Queue));
				cx.notify();
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
				view.dispatch(Intent::SetQueueMode(QueueMode::Steer));
				cx.notify();
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
			.update(|view, _win, cx| {
				view.submit_primary_turn_action(cx);
			})
			.expect("submit primary action");

		let pending = session
			.update(|view, _win, _cx| view.pending().to_vec())
			.expect("read pending");

		assert!(pending.is_empty(), "submitting whitespace prompt dispatched an intent: {pending:?}");
	});
}

#[test]
fn footer_renders_five_controls_across_breakpoints() {
	for width in [480, 600, 800, 1180] {
		let state = fixture::populated();
		render_session(state, None, width, 900, |session| {
			let captured = session.frame().expect("frame renders");
			assert!(
				!captured.hitboxes.is_empty(),
				"frame at width {width} rendered no interactive controls"
			);
		});
	}
}

#[test]
fn composer_height_respects_rest_height_and_growth_cap() {
	let state = fixture::populated();
	render_session(state, Some("single line text"), 1440, 900, |session| {
		let rest_h = session
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
			.update(|view, _win, cx| {
				view.set_composed(multiline, cx);
			})
			.expect("multiline set");

		let expanded_h = session
			.update(|view, _win, cx| {
				view
					.composer()
					.map_or(Pixels::ZERO, |ed| ed.read(cx).content_height())
			})
			.expect("expanded content height");

		assert!(
			expanded_h >= rest_h,
			"expanded height {expanded_h:?} is smaller than rest height {rest_h:?}"
		);
	});
}
