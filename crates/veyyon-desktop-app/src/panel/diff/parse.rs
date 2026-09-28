//! A unified diff read into files, hunks and lines.
//!
//! Every line's text is a byte range of the host's diff string, so parsing a
//! megabyte of diff copies none of it. Each line also records where it sits
//! in the text of the file side it belongs to, the old file's for a removed
//! line and the new file's for an added or context line, which is what a
//! highlighter parses: the side text is the side's lines joined in order.

use std::{ops::Range, sync::Arc};

use veyyon_desktop_model::{ChangeStatus, ChangesView};

/// What one line of a file's diff is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LineKind {
	/// An `@@ -a,b +c,d @@` hunk header; its text is the whole line.
	Hunk,
	/// Unchanged text shown for context.
	Context,
	/// A line the change adds.
	Added,
	/// A line the change removes.
	Removed,
	/// A `\ No newline at end of file` marker.
	Note,
}

/// One line of a file's diff.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiffLine {
	pub kind: LineKind,
	/// The line's number in the old file.
	pub old:  Option<u32>,
	/// The line's number in the new file.
	pub new:  Option<u32>,
	/// The line's text without its sign, as a range of the diff string.
	pub text: Range<usize>,
	/// Where the line starts in its side's text.
	pub at:   usize,
}

/// Which version of a file a line belongs to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Side {
	Old,
	New,
}

impl DiffLine {
	/// The side whose text holds this line, `None` for a header or a note.
	pub const fn side(&self) -> Option<Side> {
		match self.kind {
			LineKind::Removed => Some(Side::Old),
			LineKind::Added | LineKind::Context => Some(Side::New),
			LineKind::Hunk | LineKind::Note => None,
		}
	}
}

/// One file of the diff.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiffFile {
	pub path:          String,
	pub previous_path: Option<String>,
	/// The status the host's file list states, absent for a file the list
	/// does not carry.
	pub status:        Option<ChangeStatus>,
	pub additions:     u64,
	pub deletions:     u64,
	/// Git reported a binary difference, which has no lines.
	pub binary:        bool,
	pub lines:         Vec<DiffLine>,
	/// Indices into `lines` of the hunk headers.
	pub hunks:         Vec<usize>,
}

impl DiffFile {
	const fn new(path: String) -> Self {
		Self {
			path,
			previous_path: None,
			status: None,
			additions: 0,
			deletions: 0,
			binary: false,
			lines: Vec::new(),
			hunks: Vec::new(),
		}
	}

	/// The text of `side`: its lines in order, each followed by a newline.
	/// Every line's [`DiffLine::at`] is an offset into this string.
	pub fn side_text(&self, source: &str, side: Side) -> String {
		let mut text = String::new();
		for line in &self.lines {
			let belongs = match side {
				Side::Old => matches!(line.kind, LineKind::Removed | LineKind::Context),
				Side::New => matches!(line.kind, LineKind::Added | LineKind::Context),
			};
			if belongs {
				text.push_str(source.get(line.text.clone()).unwrap_or_default());
				text.push('\n');
			}
		}
		text
	}
}

/// A diff string and the files it parsed into.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ParsedDiff {
	pub source:    Arc<str>,
	pub files:     Vec<DiffFile>,
	/// The diff string stops short of the scope's full diff.
	pub truncated: bool,
	/// Changed files the host held back at its file budget.
	pub withheld:  u64,
}

/// Parses the host's changes into files. A file the list names and the diff
/// string does not carry is kept with no lines, after the ones it does.
pub fn parse(view: &ChangesView) -> ParsedDiff {
	let source: Arc<str> = Arc::from(view.diff.as_str());
	let mut files = parse_files(&source);
	for file in &mut files {
		if let Some(listed) = view.files.iter().find(|listed| listed.path == file.path) {
			file.status = Some(listed.status);
			file.previous_path.clone_from(&listed.previous_path);
			file.additions = listed.additions;
			file.deletions = listed.deletions;
		}
	}
	for listed in &view.files {
		if !files.iter().any(|file| file.path == listed.path) {
			let mut file = DiffFile::new(listed.path.clone());
			file.status = Some(listed.status);
			file.previous_path.clone_from(&listed.previous_path);
			file.additions = listed.additions;
			file.deletions = listed.deletions;
			files.push(file);
		}
	}
	ParsedDiff { source, files, truncated: view.diff_truncated, withheld: view.files_withheld }
}

/// The hunk being read: how many old and new lines it still owes, and the
/// next line number on each side.
struct Hunk {
	old_left: u32,
	new_left: u32,
	old_next: u32,
	new_next: u32,
}

/// Parses every file of a unified diff, `git diff` headers or plain `---`
/// and `+++` pairs alike.
fn parse_files(source: &str) -> Vec<DiffFile> {
	let mut files: Vec<DiffFile> = Vec::new();
	let mut hunk: Option<Hunk> = None;
	let mut offsets = (0usize, 0usize);
	let mut start = 0;
	for raw in source.split_inclusive('\n') {
		let line_start = start;
		start += raw.len();
		let line = raw.strip_suffix('\n').unwrap_or(raw);
		let line = line.strip_suffix('\r').unwrap_or(line);
		let body = line_start + 1..line_start + line.len();
		if let Some(open) = hunk.as_mut() {
			let Some(file) = files.last_mut() else { break };
			let (kind, old, new) = match line.as_bytes().first() {
				Some(b' ') | None => (LineKind::Context, Some(open.old_next), Some(open.new_next)),
				Some(b'-') => (LineKind::Removed, Some(open.old_next), None),
				Some(b'+') => (LineKind::Added, None, Some(open.new_next)),
				Some(b'\\') => (LineKind::Note, None, None),
				Some(_) => {
					hunk = None;
					header_line(&mut files, line, line_start, &mut hunk, &mut offsets);
					continue;
				},
			};
			let body = if line.is_empty() {
				line_start..line_start
			} else {
				body
			};
			let at = if kind == LineKind::Removed {
				offsets.0
			} else {
				offsets.1
			};
			if matches!(kind, LineKind::Removed | LineKind::Context) {
				offsets.0 += body.len() + 1;
				open.old_left = open.old_left.saturating_sub(1);
				open.old_next += 1;
			}
			if matches!(kind, LineKind::Added | LineKind::Context) {
				offsets.1 += body.len() + 1;
				open.new_left = open.new_left.saturating_sub(1);
				open.new_next += 1;
			}
			file.lines.push(DiffLine { kind, old, new, text: body, at });
			if open.old_left == 0 && open.new_left == 0 {
				hunk = None;
			}
			continue;
		}
		if let Some((old_next, old_left, new_next, new_left)) = hunk_header(line) {
			if files.is_empty() {
				files.push(DiffFile::new(String::new()));
			}
			if let Some(file) = files.last_mut() {
				file.hunks.push(file.lines.len());
				file.lines.push(DiffLine {
					kind: LineKind::Hunk,
					old:  None,
					new:  None,
					text: line_start..line_start + line.len(),
					at:   0,
				});
			}
			if old_left > 0 || new_left > 0 {
				hunk = Some(Hunk { old_left, new_left, old_next, new_next });
			}
			continue;
		}
		header_line(&mut files, line, line_start, &mut hunk, &mut offsets);
	}
	for file in &mut files {
		if file.additions == 0 && file.deletions == 0 {
			file.additions = count(file, LineKind::Added);
			file.deletions = count(file, LineKind::Removed);
		}
	}
	files.retain(|file| !file.path.is_empty() || !file.lines.is_empty());
	files
}

fn count(file: &DiffFile, kind: LineKind) -> u64 {
	file.lines.iter().filter(|line| line.kind == kind).count() as u64
}

/// Reads one line outside a hunk, `start` bytes into the diff: a file
/// header, header metadata, or the no-newline marker after a hunk's last
/// line.
fn header_line(
	files: &mut Vec<DiffFile>,
	line: &str,
	start: usize,
	hunk: &mut Option<Hunk>,
	offsets: &mut (usize, usize),
) {
	if let Some(rest) = line.strip_prefix("diff --git ") {
		*hunk = None;
		*offsets = (0, 0);
		let path = rest
			.rsplit_once(" b/")
			.map_or(rest, |(_, new)| new)
			.to_owned();
		files.push(DiffFile::new(path));
		return;
	}
	if let Some(old) = line.strip_prefix("--- ") {
		let starts_file = files
			.last()
			.is_none_or(|file| !file.lines.is_empty() || file.binary);
		if starts_file {
			*offsets = (0, 0);
			files.push(DiffFile::new(strip_side(old).unwrap_or_default().to_owned()));
		}
		return;
	}
	let Some(file) = files.last_mut() else { return };
	if let Some(new) = line.strip_prefix("+++ ") {
		if let Some(path) = strip_side(new) {
			path.clone_into(&mut file.path);
		}
	} else if let Some(from) = line.strip_prefix("rename from ") {
		file.previous_path = Some(from.to_owned());
	} else if let Some(to) = line.strip_prefix("rename to ") {
		to.clone_into(&mut file.path);
	} else if line.starts_with("Binary files ") || line == "GIT binary patch" {
		file.binary = true;
	} else if line.starts_with('\\') && !file.lines.is_empty() {
		let text = start + 1..start + line.len();
		file
			.lines
			.push(DiffLine { kind: LineKind::Note, old: None, new: None, text, at: 0 });
	}
}

/// The path of a `---`/`+++` header, without its `a/` or `b/` prefix and
/// without a trailing tab-separated timestamp; `None` for `/dev/null`.
fn strip_side(header: &str) -> Option<&str> {
	let path = header.split('\t').next().unwrap_or(header).trim_end();
	if path == "/dev/null" {
		return None;
	}
	Some(
		path
			.strip_prefix("a/")
			.or_else(|| path.strip_prefix("b/"))
			.unwrap_or(path),
	)
}

/// The start and count of each side of an `@@ -a,b +c,d @@` header.
fn hunk_header(line: &str) -> Option<(u32, u32, u32, u32)> {
	let rest = line.strip_prefix("@@ -")?;
	let (ranges, _) = rest.split_once(" @@")?;
	let (old, new) = ranges.split_once(" +")?;
	let (old_start, old_count) = range(old)?;
	let (new_start, new_count) = range(new)?;
	Some((old_start, old_count, new_start, new_count))
}

fn range(text: &str) -> Option<(u32, u32)> {
	match text.split_once(',') {
		Some((start, count)) => Some((start.parse().ok()?, count.parse().ok()?)),
		None => Some((text.parse().ok()?, 1)),
	}
}

#[cfg(test)]
#[path = "parse_tests.rs"]
mod tests;
