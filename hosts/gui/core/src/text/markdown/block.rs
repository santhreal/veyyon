//! Block structure: what a line begins, and where it ends.

use super::{
	Md, Span,
	inline::inline,
	list::{parse_list, parse_list_marker},
	table::{is_table_delimiter, parse_table},
};

/// Split message text into blocks.
pub fn parse(text: &str) -> Vec<Md> {
	let lines: Vec<&str> = text.lines().collect();
	let mut blocks = Vec::new();
	let mut i = 0;

	while i < lines.len() {
		let line = lines[i];

		if is_blank(line) {
			i += 1;
			continue;
		}

		if let Some((lang, body, next_i)) = parse_fenced_code(&lines, i) {
			blocks.push(Md::Code { lang, body });
			i = next_i;
			continue;
		}

		if let Some((level, spans)) = parse_atx_heading(line) {
			blocks.push(Md::Heading { level, spans });
			i += 1;
			continue;
		}

		if is_thematic_break(line) {
			blocks.push(Md::Rule);
			i += 1;
			continue;
		}

		if is_blockquote_line(line) {
			let (quote_lines, next_i) = collect_blockquote_lines(&lines, i);
			let quote_text = quote_lines.join("\n");
			let inner_blocks = parse(&quote_text);
			blocks.push(Md::Quote(inner_blocks));
			i = next_i;
			continue;
		}

		if parse_list_marker(line).is_some() {
			let (items, next_i) = parse_list(&lines, i);
			blocks.push(Md::List(items));
			i = next_i;
			continue;
		}

		if let Some((head, rows, next_i)) = parse_table(&lines, i) {
			blocks.push(Md::Table { head, rows });
			i = next_i;
			continue;
		}

		let (p_block, next_i) = parse_paragraph_or_setext(&lines, i);
		blocks.push(p_block);
		i = next_i;
	}

	blocks
}

pub(super) fn is_blank(line: &str) -> bool {
	line.trim().is_empty()
}

pub(super) fn count_indent_columns(line: &str) -> usize {
	let mut cols = 0;
	for b in line.bytes() {
		if b == b' ' {
			cols += 1;
		} else if b == b'\t' {
			cols += 3;
		} else {
			break;
		}
	}
	cols
}

fn strip_indent_columns(line: &str, max_cols: usize) -> &str {
	let mut stripped = 0;
	let mut byte_offset = 0;
	for (idx, ch) in line.char_indices() {
		if stripped >= max_cols {
			break;
		}
		if ch == ' ' {
			stripped += 1;
			byte_offset = idx + 1;
		} else if ch == '\t' {
			stripped += 3;
			byte_offset = idx + 1;
		} else {
			break;
		}
	}
	&line[byte_offset..]
}

fn parse_fenced_code(lines: &[&str], start: usize) -> Option<(String, String, usize)> {
	let first_line = lines[start];
	let indent_cols = count_indent_columns(first_line);
	let trimmed_start = first_line.trim_start();

	let fence_char = trimmed_start.as_bytes().first().copied()?;
	if fence_char != b'`' && fence_char != b'~' {
		return None;
	}

	let fence_count = trimmed_start
		.bytes()
		.take_while(|&b| b == fence_char)
		.count();
	if fence_count < 3 {
		return None;
	}

	let info_part = &trimmed_start[fence_count..];
	let lang = info_part.trim().to_lowercase();

	let mut body_lines = Vec::new();
	let mut i = start + 1;

	while i < lines.len() {
		let line = lines[i];
		let trimmed_line = line.trim_start();
		if trimmed_line.starts_with(fence_char as char) {
			let count = trimmed_line
				.bytes()
				.take_while(|&b| b == fence_char)
				.count();
			if count >= fence_count && trimmed_line[count..].trim().is_empty() {
				i += 1;
				return Some((lang, body_lines.join("\n"), i));
			}
		}
		let stripped_line = strip_indent_columns(line, indent_cols);
		body_lines.push(stripped_line);
		i += 1;
	}

	Some((lang, body_lines.join("\n"), i))
}

pub(super) fn parse_atx_heading(line: &str) -> Option<(u8, Vec<Span>)> {
	let trimmed = line.trim_start();
	if !trimmed.starts_with('#') {
		return None;
	}

	let level = trimmed.bytes().take_while(|&b| b == b'#').count();
	if !(1..=6).contains(&level) {
		return None;
	}

	let after_hashes = &trimmed[level..];
	if !after_hashes.is_empty() && !after_hashes.starts_with(' ') && !after_hashes.starts_with('\t')
	{
		return None;
	}

	let mut content = after_hashes.trim();
	if let Some(hash_start) = content.rfind(|c| c != '#' && c != ' ' && c != '\t') {
		let trailing_part = &content[hash_start + 1..];
		if trailing_part.trim_start().starts_with('#') && trailing_part.trim_end().ends_with('#') {
			content = content[..hash_start + 1].trim();
		}
	} else if content.chars().all(|c| c == '#' || c == ' ' || c == '\t') {
		content = "";
	}

	Some((level as u8, inline(content)))
}

pub(super) fn is_thematic_break(line: &str) -> bool {
	let trimmed = line.trim();
	if trimmed.is_empty() {
		return false;
	}
	let first = trimmed.chars().next().unwrap_or(' ');
	if first != '-' && first != '*' && first != '_' {
		return false;
	}
	let mut count = 0;
	for ch in trimmed.chars() {
		if ch == first {
			count += 1;
		} else if ch != ' ' && ch != '\t' {
			return false;
		}
	}
	count >= 3
}

pub(super) fn is_blockquote_line(line: &str) -> bool {
	let trimmed = line.trim_start();
	trimmed.starts_with('>')
}

fn strip_blockquote_prefix(line: &str) -> &str {
	let trimmed = line.trim_start();
	if let Some(rest) = trimmed.strip_prefix('>') {
		if let Some(after_space) = rest.strip_prefix(' ') {
			after_space
		} else {
			rest
		}
	} else {
		line
	}
}

fn collect_blockquote_lines<'a>(lines: &[&'a str], start: usize) -> (Vec<&'a str>, usize) {
	let mut quote_lines = Vec::new();
	let mut i = start;
	while i < lines.len() {
		let line = lines[i];
		if is_blank(line) || !is_blockquote_line(line) {
			break;
		}
		quote_lines.push(strip_blockquote_prefix(line));
		i += 1;
	}
	(quote_lines, i)
}

pub(super) fn is_fenced_code_start(line: &str) -> bool {
	let trimmed = line.trim_start();
	trimmed.starts_with("```") || trimmed.starts_with("~~~")
}

fn parse_paragraph_or_setext(lines: &[&str], start: usize) -> (Md, usize) {
	let mut p_lines = vec![lines[start].trim()];
	let mut i = start + 1;

	if i < lines.len() {
		let next_line = lines[i];
		let trimmed_next = next_line.trim();
		if !trimmed_next.is_empty() {
			if trimmed_next.chars().all(|c| c == '=') {
				let spans = inline(p_lines[0]);
				return (Md::Heading { level: 1, spans }, i + 1);
			}
			if trimmed_next.len() >= 2 && trimmed_next.chars().all(|c| c == '-') {
				let spans = inline(p_lines[0]);
				return (Md::Heading { level: 2, spans }, i + 1);
			}
		}
	}

	while i < lines.len() {
		let line = lines[i];
		if is_blank(line)
			|| is_fenced_code_start(line)
			|| parse_atx_heading(line).is_some()
			|| is_thematic_break(line)
			|| is_blockquote_line(line)
			|| parse_list_marker(line).is_some()
			|| (line.contains('|') && i + 1 < lines.len() && is_table_delimiter(lines[i + 1]))
		{
			break;
		}
		p_lines.push(line.trim());
		i += 1;
	}

	let joined = p_lines.join(" ");
	(Md::Paragraph(inline(&joined)), i)
}
