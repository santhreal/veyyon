//! Columns and rows.

use gpui::{App, Div, ParentElement, Styled};
use veyyon_gui_contract::view::{Table, TableRow};
use veyyon_gui_kit::{
	chrome::{chip, column, row, rule},
	text::{caption, text_in},
	tokens::{space, text},
};
use veyyon_gui_theme::Role;

use crate::tone;

pub fn table(value: &Table, cx: &App) -> Div {
	if value.rows.is_empty() {
		return column(space::TIGHT)
			.child(caption(value.empty.clone().unwrap_or_else(|| "No rows".to_owned()), cx));
	}

	let width = value.columns.len();
	let mut stack = column(space::TIGHT);
	if width > 0 {
		stack =
			stack
				.child(
					row(space::BASE).children(value.columns.iter().map(|name| {
						text_in(name.clone(), Role::TextSecondary, text::SMALL, cx).flex_1()
					})),
				)
				.child(rule(Role::StrokeSubtle, cx));
	}
	stack.children(value.rows.iter().map(|line| body_row(line, width, cx)))
}

/// One row, padded to the header's width.
fn body_row(line: &TableRow, width: usize, cx: &App) -> Div {
	let role = tone::role(line.tone);
	let size = if line.emphasis {
		text::BODY
	} else {
		text::SMALL
	};
	row(space::BASE)
		.children(
			cells(line, width)
				.into_iter()
				.map(|cell| text_in(cell, role, size, cx).flex_1()),
		)
		.children(
			line
				.badges
				.iter()
				.map(|badge| chip(badge.text.clone(), tone::role(badge.tone), cx)),
		)
}

/// The cells a row draws, padded or truncated to `width`.
///
/// A short row is padded and a long row is truncated, both to the header's
/// count. Drawing a short row as it arrived shifts every cell after the gap
/// under the wrong column, and nothing about the result looks like an error:
/// it reads as data.
///
/// `width == 0` is a headerless table, which has no count to align to, so the
/// row is drawn as it arrived.
pub fn cells(line: &TableRow, width: usize) -> Vec<String> {
	if width == 0 {
		return line.cells.clone();
	}
	let mut out = line.cells.clone();
	out.truncate(width);
	while out.len() < width {
		out.push(String::new());
	}
	out
}

#[cfg(test)]
mod tests {
	//! WHY THIS SUITE EXISTS.
	//!
	//! A row that does not match its header shifts every cell after the gap
	//! under the wrong column, and the result reads as data rather than as a
	//! defect: a cost under the token column, a date under the size column. The
	//! contract reports this through `Table::is_aligned`, and this is the half
	//! that has to act on it.
	//!
	//! The headerless case is the one a padding loop gets wrong: there is no
	//! count to align to, and padding to zero would erase every cell.
	//!
	//! WHAT IT DOES NOT CATCH. Column widths. Whether the columns line up on
	//! screen is the window's own measurement.

	use veyyon_gui_contract::fixtures;

	use super::*;

	#[test]
	fn a_short_row_is_padded_to_the_header_width() {
		let line = TableRow::new(vec!["1.2.9".to_owned(), "2026-04-20".to_owned()]);
		assert_eq!(cells(&line, 4), vec![
			"1.2.9".to_owned(),
			"2026-04-20".to_owned(),
			String::new(),
			String::new(),
		]);
	}

	#[test]
	fn a_long_row_is_truncated_to_the_header_width() {
		let line = TableRow::new(vec!["a".to_owned(), "b".to_owned(), "stray".to_owned()]);
		assert_eq!(cells(&line, 2), vec!["a".to_owned(), "b".to_owned()]);
	}

	#[test]
	fn a_headerless_row_is_drawn_as_it_arrived() {
		let line = TableRow::new(vec!["the plan replaces the transport".to_owned()]);
		assert_eq!(cells(&line, 0), line.cells);
	}

	#[test]
	fn every_fixture_row_comes_out_at_the_header_width() {
		let fixture = fixtures::views::table();
		let width = fixture.columns.len();
		assert!(width > 0);
		for line in &fixture.rows {
			assert_eq!(cells(line, width).len(), width);
		}
	}

	#[test]
	fn an_empty_table_has_something_to_say() {
		let empty = Table::new(vec!["name".to_owned()], Vec::new()).empty_text("No models");
		assert_eq!(empty.empty.as_deref(), Some("No models"));
	}
}
