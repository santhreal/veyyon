//! A change to files, per hunk and per line.
//!
//! The diff viewer and the plan review's change list are this shape. It is the
//! one shape that is not rows of text: a diff line carries two line numbers,
//! either of which can be absent, and that pair is what makes a diff readable.

/// A titled set of changed files.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Diff {
	pub title:  String,
	pub files:  Vec<DiffFile>,
	pub footer: Option<String>,
}

impl Diff {
	pub fn new(title: impl Into<String>, files: Vec<DiffFile>) -> Diff {
		Diff { title: title.into(), files, footer: None }
	}

	pub fn footer(mut self, footer: impl Into<String>) -> Diff {
		self.footer = Some(footer.into());
		self
	}

	/// Added and removed line counts across every file, which is what the
	/// heading reports.
	pub fn totals(&self) -> (usize, usize) {
		self
			.files
			.iter()
			.fold((0, 0), |(added, removed), file| (added + file.added, removed + file.removed))
	}
}

/// One file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffFile {
	pub path:      String,
	/// The path before a rename, when the file moved.
	pub old_path:  Option<String>,
	pub added:     usize,
	pub removed:   usize,
	pub hunks:     Vec<DiffHunk>,
	/// True when the body is absent because it is binary, too large, or not
	/// fetched. A file with no hunks and no reason reads as an empty change.
	pub collapsed: Option<String>,
}

impl DiffFile {
	pub fn new(path: impl Into<String>, hunks: Vec<DiffHunk>) -> DiffFile {
		let mut file = DiffFile {
			path: path.into(),
			old_path: None,
			added: 0,
			removed: 0,
			hunks,
			collapsed: None,
		};
		let (added, removed) = file.hunks.iter().fold((0, 0), |(added, removed), hunk| {
			(
				added
					+ hunk
						.lines
						.iter()
						.filter(|line| line.kind == DiffLineKind::Added)
						.count(),
				removed
					+ hunk
						.lines
						.iter()
						.filter(|line| line.kind == DiffLineKind::Removed)
						.count(),
			)
		});
		file.added = added;
		file.removed = removed;
		file
	}

	/// A file that moved. The old path is kept rather than folded into the new
	/// one: a rename with no line changes has nothing else to show, and a
	/// renderer that only had the new path would draw it as an untouched file.
	pub fn renamed(
		old_path: impl Into<String>,
		path: impl Into<String>,
		hunks: Vec<DiffHunk>,
	) -> DiffFile {
		DiffFile { old_path: Some(old_path.into()), ..DiffFile::new(path, hunks) }
	}

	/// A file whose body is not shown, and why.
	pub fn collapsed(path: impl Into<String>, reason: impl Into<String>) -> DiffFile {
		DiffFile {
			path:      path.into(),
			old_path:  None,
			added:     0,
			removed:   0,
			hunks:     Vec::new(),
			collapsed: Some(reason.into()),
		}
	}
}

/// One hunk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffHunk {
	/// The `@@ -a,b +c,d @@` line, or whatever the producer calls this range.
	pub header: String,
	pub lines:  Vec<DiffLine>,
}

impl DiffHunk {
	pub fn new(header: impl Into<String>, lines: Vec<DiffLine>) -> DiffHunk {
		DiffHunk { header: header.into(), lines }
	}
}

/// One line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffLine {
	pub kind: DiffLineKind,
	/// Line number on the left, absent for an added line.
	pub old:  Option<u32>,
	/// Line number on the right, absent for a removed line.
	pub new:  Option<u32>,
	pub text: String,
}

impl DiffLine {
	pub fn context(old: u32, new: u32, text: impl Into<String>) -> DiffLine {
		DiffLine { kind: DiffLineKind::Context, old: Some(old), new: Some(new), text: text.into() }
	}

	pub fn added(new: u32, text: impl Into<String>) -> DiffLine {
		DiffLine { kind: DiffLineKind::Added, old: None, new: Some(new), text: text.into() }
	}

	pub fn removed(old: u32, text: impl Into<String>) -> DiffLine {
		DiffLine { kind: DiffLineKind::Removed, old: Some(old), new: None, text: text.into() }
	}
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiffLineKind {
	Context,
	Added,
	Removed,
}

#[cfg(test)]
mod tests {
	//! WHY THIS SUITE EXISTS.
	//!
	//! The counts in a diff heading are derived, not reported: a producer that
	//! sent its own totals could disagree with the lines it sent, and the
	//! heading is what a reviewer trusts. Deriving them means the heading cannot
	//! be wrong about the body, and this pins that they are derived from the
	//! line kinds rather than from the line count.
	//!
	//! WHAT IT DOES NOT CATCH. Whether the line numbers are right. Those come
	//! from the producer and nothing here can check them.

	use super::*;

	#[test]
	fn a_files_counts_come_from_its_line_kinds() {
		let file = DiffFile::new("src/main.rs", vec![DiffHunk::new("@@ -1,3 +1,4 @@", vec![
			DiffLine::context(1, 1, "fn main() {"),
			DiffLine::removed(2, "    old();"),
			DiffLine::added(2, "    new();"),
			DiffLine::added(3, "    also();"),
			DiffLine::context(3, 4, "}"),
		])]);
		assert_eq!((file.added, file.removed), (2, 1));
	}

	#[test]
	fn totals_add_up_across_files_and_ignore_a_collapsed_one() {
		let view = Diff::new("Changes", vec![
			DiffFile::new("a.rs", vec![DiffHunk::new("@@", vec![DiffLine::added(1, "one")])]),
			DiffFile::new("b.rs", vec![DiffHunk::new("@@", vec![DiffLine::removed(1, "two")])]),
			DiffFile::collapsed("logo.png", "binary"),
		]);
		assert_eq!(view.totals(), (1, 1));
	}
}
