//! Re-breaking the grid's text when the window gives it another width.
//!
//! A terminal's line breaks are two different things wearing one shape. A
//! break the host wrote is part of the output and survives any width; a break
//! the terminal made because the text reached the last column belongs to the
//! width it was made at, and keeping it at a new width leaves a column of
//! ragged half-lines where the output should have re-flowed. A row states
//! which of the two it ended with, so this module joins the runs back into
//! the lines the host wrote and breaks them again at the new width.
//!
//! The alternate screen is not re-flowed. A full-screen program addresses
//! cells directly and redraws itself after a resize, so joining its rows
//! would splice together text that was never one line.

use std::{collections::VecDeque, mem};

use super::{
	cell::Cell,
	grid::{MAX_SCROLLBACK_ROWS, Row, TerminalGrid},
};

/// Resizes the grid, re-breaking the primary screen's text at the new width.
pub fn resize(grid: &mut TerminalGrid, new_cols: usize, new_rows: usize) {
	let new_cols = new_cols.max(1);
	let new_rows = new_rows.max(1);
	if new_cols == grid.cols && new_rows == grid.rows {
		return;
	}

	let reflowing = new_cols != grid.cols;
	let offset = reflowing.then(|| cursor_offset(grid));

	if reflowing {
		let mut lines = logical_lines(&grid.primary_lines);
		drop_trailing_blanks(&mut lines, offset.map_or(0, |offset| offset.line));
		let mut rebuilt: VecDeque<Row> = VecDeque::with_capacity(grid.primary_lines.len());
		for line in lines {
			for row in break_line(&line, new_cols) {
				rebuilt.push_back(row);
			}
		}
		grid.primary_lines = rebuilt;
	} else {
		for line in &mut grid.primary_lines {
			line.cells.resize(new_cols, Cell::blank());
		}
	}

	while grid.primary_lines.len() < new_rows {
		grid.primary_lines.push_back(Row::blank(new_cols));
	}
	while grid.primary_lines.len() > MAX_SCROLLBACK_ROWS + new_rows {
		grid.primary_lines.pop_front();
	}

	for line in &mut grid.alt_lines {
		line.cells.resize(new_cols, Cell::blank());
	}
	grid.alt_lines.resize(new_rows, Row::blank(new_cols));

	grid.cols = new_cols;
	grid.rows = new_rows;
	grid.scroll_top = 0;
	grid.scroll_bottom = new_rows.saturating_sub(1);
	grid.wrap_next = false;

	if let Some(offset) = offset {
		place_cursor(grid, offset);
	} else {
		// The width did not change, so the text did not move: only the rows
		// the window lost are taken off the cursor.
		grid.cursor_col = grid.cursor_col.min(new_cols.saturating_sub(1));
		grid.cursor_row = grid.cursor_row.min(new_rows.saturating_sub(1));
	}
}

/// Where the cursor sits as a line the host wrote and a column along it.
#[derive(Debug, Clone, Copy)]
struct CursorOffset {
	line:  usize,
	along: usize,
}

/// The cursor's place in the text rather than on the screen.
fn cursor_offset(grid: &TerminalGrid) -> CursorOffset {
	let base = grid.primary_lines.len().saturating_sub(grid.rows);
	let target = base + grid.cursor_row;
	let mut line = 0;
	let mut along = 0;
	for (index, row) in grid.primary_lines.iter().enumerate() {
		if index == target {
			return CursorOffset { line, along: along + grid.cursor_col };
		}
		if row.wrapped {
			along += row.cells.len();
		} else {
			line += 1;
			along = 0;
		}
	}
	CursorOffset { line, along }
}

/// Puts the cursor back on the row and column its text offset now falls on.
fn place_cursor(grid: &mut TerminalGrid, offset: CursorOffset) {
	let mut line = 0;
	let mut along = 0;
	let mut landed = grid.primary_lines.len().saturating_sub(1);
	let mut col = 0;
	for (index, row) in grid.primary_lines.iter().enumerate() {
		let width = row.cells.len();
		if line == offset.line && offset.along >= along && offset.along < along + width {
			landed = index;
			col = offset.along - along;
			break;
		}
		if row.wrapped {
			along += width;
		} else {
			if line == offset.line {
				landed = index;
				col = width.saturating_sub(1);
				break;
			}
			line += 1;
			along = 0;
		}
	}

	let base = grid.primary_lines.len().saturating_sub(grid.rows);
	grid.cursor_row = landed.saturating_sub(base).min(grid.rows.saturating_sub(1));
	grid.cursor_col = col.min(grid.cols.saturating_sub(1));
}

/// The rows joined back into the lines the host wrote, trailing blanks cut.
///
/// A line's trailing blanks are padding the grid added to square the row off,
/// not text, and carrying them would break the next line early. A blank that
/// carries a background colour is not padding and stays.
fn logical_lines(rows: &VecDeque<Row>) -> Vec<Vec<Cell>> {
	let mut lines = Vec::with_capacity(rows.len());
	let mut current: Vec<Cell> = Vec::new();
	for row in rows {
		let mut cells = row.cells.as_slice();
		if row.wrapped && ends_in_filler(cells) {
			// The column a wide glyph vacated at this break is not text, and
			// the break itself is about to be undone.
			cells = &cells[..cells.len() - 1];
		}
		current.extend_from_slice(cells);
		if !row.wrapped {
			trim_padding(&mut current);
			lines.push(mem::take(&mut current));
		}
	}
	if !current.is_empty() {
		trim_padding(&mut current);
		lines.push(current);
	}
	lines
}

/// Cuts the blank lines below the text, keeping the one the cursor is on.
///
/// A blank row at the bottom of the screen is the viewport, not output. Re-
/// breaking it as a line of its own makes the text taller than the rows it
/// needs, which pushes the top of the output into scrollback every time the
/// window narrows.
fn drop_trailing_blanks(lines: &mut Vec<Vec<Cell>>, cursor_line: usize) {
	let last_text = lines.iter().rposition(|line| !line.is_empty());
	let keep = last_text.map_or(0, |index| index + 1).max(cursor_line + 1);
	lines.truncate(keep);
}

/// Whether the row's last cell is the column a wrapped wide glyph vacated.
///
/// A continuation cell carries the same shape, and it is told apart by the
/// cell before it: a continuation always follows its own double-width lead.
fn ends_in_filler(cells: &[Cell]) -> bool {
	let Some(last) = cells.last() else {
		return false;
	};
	let follows_a_lead = cells.len() >= 2 && cells[cells.len() - 2].width == 2;
	last.is_unlit_zero_width() && !follows_a_lead
}

/// Cuts the blank cells a row was squared off with from the end of a line.
fn trim_padding(line: &mut Vec<Cell>) {
	let blank = Cell::blank();
	while line.last().is_some_and(|cell| *cell == blank) {
		line.pop();
	}
}

/// One line of text broken into rows of `cols` cells.
///
/// A wide glyph is never split across the break: a pair that would straddle
/// the last column moves whole to the next row, and the column it vacated is
/// left blank, which is what a terminal does when a double-width character
/// meets the right margin.
fn break_line(line: &[Cell], cols: usize) -> Vec<Row> {
	if line.is_empty() {
		return vec![Row::blank(cols)];
	}

	let mut rows = Vec::with_capacity(line.len() / cols + 1);
	let mut start = 0;
	while start < line.len() {
		let mut end = (start + cols).min(line.len());
		if end < line.len() && line[end - 1].width == 2 {
			end -= 1;
		}
		let mut cells = line[start..end].to_vec();
		if end < line.len() && cells.len() < cols {
			// A wide glyph moved whole to the next row: the column it left is
			// a filler, so the next join knows it was never text.
			cells.resize(cols, Cell::filler());
		}
		cells.resize(cols, Cell::blank());
		rows.push(Row { cells, wrapped: end < line.len() });
		start = end;
	}
	rows
}
