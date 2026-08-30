//! A list chosen from.

use gpui::{App, Div, ParentElement, Styled};
use veyyon_gui_contract::screen::{PickList, PickRow};
use veyyon_gui_kit::{
	chrome::{chip, column, row, well},
	text::{caption, text_in},
	theme::ActiveTheme,
	tokens::{radius, space, text},
};
use veyyon_gui_theme::Role;
use veyyon_gui_views::tone;

pub fn pick(value: &PickList, cx: &App) -> Div {
	let mut stack = column(space::TIGHT);
	if let Some(query) = &value.query {
		stack = stack.child(well(query.clone(), Role::TextPrimary, cx));
	}
	if value.rows.is_empty() {
		return stack.child(caption(value.empty.clone(), cx));
	}

	stack = stack.children(
		value
			.rows
			.iter()
			.enumerate()
			.map(|(index, entry)| entry_row(entry, state_of(value, index), value.multi, cx)),
	);
	match &value.footer {
		None => stack,
		Some(footer) => stack.child(caption(footer.clone(), cx)),
	}
}

/// How a row reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RowState {
	/// The row the highlight is on.
	Highlighted,
	/// A row that can be chosen.
	Available,
	/// A row that cannot be chosen, and says so.
	Disabled,
}

/// The state of the row at `index`.
///
/// A disabled row is never highlighted, even when the index points at it: a
/// highlight on a row that cannot be chosen reads as a selection that does
/// nothing when confirmed.
pub fn state_of(value: &PickList, index: usize) -> RowState {
	let Some(entry) = value.rows.get(index) else {
		return RowState::Available;
	};
	if entry.disabled {
		RowState::Disabled
	} else if value.selected == index {
		RowState::Highlighted
	} else {
		RowState::Available
	}
}

/// The role a row's label reads in.
pub fn state_role(state: RowState) -> Role {
	match state {
		RowState::Highlighted => Role::TextPrimary,
		RowState::Available => Role::TextSecondary,
		RowState::Disabled => Role::TextMuted,
	}
}

/// The mark that says whether a row is chosen.
///
/// A single-choice list has one answer and the highlight is it, so a check mark
/// beside it would claim a second kind of selection. A multiple-choice list
/// needs the mark, because the highlight moves and the answers stay.
pub fn check_mark(checked: bool, multi: bool) -> &'static str {
	match (multi, checked) {
		(true, true) => "☑",
		(true, false) => "☐",
		(false, true) => "•",
		(false, false) => " ",
	}
}

fn entry_row(entry: &PickRow, state: RowState, multi: bool, cx: &App) -> Div {
	let role = state_role(state);
	let mut line = row(space::SNUG)
		.items_baseline()
		.w_full()
		.p(space::TIGHT)
		.rounded(radius::SMALL)
		.child(text_in(check_mark(entry.checked, multi), role, text::BODY, cx))
		.child(text_in(entry.label.clone(), role, text::BODY, cx));
	if let Some(detail) = &entry.detail {
		line = line.child(caption(detail.clone(), cx));
	}
	line = line.children(
		entry
			.badges
			.iter()
			.map(|badge| chip(badge.text.clone(), tone::role(badge.tone), cx)),
	);
	if state == RowState::Highlighted {
		line = line.bg(cx.color(Role::InteractionSelected));
	}
	line
}

#[cfg(test)]
mod tests {
	//! WHY THIS SUITE EXISTS.
	//!
	//! The highlight index arrives from a session. Two ways it goes wrong and
	//! neither looks wrong: it lands past the last row, which panics a renderer
	//! that indexes `rows`, and it lands on a disabled row, which draws a
	//! selection that does nothing when confirmed. The check mark is the third:
	//! drawing one on a single-choice list claims a second kind of selection
	//! beside the highlight.
	//!
	//! WHAT IT DOES NOT CATCH. Keyboard movement. Nothing moves the highlight
	//! yet.

	use veyyon_gui_contract::fixtures;

	use super::*;

	#[test]
	fn the_highlight_lands_on_the_row_the_list_selected() {
		let picker = fixtures::routes::model_picker();
		assert_eq!(picker.selected, 1);
		assert_eq!(state_of(&picker, 1), RowState::Highlighted);
		assert_eq!(state_of(&picker, 0), RowState::Available);
	}

	#[test]
	fn a_disabled_row_is_never_highlighted() {
		let mut picker = fixtures::routes::model_picker();
		let disabled = picker
			.rows
			.iter()
			.position(|entry| entry.disabled)
			.expect("the fixture carries a disabled row");
		picker.selected = disabled;
		assert_eq!(state_of(&picker, disabled), RowState::Disabled);
	}

	#[test]
	fn a_highlight_past_the_end_draws_no_highlight_rather_than_panicking() {
		let picker = fixtures::routes::model_picker().highlight(9_999);
		assert!(picker.highlighted().is_none());
		for index in 0..picker.rows.len() {
			assert_ne!(state_of(&picker, index), RowState::Highlighted);
		}
		assert_eq!(state_of(&picker, 9_999), RowState::Available);
	}

	#[test]
	fn a_single_choice_list_marks_nothing_the_highlight_already_says() {
		assert_eq!(check_mark(false, false), " ");
		assert_eq!(check_mark(true, false), "•");
		assert_ne!(check_mark(true, false), check_mark(true, true));
	}

	#[test]
	fn a_multiple_choice_list_marks_both_states() {
		assert_eq!(check_mark(true, true), "☑");
		assert_eq!(check_mark(false, true), "☐");
	}

	#[test]
	fn no_two_row_states_read_the_same() {
		let all = [RowState::Highlighted, RowState::Available, RowState::Disabled];
		let mut roles: Vec<Role> = all.iter().copied().map(state_role).collect();
		let count = roles.len();
		roles.sort_by_key(|role| format!("{role:?}"));
		roles.dedup();
		assert_eq!(roles.len(), count, "two row states share a role");
	}
}
