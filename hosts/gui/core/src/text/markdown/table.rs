//! Pipe tables. A header row, a delimiter row, and body rows split on
//! unescaped pipes.

use super::{Row, block::is_blank, inline::inline};

pub(super) fn parse_table(lines: &[&str], start: usize) -> Option<(Row, Vec<Row>, usize)> {
	let header_line = lines[start];
	if !header_line.contains('|') || start + 1 >= lines.len() {
		return None;
	}

	let delimiter_line = lines[start + 1];
	if !is_table_delimiter(delimiter_line) {
		return None;
	}

	let head_cells_raw = split_table_row(header_line);
	if head_cells_raw.is_empty() {
		return None;
	}

	let head: Row = head_cells_raw
		.into_iter()
		.map(|c| inline(c.trim()))
		.collect();
	let col_count = head.len();
	let mut rows = Vec::new();
	let mut i = start + 2;

	while i < lines.len() {
		let line = lines[i];
		if is_blank(line) || !line.contains('|') {
			break;
		}
		let row_cells_raw = split_table_row(line);
		let mut row: Row = row_cells_raw
			.into_iter()
			.map(|c| inline(c.trim()))
			.collect();
		while row.len() < col_count {
			row.push(Vec::new());
		}
		rows.push(row);
		i += 1;
	}

	Some((head, rows, i))
}

pub(super) fn is_table_delimiter(line: &str) -> bool {
	let trimmed = line.trim();
	if trimmed.is_empty() || !trimmed.contains('-') {
		return false;
	}
	trimmed
		.chars()
		.all(|c| c == '|' || c == '-' || c == ':' || c == ' ' || c == '\t')
}

fn split_table_row(line: &str) -> Vec<String> {
	let mut cells = Vec::new();
	let mut current = String::new();
	let mut escaped = false;

	for ch in line.chars() {
		if escaped {
			current.push(ch);
			escaped = false;
		} else if ch == '\\' {
			current.push('\\');
			escaped = true;
		} else if ch == '|' {
			cells.push(current);
			current = String::new();
		} else {
			current.push(ch);
		}
	}
	cells.push(current);

	let starts_with_pipe = line.trim_start().starts_with('|');
	let ends_with_pipe = line.trim_end().ends_with('|') && !line.trim_end().ends_with(r"\|");

	if starts_with_pipe && !cells.is_empty() && cells[0].trim().is_empty() {
		cells.remove(0);
	}
	if ends_with_pipe && !cells.is_empty() && cells[cells.len() - 1].trim().is_empty() {
		cells.pop();
	}

	cells
}
