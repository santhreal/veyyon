//! The owned block model a markdown document parses into.
//!
//! The model holds no borrowed parser state, so a document keeps its blocks
//! across frames and a renderer reads them without reparsing.

use std::{ops::Range, sync::Arc};

/// Style flags of one run of inline text.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RunStyle {
	/// Strong emphasis.
	pub bold:   bool,
	/// Emphasis.
	pub italic: bool,
	/// Strikethrough.
	pub strike: bool,
	/// Inline code.
	pub code:   bool,
	/// The destination of the link the run is part of.
	pub link:   Option<Arc<str>>,
}

/// A byte range of an [`Inlines`] text drawn with one style.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Run {
	/// The bytes of [`Inlines::text`] the run covers.
	pub range: Range<usize>,
	/// How the run is drawn.
	pub style: RunStyle,
}

/// Inline text and its style runs.
///
/// The runs cover `text` end to end, in order, with no gap and no overlap.
/// Two neighbouring runs never share a style. A soft line break is a space
/// and a hard line break is `\n`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Inlines {
	/// The text of every run, concatenated.
	pub text: Arc<str>,
	/// The style runs over `text`.
	pub runs: Vec<Run>,
}

impl Inlines {
	/// Inline text drawn in one plain run.
	pub fn plain(text: &str) -> Self {
		let runs = if text.is_empty() {
			Vec::new()
		} else {
			vec![Run { range: 0..text.len(), style: RunStyle::default() }]
		};
		Self { text: Arc::from(text), runs }
	}

	/// Whether the text is empty.
	pub fn is_empty(&self) -> bool {
		self.text.is_empty()
	}
}

/// The horizontal alignment of a table column.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum Align {
	/// No alignment was written; drawn at the start.
	#[default]
	None,
	/// `:---`
	Left,
	/// `:---:`
	Center,
	/// `---:`
	Right,
}

/// One block of a markdown document.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Block {
	/// A paragraph. Raw HTML blocks are paragraphs of their source text.
	Paragraph(Inlines),
	/// An ATX or setext heading; `level` is 1 to 6.
	Heading {
		/// The heading level, 1 to 6.
		level: u8,
		/// The heading text.
		runs:  Inlines,
	},
	/// A fenced or indented code block.
	CodeBlock {
		/// The first word of the fence's info string, if any.
		lang: Option<Arc<str>>,
		/// The code, without the newline that ends its last line.
		code: Arc<str>,
	},
	/// An ordered or bullet list.
	List {
		/// Whether the markers are numbers.
		ordered: bool,
		/// The number of the first item; 1 for a bullet list.
		start:   u64,
		/// The blocks of each item. The text of a tight item is a paragraph.
		items:   Vec<Vec<Self>>,
	},
	/// The checkbox of a task list item. It is the first block of its item.
	TaskItem {
		/// Whether the box is ticked.
		checked: bool,
	},
	/// A block quote.
	Quote(Vec<Self>),
	/// A table.
	Table {
		/// The alignment of each column.
		align: Vec<Align>,
		/// The header cells.
		head:  Vec<Inlines>,
		/// The body rows.
		rows:  Vec<Vec<Inlines>>,
	},
	/// A thematic break.
	Rule,
}
