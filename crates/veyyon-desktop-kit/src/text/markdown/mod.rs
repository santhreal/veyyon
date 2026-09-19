//! Markdown block renderer primitive (§8.25).
//!
//! Source is read into blocks — headings, bullets, ordered items, quotes,
//! fenced code and paragraphs — and each block is drawn at its ramp.
//! Consecutive lines of prose are one paragraph, as in Markdown, so a paragraph
//! wrapped in the source is not a stack of one-line paragraphs on the frame.
//! Prose is set at the reading size unless the caller sets another.
//!
//! A block's own text goes through [`inline_prose`], so the markers inside it
//! are set rather than drawn. This module owns the block markers and nothing
//! else: `inline.rs` owns everything between them, and `blocks.rs` reads the
//! source into the blocks drawn here.

mod blocks;
mod table;

use veyyon_gpui::{App, IntoElement, Pixels, RenderOnce, SharedString, Window, div, prelude::*};

pub(crate) use self::blocks::{MdBlock, blocks};
use crate::{
	text::{code_block::CodeBlock, selectable::prose_element, span_selection::SelectableProse},
	token_set::{ColorRole, SpacingStep, StrokeStep, TextRamp, TokenSet},
};

/// Markdown structured document renderer.
#[derive(IntoElement)]
pub struct Markdown {
	source:           SharedString,
	prose:            Option<(Pixels, Pixels)>,
	table_row_height: Option<Pixels>,
	selection:        Option<SelectableProse>,
}

impl Markdown {
	/// Creates a markdown renderer with source text. Prose is set at the
	/// reading ramp unless [`Markdown::prose_size`] says otherwise.
	#[must_use]
	pub fn new(source: impl Into<SharedString>) -> Self {
		Self {
			source:           source.into(),
			prose:            None,
			table_row_height: None,
			selection:        None,
		}
	}

	/// Overrides table row height for surfaces with dedicated table row tokens.
	#[must_use]
	pub const fn table_row_height(mut self, height: Pixels) -> Self {
		self.table_row_height = Some(height);
		self
	}

	/// The spans of this document are selectable, numbered from the id
	/// `selection` opens at and drawing the selection it carries.
	#[must_use]
	pub fn selection(mut self, selection: SelectableProse) -> Self {
		self.selection = Some(selection);
		self
	}

	/// The size and line height paragraphs and bullets are set at, for a
	/// surface whose tokens resolve the prose size themselves.
	#[must_use]
	pub const fn prose_size(mut self, size: Pixels, line_height: Pixels) -> Self {
		self.prose = Some((size, line_height));
		self
	}
}

/// The count of contiguous bytes of `delimiter` starting at `at`, which is how
/// a run of inline markers is measured.
///
/// `veyyon-desktop-model` states the same count for the streaming parser that
/// mends an unterminated shape. The two are separate on purpose: §8.2 admits no
/// edge from the kit to the model, so a primitive both layers read is defined
/// in each rather than reached across. Change one and change the other.
#[must_use]
pub fn run_len(bytes: &[u8], at: usize, delimiter: u8) -> usize {
	bytes[at..]
		.iter()
		.take_while(|byte| **byte == delimiter)
		.count()
}

/// The first block that has text on it, for a surface that draws one unstyled
/// line of a document: a status line, a card's title. Empty when the document
/// has no text.
///
/// Every block marker comes off except an ordered one, which is the step's
/// number: a plan whose first line is `1. Measure` states the step it is on,
/// and a run bar reading `Measure` has dropped content rather than a marker.
/// An unordered bullet is a glyph standing in for a list, and one line is no
/// list, so it comes off.
#[must_use]
pub fn plain_line(source: &str) -> String {
	blocks(source)
		.iter()
		.find_map(|block| {
			let text = match block {
				MdBlock::Heading { text, .. } | MdBlock::Paragraph(text) => {
					crate::text::inline::plain(text)
				},
				MdBlock::Bullet { marker, text, .. } => {
					let text = crate::text::inline::plain(text);
					if marker.ends_with('.') && !text.trim().is_empty() {
						format!("{marker} {}", text.trim_start())
					} else {
						text
					}
				},
				MdBlock::Quote(text) => {
					let mut body = text.as_str();
					while let Some(rest) = body.strip_prefix('>') {
						body = rest.trim_start();
					}
					crate::text::inline::plain(body)
				},
				MdBlock::Code { lines, .. } => lines
					.iter()
					.find(|line| !line.trim().is_empty())
					.cloned()
					.unwrap_or_default(),
				// A table's first line is its header, which states what the rows are
				// of rather than what any one row holds.
				MdBlock::Table { head, .. } => crate::text::inline::plain(&head.join(" ")),
			};
			let text = text.trim().to_owned();
			(!text.is_empty()).then_some(text)
		})
		.unwrap_or_default()
}

impl RenderOnce for Markdown {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let resolved_tokens = TokenSet::for_app(cx);
		let tokens: &TokenSet = &resolved_tokens;
		let ink = tokens.color(ColorRole::Foreground);
		let (prose_size, prose_line) = self
			.prose
			.unwrap_or_else(|| (tokens.font_size(TextRamp::Read), tokens.line_height(TextRamp::Read)));

		let mut container = div()
			.flex()
			.flex_col()
			.gap(tokens.spacing(SpacingStep::S3))
			.w_full();

		// Spans are numbered in the order the document draws them, so the
		// surface that holds the selection can name the text of a span without
		// reading the frame: prose is one span, and a code pane is one per
		// line. `document_spans` walks the same order.
		let selection = self.selection.as_ref();
		let mut index: u16 = 0;
		for block in blocks(&self.source) {
			container = match block {
				MdBlock::Heading { level, text } => {
					let ramp = if level == 1 {
						TextRamp::Lead
					} else {
						TextRamp::Head
					};
					let drawn = prose_element(
						&text,
						tokens,
						tokens.font_size(ramp),
						tokens.line_height(ramp),
						index,
						selection,
					);
					index += 1;
					container.child(div().w_full().text_color(ink).child(drawn))
				},
				// The row carries the prose ramp so the marker draws at the size
				// of the text it marks; a marker that sets none draws at gpui's
				// 16px default, which §6.3 does not author.
				MdBlock::Bullet { depth, marker, text } => {
					let drawn = prose_element(&text, tokens, prose_size, prose_line, index, selection);
					index += 1;
					container.child(
						div()
							.w_full()
							.text_color(ink)
							.text_size(prose_size)
							.line_height(prose_line)
							.pl(
								tokens.spacing(SpacingStep::S4)
									* f32::from(u8::try_from(depth).unwrap_or(u8::MAX)),
							)
							.flex()
							.flex_row()
							.gap(tokens.spacing(SpacingStep::S2))
							.child(
								div()
									.flex_shrink_0()
									.text_color(tokens.color(ColorRole::Muted))
									.child(marker),
							)
							.child(div().flex_1().min_w_0().child(drawn)),
					)
				},
				// A quote is what someone else said, so it is set off by the
				// rule down its leading edge rather than by another ramp.
				MdBlock::Quote(text) => {
					let drawn = prose_element(&text, tokens, prose_size, prose_line, index, selection);
					index += 1;
					container.child(
						div()
							.w_full()
							.flex()
							.flex_row()
							.gap(tokens.spacing(SpacingStep::S2))
							.border_l(tokens.stroke(StrokeStep::Hairline))
							.border_color(tokens.color(ColorRole::Hairline))
							.pl(tokens.spacing(SpacingStep::S2))
							.text_color(tokens.color(ColorRole::Secondary))
							.child(drawn),
					)
				},
				MdBlock::Paragraph(text) => {
					let drawn = prose_element(&text, tokens, prose_size, prose_line, index, selection);
					index += 1;
					container.child(div().w_full().text_color(ink).child(drawn))
				},
				MdBlock::Code { lang, lines } => {
					let first = index;
					index += u16::try_from(lines.len()).unwrap_or(u16::MAX);
					let mut pane = CodeBlock::lines(lines.into_iter().map(SharedString::from));
					if !lang.is_empty() {
						pane = pane.caption(lang);
					}
					if let Some(selection) = selection {
						pane = pane.selection(selection.clone(), selection.span(first));
					}
					container.child(pane)
				},
				MdBlock::Table { head, align, rows } => {
					let table_line = self.table_row_height.unwrap_or(prose_line);
					container.child(table::table_block(
						&head, &align, &rows, tokens, prose_size, table_line, &mut index, selection,
					))
				},
			};
		}

		container
	}
}

#[cfg(test)]
mod tests {
	use super::plain_line;

	#[test]
	fn the_plain_line_is_the_first_block_with_text_and_carries_no_marker() {
		assert_eq!(plain_line("# **Ship** the `tag`\n\nbody"), "Ship the tag");
		assert_eq!(plain_line("\n\n- [the plan](docs/plan.md)"), "the plan (docs/plan.md)");
		assert_eq!(plain_line("```sh\ncargo test\n```"), "cargo test");
		assert_eq!(plain_line(""), "");
		assert_eq!(plain_line("\n \n"), "");
		assert_eq!(plain_line("| Col 1 | Col 2 |\n|---|---|\n| a | b |"), "Col 1 Col 2");
		assert_eq!(plain_line("```sh\n\n  cargo test\n```"), "cargo test");
		assert_eq!(plain_line(">>> nested quote"), "nested quote");
	}
}
