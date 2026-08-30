//! Unified diff as a transcript needs it: files, hunks, and lines with the
//! numbers they take on each side.
//!
//! A patch reaches the window from a tool result or from a fence in a message,
//! which means it can be truncated, prefixed with `a/` and `b/`, quoted with C
//! escapes, binary, a rename with no body, or not a patch at all. Every one of
//! those has a reading here, and none of them is an error: the worst case is a
//! file with no hunks, which draws as a header.

mod file;
mod header;

use file::parse_file;

/// What a diff line does to the file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineKind {
	Context,
	Added,
	Removed,
}

/// One line inside a hunk, with the numbers it takes on each side.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffLine {
	pub kind:       LineKind,
	pub text:       String,
	pub old_no:     Option<u32>,
	pub new_no:     Option<u32>,
	/// Set when the source marked this line as having no trailing newline.
	pub no_newline: bool,
}

/// One `@@` run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hunk {
	pub old_start: u32,
	pub old_len:   u32,
	pub new_start: u32,
	pub new_len:   u32,
	/// The text after the closing `@@`, which git fills with the enclosing
	/// function or section.
	pub section:   String,
	pub lines:     Vec<DiffLine>,
}

/// What happened to one file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Change {
	Added,
	Removed,
	Renamed,
	Modified,
}

/// One file's worth of a patch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileDiff {
	pub old_path: String,
	pub new_path: String,
	pub change:   Change,
	pub hunks:    Vec<Hunk>,
	/// Set for `Binary files … differ`, where there are no hunks to draw.
	pub binary:   bool,
	/// The mode line's value when the patch carries one.
	pub mode:     Option<String>,
}

impl FileDiff {
	/// The path to name this file by: the new one unless it was removed.
	pub fn path(&self) -> &str {
		if self.change == Change::Removed {
			&self.old_path
		} else if !self.new_path.is_empty() {
			&self.new_path
		} else {
			&self.old_path
		}
	}

	/// How many lines this patch adds.
	pub fn added(&self) -> usize {
		self
			.hunks
			.iter()
			.map(|h| h.lines.iter().filter(|l| l.kind == LineKind::Added).count())
			.sum()
	}

	/// How many lines it removes.
	pub fn removed(&self) -> usize {
		self
			.hunks
			.iter()
			.map(|h| {
				h.lines
					.iter()
					.filter(|l| l.kind == LineKind::Removed)
					.count()
			})
			.sum()
	}
}

/// Split patch text into files.
pub fn parse(text: &str) -> Vec<FileDiff> {
	if text.is_empty() {
		return Vec::new();
	}
	let lines: Vec<&str> = text.lines().collect();

	let mut files = Vec::new();
	let mut i = 0;
	let n = lines.len();

	while i < n {
		let line = lines[i];

		// Three ways a file's body can begin, and one reading of all three: a
		// git header, a plain `---`/`+++` pair, or a bare hunk from a patch
		// somebody pasted without its header.
		let opens_a_file = line.starts_with("diff --git ")
			|| line.starts_with("--- ")
			|| line.starts_with("@@ ")
			|| (line.starts_with("@@") && line.contains(" -") && line.contains(" +"));
		if opens_a_file {
			let (file_diff, next_i) = parse_file(&lines, i);
			files.push(file_diff);
			i = next_i;
		} else {
			i += 1;
		}
	}

	files
}

/// Whether text looks like a patch, for deciding how to draw a fenced block
/// whose info string does not say.
pub fn looks_like_a_patch(text: &str) -> bool {
	let mut has_header = false;
	let mut has_plus_or_minus = false;

	for line in text.lines() {
		let trimmed_line = line.strip_suffix('\r').unwrap_or(line);
		if trimmed_line.starts_with("diff --git ")
			|| (trimmed_line.starts_with("@@ -") && trimmed_line.contains(" +"))
		{
			has_header = true;
		}
		if trimmed_line.starts_with('+') || trimmed_line.starts_with('-') {
			has_plus_or_minus = true;
		}
		if has_header && has_plus_or_minus {
			return true;
		}
	}

	false
}

#[cfg(test)]
mod tests;
