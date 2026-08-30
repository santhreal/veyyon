//! One turn, and what a turn is made of.
//!
//! A message is parsed once, when it is written, not once per frame. The
//! parsers in [`text`](crate::text) return offsets into the string they were
//! handed, and a transcript is redrawn on every frame of every animation, so
//! parsing at draw time would re-parse the whole conversation sixty times a
//! second to produce the same answer.
//!
//! WHAT HAS NO PRODUCER YET. [`Role::Engine`], [`Message::streaming`] and
//! [`ToolCall`] are shapes an engine fills. Nothing in this window constructs
//! one, and nothing invents one to have something to draw: the renderers handle
//! them, the tests construct them, and the transcript shows what is there. The
//! alternative is a shape defined the day an engine arrives, which is the day
//! every surface has to change.

use crate::text::{diff::FileDiff, markdown::Md};

/// Who said it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
	/// The operator, at the keyboard.
	Operator,
	/// An engine. No engine is attached, so nothing produces this yet.
	Engine,
}

/// One piece of a message, in the order it was written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Block {
	/// Prose, and everything markdown covers: headings, lists, quotes, tables,
	/// and fenced code, already split.
	Prose(Vec<Md>),
	/// A patch, by file. What a paste of a diff becomes, and what an engine's
	/// edit will be.
	Patch(Vec<FileDiff>),
	/// What a tool did.
	Tool(ToolCall),
}

/// What kind of thing a tool did, which is what decides its glyph and how its
/// one line reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolKind {
	/// A command in a shell.
	Ran,
	/// A file that was read.
	Read,
	/// A file that was written.
	Edited,
	/// A search over the checkout.
	Searched,
	/// Anything else a tool can be.
	Other,
}

/// Where a tool call is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolState {
	/// Still going.
	Running,
	/// Finished and did what it said.
	Done,
	/// Finished and did not, with what it said about that.
	Failed(String),
	/// Waiting to be allowed.
	Waiting,
}

/// One thing a tool did: the line that names it, and what it produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolCall {
	pub id:     String,
	pub kind:   ToolKind,
	/// One line: the command, the path, the query.
	pub what:   String,
	/// What it produced, folded away until asked for.
	pub detail: String,
	pub state:  ToolState,
}

/// One turn on screen.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Message {
	pub id:        u64,
	pub role:      Role,
	pub blocks:    Vec<Block>,
	pub at_ms:     u64,
	/// Whether whoever is writing this has finished. An operator's message is
	/// never streaming; an engine's is, until it is.
	pub streaming: bool,
}

impl Message {
	/// What the operator wrote, parsed.
	///
	/// A paste that is a patch is a patch: the whole text is one, or none of it
	/// is, because a diff parser handed prose finds nothing and a transcript
	/// that guesses per paragraph would split a patch down the middle.
	pub fn written(id: u64, at_ms: u64, text: &str) -> Message {
		let blocks = if crate::text::diff::looks_like_a_patch(text) {
			vec![Block::Patch(crate::text::diff::parse(text))]
		} else {
			vec![Block::Prose(crate::text::markdown::parse(text))]
		};
		Message { id, role: Role::Operator, blocks, at_ms, streaming: false }
	}

	/// What an engine has written so far, parsed, and still being written.
	///
	/// The same parse as an operator's message, because a transcript draws one
	/// kind of content however it arrived. `streaming` is what the caller closes
	/// when the answer ends, and it is what the turn draws its spinner from.
	pub fn answered(id: u64, at_ms: u64, text: &str, streaming: bool) -> Message {
		let mut message = Message::written(id, at_ms, text);
		message.role = Role::Engine;
		message.streaming = streaming;
		message
	}

	/// The prose of this message, joined, with code and patches left out.
	///
	/// What a sidebar row's second line and the palette's search read: a
	/// preview that quotes the first line of a code block says nothing about
	/// the conversation.
	pub fn text(&self) -> String {
		let mut lines: Vec<String> = Vec::new();
		for block in &self.blocks {
			match block {
				Block::Prose(blocks) => prose_lines(blocks, &mut lines),
				Block::Patch(files) => lines.extend(files.iter().map(|file| file.path().to_owned())),
				Block::Tool(call) => lines.push(call.what.clone()),
			}
		}
		lines.retain(|line| !line.trim().is_empty());
		lines.join("\n")
	}
}

/// The readable text of a run of markdown blocks, in order.
fn prose_lines(blocks: &[Md], into: &mut Vec<String>) {
	use crate::text::markdown::flatten;
	for block in blocks {
		match block {
			Md::Heading { spans, .. } | Md::Paragraph(spans) => into.push(flatten(spans)),
			Md::List(items) => into.extend(items.iter().map(|item| flatten(&item.spans))),
			Md::Quote(inner) => prose_lines(inner, into),
			Md::Table { head, rows } => {
				into.extend(head.iter().map(|cell| flatten(cell)));
				for row in rows {
					into.extend(row.iter().map(|cell| flatten(cell)));
				}
			},
			// A fence is not prose, and a rule has no text.
			Md::Code { .. } | Md::Rule => {},
		}
	}
}
