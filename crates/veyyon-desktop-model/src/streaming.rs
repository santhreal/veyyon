use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{
	connection::EntryId,
	transcript::{ContentBlock, TranscriptEntry},
};

/// State container representing in-flight assistant token generation and active
/// tool progress.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct StreamingMessageState {
	pub entry:        EntryId,
	pub tool:         Option<String>,
	pub accumulating: TranscriptEntry,
	pub revision:     u64,
}

/// Text a streaming reply grew by since the frame before it.
///
/// The host sends one instead of a whole [`StreamingMessageState`] when the
/// reply differs from the one the window holds only by text appended to one
/// `Text` or `Thinking` block, so a frame costs the size of the delta rather
/// than the size of the reply. Every other field of the held entry, `raw`
/// included, keeps the value the last `StreamingChanged` carried.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub struct StreamingAppend {
	pub entry:    EntryId,
	pub block:    u32,
	pub text:     String,
	pub revision: u64,
}

/// An append that does not fit the reply the window holds.
///
/// The host computes each append against the reply it last sent, so a
/// mismatch means the window and the host disagree about what is drawn.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum StreamingAppendError {
	#[error("streaming append for entry `{}` arrived while no reply is streaming", .entry.0)]
	NoStream { entry: EntryId },
	#[error("streaming append for entry `{}` arrived while entry `{}` is streaming", .sent.0, .held.0)]
	OtherEntry { held: EntryId, sent: EntryId },
	#[error("streaming append names block {block} of entry `{}`, which holds {blocks}", .entry.0)]
	NoBlock { entry: EntryId, block: u32, blocks: usize },
	#[error("streaming append names block {block} of entry `{}`, which holds no text", .entry.0)]
	NotText { entry: EntryId, block: u32 },
}

impl StreamingMessageState {
	/// Appends `append.text` to the block it names and takes its revision.
	///
	/// # Errors
	///
	/// Fails, leaving the state unchanged, when `append` names another entry,
	/// a block the entry does not hold, or a block other than `Text` or
	/// `Thinking`.
	pub fn append(&mut self, append: &StreamingAppend) -> Result<(), StreamingAppendError> {
		if self.entry != append.entry {
			return Err(StreamingAppendError::OtherEntry {
				held: self.entry.clone(),
				sent: append.entry.clone(),
			});
		}
		let blocks = self.accumulating.content.len();
		let block = usize::try_from(append.block)
			.ok()
			.and_then(|ix| self.accumulating.content.get_mut(ix));
		let text = match block {
			Some(ContentBlock::Text { text } | ContentBlock::Thinking { text }) => text,
			Some(_) => {
				return Err(StreamingAppendError::NotText {
					entry: append.entry.clone(),
					block: append.block,
				});
			},
			None => {
				return Err(StreamingAppendError::NoBlock {
					entry: append.entry.clone(),
					block: append.block,
					blocks,
				});
			},
		};
		text.push_str(&append.text);
		self.revision = append.revision;
		self.accumulating.revision = append.revision;
		Ok(())
	}
}
