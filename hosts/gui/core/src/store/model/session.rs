//! One conversation: its transcript, and the draft that has not been sent.

use super::{Message, ProjectId, SessionId};

/// How much of the last message a row's second line carries.
///
/// A row draws one line and shortens it to the width it has; this is the bound
/// on what is cloned to get there.
pub const PREVIEW_MAX: usize = 140;

/// A session: one conversation, its transcript, and its draft.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Session {
	pub id:         SessionId,
	pub project:    ProjectId,
	pub title:      String,
	pub updated_ms: u64,
	pub messages:   Vec<Message>,
	pub draft:      String,
	/// Where the caret sits in `draft`, as a byte offset. A draft belongs to its
	/// conversation, and so does the caret: a draft that reopens with the caret
	/// at zero has to be re-navigated every time it is switched back to.
	pub caret:      usize,
}

impl Session {
	pub fn new(id: impl Into<String>, project: &ProjectId, title: impl Into<String>) -> Session {
		Session {
			id:         SessionId::new(id),
			project:    project.clone(),
			title:      title.into(),
			updated_ms: 0,
			messages:   Vec::new(),
			draft:      String::new(),
			caret:      0,
		}
	}

	/// The last thing said, for the row's second line.
	///
	/// A conversation is named after its first line, so a one-message
	/// conversation would otherwise print that line twice in the same row. The
	/// second line appears once it has something else to say.
	///
	/// Bounded, because a paragraph is one line as far as markdown is concerned
	/// and a row draws one line: without the cut, every frame clones however
	/// much prose the last message happened to be.
	pub fn preview(&self) -> Option<String> {
		let text = self.messages.last()?.text();
		let line = text.lines().find(|line| !line.trim().is_empty())?.trim();
		if line.starts_with(self.title.as_str()) || self.title.starts_with(line) {
			return None;
		}
		Some(crate::text::clip(line, PREVIEW_MAX))
	}

	pub fn next_message_id(&self) -> u64 {
		self.messages.last().map_or(1, |message| message.id + 1)
	}
}
