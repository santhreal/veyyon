//! Frontend review state: local threads, change requests, and comment drafts.

use std::collections::BTreeMap;

use crate::{
	model::{ChangeRequest, ChangeRequestId, ReviewThread, ReviewThreadId, remap_thread_anchor},
	text::diff::FileDiff,
};

#[derive(Debug, Clone, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
pub struct ReviewState {
	pub threads:                 BTreeMap<ReviewThreadId, ReviewThread>,
	pub change_requests:         BTreeMap<ChangeRequestId, ChangeRequest>,
	pub selected_thread:         Option<ReviewThreadId>,
	pub selected_change_request: Option<ChangeRequestId>,
	/// Draft comment text (key None = draft for new thread; Some(id) = reply
	/// draft for thread id).
	pub drafts:                  BTreeMap<Option<ReviewThreadId>, String>,
}

impl ReviewState {
	/// How many review threads across the entire session remain unresolved.
	pub fn unresolved_count(&self) -> usize {
		self.threads.values().filter(|t| t.is_unresolved()).count()
	}

	/// How many review threads for a specific file remain unresolved.
	pub fn unresolved_count_for_file(&self, path: &str) -> usize {
		self
			.threads
			.values()
			.filter(|t| t.path == path && t.is_unresolved())
			.count()
	}

	/// All review threads anchored to a specific file, sorted by line number.
	pub fn threads_for_file(&self, path: &str) -> Vec<&ReviewThread> {
		let mut list: Vec<&ReviewThread> = self.threads.values().filter(|t| t.path == path).collect();
		list.sort_by_key(|t| (t.range.start, t.range.end));
		list
	}

	/// Find a thread anchored to a specific line in a file.
	pub fn thread_at_line(&self, path: &str, line: u32) -> Option<&ReviewThread> {
		self
			.threads
			.values()
			.find(|t| t.path == path && t.range.start <= line && line <= t.range.end)
	}

	/// Re-maps all thread anchors across updated diffs.
	pub fn remap_anchors(&mut self, files: &[FileDiff]) {
		for thread in self.threads.values_mut() {
			remap_thread_anchor(thread, files);
		}
	}
}
