//! Cards in columns: the todo board, the agent dashboard.

use gpui::{App, Div, ParentElement, Styled};
use veyyon_gui_contract::screen::{Board, BoardCard, BoardColumn};
use veyyon_gui_kit::{
	Level,
	chrome::{chip, column as stack, row},
	surface,
	text::{caption, text_in},
	theme::ActiveTheme,
	tokens::{radius, space, text},
};
use veyyon_gui_theme::Role;
use veyyon_gui_views::tone;

pub fn board(value: &Board, cx: &App) -> Div {
	let mut out = stack(space::SNUG)
		.child(caption(count_line(value), cx))
		.child(
			row(space::BASE)
				.items_start()
				.children(value.columns.iter().map(|c| lane(c, cx))),
		);
	if let Some(footer) = &value.footer {
		out = out.child(caption(footer.clone(), cx));
	}
	out
}

/// What the board says about its own size.
pub fn count_line(value: &Board) -> String {
	let cards = value.card_count();
	let columns = value.columns.len();
	match cards {
		1 => format!("1 card in {columns} columns"),
		cards => format!("{cards} cards in {columns} columns"),
	}
}

/// One column. An empty column is drawn as an empty column, not omitted: a
/// board whose "done" column disappears when it empties reads as a board with
/// fewer stages than it has.
fn lane(value: &BoardColumn, cx: &App) -> Div {
	let head = row(space::SNUG)
		.items_baseline()
		.child(text_in(value.name.clone(), tone::role(value.tone), text::SMALL, cx))
		.child(caption(value.cards.len().to_string(), cx));

	let body = if value.cards.is_empty() {
		stack(space::TIGHT).child(caption(EMPTY_COLUMN, cx))
	} else {
		stack(space::TIGHT).children(value.cards.iter().map(|entry| card(entry, cx)))
	};

	stack(space::SNUG).flex_1().child(head).child(body)
}

/// What an empty column says.
const EMPTY_COLUMN: &str = "nothing here";

/// One card.
fn card(value: &BoardCard, cx: &App) -> Div {
	let role = tone::role(value.tone);
	let mut out = surface(Level::Raised, cx)
		.w_full()
		.p(space::SNUG)
		.rounded(radius::SMALL)
		.flex()
		.flex_col()
		.gap(space::HAIR)
		.child(text_in(value.title.clone(), role, text::BODY, cx))
		.children(value.lines.iter().map(|line| caption(line.clone(), cx)));

	if !value.badges.is_empty() {
		out = out.child(
			row(space::HAIR).children(
				value
					.badges
					.iter()
					.map(|badge| chip(badge.text.clone(), tone::role(badge.tone), cx)),
			),
		);
	}
	match value.progress {
		None => out,
		Some(progress) => out.child(bar(progress, cx)),
	}
}

/// A card's progress bar.
fn bar(progress: f32, cx: &App) -> Div {
	surface(Level::Sunken, cx)
		.w_full()
		.h(BAR_HEIGHT)
		.rounded(radius::SMALL)
		.overflow_hidden()
		.child(
			gpui::div()
				.h_full()
				.w(gpui::relative(fill(progress)))
				.rounded(radius::SMALL)
				.bg(cx.color(Role::TextAccent)),
		)
}

/// The bar's height.
const BAR_HEIGHT: gpui::Pixels = gpui::px(3.0);

/// How much of a card's bar is filled.
///
/// Clamped here rather than trusted: the value arrives from a producer, and a
/// fraction above one fills past the end of the bar while a negative one wraps
/// to the full width in a layout that takes an unsigned length.
pub fn fill(progress: f32) -> f32 {
	if progress.is_nan() {
		0.0
	} else {
		progress.clamp(0.0, 1.0)
	}
}

#[cfg(test)]
mod tests {
	//! WHY THIS SUITE EXISTS.
	//!
	//! A card's progress is a fraction a producer controls, and the contract
	//! does not clamp it. Above one it fills past the end of the bar, below zero
	//! it wraps to full in a layout taking an unsigned length, and `NaN` draws a
	//! bar of no width at all — three wrong bars, none of which looks like an
	//! error. The empty column is the other half: dropping it makes a board look
	//! like it has fewer stages than it has.
	//!
	//! WHAT IT DOES NOT CATCH. Column widths, and whether a long card wraps.

	use veyyon_gui_contract::fixtures;

	use super::*;

	#[test]
	fn a_fraction_outside_the_bar_is_clamped_to_it() {
		assert_eq!(fill(0.45), 0.45);
		assert_eq!(fill(1.4), 1.0);
		assert_eq!(fill(-0.2), 0.0);
		assert_eq!(fill(f32::NAN), 0.0);
		assert_eq!(fill(f32::INFINITY), 1.0);
	}

	#[test]
	fn the_board_counts_every_card_across_every_column() {
		let board = fixtures::routes::todo_board();
		assert_eq!(board.card_count(), 4);
		assert_eq!(count_line(&board), "4 cards in 4 columns");
	}

	#[test]
	fn one_card_is_singular() {
		let board =
			Board::new("Foundation", vec![BoardColumn::new("pending", vec![BoardCard::new(
				"Only card",
			)])]);
		assert_eq!(count_line(&board), "1 card in 1 columns");
	}

	#[test]
	fn the_fixture_board_carries_an_empty_column_to_draw() {
		let board = fixtures::routes::todo_board();
		assert!(
			board.columns.iter().any(|column| column.cards.is_empty()),
			"nothing exercises the empty column"
		);
	}
}
