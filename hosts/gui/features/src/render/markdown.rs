//! Prose.
//!
//! An engine writes markdown, so a transcript that prints it verbatim is a
//! transcript with asterisks in it. Every block kind the parser in core
//! produces is drawn here, and the parser is total, so there is no input this
//! refuses: text that is not markdown is one paragraph.
//!
//! ONE TEXT ELEMENT PER RUN OF PROSE. Emphasis, code and links are styled runs
//! inside one text element rather than a row of elements per span, because a
//! row of elements does not wrap: a bold word in the middle of a sentence would
//! put the rest of the sentence on its own line. The parser hands back offsets
//! into one string, which is exactly what a run-styled text element wants.

use gpui::{
	AnyElement, App, HighlightStyle, IntoElement, ParentElement, Styled, StyledText, UnderlineStyle,
	div, px,
};
use veyyon_gui_core::text::markdown::{Md, Span};
use veyyon_gui_kit::{
	theme::{Theme, size, space, weight},
	ui::text,
};

use super::{code, list, quote, table};

/// Every block of one run of prose, in order.
pub fn blocks(blocks: &[Md], id: &str, cx: &mut App) -> Vec<AnyElement> {
	blocks
		.iter()
		.enumerate()
		.map(|(index, md)| block(md, &format!("{id}-{index}"), cx))
		.collect()
}

/// One block. Public because the operator's side of a transcript draws its
/// prose and its fences into different fills, which means asking for a block
/// at a time.
pub fn block(block: &Md, id: &str, cx: &mut App) -> AnyElement {
	let theme = Theme::get(cx);
	match block {
		Md::Heading { level, spans } => heading(*level, spans, &theme).into_any_element(),

		Md::Paragraph(spans) => runs(spans, &theme).w_full().into_any_element(),

		Md::List(items) => list::list(items, &theme).into_any_element(),

		Md::Quote(inner) => quote::quote(inner, id, cx).into_any_element(),

		Md::Code { lang, body } => code::well(id, lang, body, cx).into_any_element(),

		Md::Rule => text::hairline(&theme)
			.my(px(space::SNUG))
			.into_any_element(),

		Md::Table { head, rows } => table::table(head, rows, &theme).into_any_element(),
	}
}

/// A heading. Three sizes for six levels, because a transcript is not a
/// document and a level-five heading inside a message is a bold line.
fn heading(level: u8, spans: &[Span], theme: &Theme) -> gpui::Div {
	let size = match level {
		1 => size::section(),
		2 => size::lead(),
		_ => size::body(),
	};
	runs(spans, theme)
		.w_full()
		.text_size(px(size))
		.line_height(px(size * size::LINE_CHROME))
		.font_weight(if level <= 2 {
			weight::STRONG
		} else {
			weight::MEDIUM
		})
		.pt(px(space::TIGHT))
}

/// One run of prose: the text, with its emphasis, code and links as styled
/// runs.
pub fn runs(spans: &[Span], theme: &Theme) -> gpui::Div {
	let (body, styles) = styled(spans, theme);
	div().child(StyledText::new(body).with_highlights(styles))
}

/// The text a run of spans reads as, and the styled ranges into it.
///
/// Separate from the element because it is the part that can be wrong in a way
/// nobody sees: a range off by a byte lands inside a multi-byte character, and
/// the text system asserts on it in a debug build and mis-styles the run in a
/// release one. Every offset here is a byte offset into the returned string.
pub fn styled(
	spans: &[Span],
	theme: &Theme,
) -> (String, Vec<(std::ops::Range<usize>, HighlightStyle)>) {
	let mut body = String::new();
	let mut styles: Vec<(std::ops::Range<usize>, HighlightStyle)> = Vec::new();

	for span in spans {
		let (text, style) = match span {
			Span::Plain(text) => (text.as_str(), None),
			Span::Strong(text) => (
				text.as_str(),
				Some(HighlightStyle { font_weight: Some(weight::STRONG), ..Default::default() }),
			),
			Span::Emphasis(text) => (
				text.as_str(),
				Some(HighlightStyle {
					font_style: Some(gpui::FontStyle::Italic),
					..Default::default()
				}),
			),
			Span::Code(text) => (text.as_str(), Some(code::inline(theme))),
			// A link is underlined and takes the accent. The URL is not printed:
			// a line of prose with a raw href in it is unreadable, and the text
			// is what the writer chose to say about it.
			Span::Link { text, .. } => (
				text.as_str(),
				Some(HighlightStyle {
					color: Some(theme.accent),
					underline: Some(UnderlineStyle {
						thickness: px(1.0),
						color:     Some(theme.accent.opacity(0.5)),
						wavy:      false,
					}),
					..Default::default()
				}),
			),
		};
		let start = body.len();
		body.push_str(text);
		if let Some(style) = style {
			styles.push((start..body.len(), style));
		}
	}
	(body, styles)
}
