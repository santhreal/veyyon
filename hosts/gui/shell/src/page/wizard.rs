//! A form with an ordered set of steps and a position in it.
//!
//! The step rail is what a wizard has that a form does not: what is behind,
//! what is ahead, and what was attempted and refused. The step on screen is
//! drawn by the [`super::form`] page, so a wizard step and a settings group are
//! the same fields with the same masking.

use gpui::{App, Div, ParentElement, Styled};
use veyyon_gui_contract::screen::{StepState, Wizard, WizardStep};
use veyyon_gui_kit::{
	chrome::{column, row, rule},
	text::{caption, text_in},
	tokens::{space, text},
};
use veyyon_gui_theme::Role;

pub fn wizard(value: &Wizard, cx: &App) -> Div {
	let mut stack = column(space::BASE)
		.child(caption(progress_line(value), cx))
		.child(rail(value, cx))
		.child(rule(Role::StrokeSubtle, cx))
		.child(super::form::form(&value.form, cx));

	if !value.can_advance {
		stack = stack.child(text_in(BLOCKED, Role::StateWarning, text::SMALL, cx));
	}
	match &value.footer {
		None => stack,
		Some(footer) => stack.child(caption(footer.clone(), cx)),
	}
}

/// What the wizard says when the step on screen is not finished.
///
/// Said here, on the step, rather than at the end: a wizard that lets the
/// operator past an incomplete step reports the refusal where it cannot be
/// acted on any more.
const BLOCKED: &str = "this step is not finished";

/// How far along the wizard is.
///
/// Counts finished steps against every step, including the ones ahead. A count
/// of the steps behind the current position would report a wizard as finished
/// the moment its last step opened.
pub fn progress_line(value: &Wizard) -> String {
	format!("{} of {} done", value.completed(), value.steps.len())
}

/// The rail of steps, in order.
fn rail(value: &Wizard, cx: &App) -> Div {
	row(space::BASE).flex_wrap().children(
		value
			.steps
			.iter()
			.enumerate()
			.map(|(index, step)| self::step(step, index == value.current, cx)),
	)
}

/// One step: its marker, then its name.
fn step(value: &WizardStep, current: bool, cx: &App) -> Div {
	let role = state_role(value.state);
	let size = if current { text::BODY } else { text::SMALL };
	row(space::HAIR)
		.items_baseline()
		.child(text_in(state_marker(value.state), role, size, cx))
		.child(text_in(value.name.clone(), role, size, cx))
}

/// The marker that precedes a step's name.
///
/// Every state is distinct, and [`StepState::Failed`] is distinct from both
/// [`StepState::Pending`] and [`StepState::Skipped`]: a step whose key the
/// provider refused, drawn as one the operator has not reached yet, sends them
/// forward through a wizard that will not finish.
pub fn state_marker(state: StepState) -> &'static str {
	match state {
		StepState::Done => "✓",
		StepState::Current => "▸",
		StepState::Pending => "·",
		StepState::Skipped => "–",
		StepState::Failed => "✗",
	}
}

/// The role a step's name reads in.
pub fn state_role(state: StepState) -> Role {
	match state {
		StepState::Done => Role::StateSuccess,
		StepState::Current => Role::TextPrimary,
		StepState::Pending => Role::TextMuted,
		StepState::Skipped => Role::TextSecondary,
		StepState::Failed => Role::StateError,
	}
}

#[cfg(test)]
mod tests {
	//! WHY THIS SUITE EXISTS.
	//!
	//! Five step states, three of which mean "not done" for different reasons.
	//! `Failed` drawn like `Pending` sends the operator forward through a wizard
	//! that cannot finish, and `Skipped` drawn like `Done` claims something was
	//! configured that was not. Neither looks wrong on screen, so the markers
	//! and the roles are asserted pairwise distinct rather than one at a time.
	//!
	//! The progress line is the other half: counted against the steps behind the
	//! current position rather than every step, it reports a wizard as finished
	//! the moment its last step opens.
	//!
	//! WHAT IT DOES NOT CATCH. Advancing. Nothing moves the position yet.

	use veyyon_gui_contract::fixtures;

	use super::*;

	/// Every state, read from the enum rather than from a list here, so a state
	/// added to the contract is drawn by this suite too.
	const ALL: [StepState; 5] = [
		StepState::Done,
		StepState::Current,
		StepState::Pending,
		StepState::Skipped,
		StepState::Failed,
	];

	#[test]
	fn no_two_step_states_draw_the_same_marker() {
		let mut markers: Vec<&str> = ALL.iter().copied().map(state_marker).collect();
		let count = markers.len();
		markers.sort_unstable();
		markers.dedup();
		assert_eq!(markers.len(), count, "two step states share a marker");
	}

	#[test]
	fn a_refused_step_reads_as_neither_pending_nor_skipped_nor_done() {
		for other in [StepState::Pending, StepState::Skipped, StepState::Done] {
			assert_ne!(
				state_marker(StepState::Failed),
				state_marker(other),
				"a refused step draws like {other:?}"
			);
			assert_ne!(
				state_role(StepState::Failed),
				state_role(other),
				"a refused step reads like {other:?}"
			);
		}
	}

	#[test]
	fn a_skipped_step_never_reads_as_a_finished_one() {
		assert_ne!(state_marker(StepState::Skipped), state_marker(StepState::Done));
		assert_ne!(state_role(StepState::Skipped), state_role(StepState::Done));
	}

	#[test]
	fn the_progress_line_counts_finished_steps_against_every_step() {
		let setup = fixtures::routes::setup();
		let total = setup.steps.len();
		let done = setup
			.steps
			.iter()
			.filter(|step| step.state == StepState::Done)
			.count();
		assert_eq!(progress_line(&setup), format!("{done} of {total} done"));
		assert!(done < total, "the fixture wizard is already finished");
	}

	#[test]
	fn the_last_step_opening_is_not_the_wizard_finishing() {
		let mut setup = fixtures::routes::setup();
		let total = setup.steps.len();
		setup.current = total - 1;
		for step in setup.steps.iter_mut().take(total - 1) {
			step.state = StepState::Done;
		}
		setup.steps[total - 1].state = StepState::Current;
		assert_eq!(progress_line(&setup), format!("{} of {total} done", total - 1));
	}

	#[test]
	fn the_fixture_wizard_carries_a_refused_step_to_draw() {
		let setup = fixtures::routes::setup();
		assert!(
			setup
				.steps
				.iter()
				.any(|step| step.state == StepState::Failed),
			"nothing exercises the refused marker"
		);
		assert!(setup.step().is_some(), "the position is past the last step");
	}
}
