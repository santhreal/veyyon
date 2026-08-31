//! Review threads, comments, anchors, and change requests.
//!
//! A [`ReviewThread`] anchors an ordered list of comments to a file path and
//! line range. When a file's diff changes across commits or working-tree
//! updates, [`remap_thread_anchor`] re-locates the anchored lines or marks the
//! thread explicitly [`OrphanReason`]-orphaned.

use std::fmt;

use crate::{
	model::LineRange,
	text::diff::{Change, FileDiff, LineKind},
};

#[derive(
	Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, serde::Serialize, serde::Deserialize,
)]
#[serde(transparent)]
pub struct ReviewThreadId(String);

impl ReviewThreadId {
	pub fn new(value: impl Into<String>) -> Self {
		Self(value.into())
	}

	pub fn as_str(&self) -> &str {
		&self.0
	}
}

impl fmt::Display for ReviewThreadId {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter.write_str(&self.0)
	}
}

#[derive(
	Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, serde::Serialize, serde::Deserialize,
)]
#[serde(transparent)]
pub struct ReviewCommentId(String);

impl ReviewCommentId {
	pub fn new(value: impl Into<String>) -> Self {
		Self(value.into())
	}

	pub fn as_str(&self) -> &str {
		&self.0
	}
}

impl fmt::Display for ReviewCommentId {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter.write_str(&self.0)
	}
}

#[derive(
	Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, serde::Serialize, serde::Deserialize,
)]
#[serde(transparent)]
pub struct ChangeRequestId(String);

impl ChangeRequestId {
	pub fn new(value: impl Into<String>) -> Self {
		Self(value.into())
	}

	pub fn as_str(&self) -> &str {
		&self.0
	}
}

impl fmt::Display for ChangeRequestId {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter.write_str(&self.0)
	}
}

/// Why an anchored thread can no longer be pinned to the new diff.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum OrphanReason {
	FileDeleted,
	ContentDeleted,
	ContentModified,
	BinaryFile,
}

impl OrphanReason {
	pub const ALL: [Self; 4] =
		[Self::FileDeleted, Self::ContentDeleted, Self::ContentModified, Self::BinaryFile];

	pub fn label(self) -> &'static str {
		match self {
			Self::FileDeleted => "File deleted",
			Self::ContentDeleted => "Anchored lines deleted",
			Self::ContentModified => "Anchored lines modified",
			Self::BinaryFile => "File is binary",
		}
	}
}

/// The verbatim text lines of the anchored range when the thread was created.
#[derive(Debug, Clone, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
pub struct AnchorContext {
	pub lines: Vec<String>,
}

impl AnchorContext {
	pub fn new(lines: Vec<String>) -> Self {
		Self { lines }
	}
}

/// One comment inside a review thread.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ReviewComment {
	pub id:            ReviewCommentId,
	pub author:        String,
	pub text:          String,
	pub created_at_ms: u64,
	pub updated_at_ms: Option<u64>,
}

impl ReviewComment {
	pub fn new(id: ReviewCommentId, author: impl Into<String>, text: impl Into<String>) -> Self {
		Self { id, author: author.into(), text: text.into(), created_at_ms: 0, updated_at_ms: None }
	}
}

/// A conversation pinned to a file and line range in the review diff.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ReviewThread {
	pub id:            ReviewThreadId,
	pub path:          String,
	pub range:         LineRange,
	pub context:       AnchorContext,
	pub resolved:      bool,
	pub comments:      Vec<ReviewComment>,
	pub orphan:        Option<OrphanReason>,
	pub created_at_ms: u64,
}

impl ReviewThread {
	pub fn new(
		id: ReviewThreadId,
		path: impl Into<String>,
		range: LineRange,
		context: AnchorContext,
		initial_comment: ReviewComment,
	) -> Self {
		Self {
			id,
			path: path.into(),
			range,
			context,
			resolved: false,
			comments: vec![initial_comment],
			orphan: None,
			created_at_ms: 0,
		}
	}

	pub fn is_unresolved(&self) -> bool {
		!self.resolved
	}

	pub fn is_orphaned(&self) -> bool {
		self.orphan.is_some()
	}

	pub fn reply(&mut self, comment: ReviewComment) {
		self.comments.push(comment);
	}

	pub fn resolve(&mut self) {
		self.resolved = true;
	}

	pub fn unresolve(&mut self) {
		self.resolved = false;
	}
}

/// Lifecycle state for a change request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
pub enum ChangeRequestState {
	#[default]
	Open,
	Submitted,
	Approved,
	Closed,
}

impl ChangeRequestState {
	pub const ALL: [Self; 4] = [Self::Open, Self::Submitted, Self::Approved, Self::Closed];

	pub fn label(self) -> &'static str {
		match self {
			Self::Open => "Open",
			Self::Submitted => "Submitted",
			Self::Approved => "Approved",
			Self::Closed => "Closed",
		}
	}
}

/// A named set of review threads representing a coherent change request.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ChangeRequest {
	pub id:            ChangeRequestId,
	pub title:         String,
	pub description:   Option<String>,
	pub state:         ChangeRequestState,
	pub threads:       Vec<ReviewThreadId>,
	pub created_at_ms: u64,
}

impl ChangeRequest {
	pub fn new(id: ChangeRequestId, title: impl Into<String>) -> Self {
		Self {
			id,
			title: title.into(),
			description: None,
			state: ChangeRequestState::Open,
			threads: Vec::new(),
			created_at_ms: 0,
		}
	}
}

/// Re-maps a review thread's anchor across a new file diff.
pub fn remap_thread_anchor(thread: &mut ReviewThread, diffs: &[FileDiff]) {
	let matching_diff = diffs.iter().find(|diff| {
		diff.new_path == thread.path || diff.old_path == thread.path || diff.path() == thread.path
	});

	let Some(diff) = matching_diff else {
		// File was not modified in this diff; anchor remains where it was.
		return;
	};

	match diff.change {
		Change::Removed => {
			thread.orphan = Some(OrphanReason::FileDeleted);
			return;
		},
		Change::Renamed => {
			if !diff.new_path.is_empty() && diff.new_path != "/dev/null" {
				thread.path = diff.new_path.clone();
			}
		},
		Change::Added | Change::Modified => {},
	}

	if diff.binary {
		thread.orphan = Some(OrphanReason::BinaryFile);
		return;
	}

	if diff.hunks.is_empty() {
		// No content changes; anchor remains valid.
		thread.orphan = None;
		return;
	}

	// 1. Try exact content match in the new side lines of the diff hunks.
	if !thread.context.lines.is_empty() {
		let mut new_lines: Vec<(u32, &str)> = Vec::new();
		for hunk in &diff.hunks {
			for line in &hunk.lines {
				if let Some(new_no) = line.new_no
					&& line.kind != LineKind::Removed
				{
					new_lines.push((new_no, &line.text));
				}
			}
		}

		let ctx_len = thread.context.lines.len();
		if new_lines.len() >= ctx_len {
			let mut best_match: Option<(u32, u32, i64)> = None;
			let predicted_start = thread.range.start as i64;

			for window_start in 0..=new_lines.len() - ctx_len {
				let matches_all = thread
					.context
					.lines
					.iter()
					.enumerate()
					.all(|(idx, expected)| new_lines[window_start + idx].1 == expected.as_str());

				if matches_all {
					let start_line = new_lines[window_start].0;
					let end_line = new_lines[window_start + ctx_len - 1].0;
					let distance = (start_line as i64 - predicted_start).abs();

					if best_match
						.as_ref()
						.is_none_or(|(_, _, best_dist)| distance < *best_dist)
					{
						best_match = Some((start_line, end_line, distance));
					}
				}
			}

			if let Some((start, end, _)) = best_match {
				thread.range = LineRange { start, end };
				thread.orphan = None;
				return;
			}
		}
	}

	// 2. If content match not found, check if any hunk overlaps or touches the old
	//    range.
	let target_start = thread.range.start;
	let target_end = thread.range.end;

	for hunk in &diff.hunks {
		let hunk_old_start = hunk.old_start;
		let hunk_old_end = hunk.old_start.saturating_add(hunk.old_len);

		let overlaps = hunk_old_start <= target_end && hunk_old_end >= target_start;
		if overlaps {
			let deleted_anchored = hunk.lines.iter().any(|line| {
				line.kind == LineKind::Removed
					&& line
						.old_no
						.is_some_and(|no| no >= target_start && no <= target_end)
			});
			if deleted_anchored {
				let has_additions = hunk.lines.iter().any(|l| l.kind == LineKind::Added);
				if has_additions {
					thread.orphan = Some(OrphanReason::ContentModified);
				} else {
					thread.orphan = Some(OrphanReason::ContentDeleted);
				}
			} else {
				thread.orphan = Some(OrphanReason::ContentModified);
			}
			return;
		}
	}

	// 3. Anchored lines are in unchanged context outside all hunks; shift by
	//    preceding hunks delta.
	let mut cumulative_delta: i64 = 0;
	for hunk in &diff.hunks {
		let hunk_old_end = hunk.old_start.saturating_add(hunk.old_len);
		if hunk_old_end <= target_start {
			let hunk_delta = hunk.new_len as i64 - hunk.old_len as i64;
			cumulative_delta += hunk_delta;
		}
	}

	let shifted_start = (target_start as i64 + cumulative_delta).max(1) as u32;
	let shifted_end = (target_end as i64 + cumulative_delta).max(shifted_start as i64) as u32;

	thread.range = LineRange { start: shifted_start, end: shifted_end };
	thread.orphan = None;
}
