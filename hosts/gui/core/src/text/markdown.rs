//! Markdown as a transcript needs it: blocks, and the inline spans inside a
//! block.
//!
//! The parser is line-based and total. A message arrives a token at a time, so
//! every construct has to have a reading while it is still half-written: an
//! unclosed fence is a code block that runs to the end, an unclosed emphasis
//! marker is the literal character, an unterminated link is text. Nothing here
//! returns an error, because there is no reader to show one to.
//!
//! WHAT THIS IS NOT. It is not CommonMark. Reference links, HTML blocks, loose
//! versus tight list spacing and entity escapes are absent, because a message
//! from an engine does not use them and every one of them costs a pass.

mod block;
mod emphasis;
mod inline;
mod link;
mod list;
mod table;

pub use block::parse;
pub use inline::{flatten, inline};

/// One run of inline text inside a block.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Span {
	/// Literal plain text.
	Plain(String),
	/// Strong bold text.
	Strong(String),
	/// Emphasized italic text.
	Emphasis(String),
	/// Inline code snippet.
	Code(String),
	/// Hyperlink with display text and target URL.
	Link {
		/// Visible anchor text.
		text: String,
		/// Destination URL.
		href: String,
	},
}

/// What numbers or bullets a list item.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ListKind {
	/// Unordered bullet point.
	Bullet,
	/// The number as written, so a list starting at 3 prints 3.
	Ordered(u32),
}

/// One list item: its marker, how deep it is nested, and its text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Item {
	/// Marker kind for the list item.
	pub kind:  ListKind,
	/// Nesting depth from 0 to 5.
	pub depth: u8,
	/// Parsed inline spans of the item text.
	pub spans: Vec<Span>,
	/// Set when the item's marker is a task box: `- [ ]` or `- [x]`.
	pub done:  Option<bool>,
}

/// One block of a message, in the order it was written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Md {
	/// ATX or Setext heading with level 1 through 6.
	Heading {
		/// Heading level from 1 to 6.
		level: u8,
		/// Parsed inline spans of heading text.
		spans: Vec<Span>,
	},
	/// Paragraph block with inline spans.
	Paragraph(Vec<Span>),
	/// Consecutive list items.
	List(Vec<Item>),
	/// Blockquote container parsed recursively.
	Quote(Vec<Md>),
	/// Fenced code block with optional info language and verbatim body.
	Code {
		/// Lowercased language identifier.
		lang: String,
		/// Verbatim code body lines joined with newline.
		body: String,
	},
	/// Thematic break horizontal rule.
	Rule,
	/// Table with header cells and body rows.
	Table {
		/// Header row cells.
		head: Row,
		/// Body row cells.
		rows: Vec<Row>,
	},
}

/// One table cell: the spans inside it.
pub type Cell = Vec<Span>;

/// One table row, header or body.
pub type Row = Vec<Cell>;

#[cfg(test)]
mod tests;
