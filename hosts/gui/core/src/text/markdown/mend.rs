//! Mends half-streamed markdown so unterminated constructs parse as the shape
//! they are becoming rather than as literal text.

use super::{mend_inline::mend_inline, table::is_table_delimiter};

/// Sentinel destination URL for a link whose href is still streaming.
pub const PENDING_LINK_URL: &str = "veyyon:pending-link";

/// One kind of repair applied to complete an unclosed construct.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RepairKind {
	/// Closed an unclosed fenced code block (``` or ~~~).
	CodeFence,
	/// Finished an unclosed table row or delimiter line.
	Table,
	/// Completed an unclosed list item marker or task box.
	List,
	/// Closed unclosed inline code backticks.
	InlineCode,
	/// Closed unclosed strong delimiter run (** or __).
	Strong,
	/// Closed unclosed emphasis delimiter (* or _).
	Emphasis,
	/// Closed an unclosed link or image destination or bracket.
	Link,
	/// Prevented setext underline misparse on a trailing - or =.
	SetextGuard,
}

/// All repair kinds for exhaustive variant testing.
pub fn all_repair_kinds() -> &'static [RepairKind] {
	&[
		RepairKind::CodeFence,
		RepairKind::Table,
		RepairKind::List,
		RepairKind::InlineCode,
		RepairKind::Strong,
		RepairKind::Emphasis,
		RepairKind::Link,
		RepairKind::SetextGuard,
	]
}

/// Result of mending markdown text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mended {
	/// Complete well-formed markdown text (input plus appended completions).
	pub text:     String,
	/// Number of bytes appended to complete the document.
	pub appended: usize,
	/// Repairs applied to complete the document.
	pub repairs:  Vec<RepairKind>,
}

impl Mended {
	/// True when synthetic completions were appended.
	pub fn is_repaired(&self) -> bool {
		self.appended > 0
	}

	/// Byte length of the settled input before appended completions.
	pub fn settled_len(&self) -> usize {
		self.text.len().saturating_sub(self.appended)
	}
}

/// Mends streamed markdown text by appending minimal completions.
pub fn mend(text: &str) -> Mended {
	if text.is_empty() {
		return Mended { text: String::new(), appended: 0, repairs: Vec::new() };
	}

	let lines: Vec<&str> = text.lines().collect();
	let mut repairs = Vec::new();

	// 1. Unclosed fenced code blocks take precedence: inside code, inline markdown
	//    is literal.
	if let Some((fc, fcount)) = unclosed_fence(&lines) {
		let mut completion = String::new();
		if !text.ends_with('\n') {
			completion.push('\n');
		}
		for _ in 0..fcount {
			completion.push(fc);
		}
		repairs.push(RepairKind::CodeFence);
		let appended = completion.len();
		return Mended { text: format!("{text}{completion}"), appended, repairs };
	}

	// 2. Block-level tail structures: table, list, setext.
	let (block_suffix, block_repairs) = mend_block_tail(text, &lines);
	repairs.extend(block_repairs);

	// 3. Inline delimiters across prose / headings / lists / table cells.
	let (inline_suffix, inline_repairs) = mend_inline(text);
	repairs.extend(inline_repairs);

	let mut completion = String::new();
	completion.push_str(&inline_suffix);
	completion.push_str(&block_suffix);

	let appended = completion.len();
	Mended {
		text: if appended == 0 {
			text.to_string()
		} else {
			format!("{text}{completion}")
		},
		appended,
		repairs,
	}
}

fn unclosed_fence(lines: &[&str]) -> Option<(char, usize)> {
	let mut active_fence: Option<(char, usize)> = None;

	for line in lines {
		let trimmed = line.trim_start();
		if let Some((fc, fcount)) = active_fence {
			if trimmed.starts_with(fc) {
				let count = trimmed.chars().take_while(|&c| c == fc).count();
				if count >= fcount && trimmed[count..].trim().is_empty() {
					active_fence = None;
				}
			}
		} else if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
			let fc = trimmed.chars().next().unwrap_or('`');
			let fcount = trimmed.chars().take_while(|&c| c == fc).count();
			if fcount >= 3 {
				active_fence = Some((fc, fcount));
			}
		}
	}

	active_fence
}

fn mend_block_tail(text: &str, lines: &[&str]) -> (String, Vec<RepairKind>) {
	let mut suffix = String::new();
	let mut repairs = Vec::new();

	if setext_partial(text) {
		suffix.push('\u{200B}');
		repairs.push(RepairKind::SetextGuard);
		return (suffix, repairs);
	}

	let last_line = lines.last().copied().unwrap_or("");
	let trimmed = last_line.trim_start();

	// List item unclosed task box
	if let Some(rest) = trimmed
		.strip_prefix("- ")
		.or_else(|| trimmed.strip_prefix("* "))
		.or_else(|| trimmed.strip_prefix("+ "))
	{
		let r_trimmed = rest.trim_start();
		if r_trimmed == "[" || r_trimmed == "[ " || r_trimmed == "[x" || r_trimmed == "[X" {
			suffix.push_str("] ");
			repairs.push(RepairKind::List);
		}
	}

	// Table detection at the tail
	let last_blank_idx = lines
		.iter()
		.rposition(|l| l.trim().is_empty())
		.map(|idx| idx + 1)
		.unwrap_or(0);
	let block_lines = &lines[last_blank_idx..];

	if !block_lines.is_empty() {
		let header_line = block_lines[0];
		let is_header_candidate = header_line.contains('|')
			&& !header_line.trim_start().starts_with('#')
			&& !header_line.trim_start().starts_with('>')
			&& !header_line.trim_start().starts_with("```")
			&& !header_line.trim_start().starts_with("~~~");
		if is_header_candidate {
			if block_lines.len() == 1 {
				let col_count = split_table_cols(header_line);
				if col_count > 0 {
					if !header_line.trim_end().ends_with('|') {
						suffix.push_str(" |");
					}
					if !text.ends_with('\n') {
						suffix.push('\n');
					}
					suffix.push('|');
					for _ in 0..col_count {
						suffix.push_str("---|");
					}
					repairs.push(RepairKind::Table);
				}
			} else if block_lines.len() >= 2 {
				let delim_line = block_lines[1];
				if is_table_delimiter(delim_line) {
					let last_row = block_lines[block_lines.len() - 1];
					if !last_row.trim_end().ends_with('|') && last_row.contains('|') {
						suffix.push_str(" |");
						repairs.push(RepairKind::Table);
					}
				}
			}
		}
	}

	(suffix, repairs)
}

fn split_table_cols(line: &str) -> usize {
	let mut count: usize = 0;
	let mut escaped = false;
	for ch in line.chars() {
		if escaped {
			escaped = false;
		} else if ch == '\\' {
			escaped = true;
		} else if ch == '|' {
			count += 1;
		}
	}
	let starts_pipe = line.trim_start().starts_with('|');
	let ends_pipe = line.trim_end().ends_with('|') && !line.trim_end().ends_with(r"\|");
	match (starts_pipe, ends_pipe) {
		(true, true) => count.saturating_sub(1),
		(true, false) | (false, true) => count,
		(false, false) => count + 1,
	}
}

fn setext_partial(text: &str) -> bool {
	let Some(nl) = text.rfind('\n') else {
		return false;
	};
	let last = &text[nl + 1..];
	let trimmed = last.trim_start();
	let underline =
		|c: char| !trimmed.is_empty() && trimmed.len() <= 2 && trimmed.chars().all(|x| x == c);
	(underline('-') || underline('='))
		&& text[..nl]
			.lines()
			.last()
			.is_some_and(|l| !l.trim().is_empty())
}
