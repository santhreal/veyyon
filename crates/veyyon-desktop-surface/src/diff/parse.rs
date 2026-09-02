//! Unified diff parser (§5.11).
//!
//! Parses raw unified diff text into structured `DiffFile`s and `DiffRow`s,
//! calculating additions, deletions, intraline highlights, and enforcing the
//! 2,000 changed-row ceiling.

use veyyon_desktop_model::ChangeStatus;

use crate::{
	diff::intraline::pair_intraline,
	right_panel::{DiffFile, DiffRow},
};

/// Maximum number of changed lines parsed before appending a truncation row.
pub const CHANGED_ROWS_CAP: usize = 2000;

/// Parses a multi-file unified git diff string into structured `DiffFile`
/// models.
#[must_use]
pub fn parse_diff(text: &str) -> Vec<DiffFile> {
	if text.trim().is_empty() {
		return Vec::new();
	}

	let mut files = Vec::new();
	let mut current_file: Option<FileBuilder> = None;

	for line in text.lines() {
		if line.starts_with("diff --git ") {
			if let Some(builder) = current_file.take() {
				files.push(builder.finish());
			}
			current_file = Some(FileBuilder::from_git_header(line));
		} else if let Some(builder) = &mut current_file {
			builder.feed_line(line);
		} else if line.starts_with("--- ") || line.starts_with("@@ ") {
			// Bare diff without `diff --git` header
			let mut builder = FileBuilder::default();
			builder.feed_line(line);
			current_file = Some(builder);
		}
	}

	if let Some(builder) = current_file {
		files.push(builder.finish());
	}

	files
}

#[derive(Default)]
struct FileBuilder {
	path:             String,
	old_path:         Option<String>,
	status:           Option<ChangeStatus>,
	additions:        usize,
	deletions:        usize,
	rows:             Vec<DiffRow>,
	current_old_line: usize,
	current_new_line: usize,
	pending_removed:  Vec<(usize, String)>,
	pending_added:    Vec<(usize, String)>,
	total_changed:    usize,
	truncated:        bool,
}

impl FileBuilder {
	fn from_git_header(line: &str) -> Self {
		let parts: Vec<&str> = line.split_whitespace().collect();
		let mut path = String::new();
		let mut old_path = None;

		if parts.len() >= 4 {
			let a_path = parts[2].strip_prefix("a/").unwrap_or(parts[2]);
			let b_path = parts[3].strip_prefix("b/").unwrap_or(parts[3]);
			path = b_path.to_string();
			if a_path != b_path {
				old_path = Some(a_path.to_string());
			}
		}

		Self { path, old_path, ..Self::default() }
	}

	fn feed_line(&mut self, line: &str) {
		if self.truncated {
			if line.starts_with('+') && !line.starts_with("+++") {
				self.additions += 1;
				self.total_changed += 1;
			} else if line.starts_with('-') && !line.starts_with("---") {
				self.deletions += 1;
				self.total_changed += 1;
			}
			return;
		}

		if line.starts_with("new file mode") {
			self.status = Some(ChangeStatus::Added);
		} else if line.starts_with("deleted file mode") {
			self.status = Some(ChangeStatus::Deleted);
		} else if line.starts_with("rename from ") {
			let old = line.trim_start_matches("rename from ").trim();
			self.old_path = Some(old.to_string());
			self.status = Some(ChangeStatus::Renamed);
		} else if line.starts_with("rename to ") {
			let new = line.trim_start_matches("rename to ").trim();
			self.path = new.to_string();
			self.status = Some(ChangeStatus::Renamed);
		} else if line.starts_with("--- ") {
			let p = line.trim_start_matches("--- ").trim();
			if p == "/dev/null" {
				self.status = Some(ChangeStatus::Added);
			} else if self.path.is_empty() {
				self.path = p.strip_prefix("a/").unwrap_or(p).to_string();
			}
		} else if line.starts_with("+++ ") {
			let p = line.trim_start_matches("+++ ").trim();
			if p == "/dev/null" {
				self.status = Some(ChangeStatus::Deleted);
			} else if p != "/dev/null" {
				self.path = p.strip_prefix("b/").unwrap_or(p).to_string();
			}
		} else if line.starts_with("Binary files ") || line.starts_with("GIT binary patch") {
			self.flush_pending();
			self
				.rows
				.push(DiffRow::Binary { message: line.to_string() });
		} else if line.starts_with("@@ ") {
			self.flush_pending();
			self.parse_hunk_header(line);
		} else if let Some(stripped) = line.strip_prefix('+') {
			let text = stripped.to_string();
			let new_line = self.current_new_line;
			self.current_new_line += 1;
			self.additions += 1;
			self.total_changed += 1;

			if self.total_changed > CHANGED_ROWS_CAP {
				self.flush_pending();
				self.truncated = true;
				return;
			}
			self.pending_added.push((new_line, text));
		} else if let Some(stripped) = line.strip_prefix('-') {
			let text = stripped.to_string();
			let old_line = self.current_old_line;
			self.current_old_line += 1;
			self.deletions += 1;
			self.total_changed += 1;

			if self.total_changed > CHANGED_ROWS_CAP {
				self.flush_pending();
				self.truncated = true;
				return;
			}
			self.pending_removed.push((old_line, text));
		} else if line.starts_with(' ') || (line.is_empty() && !self.rows.is_empty()) {
			self.flush_pending();
			let text = if line.is_empty() {
				String::new()
			} else {
				line[1..].to_string()
			};
			let old_line = self.current_old_line;
			let new_line = self.current_new_line;
			self.current_old_line += 1;
			self.current_new_line += 1;
			self
				.rows
				.push(DiffRow::Context { old_line, new_line, text });
		} else if line.starts_with(r"\ No newline") {
			// Meta note, ignore
		}
	}

	fn parse_hunk_header(&mut self, line: &str) {
		// @@ -old_start,old_count +new_start,new_count @@ symbol
		let Some(after_first) = line.strip_prefix("@@ -") else {
			return;
		};
		let Some((spec, rest)) = after_first.split_once(" @@") else {
			return;
		};
		let symbol = rest.trim();
		let symbol = if symbol.is_empty() {
			None
		} else {
			Some(symbol.to_string())
		};

		let parts: Vec<&str> = spec.split(" +").collect();
		if parts.len() != 2 {
			return;
		}

		let (old_start, old_count) = parse_range(parts[0]);
		let (new_start, new_count) = parse_range(parts[1]);

		self.current_old_line = old_start;
		self.current_new_line = new_start;

		self
			.rows
			.push(DiffRow::HunkHeader { old_start, old_count, new_start, new_count, symbol });
	}

	fn flush_pending(&mut self) {
		if self.pending_removed.is_empty() && self.pending_added.is_empty() {
			return;
		}

		let removed = std::mem::take(&mut self.pending_removed);
		let added = std::mem::take(&mut self.pending_added);
		let pairs = removed.len().min(added.len());

		for (i, (old_line, text)) in removed.into_iter().enumerate() {
			let intraline = if i < pairs {
				pair_intraline(&text, &added[i].1).0
			} else {
				Vec::new()
			};
			self
				.rows
				.push(DiffRow::Removed { old_line, text, intraline });
		}

		for (i, (new_line, text)) in added.into_iter().enumerate() {
			let intraline = if i < pairs {
				if let Some(DiffRow::Removed { text: old_text, .. }) =
					self.rows.get(self.rows.len() - (pairs - i))
				{
					pair_intraline(old_text, &text).1
				} else {
					Vec::new()
				}
			} else {
				Vec::new()
			};
			self.rows.push(DiffRow::Added { new_line, text, intraline });
		}
	}

	fn finish(mut self) -> DiffFile {
		self.flush_pending();
		if self.truncated && self.total_changed > CHANGED_ROWS_CAP {
			let remaining = self.total_changed - CHANGED_ROWS_CAP;
			self.rows.push(DiffRow::Truncated { remaining });
		}

		let status = self.status.unwrap_or({
			if self.additions > 0 && self.deletions == 0 {
				ChangeStatus::Added
			} else if self.deletions > 0 && self.additions == 0 {
				ChangeStatus::Deleted
			} else {
				ChangeStatus::Modified
			}
		});

		DiffFile {
			path: self.path,
			old_path: self.old_path,
			status,
			additions: self.additions,
			deletions: self.deletions,
			rows: self.rows,
		}
	}
}

fn parse_range(range_str: &str) -> (usize, usize) {
	if let Some((start_s, count_s)) = range_str.split_once(',') {
		let start = start_s.parse::<usize>().unwrap_or(1);
		let count = count_s.parse::<usize>().unwrap_or(1);
		(start, count)
	} else {
		let start = range_str.parse::<usize>().unwrap_or(1);
		(start, 1)
	}
}
