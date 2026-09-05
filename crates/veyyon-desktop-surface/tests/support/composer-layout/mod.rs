//! Helper utilities for asserting composer layout geometry, turn state
//! fixtures, and footer hitboxes across conversational phases and breakpoints.

use veyyon_desktop_kit::SpacingStep;
use veyyon_desktop_model::{InteractionId, QueueMode};
use veyyon_desktop_scene::session::HeadlessSession;
use veyyon_desktop_surface::{
	Card, ShellState, ShellView,
	composer::TurnPhase,
	fixture,
	layout::{ShedInput, shell_widths},
};
use veyyon_gpui::{Bounds, Pixels};

/// Turn phase variant discriminant for sweeping all 7 fundamental turn actions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, strum::EnumIter)]
pub enum TurnPhaseDiscriminant {
	Idle,
	RunningSteer,
	RunningQueue,
	QuestionPending,
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
		TurnPhaseDiscriminant::QuestionPending => {
			state.turn =
				TurnPhase::QuestionPending { interaction: InteractionId::from("q"), options: 3 };
			state.cards = vec![Card::Question {
				prompt:  "Select option".to_string(),
				options: vec!["A".to_string(), "B".to_string(), "C".to_string()],
			}];
			(state, false)
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
				&& x + w < f_right - 32.0
				&& (w - 28.0).abs() <= 6.0
				&& x >= f_right - 80.0
		})
		.copied()
}
