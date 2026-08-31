//! Review thread and change request dispatch.

use crate::{
	command::UiCommand,
	model::*,
	navigation::*,
	store::{Effects, Store},
	text::diff::LineKind,
};

impl Store {
	pub(super) fn dispatch_review(&mut self, command: &UiCommand, _effects: &mut Effects) -> bool {
		match command {
			UiCommand::StartReviewThread { path, range, text } => {
				if range.start == 0 || range.start > range.end || text.trim().is_empty() {
					return true;
				}

				// Refuse when range is past the end of the file diff if known.
				if let Some(versioned) = self.replica.changes.readable()
					&& let Some(file) = versioned
						.value
						.parsed
						.iter()
						.find(|f| f.path() == path || f.new_path == *path)
				{
					let max_line = file
						.hunks
						.iter()
						.flat_map(|h| h.lines.iter().filter_map(|l| l.new_no))
						.max()
						.unwrap_or(0);
					if max_line > 0 && range.start > max_line {
						return true;
					}
				}

				// Extract context lines if available from replica.
				let mut context_lines = Vec::new();
				if let Some(versioned) = self.replica.changes.readable()
					&& let Some(file) = versioned
						.value
						.parsed
						.iter()
						.find(|f| f.path() == path || f.new_path == *path)
				{
					for hunk in &file.hunks {
						for line in &hunk.lines {
							if let Some(new_no) = line.new_no
								&& new_no >= range.start
								&& new_no <= range.end
								&& line.kind != LineKind::Removed
							{
								context_lines.push(line.text.clone());
							}
						}
					}
				}

				let thread_id = self.next_review_thread_id();
				let comment_id = self.next_review_comment_id();
				let comment = ReviewComment::new(comment_id, "You", text.clone());
				let thread = ReviewThread::new(
					thread_id.clone(),
					path.clone(),
					*range,
					AnchorContext::new(context_lines),
					comment,
				);

				self
					.frontend
					.review
					.threads
					.insert(thread_id.clone(), thread);
				self.frontend.review.selected_thread = Some(thread_id);
				self.frontend.review.drafts.remove(&None);
				self.frontend.review_range = None;
				true
			},
			UiCommand::ReplyReviewThread { thread_id, text } => {
				if text.trim().is_empty() {
					return true;
				}
				if self.frontend.review.threads.contains_key(thread_id) {
					let comment_id = self.next_review_comment_id();
					let comment = ReviewComment::new(comment_id, "You", text.clone());
					if let Some(thread) = self.frontend.review.threads.get_mut(thread_id) {
						thread.reply(comment);
					}
					self.frontend.review.drafts.remove(&Some(thread_id.clone()));
				}
				true
			},
			UiCommand::EditReviewDraft { thread_id, text } => {
				if text.is_empty() {
					self.frontend.review.drafts.remove(thread_id);
				} else {
					self
						.frontend
						.review
						.drafts
						.insert(thread_id.clone(), text.clone());
				}
				true
			},
			UiCommand::ResolveReviewThread(thread_id) => {
				if let Some(thread) = self.frontend.review.threads.get_mut(thread_id) {
					thread.resolve();
				}
				true
			},
			UiCommand::UnresolveReviewThread(thread_id) => {
				if let Some(thread) = self.frontend.review.threads.get_mut(thread_id) {
					thread.unresolve();
				}
				true
			},
			UiCommand::ToggleReviewThreadResolved(thread_id) => {
				if let Some(thread) = self.frontend.review.threads.get_mut(thread_id) {
					if thread.resolved {
						thread.unresolve();
					} else {
						thread.resolve();
					}
				}
				true
			},
			UiCommand::DeleteReviewThread(thread_id) => {
				self.frontend.review.threads.remove(thread_id);
				if self.frontend.review.selected_thread.as_ref() == Some(thread_id) {
					self.frontend.review.selected_thread = None;
				}
				true
			},
			UiCommand::DeleteReviewComment { thread_id, comment_id } => {
				if let Some(thread) = self.frontend.review.threads.get_mut(thread_id) {
					thread.comments.retain(|c| &c.id != comment_id);
					if thread.comments.is_empty() {
						self.frontend.review.threads.remove(thread_id);
						if self.frontend.review.selected_thread.as_ref() == Some(thread_id) {
							self.frontend.review.selected_thread = None;
						}
					}
				}
				true
			},
			UiCommand::SelectReviewThread(thread_id) => {
				self.frontend.review.selected_thread = thread_id.clone();
				if let Some(id) = thread_id
					&& let Some(thread) = self.frontend.review.threads.get(id)
				{
					self.frontend.review_range = Some((thread.path.clone(), thread.range));
					self.frontend.route = Route::Changes;
				}
				true
			},
			UiCommand::CreateChangeRequest { title, description } => {
				if title.trim().is_empty() {
					return true;
				}
				let cr_id = self.next_change_request_id();
				let mut cr = ChangeRequest::new(cr_id.clone(), title.clone());
				cr.description = description.clone();
				cr.threads = self.frontend.review.threads.keys().cloned().collect();
				self
					.frontend
					.review
					.change_requests
					.insert(cr_id.clone(), cr);
				self.frontend.review.selected_change_request = Some(cr_id);
				true
			},
			UiCommand::SetChangeRequestState { id, state } => {
				if let Some(cr) = self.frontend.review.change_requests.get_mut(id) {
					cr.state = *state;
				}
				true
			},
			UiCommand::RemapReviewAnchors => {
				if let Some(versioned) = self.replica.changes.readable() {
					self.frontend.review.remap_anchors(&versioned.value.parsed);
				}
				true
			},
			_ => false,
		}
	}
}
