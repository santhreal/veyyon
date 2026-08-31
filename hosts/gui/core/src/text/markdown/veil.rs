//! The reveal boundary for streamed markdown.
//!
//! Given the previous prefix and the current prefix, states the byte offset up
//! to which the document is settled (guaranteed not to reflow or alter its
//! block or span structure on future deltas) and what is still provisional.
//!
//! Settled text must never reflow: the boundary only moves forward, and a
//! repair that appended a closer does not settle that closer.

use super::mend::mend;

/// Reveal boundary for a streamed markdown document.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Veil {
	/// Byte offset in the current raw text up to which content is settled.
	pub settled: usize,
}

impl Veil {
	/// Create a new veil at the given settled byte offset.
	pub const fn new(settled: usize) -> Self {
		Self { settled }
	}

	/// Whether the entire current document is settled.
	pub fn is_fully_settled(&self, current_len: usize) -> bool {
		self.settled >= current_len
	}

	/// Returns the settled slice of the text.
	pub fn settled_str<'a>(&self, text: &'a str) -> &'a str {
		let end = self.settled.min(text.len());
		&text[..end]
	}

	/// Returns the provisional slice of the text.
	pub fn provisional_str<'a>(&self, text: &'a str) -> &'a str {
		let start = self.settled.min(text.len());
		&text[start..]
	}
}

/// Compute the reveal boundary given the previous state and the current
/// streamed text.
///
/// `prev_text`: text from the prior delta.
/// `prev_settled`: settled byte offset from the prior delta.
/// `current_text`: text of the current delta (raw, before mending).
pub fn reveal_boundary(prev_text: &str, prev_settled: usize, current_text: &str) -> Veil {
	let common = common_prefix_len(prev_text, current_text);
	let base_settled = prev_settled.min(common);

	let raw_computed = compute_settled_offset(current_text);
	let mut settled = base_settled.max(raw_computed);

	settled = settled.min(current_text.len());
	while settled > 0 && !current_text.is_char_boundary(settled) {
		settled -= 1;
	}

	Veil::new(settled)
}

fn common_prefix_len(a: &str, b: &str) -> usize {
	let mut p = a
		.as_bytes()
		.iter()
		.zip(b.as_bytes())
		.take_while(|(x, y)| x == y)
		.count();
	while p > 0 && !b.is_char_boundary(p) {
		p -= 1;
	}
	p
}

/// Compute how far into `text` content is settled based on block and inline
/// boundaries.
fn compute_settled_offset(text: &str) -> usize {
	if text.is_empty() {
		return 0;
	}

	let mended = mend(text);
	let max_settled = text.len();

	let lines: Vec<&str> = text.lines().collect();
	let mut settled = 0;
	let mut in_code_fence = false;
	let mut fence_char = '`';
	let mut fence_len = 0;
	let mut current_offset = 0;

	for line in &lines {
		let line_len = line.len();
		let trimmed = line.trim_start();

		if in_code_fence {
			if trimmed.starts_with(fence_char) {
				let count = trimmed.chars().take_while(|&c| c == fence_char).count();
				if count >= fence_len && trimmed[count..].trim().is_empty() {
					in_code_fence = false;
					settled = current_offset + line_len;
				}
			}
		} else if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
			fence_char = trimmed.chars().next().unwrap_or('`');
			fence_len = trimmed.chars().take_while(|&c| c == fence_char).count();
			if fence_len >= 3 {
				in_code_fence = true;
			}
		} else if trimmed.is_empty() {
			settled = current_offset + line_len;
		}

		current_offset += line_len;
		if current_offset < text.len() && text.as_bytes()[current_offset] == b'\r' {
			current_offset += 1;
		}
		if current_offset < text.len() && text.as_bytes()[current_offset] == b'\n' {
			current_offset += 1;
		}
	}

	if !mended.is_repaired() {
		if text.ends_with('\n') {
			settled = max_settled;
		} else if let Some(last_ws) = text.rfind(|c: char| c.is_whitespace()) {
			settled = settled.max(last_ws + 1);
		}
	}

	settled.min(max_settled)
}
