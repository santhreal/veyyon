//! The goal the shown session runs: its objective, status, turns, tokens
//! against the budget and run time, why the host stood down, and the
//! controls its status allows. A dropped goal is not drawn.

use gpui::{AnyElement, Context, div, prelude::*};
use veyyon_desktop_model::{GoalControl, GoalStatus, GoalView, HostActionKind};
use veyyon_desktop_ui::{
	controls::{Button, ButtonSize, ButtonVariant, DotStatus, StatusDot},
	theme::{ActiveTheme, TypeStyled, radius, space, text},
};

use super::{InteractionDock, countdown::spell};
use crate::composer::tokens;

/// The dot a goal's status is drawn with.
const fn dot(goal: &GoalView) -> DotStatus {
	match goal.status {
		GoalStatus::Active if goal.driving => DotStatus::Running,
		GoalStatus::Active => DotStatus::Idle,
		GoalStatus::Paused | GoalStatus::BudgetLimited => DotStatus::Waiting,
		GoalStatus::Complete => DotStatus::Success,
		GoalStatus::Dropped => DotStatus::Error,
	}
}

/// The status, turns, tokens against the budget and run time, on one line.
fn facts(goal: &GoalView) -> String {
	let turns = match goal.turns_completed {
		1 => "1 turn".to_owned(),
		count => format!("{count} turns"),
	};
	let used = match goal.token_budget {
		Some(budget) => format!("{} / {} tokens", tokens(goal.tokens_used), tokens(budget)),
		None => format!("{} tokens", tokens(goal.tokens_used)),
	};
	format!("{} · {turns} · {used} · {}", goal.status.label(), spell(goal.time_used_seconds))
}

impl InteractionDock {
	/// The goal strip, or `None` while the session runs no goal.
	pub(super) fn render_goal(&self, cx: &Context<Self>) -> Option<AnyElement> {
		let session = self.session.as_ref()?;
		let app = self.app.read(cx);
		let goal = app
			.goal(session)
			.filter(|goal| goal.status != GoalStatus::Dropped)?;
		let blocked = app.refusal(HostActionKind::ControlGoal);
		let palette = cx.theme().palette;
		let (status, objective, line) = (dot(goal), goal.objective.clone(), facts(goal));
		let stood_down = goal.stood_down.clone();
		let controls: Vec<GoalControl> = goal.status.allowed_controls().to_vec();
		let buttons = controls.into_iter().map(|control| {
			let variant = if control.ends_the_goal() {
				ButtonVariant::Danger
			} else {
				ButtonVariant::Secondary
			};
			Button::new(("dock-goal-control", control as usize), control.label())
				.variant(variant)
				.size(ButtonSize::Sm)
				.disabled(blocked.is_some())
				.on_click(cx.listener(move |this, _, _, cx| this.control_goal(control, cx)))
		});
		let heading = div()
			.flex()
			.items_center()
			.gap(space::S2)
			.child(StatusDot::new(status))
			.child(
				div()
					.flex_none()
					.text_color(palette.text.muted)
					.child("Goal"),
			)
			.child(
				div()
					.flex_1()
					.min_w_0()
					.truncate()
					.type_style(text::UI_MEDIUM)
					.text_color(palette.text.primary)
					.child(objective),
			)
			.children(buttons);
		let reason = stood_down.map(|reason| {
			div()
				.flex()
				.flex_col()
				.child(
					div()
						.text_color(palette.status.waiting)
						.child(format!("Stood down: {reason}")),
				)
				.child(
					div()
						.type_style(text::MICRO)
						.text_color(palette.text.muted)
						.child("Resume to continue driving turns, or drop to end the goal."),
				)
		});
		Some(
			div()
				.id("dock-goal")
				.flex()
				.flex_col()
				.gap(space::S1)
				.px(space::S3)
				.py(space::S2)
				.rounded(radius::LG)
				.border_1()
				.border_color(palette.border.subtle)
				.bg(palette.bg.surface)
				.type_style(text::SMALL)
				.text_color(palette.text.secondary)
				.child(heading)
				.child(div().text_color(palette.text.muted).child(line))
				.children(reason)
				.children(blocked.map(|reason| div().text_color(palette.text.faint).child(reason)))
				.into_any_element(),
		)
	}
}
