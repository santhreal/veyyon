//! Markdown block renderer primitive (§8.25).
//!
//! Source is read into blocks — headings, bullets, fenced code and
//! paragraphs — and each block is drawn at its ramp. Consecutive lines of
//! prose are one paragraph, as in Markdown, so a paragraph wrapped in the
//! source is not a stack of one-line paragraphs on the frame. Prose is set at
//! the reading size unless the caller sets another.

use veyyon_gpui::{App, IntoElement, Pixels, RenderOnce, SharedString, Window, div, prelude::*};

use crate::{
	text::code_block::CodeBlock,
	token_set::{ColorRole, SpacingStep, TextRamp, TokenSet},
};

/// Markdown structured document renderer.
#[derive(IntoElement)]
pub struct Markdown {
	source: SharedString,
	prose:  Option<(Pixels, Pixels)>,
}

impl Markdown {
	/// Creates a markdown renderer with source text. Prose is set at the
	/// reading ramp unless [`Markdown::prose_size`] says otherwise.
	#[must_use]
	pub fn new(source: impl Into<SharedString>) -> Self {
		Self { source: source.into(), prose: None }
	}

	/// The size and line height paragraphs and bullets are set at, for a
	/// surface whose tokens resolve the prose size themselves.
	#[must_use]
	pub const fn prose_size(mut self, size: Pixels, line_height: Pixels) -> Self {
		self.prose = Some((size, line_height));
		self
	}
}

/// One block of a Markdown document.
#[derive(Debug, PartialEq, Eq)]
enum MdBlock {
	Heading { level: u8, text: String },
	Bullet(String),
	Paragraph(String),
	Code { lang: String, lines: Vec<String> },
}

/// Reads `source` into blocks.
fn blocks(source: &str) -> Vec<MdBlock> {
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
			if line.starts_with("```") {
				out.push(MdBlock::Code { lang: std::mem::take(lang), lines: std::mem::take(lines) });
				code = None;
			} else {
				lines.push(line.to_owned());
			}
			continue;
		}
		if let Some(lang) = line.strip_prefix("```") {
			flush(&mut paragraph, &mut out);
			code = Some((lang.trim().to_owned(), Vec::new()));
		} else if let Some(text) = line.strip_prefix("### ") {
			flush(&mut paragraph, &mut out);
			out.push(MdBlock::Heading { level: 3, text: text.to_owned() });
		} else if let Some(text) = line.strip_prefix("## ") {
			flush(&mut paragraph, &mut out);
			out.push(MdBlock::Heading { level: 2, text: text.to_owned() });
		} else if let Some(text) = line.strip_prefix("# ") {
			flush(&mut paragraph, &mut out);
			out.push(MdBlock::Heading { level: 1, text: text.to_owned() });
		} else if let Some(text) = line.strip_prefix("- ").or_else(|| line.strip_prefix("* ")) {
			flush(&mut paragraph, &mut out);
			out.push(MdBlock::Bullet(text.to_owned()));
		} else if line.trim().is_empty() {
			flush(&mut paragraph, &mut out);
		} else {
			paragraph.push(line.trim());
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
		let prose = |ramp: TextRamp| {
			div()
				.w_full()
				.text_size(tokens.font_size(ramp))
				.line_height(tokens.line_height(ramp))
				.text_color(ink)
		};
		let body = || match self.prose {
			Some((size, line_height)) => div()
				.w_full()
				.text_size(size)
				.line_height(line_height)
				.text_color(ink),
			None => prose(TextRamp::Read),
		};

		let mut container = div()
			.flex()
			.flex_col()
			.gap(tokens.spacing(SpacingStep::S3))
			.w_full();

		for block in blocks(&self.source) {
			container = match block {
				MdBlock::Heading { level, text } => {
					let ramp = if level == 1 {
						TextRamp::Lead
					} else {
						TextRamp::Head
					};
					container.child(prose(ramp).child(text))
				},
				MdBlock::Bullet(text) => container.child(
					div()
						.w_full()
						.flex()
						.flex_row()
						.gap(tokens.spacing(SpacingStep::S2))
						.child(
							div()
								.flex_shrink_0()
								.text_color(tokens.color(ColorRole::Muted))
								.child("•"),
						)
						.child(body().flex_1().min_w_0().child(text)),
				),
				MdBlock::Paragraph(text) => container.child(body().child(text)),
				MdBlock::Code { lang, lines } => {
					let mut pane = CodeBlock::lines(lines.into_iter().map(SharedString::from));
					if !lang.is_empty() {
						pane = pane.caption(lang);
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
	use super::{MdBlock, blocks};

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
			MdBlock::Bullet("c".into()),
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
}
