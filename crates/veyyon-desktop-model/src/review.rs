//! Window-local review threads. Host changes are read-only inputs; reviews
//! never gate an action.

use serde::{Deserialize, Serialize};

use crate::{ChangeScope, VersionedStore};

/// The version of the file a line belongs to, independent of diff layout.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ReviewSide {
	Old,
	New,
}

/// A visible source line from one side of a parsed diff.
#[derive(Debug, Clone, Copy)]
pub struct ReviewLine<'a> {
	pub number: usize,
	pub text:   &'a str,
}

/// Context is literal source text, never a line number or a fuzzy match.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReviewAnchor {
	pub repository:    String,
	pub file:          String,
	pub scope:         ChangeScope,
	pub side:          ReviewSide,
	pub original_line: usize,
	pub text:          String,
	pub before:        Option<String>,
	pub after:         Option<String>,
	/// An initially ambiguous source is never disambiguated by deleting one
	/// copy.
	pub ambiguous:     bool,
}

/// Current placement; missing context never falls back to a nearby line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReviewPlacement {
	Attached(usize),
	Missing,
	Ambiguous,
}

impl ReviewAnchor {
	/// Captures adjacent source lines only when the diff includes them.
	pub fn capture(
		repository: &str,
		file: &str,
		scope: ChangeScope,
		side: ReviewSide,
		line: usize,
		lines: &[ReviewLine<'_>],
	) -> Option<Self> {
		if repository.is_empty() || file.is_empty() || line == 0 {
			return None;
		}
		let index = lines
			.iter()
			.position(|candidate| candidate.number == line)?;
		let target = lines[index];
		let mut anchor = Self {
			repository: repository.to_owned(),
			file: file.to_owned(),
			scope,
			side,
			original_line: line,
			text: target.text.to_owned(),
			before: adjacent(lines, index, false).map(str::to_owned),
			after: adjacent(lines, index, true).map(str::to_owned),
			ambiguous: false,
		};
		anchor.ambiguous = matches!(anchor.locate(lines), ReviewPlacement::Ambiguous);
		Some(anchor)
	}

	/// Repositions only when the entire recorded context matches exactly once.
	#[must_use]
	pub fn locate(&self, lines: &[ReviewLine<'_>]) -> ReviewPlacement {
		if self.ambiguous {
			return ReviewPlacement::Ambiguous;
		}
		let mut found = None;
		for (index, line) in lines.iter().enumerate() {
			if line.text != self.text
				|| self
					.before
					.as_deref()
					.is_some_and(|text| adjacent(lines, index, false) != Some(text))
				|| self
					.after
					.as_deref()
					.is_some_and(|text| adjacent(lines, index, true) != Some(text))
			{
				continue;
			}
			if found.is_some() {
				return ReviewPlacement::Ambiguous;
			}
			found = Some(line.number);
		}
		found.map_or(ReviewPlacement::Missing, ReviewPlacement::Attached)
	}
}

fn adjacent<'a>(lines: &[ReviewLine<'a>], index: usize, after: bool) -> Option<&'a str> {
	let target = lines.get(index)?;
	let neighbor = if after {
		lines.get(index.checked_add(1)?)?
	} else {
		lines.get(index.checked_sub(1)?)?
	};
	let contiguous = if after {
		target.number.checked_add(1) == Some(neighbor.number)
	} else {
		neighbor.number.checked_add(1) == Some(target.number)
	};
	contiguous.then_some(neighbor.text)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReviewThread {
	pub id:       u64,
	pub anchor:   ReviewAnchor,
	pub comments: Vec<String>,
	pub resolved: bool,
	/// Once a rediff loses the identity, later copies cannot silently claim it.
	pub orphaned: bool,
}

/// One host-local document, partitioned by repository, path and change scope.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReviewsStore {
	pub version: u32,
	pub threads: Vec<ReviewThread>,
}

impl Default for ReviewsStore {
	fn default() -> Self {
		Self { version: Self::CURRENT_VERSION, threads: Vec::new() }
	}
}

impl VersionedStore for ReviewsStore {
	fn version(&self) -> u32 {
		self.version
	}
}

impl ReviewsStore {
	/// Adds a thread without consulting or changing submit/apply capability.
	pub fn create(&mut self, anchor: ReviewAnchor, comment: &str) -> Option<u64> {
		let comment = comment.trim();
		if comment.is_empty() {
			return None;
		}
		let id = self
			.threads
			.iter()
			.map(|thread| thread.id)
			.max()
			.unwrap_or(0)
			.checked_add(1)?;
		self.threads.push(ReviewThread {
			id,
			anchor,
			comments: vec![comment.to_owned()],
			resolved: false,
			orphaned: false,
		});
		Some(id)
	}

	pub fn reply(&mut self, id: u64, comment: &str) -> bool {
		let comment = comment.trim();
		if comment.is_empty() {
			return false;
		}
		let Some(thread) = self.threads.iter_mut().find(|thread| thread.id == id) else {
			return false;
		};
		thread.comments.push(comment.to_owned());
		true
	}

	pub fn set_resolved(&mut self, id: u64, resolved: bool) -> bool {
		let Some(thread) = self.threads.iter_mut().find(|thread| thread.id == id) else {
			return false;
		};
		thread.resolved = resolved;
		true
	}
}
