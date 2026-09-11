//! A pipe table, drawn as the grid its source states (§8.25).
//!
//! A table reaches this surface in a model's own reply, one row at a time, so
//! the grid is drawn from whatever rows have arrived rather than from a
//! finished document: a header with no body row is a header, and a row with
//! fewer cells than the header draws the cells it has.
//!
//! Every column is one share of the row's measure with a floor of zero, so a
//! narrow window shortens the cells rather than pushing the last column out of
//! the surface.

use veyyon_gpui::{Div, ParentElement, Pixels, Styled, div};

use super::blocks::CellAlign;
use crate::{
	text::{selectable::prose_element, span_selection::SelectableProse},
	token_set::{ColorRole, SpacingStep, StrokeStep, TextWeight, TokenSet},
};

/// What one cell of a table is drawn in, and where in the document its text
/// is: a cell is one span, numbered in the order the grid draws it.
struct Cell<'a> {
	text:      &'a str,
	align:     CellAlign,
	index:     u16,
	selection: Option<&'a SelectableProse>,
}

/// One row of the grid: its cells side by side, each taking an equal share of
/// the measure.
fn table_row(cells: Vec<Cell<'_>>, tokens: &TokenSet, size: Pixels, line_height: Pixels) -> Div {
	let mut row = div()
		.w_full()
		.flex()
		.flex_row()
		.gap(tokens.spacing(SpacingStep::S3));
	for cell in cells {
		let drawn = prose_element(cell.text, tokens, size, line_height, cell.index, cell.selection);
		let mut held = div().flex_1().min_w_0().flex().flex_row();
		held = match cell.align {
			CellAlign::Start => held.justify_start(),
			CellAlign::Center => held.justify_center(),
			CellAlign::End => held.justify_end(),
		};
		row = row.child(held.child(drawn));
	}
	row
}

/// The alignment column `at` states, or the leading edge when the delimiter
/// row stated nothing for it.
fn align_of(align: &[CellAlign], at: usize) -> CellAlign {
	align.get(at).copied().unwrap_or(CellAlign::Start)
}

/// The grid a table draws as: the header row set apart by the rule under it,
/// then one row per row of the source.
///
/// `index` is advanced past every cell this grid drew, so the block after it
/// is numbered where this one stopped.
pub(super) fn table_block(
	head: &[String],
	align: &[CellAlign],
	rows: &[Vec<String>],
	tokens: &TokenSet,
	size: Pixels,
	line_height: Pixels,
	index: &mut u16,
	selection: Option<&SelectableProse>,
) -> Div {
	let head_cells: Vec<Cell<'_>> = head
		.iter()
		.enumerate()
		.map(|(at, text)| {
			let cell = Cell { text, align: align_of(align, at), index: *index, selection };
			*index += 1;
			cell
		})
		.collect();
	let mut grid = div()
		.w_full()
		.flex()
		.flex_col()
		.gap(tokens.spacing(SpacingStep::S2))
		.child(
			div()
				.w_full()
				.pb(tokens.spacing(SpacingStep::S1))
				.border_b(tokens.stroke(StrokeStep::Hairline))
				.border_color(tokens.color(ColorRole::Hairline))
				.text_color(tokens.color(ColorRole::Secondary))
				.font_weight(tokens.font_weight(TextWeight::Medium))
				.child(table_row(head_cells, tokens, size, line_height)),
		);
	for row in rows {
		let cells: Vec<Cell<'_>> = row
			.iter()
			.enumerate()
			.map(|(at, text)| {
				let cell = Cell { text, align: align_of(align, at), index: *index, selection };
				*index += 1;
				cell
			})
			.collect();
		grid = grid.child(
			div()
				.w_full()
				.text_color(tokens.color(ColorRole::Foreground))
				.child(table_row(cells, tokens, size, line_height)),
		);
	}
	grid
}
