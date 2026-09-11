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
//! else: `inline.rs` owns everything between them.

use veyyon_gpui::{App, IntoElement, Pixels, RenderOnce, SharedString, Window, div, prelude::*};

use crate::{
	text::{code_block::CodeBlock, selectable::prose_element, span_selection::SelectableProse},
	token_set::{ColorRole, SpacingStep, StrokeStep, TextRamp, TokenSet},
};

/// Markdown structured document renderer.
#[derive(IntoElement)]
pub struct Markdown {
	source:    SharedString,
	prose:     Option<(Pixels, Pixels)>,
	selection: Option<SelectableProse>,
}

impl Markdown {
	/// Creates a markdown renderer with source text. Prose is set at the
	/// reading ramp unless [`Markdown::prose_size`] says otherwise.
	#[must_use]
	pub fn new(source: impl Into<SharedString>) -> Self {
		Self { source: source.into(), prose: None, selection: None }
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

/// The first block that has text on it, with every marker off, for a surface
/// that draws one unstyled line of a document: a status line, a card's title.
/// Empty when the document has no text.
#[must_use]
pub fn plain_line(source: &str) -> String {
	blocks(source)
		.iter()
		.find_map(|block| {
			let text = match block {
				MdBlock::Heading { text, .. }
				| MdBlock::Quote(text)
				| MdBlock::Paragraph(text)
				| MdBlock::Bullet { text, .. } => crate::text::inline::plain(text),
				MdBlock::Code { lines, .. } => lines.first().cloned().unwrap_or_default(),
			};
			let text = text.trim().to_owned();
			(!text.is_empty()).then_some(text)
		})
		.unwrap_or_default()
}

/// One block of a Markdown document.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum MdBlock {
	Heading {
		level: u8,
		text:  String,
	},
	/// A list item: its own marker, and how deep the source indented it.
	Bullet {
		depth:  usize,
		marker: String,
		text:   String,
	},
	Quote(String),
	Paragraph(String),
	Code {
		lang:  String,
		lines: Vec<String>,
	},
}

/// The heading level a line opens with, and the text after it.
fn heading_of(line: &str) -> Option<(u8, &str)> {
	let hashes = line.bytes().take_while(|b| *b == b'#').count();
	if !(1..=6).contains(&hashes) {
		return None;
	}
	let rest = line.get(hashes..)?;
	let text = rest.strip_prefix(' ')?;
	Some((u8::try_from(hashes).ok()?, text.trim_start()))
}

/// The list marker a line opens with, and the text after it. An ordered item
/// keeps its own number, because renumbering it would state another order.
fn item_of(line: &str) -> Option<(String, &str)> {
	if let Some(text) = line
		.strip_prefix("- ")
		.or_else(|| line.strip_prefix("* "))
		.or_else(|| line.strip_prefix("+ "))
	{
		return Some(("•".to_owned(), text));
	}
	let digits = line.bytes().take_while(u8::is_ascii_digit).count();
	if digits == 0 || digits > 9 {
		return None;
	}
	let rest = line.get(digits..)?;
	let text = rest
		.strip_prefix(". ")
		.or_else(|| rest.strip_prefix(") "))?;
	Some((format!("{}.", &line[..digits]), text))
}

/// Reads `source` into blocks.
pub(crate) fn blocks(source: &str) -> Vec<MdBlock> {
	let mut out = Vec::new();
	let mut paragraph: Vec<&str> = Vec::new();
	let mut code: Option<(String, Vec<String>)> = None;

	let flush = |paragraph: &mut Vec<&str>, out: &mut Vec<MdBlock>| {
		if !paragraph.is_empty() {
			out.push(MdBlock::Paragraph(paragraph.join(" ")));
			paragraph.clear();
		}
	};

	for line in source.lines() {
		if let Some((lang, lines)) = code.as_mut() {
			if line.trim_start().starts_with("```") || line.trim_start().starts_with("~~~") {
				out.push(MdBlock::Code { lang: std::mem::take(lang), lines: std::mem::take(lines) });
				code = None;
			} else {
				lines.push(line.to_owned());
			}
			continue;
		}
		let body = line.trim_start();
		let depth = (line.len() - body.len()) / 2;
		if let Some(lang) = body
			.strip_prefix("```")
			.or_else(|| body.strip_prefix("~~~"))
		{
			flush(&mut paragraph, &mut out);
			code = Some((lang.trim().to_owned(), Vec::new()));
		} else if let Some((level, text)) = heading_of(body) {
			flush(&mut paragraph, &mut out);
			out.push(MdBlock::Heading { level, text: text.to_owned() });
		} else if let Some(text) = body.strip_prefix('>') {
			flush(&mut paragraph, &mut out);
			out.push(MdBlock::Quote(text.trim_start().to_owned()));
		} else if let Some((marker, text)) = item_of(body) {
			flush(&mut paragraph, &mut out);
			out.push(MdBlock::Bullet { depth, marker, text: text.to_owned() });
		} else if body.is_empty() {
			flush(&mut paragraph, &mut out);
		} else {
			paragraph.push(body);
		}
	}
	flush(&mut paragraph, &mut out);
	if let Some((lang, lines)) = code {
		// An unclosed fence at the end of a streaming message is still code.
		out.push(MdBlock::Code { lang, lines });
	}
	out
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
			};
		}

		container
	}
}

#[cfg(test)]
mod tests {
	use super::{MdBlock, blocks, plain_line};

	#[test]
	fn consecutive_lines_are_one_paragraph_and_a_blank_line_ends_it() {
		let read = blocks("one\ntwo\n\nthree");
		assert_eq!(read, [MdBlock::Paragraph("one two".into()), MdBlock::Paragraph("three".into())]);
	}

	#[test]
	fn a_heading_bullet_or_fence_ends_the_paragraph_before_it() {
		let read = blocks("a\n# H\nb\n- c\nd\n```rs\nx\n```\ne");
		assert_eq!(read, [
			MdBlock::Paragraph("a".into()),
			MdBlock::Heading { level: 1, text: "H".into() },
			MdBlock::Paragraph("b".into()),
			MdBlock::Bullet { depth: 0, marker: "•".into(), text: "c".into() },
			MdBlock::Paragraph("d".into()),
			MdBlock::Code { lang: "rs".into(), lines: vec!["x".into()] },
			MdBlock::Paragraph("e".into()),
		]);
	}

	#[test]
	fn an_unclosed_fence_is_still_code() {
		let read = blocks("```\nlet a = 1;");
		assert_eq!(read, [MdBlock::Code { lang: String::new(), lines: vec!["let a = 1;".into()] }]);
	}

	#[test]
	fn every_heading_level_is_a_heading_and_a_bare_hash_is_prose() {
		for level in 1..=6_u8 {
			let hashes = "#".repeat(usize::from(level));
			let read = blocks(&format!("{hashes} H"));
			assert_eq!(read, [MdBlock::Heading { level, text: "H".into() }], "{hashes} H");
		}
		assert_eq!(blocks("####### H"), [MdBlock::Paragraph("####### H".into())]);
		assert_eq!(blocks("#nothash"), [MdBlock::Paragraph("#nothash".into())]);
	}

	#[test]
	fn every_list_marker_is_an_item_and_an_ordered_one_keeps_its_number() {
		for marker in ["-", "*", "+"] {
			let read = blocks(&format!("{marker} item"));
			assert_eq!(read, [MdBlock::Bullet {
				depth:  0,
				marker: "•".into(),
				text:   "item".into(),
			}]);
		}
		assert_eq!(blocks("2. second\n3) third"), [
			MdBlock::Bullet { depth: 0, marker: "2.".into(), text: "second".into() },
			MdBlock::Bullet { depth: 0, marker: "3.".into(), text: "third".into() },
		]);
		assert_eq!(blocks("1.no space"), [MdBlock::Paragraph("1.no space".into())]);
	}

	#[test]
	fn an_indented_item_states_its_depth() {
		let read = blocks("- top\n  - under\n    - deeper");
		assert_eq!(read, [
			MdBlock::Bullet { depth: 0, marker: "•".into(), text: "top".into() },
			MdBlock::Bullet { depth: 1, marker: "•".into(), text: "under".into() },
			MdBlock::Bullet { depth: 2, marker: "•".into(), text: "deeper".into() },
		]);
	}

	#[test]
	fn a_quote_is_its_own_block_without_the_arrow() {
		assert_eq!(blocks("> said so"), [MdBlock::Quote("said so".into())]);
	}

	#[test]
	fn the_plain_line_is_the_first_block_with_text_and_carries_no_marker() {
		assert_eq!(plain_line("# **Ship** the `tag`\n\nbody"), "Ship the tag");
		assert_eq!(plain_line("\n\n- [the plan](docs/plan.md)"), "the plan (docs/plan.md)");
		assert_eq!(plain_line("```sh\ncargo test\n```"), "cargo test");
		assert_eq!(plain_line(""), "");
		assert_eq!(plain_line("\n \n"), "");
	}
}
