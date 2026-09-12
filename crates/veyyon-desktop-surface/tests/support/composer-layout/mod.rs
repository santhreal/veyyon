//! Helper utilities for asserting composer layout geometry, turn state
//! fixtures, and footer hitboxes across conversational phases and breakpoints.
//!
//! Several test binaries include this module and each uses a subset of it, so
//! an unused helper here is a helper another suite calls.
#![allow(dead_code, reason = "each including suite calls a subset of these helpers")]

use std::path::Path;

use veyyon_desktop_kit::{SpacingStep, load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_model::{InteractionId, QueueMode, SessionId, SurfaceId};
use veyyon_desktop_scene::{
	headless::{RenderOptions, headless_context},
	session::HeadlessSession,
};
use veyyon_desktop_surface::{
	Availability, Card, Keymap, ShellState, ShellView,
	composer::TurnPhase,
	fixture, install_tokens,
	layout::{ShedInput, shell_widths},
};
use veyyon_gpui::{App, AppContext, Bounds, Pixels};

/// What the projection marks the composer's answer with while the open
/// question offers options, which is what the window reads before it sends
/// one. Kept as the reason's own words rather than the desktop crate's
/// constant, which a surface suite cannot import, so a suite fails if the two
/// stop agreeing about the control being unavailable at all.
pub const ANSWERED_BY_OPTION: &str = "choose one of the options";

/// Marks the composer's answer with what the projection states for the phase
/// the state is in, which is what the window reads before it sends an answer.
pub fn seed_answer_availability(session: &mut HeadlessSession<ShellView>) {
	session
		.update(|view, _window, _cx| {
			let TurnPhase::QuestionPending { interaction, options } = view.state().turn.clone() else {
				return;
			};
			if options == 0 {
				return;
			}
			let session_id = SessionId::from(view.state().current_id.to_string());
			let id = SurfaceId::QuestionSubmitButton(session_id, interaction);
			view
				.state_mut()
				.controls
				.set_availability(id, Availability::Unavailable {
					reason: ANSWERED_BY_OPTION.to_owned(),
				});
		})
		.expect("the view is live");
}

/// Opens a headless shell window on the bundled tokens and dark theme at the
/// given size, optionally seeding composed text, and runs `test` against the
/// live session.
///
/// No keymap is bound, so a chord reaches nothing: a suite that presses one
/// calls [`render_session_with_keys`] instead.
pub fn render_session<R>(
	state: ShellState,
	seed_text: Option<&str>,
	width: u32,
	height: u32,
	test: impl FnOnce(&mut HeadlessSession<ShellView>) -> R,
) -> R {
	open_shell(state, seed_text, width, height, false, test)
}

/// The same window with the default keymap bound, for a suite whose gesture is
/// a keystroke rather than a pointer press.
pub fn render_session_with_keys<R>(
	state: ShellState,
	seed_text: Option<&str>,
	width: u32,
	height: u32,
	test: impl FnOnce(&mut HeadlessSession<ShellView>) -> R,
) -> R {
	open_shell(state, seed_text, width, height, true, test)
}

fn open_shell<R>(
	state: ShellState,
	seed_text: Option<&str>,
	width: u32,
	height: u32,
	bind_keys: bool,
	test: impl FnOnce(&mut HeadlessSession<ShellView>) -> R,
) -> R {
	let mut cx = headless_context().expect("headless context available");
	let tokens = load_bundled_tokens().expect("tokens load");
	let theme = load_bundled_theme("dark").expect("theme loads");
	let options = RenderOptions { width, height, scale_factor: 1.0, ..RenderOptions::default() };

	let mut session = HeadlessSession::open(&mut cx, &options, move |_window, app: &mut App| {
		let installed = install_tokens(app, &tokens, &theme, Path::new("surface"))
			.expect("tokens and theme install");
		if bind_keys {
			app.bind_keys(Keymap::default().bindings());
		}

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

/// Turn phase variant discriminant for sweeping every fundamental turn action.
///
/// A question appears twice, because the shape it is answered with decides
/// what the composer's primary action can do: a question that offers options
/// is answered by the index of one of them, from its card, and a question
/// that offers none is answered by the composer's own text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, strum::EnumIter)]
pub enum TurnPhaseDiscriminant {
	Idle,
	RunningSteer,
	RunningQueue,
	QuestionPendingChoice,
	QuestionPendingFreeText,
	ApprovalPending,
	PlanPendingEmpty,
	PlanPendingWithText,
}

/// Builds the test `ShellState` and text requirement for a turn phase
/// discriminant.
pub fn build_state_for_phase(discriminant: TurnPhaseDiscriminant) -> (ShellState, bool) {
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
		TurnPhaseDiscriminant::QuestionPendingChoice => {
			state.turn =
				TurnPhase::QuestionPending { interaction: InteractionId::from("q"), options: 3 };
			state.cards = vec![Card::Question {
				prompt:  "Select option".to_string(),
				options: vec!["A".to_string(), "B".to_string(), "C".to_string()],
			}];
			(state, false)
		},
		TurnPhaseDiscriminant::QuestionPendingFreeText => {
			state.turn =
				TurnPhase::QuestionPending { interaction: InteractionId::from("q"), options: 0 };
			state.cards =
				vec![Card::Question { prompt: "Name the branch".to_string(), options: Vec::new() }];
			(state, true)
		},
		TurnPhaseDiscriminant::ApprovalPending => {
			state.turn = TurnPhase::ApprovalPending { interaction: InteractionId::from("a") };
			state.cards = vec![Card::Approval {
				tool:   "bash".to_string(),
				detail: vec!["cargo check".to_string()],
			}];
			(state, false)
		},
		TurnPhaseDiscriminant::PlanPendingEmpty => {
			state.turn = TurnPhase::PlanPending { interaction: InteractionId::from("p") };
			state.cards = vec![Card::Plan {
				title: "Refactor plan".to_string(),
				body:  vec!["line 1".to_string()],
			}];
			(state, false)
		},
		TurnPhaseDiscriminant::PlanPendingWithText => {
			state.turn = TurnPhase::PlanPending { interaction: InteractionId::from("p") };
			state.cards = vec![Card::Plan {
				title: "Refactor plan".to_string(),
				body:  vec!["line 1".to_string()],
			}];
			(state, true)
		},
	}
}

/// Resolves the expected composer float bounds `(left, top, right, bottom)`
/// from the rendered layout box tree, anchoring on the float's border, fill,
/// width, and height constraints derived dynamically from the view.
pub fn composer_float_bounds(
	session: &mut HeadlessSession<ShellView>,
	width: u32,
	height: u32,
) -> (f32, f32, f32, f32) {
	let (expected_w, min_h, max_h) = session
		.update(|view, _window, _cx| {
			assert!(!view.has_notice(), "layout fixture has no attention strip");
			let chrome_px = view.installed().surface.shell.titlebar_height_px;
			let keymap = &view.state().keymap;
			let panel_available = !view.state().panel.is_empty();
			let widths = shell_widths(
				ShedInput {
					viewport_px:        width as f32,
					viewport_height_px: height as f32,
					chrome_height_px:   chrome_px,
					gutter_px:          f32::from(view.installed().set.spacing(SpacingStep::S4)),
					queue_collapsed:    keymap.queue_collapsed,
					queue_float_open:   false,
					panel_open:         panel_available && !keymap.panel_collapsed,
					panel_width:        view.panel_width(),
					labels:             view.labels(),
				},
				&view.installed().surface,
			);
			let min_h = view.installed().surface.composer.rest_height_px - 1.0;
			let max_h = view.installed().surface.composer.growth_cap_px + 2.0;
			(widths.composer_px, min_h, max_h)
		})
		.expect("widths resolved from view");

	let captured = session.frame().expect("frame renders");
	let float_box = captured
		.layout
		.iter()
		.filter(|b| {
			b.visible
				&& (b.bounds.width() - expected_w).abs() <= 2.0
				&& b.bounds.height() >= min_h
				&& b.bounds.height() <= max_h
				&& b.bounds.bottom >= (height as f32) * 0.7
				&& b.border.is_some()
				&& b.fill.is_some()
		})
		.max_by(|a, b| a.bounds.bottom.total_cmp(&b.bounds.bottom))
		.expect("composer-float layout box with border and fill exists in frame");

	(float_box.bounds.left, float_box.bounds.top, float_box.bounds.right, float_box.bounds.bottom)
}

/// Locates the integrated model selector trigger hitbox in the composer footer.
pub fn find_model_trigger_hitbox(
	hitboxes: &[Bounds<Pixels>],
	f_left: f32,
	f_right: f32,
	f_bottom: f32,
) -> Option<Bounds<Pixels>> {
	hitboxes
		.iter()
		.find(|rect| {
			let y = f32::from(rect.origin.y);
			let h = f32::from(rect.size.height);
			let x = f32::from(rect.origin.x);
			let w = f32::from(rect.size.width);
			y >= f_bottom - 50.0
				&& y <= f_bottom
				&& (h - 28.0).abs() <= 6.0
				&& x >= f_left
				&& x < (f_right - f_left).mul_add(0.7, f_left)
				&& w >= 30.0
		})
		.copied()
}

/// Locates the up-arrow primary action button hitbox in the composer footer.
pub fn find_primary_action_hitbox(
	hitboxes: &[Bounds<Pixels>],
	f_right: f32,
	f_bottom: f32,
) -> Option<Bounds<Pixels>> {
	hitboxes
		.iter()
		.find(|rect| {
			let y = f32::from(rect.origin.y);
			let h = f32::from(rect.size.height);
			let x = f32::from(rect.origin.x);
			let w = f32::from(rect.size.width);
			y >= f_bottom - 50.0
				&& y <= f_bottom
				&& (h - 28.0).abs() <= 6.0
				&& (w - 28.0).abs() <= 6.0
				&& x >= f_right - 50.0
				&& x <= f_right
		})
		.copied()
}

/// Locates the separate stop control hitbox in the composer footer (only
/// present when running).
pub fn find_stop_control_hitbox(
	hitboxes: &[Bounds<Pixels>],
	f_right: f32,
	f_bottom: f32,
) -> Option<Bounds<Pixels>> {
	hitboxes
		.iter()
		.find(|rect| {
			let y = f32::from(rect.origin.y);
			let h = f32::from(rect.size.height);
			let x = f32::from(rect.origin.x);
			let w = f32::from(rect.size.width);
			y >= f_bottom - 50.0
				&& y <= f_bottom
				&& (h - 28.0).abs() <= 6.0
				&& x >= f_right - 80.0
				&& x + w < f_right - 32.0
				&& (w - 28.0).abs() <= 6.0
		})
		.copied()
}
