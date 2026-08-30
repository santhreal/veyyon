//! List items: the marker, the nesting depth, and where the item's text
//! continues onto the next line.

use super::{
	Item, ListKind,
	block::{
		count_indent_columns, is_blank, is_blockquote_line, is_fenced_code_start, is_thematic_break,
		parse_atx_heading,
	},
	inline::inline,
};

pub(super) fn parse_list_marker(line: &str) -> Option<(ListKind, u8, usize, &str)> {
	let col_indent = count_indent_columns(line);
	let trimmed = line.trim_start();

	if let Some(rest) = trimmed
		.strip_prefix("- ")
		.or_else(|| trimmed.strip_prefix("* "))
		.or_else(|| trimmed.strip_prefix("+ "))
	{
		let depth = (col_indent / 2).min(5) as u8;
		let text_col_indent = col_indent + 2;
		return Some((ListKind::Bullet, depth, text_col_indent, rest));
	}

	let digit_count = trimmed.bytes().take_while(|b| b.is_ascii_digit()).count();
	if (1..=9).contains(&digit_count) {
		let after_digits = &trimmed[digit_count..];
		if let Some(rest) = after_digits
			.strip_prefix(". ")
			.or_else(|| after_digits.strip_prefix(") "))
			&& let Ok(num) = trimmed[..digit_count].parse::<u32>()
		{
			let depth = (col_indent / 2).min(5) as u8;
			let text_col_indent = col_indent + digit_count + 2;
			return Some((ListKind::Ordered(num), depth, text_col_indent, rest));
		}
	}

	None
}

pub(super) fn parse_list(lines: &[&str], start: usize) -> (Vec<Item>, usize) {
	let mut items = Vec::new();
	let mut i = start;

	while i < lines.len() {
		let line = lines[i];
		if is_blank(line) {
			break;
		}

		let Some((kind, depth, text_col_indent, content)) = parse_list_marker(line) else {
			break;
		};

		let mut item_raw_text = content.to_string();
		let mut done = None;

		let trimmed_content = item_raw_text.trim_start();
		if trimmed_content.starts_with("[ ]")
			&& (trimmed_content.len() == 3
				|| trimmed_content[3..].starts_with(' ')
				|| trimmed_content[3..].starts_with('\t'))
		{
			done = Some(false);
			item_raw_text = trimmed_content[3..].trim_start().to_string();
		} else if (trimmed_content.starts_with("[x]") || trimmed_content.starts_with("[X]"))
			&& (trimmed_content.len() == 3
				|| trimmed_content[3..].starts_with(' ')
				|| trimmed_content[3..].starts_with('\t'))
		{
			done = Some(true);
			item_raw_text = trimmed_content[3..].trim_start().to_string();
		}

		i += 1;

		while i < lines.len() {
			let next_line = lines[i];
			if is_blank(next_line) {
				break;
			}
			if parse_list_marker(next_line).is_some() {
				break;
			}
			if is_fenced_code_start(next_line)
				|| parse_atx_heading(next_line).is_some()
				|| is_thematic_break(next_line)
				|| is_blockquote_line(next_line)
			{
				break;
			}
			let next_col_indent = count_indent_columns(next_line);
			if next_col_indent >= text_col_indent {
				item_raw_text.push(' ');
				item_raw_text.push_str(next_line.trim());
				i += 1;
			} else {
				break;
			}
		}

		let spans = inline(&item_raw_text);
		items.push(Item { kind, depth, spans, done });
	}

	(items, i)
}
