//! A question the operator answers before the tool continues.

use gpui::{App, Div, ParentElement, Styled};
use veyyon_gui_contract::view::{Choice, Question, Tone};
use veyyon_gui_kit::{
	chrome::{chip, column, row},
	text::{caption, text_in},
	tokens::{space, text},
};
use veyyon_gui_theme::Role;

use crate::tone;

pub fn question(value: &Question, cx: &App) -> Div {
	let answered = value.answer();
	let mut stack =
		column(space::SNUG).child(text_in(value.prompt.clone(), Role::TextPrimary, text::BODY, cx));

	for (index, choice) in value.choices.iter().enumerate() {
		let state = state_of(value, index);
		stack = stack.child(self::choice(choice, state, cx));
	}

	if let Some(taken) = answered {
		stack = stack.child(caption(format!("answered: {}", taken.label), cx));
	}
	stack
}

/// How a choice reads: taken, offered, or passed over.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChoiceState {
	/// The choice that was taken.
	Taken,
	/// A choice that is still available.
	Offered,
	/// A choice offered first, on an open question.
	Recommended,
	/// A choice that was not taken, on a question that is closed.
	Passed,
}

/// The state of the choice at `index`.
///
/// Read through the question rather than by indexing `choices`: the answered
/// index arrives from a session, and a redraw against a shorter choice list
/// would panic a window that indexed it directly.
pub fn state_of(value: &Question, index: usize) -> ChoiceState {
	match value.answered {
		Some(answered) if answered == index => ChoiceState::Taken,
		Some(_) => ChoiceState::Passed,
		None
			if value
				.choices
				.get(index)
				.is_some_and(|choice| choice.recommended) =>
		{
			ChoiceState::Recommended
		},
		None => ChoiceState::Offered,
	}
}

/// The role a choice's label reads in.
pub fn state_role(state: ChoiceState) -> Role {
	match state {
		ChoiceState::Taken => Role::TextAccent,
		ChoiceState::Recommended => Role::TextPrimary,
		ChoiceState::Offered => Role::TextSecondary,
		ChoiceState::Passed => Role::TextMuted,
	}
}

/// The marker that precedes a choice.
pub fn state_marker(state: ChoiceState) -> &'static str {
	match state {
		ChoiceState::Taken => "●",
		ChoiceState::Recommended => "▸",
		ChoiceState::Offered => "○",
		ChoiceState::Passed => "·",
	}
}

fn choice(value: &Choice, state: ChoiceState, cx: &App) -> Div {
	let role = state_role(state);
	let mut line = row(space::SNUG)
		.items_baseline()
		.child(text_in(state_marker(state), role, text::BODY, cx))
		.child(text_in(value.label.clone(), role, text::BODY, cx));
	if state == ChoiceState::Recommended {
		line = line.child(chip("recommended", tone::role(Some(Tone::Accent)), cx));
	}
	line = line.children(
		value
			.badges
			.iter()
			.map(|badge| chip(badge.text.clone(), tone::role(badge.tone), cx)),
	);
	match &value.detail {
		None => line,
		Some(detail) => column(space::HAIR)
			.child(line)
			.child(caption(detail.clone(), cx)),
	}
}

#[cfg(test)]
mod tests {
	//! WHY THIS SUITE EXISTS.
	//!
	//! An answered index arrives from a session and decides how every choice
	//! reads. Indexing `choices` with it panics a window when the list changed
	//! underneath — a redraw from history against a revised set. The other
	//! failure is quieter: an answered question that still marks a
	//! recommendation reads as open, and an operator answers it twice.
	//!
	//! WHAT IT DOES NOT CATCH. Multiple selection, which the contract carries as
	//! one index and cannot express yet.

	use veyyon_gui_contract::fixtures;

	use super::*;

	#[test]
	fn an_open_question_offers_its_recommendation_and_marks_nothing_taken() {
		let open = fixtures::views::question();
		let states: Vec<ChoiceState> = (0..open.choices.len())
			.map(|index| state_of(&open, index))
			.collect();
		assert_eq!(states, vec![
			ChoiceState::Recommended,
			ChoiceState::Offered,
			ChoiceState::Offered,
		]);
	}

	#[test]
	fn an_answered_question_marks_one_choice_taken_and_no_recommendation() {
		let closed = fixtures::views::answered_question();
		let states: Vec<ChoiceState> = (0..closed.choices.len())
			.map(|index| state_of(&closed, index))
			.collect();
		assert_eq!(states, vec![ChoiceState::Taken, ChoiceState::Passed, ChoiceState::Passed]);
		assert!(!states.contains(&ChoiceState::Recommended), "a closed question still recommends");
	}

	#[test]
	fn an_answer_past_the_end_marks_nothing_taken_rather_than_panicking() {
		let stale = fixtures::views::question().answered(9_999);
		let states: Vec<ChoiceState> = (0..stale.choices.len())
			.map(|index| state_of(&stale, index))
			.collect();
		assert!(!states.contains(&ChoiceState::Taken));
		assert_eq!(stale.answer(), None);
	}

	#[test]
	fn no_two_choice_states_read_the_same() {
		let all =
			[ChoiceState::Taken, ChoiceState::Recommended, ChoiceState::Offered, ChoiceState::Passed];

		let mut roles: Vec<Role> = all.iter().copied().map(state_role).collect();
		let count = roles.len();
		roles.sort_by_key(|role| format!("{role:?}"));
		roles.dedup();
		assert_eq!(roles.len(), count, "two choice states share a role");

		let mut markers: Vec<&str> = all.iter().copied().map(state_marker).collect();
		markers.sort_unstable();
		markers.dedup();
		assert_eq!(markers.len(), count, "two choice states share a marker");
	}
}
