//! Converts pulldown-cmark events into the owned block model.
//!
//! The builder is iterative, so a deeply nested quote or list cannot exhaust
//! the stack. pulldown-cmark closes every open tag at the end of its input,
//! which makes a prefix of a streamed document parse into complete blocks.

use std::{mem, sync::Arc};

use pulldown_cmark::{Alignment, CodeBlockKind, Event, Options, Parser, Tag, TagEnd};

use super::model::{Align, Block, Inlines, Run, RunStyle};

/// The blocks of one parse.
pub struct Parsed {
	/// The top-level blocks.
	pub blocks:                    Vec<Block>,
	/// The source byte offset each top-level block starts at.
	pub starts:                    Vec<usize>,
	/// Whether the source defines a link reference, which a link anywhere in
	/// the document can name.
	pub has_reference_definitions: bool,
}

/// Parses `source`, reporting block offsets shifted by `base`.
pub fn parse(source: &str, base: usize) -> Parsed {
	let options = Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS;
	let mut events = Parser::new_ext(source, options).into_offset_iter();
	let mut builder = Builder::default();
	for (event, range) in events.by_ref() {
		builder.event(event, base + range.start);
	}
	let has_reference_definitions = events.reference_definitions().iter().next().is_some();
	let (blocks, starts) = builder.finish();
	Parsed { blocks, starts, has_reference_definitions }
}

/// A block that holds other blocks.
enum Container {
	Quote(Vec<Block>),
	List { ordered: bool, start: u64, items: Vec<Vec<Block>> },
	Item(Vec<Block>),
	Table { align: Vec<Align>, head: Vec<Inlines>, rows: Vec<Vec<Inlines>>, row: Vec<Inlines> },
}

/// What an inline buffer becomes when it closes.
#[derive(Clone, Copy)]
enum InlineKind {
	Paragraph,
	/// The text of a tight list item, which pulldown-cmark does not wrap in a
	/// paragraph.
	Implicit,
	Heading(u8),
	Cell,
}

/// A block that holds text.
enum Leaf {
	Inline { kind: InlineKind, buf: InlineBuf },
	Code { lang: Option<Arc<str>>, code: String },
	Html(String),
}

/// Inline text being collected, with the styles open at its end.
#[derive(Default)]
struct InlineBuf {
	text:   String,
	runs:   Vec<Run>,
	bold:   u32,
	italic: u32,
	strike: u32,
	links:  Vec<Arc<str>>,
}

impl InlineBuf {
	fn push(&mut self, text: &str, code: bool) {
		if text.is_empty() {
			return;
		}
		let style = RunStyle {
			bold: self.bold > 0,
			italic: self.italic > 0,
			strike: self.strike > 0,
			code,
			link: self.links.last().cloned(),
		};
		let start = self.text.len();
		self.text.push_str(text);
		let end = self.text.len();
		match self.runs.last_mut() {
			Some(last) if last.style == style => last.range.end = end,
			_ => self.runs.push(Run { range: start..end, style }),
		}
	}

	fn finish(self) -> Inlines {
		Inlines { text: Arc::from(self.text), runs: self.runs }
	}
}

#[derive(Default)]
struct Builder {
	root:          Vec<Block>,
	starts:        Vec<usize>,
	stack:         Vec<Container>,
	leaf:          Option<Leaf>,
	pending_start: usize,
}

impl Builder {
	fn event(&mut self, event: Event<'_>, offset: usize) {
		match event {
			Event::Start(tag) => self.start(tag, offset),
			Event::End(end) => self.end(end),
			Event::Text(text) | Event::InlineHtml(text) => self.text(&text, false),
			Event::Code(text) => self.text(&text, true),
			Event::Html(html) => match &mut self.leaf {
				Some(Leaf::Html(buf)) => buf.push_str(&html),
				_ => self.text(&html, false),
			},
			Event::SoftBreak => self.text(" ", false),
			Event::HardBreak => self.text("\n", false),
			Event::Rule => {
				self.open_block(offset);
				self.push_block(Block::Rule);
			},
			Event::TaskListMarker(checked) => {
				self.close_implicit();
				self.push_block(Block::TaskItem { checked });
			},
			_ => {},
		}
	}

	fn start(&mut self, tag: Tag<'_>, offset: usize) {
		match tag {
			Tag::Paragraph => self.open_inline(InlineKind::Paragraph, offset),
			Tag::Heading { level, .. } => self.open_inline(InlineKind::Heading(level as u8), offset),
			Tag::TableCell => {
				self.leaf = Some(Leaf::Inline { kind: InlineKind::Cell, buf: InlineBuf::default() });
			},
			Tag::CodeBlock(kind) => {
				self.open_block(offset);
				let lang = match kind {
					CodeBlockKind::Fenced(info) => fence_language(&info),
					CodeBlockKind::Indented => None,
				};
				self.leaf = Some(Leaf::Code { lang, code: String::new() });
			},
			Tag::HtmlBlock => {
				self.open_block(offset);
				self.leaf = Some(Leaf::Html(String::new()));
			},
			Tag::BlockQuote(_) => self.open_container(Container::Quote(Vec::new()), offset),
			Tag::List(first) => self.open_container(
				Container::List {
					ordered: first.is_some(),
					start:   first.unwrap_or(1),
					items:   Vec::new(),
				},
				offset,
			),
			Tag::Item => self.open_container(Container::Item(Vec::new()), offset),
			Tag::Table(align) => self.open_container(
				Container::Table {
					align: align.iter().map(|a| column_align(*a)).collect(),
					head:  Vec::new(),
					rows:  Vec::new(),
					row:   Vec::new(),
				},
				offset,
			),
			Tag::Emphasis => self.style(|buf| buf.italic += 1),
			Tag::Strong => self.style(|buf| buf.bold += 1),
			Tag::Strikethrough => self.style(|buf| buf.strike += 1),
			Tag::Link { dest_url, .. } | Tag::Image { dest_url, .. } => {
				self.style(|buf| buf.links.push(Arc::from(&*dest_url)));
			},
			_ => {},
		}
	}

	fn end(&mut self, end: TagEnd) {
		match end {
			TagEnd::Paragraph
			| TagEnd::Heading(_)
			| TagEnd::TableCell
			| TagEnd::CodeBlock
			| TagEnd::HtmlBlock => self.close_leaf(),
			TagEnd::BlockQuote(_) | TagEnd::List(_) | TagEnd::Item | TagEnd::Table => {
				self.close_container();
			},
			TagEnd::TableHead => {
				if let Some(Container::Table { head, row, .. }) = self.stack.last_mut() {
					*head = mem::take(row);
				}
			},
			TagEnd::TableRow => {
				if let Some(Container::Table { rows, row, .. }) = self.stack.last_mut() {
					rows.push(mem::take(row));
				}
			},
			TagEnd::Emphasis => self.style(|buf| buf.italic = buf.italic.saturating_sub(1)),
			TagEnd::Strong => self.style(|buf| buf.bold = buf.bold.saturating_sub(1)),
			TagEnd::Strikethrough => self.style(|buf| buf.strike = buf.strike.saturating_sub(1)),
			TagEnd::Link | TagEnd::Image => self.style(|buf| drop(buf.links.pop())),
			_ => {},
		}
	}

	/// Appends text to the open leaf, opening an implicit paragraph when no
	/// leaf is open.
	fn text(&mut self, text: &str, code: bool) {
		if let Some(Leaf::Code { code: buf, .. } | Leaf::Html(buf)) = &mut self.leaf {
			buf.push_str(text);
			return;
		}
		self.style(|buf| buf.push(text, code));
	}

	/// Applies `change` to the open inline buffer, opening an implicit
	/// paragraph when no leaf is open.
	fn style(&mut self, change: impl FnOnce(&mut InlineBuf)) {
		let leaf = self.leaf.get_or_insert_with(|| Leaf::Inline {
			kind: InlineKind::Implicit,
			buf:  InlineBuf::default(),
		});
		if let Leaf::Inline { buf, .. } = leaf {
			change(buf);
		}
	}

	/// Closes an implicit paragraph and records where a top-level block
	/// starts.
	fn open_block(&mut self, offset: usize) {
		self.close_implicit();
		if self.stack.is_empty() && self.leaf.is_none() {
			self.pending_start = offset;
		}
	}

	fn open_inline(&mut self, kind: InlineKind, offset: usize) {
		self.open_block(offset);
		self.leaf = Some(Leaf::Inline { kind, buf: InlineBuf::default() });
	}

	fn open_container(&mut self, container: Container, offset: usize) {
		self.open_block(offset);
		self.stack.push(container);
	}

	fn close_implicit(&mut self) {
		if matches!(self.leaf, Some(Leaf::Inline { kind: InlineKind::Implicit, .. })) {
			self.close_leaf();
		}
	}

	fn close_leaf(&mut self) {
		let Some(leaf) = self.leaf.take() else {
			return;
		};
		match leaf {
			Leaf::Inline { kind: InlineKind::Cell, buf } => {
				if let Some(Container::Table { row, .. }) = self.stack.last_mut() {
					row.push(buf.finish());
				}
			},
			Leaf::Inline { kind: InlineKind::Heading(level), buf } => {
				self.push_block(Block::Heading { level, runs: buf.finish() });
			},
			Leaf::Inline { buf, .. } => self.push_block(Block::Paragraph(buf.finish())),
			Leaf::Code { lang, mut code } => {
				if code.ends_with('\n') {
					code.pop();
				}
				self.push_block(Block::CodeBlock { lang, code: Arc::from(code) });
			},
			Leaf::Html(html) => {
				self.push_block(Block::Paragraph(Inlines::plain(html.trim_end_matches('\n'))));
			},
		}
	}

	fn close_container(&mut self) {
		self.close_leaf();
		let Some(container) = self.stack.pop() else {
			return;
		};
		match container {
			Container::Quote(blocks) => self.push_block(Block::Quote(blocks)),
			Container::List { ordered, start, items } => {
				self.push_block(Block::List { ordered, start, items });
			},
			Container::Item(blocks) => match self.stack.last_mut() {
				Some(Container::List { items, .. }) => items.push(blocks),
				_ => blocks.into_iter().for_each(|block| self.push_block(block)),
			},
			Container::Table { align, head, rows, .. } => {
				self.push_block(Block::Table { align, head, rows });
			},
		}
	}

	fn push_block(&mut self, block: Block) {
		match self.stack.last_mut() {
			Some(Container::Quote(blocks) | Container::Item(blocks)) => blocks.push(block),
			Some(Container::List { items, .. }) => match items.last_mut() {
				Some(item) => item.push(block),
				None => items.push(vec![block]),
			},
			// pulldown-cmark nests no block directly in a table.
			Some(Container::Table { .. }) => {},
			None => {
				self.root.push(block);
				self.starts.push(self.pending_start);
			},
		}
	}

	fn finish(mut self) -> (Vec<Block>, Vec<usize>) {
		self.close_leaf();
		while !self.stack.is_empty() {
			self.close_container();
		}
		(self.root, self.starts)
	}
}

/// The language word of a fence info string: its text up to the first space
/// or comma, so `rust,ignore` and `rust title="x"` both name `rust`.
fn fence_language(info: &str) -> Option<Arc<str>> {
	info
		.split(|c: char| c.is_whitespace() || c == ',')
		.find(|word| !word.is_empty())
		.map(Arc::from)
}

const fn column_align(align: Alignment) -> Align {
	match align {
		Alignment::None => Align::None,
		Alignment::Left => Align::Left,
		Alignment::Center => Align::Center,
		Alignment::Right => Align::Right,
	}
}
