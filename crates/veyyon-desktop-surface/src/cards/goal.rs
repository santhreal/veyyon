//! The goal card: what autonomous goal is running, its progress, and controls.

use veyyon_desktop_kit::{ColorRole, SpacingStep, TextRamp, TextWeight, TintRole, TokenSet};
use veyyon_desktop_model::{GoalControl, GoalStatus, GoalView};
use veyyon_desktop_tokens::AttachedCardsSurfaceTokens;
use veyyon_gpui::{Context, Div, ParentElement, Styled, div};

use super::{
	answers::{Choice, answers},
	shell,
};
use crate::{ShellView, composer::state::thousands, controls::Availability, intent::Intent};

/// Status tint role for a goal status.
///
/// Ring tint mapping:
/// - `Active` -> `TintRole::Working`
/// - `Paused` and `BudgetLimited` -> `TintRole::Attention`
/// - `Complete` -> `TintRole::Done`
/// - `Dropped` -> `TintRole::Input`
#[must_use]
pub const fn status_tint(status: GoalStatus) -> TintRole {
	match status {
		GoalStatus::Active => TintRole::Working,
		GoalStatus::Paused | GoalStatus::BudgetLimited => TintRole::Attention,
		GoalStatus::Complete => TintRole::Done,
		GoalStatus::Dropped => TintRole::Input,
	}
}

/// Formats seconds into a human-readable duration string.
#[must_use]
pub fn format_duration(seconds: u64) -> String {
	if seconds < 60 {
		format!("{seconds}s")
	} else if seconds < 3600 {
		format!("{}m {}s", seconds / 60, seconds % 60)
	} else {
		format!("{}h {}m", seconds / 3600, (seconds % 3600) / 60)
	}
}

/// A goal card stating the objective, status, turns, tokens against budget,
/// elapsed duration, stand-down notice if any, and control choices.
pub(super) fn goal(
	_card: usize,
	view: &GoalView,
	answer: &Availability,
	geometry: &AttachedCardsSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> Div {
	let tint = status_tint(view.status);

	let mut metadata = div()
		.w_full()
		.flex()
		.flex_col()
		.gap(tokens.spacing(SpacingStep::S1));

	let status_line = format!("Status: {}", view.status.label());
	let turns_line = if view.turns_completed == 1 {
		"1 turn completed".to_string()
	} else {
		format!("{} turns completed", view.turns_completed)
	};

	let tokens_line = if let Some(budget) = view.token_budget {
		format!(
			"{} / {} tokens",
			thousands(view.tokens_used),
			thousands(budget)
		)
	} else {
		format!("{} tokens used", thousands(view.tokens_used))
	};

	let duration_line = format!("Run time: {}", format_duration(view.time_used_seconds));

	metadata = metadata
		.child(
			div()
				.text_size(tokens.font_size(TextRamp::Small))
				.line_height(tokens.line_height(TextRamp::Small))
				.text_color(tokens.color(ColorRole::Secondary))
				.child(format!("{status_line} · {turns_line}")),
		)
		.child(
			div()
				.text_size(tokens.font_size(TextRamp::Small))
				.line_height(tokens.line_height(TextRamp::Small))
				.text_color(tokens.color(ColorRole::Muted))
				.child(format!("{tokens_line} · {duration_line}")),
		);

	if let Some(reason) = &view.stood_down {
		metadata = metadata.child(
			div()
				.w_full()
				.flex()
				.flex_col()
				.gap(tokens.spacing(SpacingStep::S1))
				.child(
					div()
						.text_size(tokens.font_size(TextRamp::Small))
						.line_height(tokens.line_height(TextRamp::Small))
						.text_color(tokens.tint(TintRole::Attention).ink)
						.child(format!("Stood down: {reason}")),
				)
				.child(
					div()
						.text_size(tokens.font_size(TextRamp::Micro))
						.line_height(tokens.line_height(TextRamp::Micro))
						.text_color(tokens.color(ColorRole::Muted))
						.child("Resume to continue driving turns, or drop to end the goal."),
				),
		);
	}

	let mut choices: Vec<(&'static str, Choice)> = Vec::new();
	for &control in view.status.allowed_controls() {
		match control {
			GoalControl::Pause => {
				choices.push((
					"Pause",
					Choice::Fixed(Box::new(Intent::ControlGoal { op: GoalControl::Pause })),
				));
			},
			GoalControl::Resume => {
				choices.push((
					"Resume",
					Choice::Fixed(Box::new(Intent::ControlGoal { op: GoalControl::Resume })),
				));
			},
			GoalControl::Drop => {
				choices.push((
					"Drop",
					Choice::Fixed(Box::new(Intent::ControlGoal { op: GoalControl::Drop })),
				));
			},
		}
	}

	shell(tint, geometry.plan_padding, tokens)
		.child(
			div()
				.w_full()
				.min_w_0()
				.overflow_hidden()
				.whitespace_nowrap()
				.truncate()
				.text_size(tokens.font_size(TextRamp::Body))
				.line_height(tokens.line_height(TextRamp::Body))
				.font_weight(tokens.font_weight(TextWeight::Medium))
				.text_color(tokens.color(ColorRole::Foreground))
				.child(view.objective.clone()),
		)
		.child(metadata)
		.child(answers(&choices, answer, tokens, cx))
}

/// Toggles the goal card open or closed in shell state.
pub fn toggle_goal_card(state: &mut crate::model::ShellState) {
	state.goal_card_open = !state.goal_card_open;
	if state.goal_card_open {
		if let Some(goal) = &state.goal
			&& state.cards.iter().all(|c| !matches!(c, crate::Card::Goal { .. }))
		{
			state.cards.push(crate::Card::Goal { view: goal.clone() });
		}
	} else {
		state.cards.retain(|c| !matches!(c, crate::Card::Goal { .. }));
	}
}
