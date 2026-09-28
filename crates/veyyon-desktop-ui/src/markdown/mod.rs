//! Streaming markdown: an owned block model, incremental reparsing,
//! syntax highlighting onto the theme's roles, and gpui rendering.
//!
//! A [`MarkdownDoc`] holds the source and its blocks. [`MarkdownDoc::append`]
//! reparses from the start of the last top-level block, or of the one before
//! it when no blank line separates them, so each streamed delta costs the
//! size of the blocks it can change rather than the size of the document.
//! [`render`] draws a document with the active theme.

pub mod highlight;
mod model;
mod parse;
mod render;

pub use highlight::{Highlighted, SyntaxRole, cached, highlight, resolve_language};
pub use model::{Align, Block, Inlines, Run, RunStyle};
pub use render::{CopyButton, LinkHandler, MarkdownStyle, render};

/// A markdown source and the blocks it parses into.
///
/// Parsing enables tables, strikethrough and task lists. A document that
/// defines a link reference reparses in full on every change, because the
/// definition applies to links in blocks before it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MarkdownDoc {
	source:                    String,
	blocks:                    Vec<Block>,
	/// The byte offset each top-level block starts at.
	starts:                    Vec<usize>,
	has_reference_definitions: bool,
}

impl MarkdownDoc {
	/// Parses `source` in full.
	pub fn new(source: impl Into<String>) -> Self {
		let mut doc = Self { source: source.into(), ..Self::default() };
		doc.reparse_from(0);
		doc
	}

	/// The markdown source.
	pub fn source(&self) -> &str {
		&self.source
	}

	/// The top-level blocks.
	pub fn blocks(&self) -> &[Block] {
		&self.blocks
	}

	/// Replaces the source and parses it in full.
	pub fn set_source(&mut self, source: impl Into<String>) {
		self.source = source.into();
		self.reparse_from(0);
	}

	/// Appends `delta` to the source and reparses from the start of the last
	/// top-level block, or of the block before it when no blank line separates
	/// the two: until it grows, the first line of the last block can still
	/// become continuation text of that block (`#` turning into `#x` under a
	/// paragraph, `|` into `| 1` under a table). The result equals a full
	/// parse of the new source.
	pub fn append(&mut self, delta: &str) {
		if delta.is_empty() {
			return;
		}
		self.source.push_str(delta);
		let first = if self.has_reference_definitions { 0 } else { self.restart_block() };
		self.reparse_from(first);
	}

	/// The index of the first block a reparse after an append covers.
	fn restart_block(&self) -> usize {
		let last = self.starts.len().saturating_sub(1);
		match self.starts.get(last) {
			Some(&start) if last > 0 && !follows_blank_line(&self.source, start) => last - 1,
			_ => last,
		}
	}

	/// Replaces the blocks from index `first` on with a parse of the source
	/// from the line that block starts on.
	///
	/// A top-level block starts a line. Text appended after a blank line
	/// cannot change a block before that line; a link reference definition is
	/// the exception, so a tail that defines one reparses the whole document.
	fn reparse_from(&mut self, first: usize) {
		let offset = match self.starts.get(first) {
			Some(&start) if first > 0 => line_start(&self.source, start),
			_ => 0,
		};
		let parsed = parse::parse(&self.source[offset..], offset);
		if offset > 0 && parsed.has_reference_definitions {
			self.reparse_from(0);
			return;
		}
		let keep = if offset == 0 { 0 } else { first };
		self.blocks.truncate(keep);
		self.starts.truncate(keep);
		self.blocks.extend(parsed.blocks);
		self.starts.extend(parsed.starts);
		self.has_reference_definitions = parsed.has_reference_definitions;
	}
}

/// The offset of the start of the line holding byte `at`.
fn line_start(source: &str, at: usize) -> usize {
	source.get(..at).and_then(|head| head.rfind('\n')).map_or(0, |newline| newline + 1)
}

/// Whether the line before the one holding byte `at` is blank: empty or
/// spaces and tabs only.
fn follows_blank_line(source: &str, at: usize) -> bool {
	let Some(newline) = line_start(source, at).checked_sub(1) else {
		return false;
	};
	let previous = line_start(source, newline);
	source.get(previous..newline).is_some_and(|line| line.trim_matches([' ', '\t', '\r']).is_empty())
}
