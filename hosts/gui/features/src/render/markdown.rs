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
use veyyon_gui_core::text::markdown::{Item, ListKind, Md, Span};
use veyyon_gui_kit::{
	theme::{Theme, radius, size, space, weight},
	ui::{Icon, card, icon, square, text},
};

use super::code;

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

		Md::List(items) => {
			let mut column = text::stack(space::TIGHT).w_full();
			for item in items {
				column = column.child(bullet(item, &theme));
			}
			column.into_any_element()
		},

		// A quote is a run of blocks indented behind a rule, so a quote of a
		// list is a list and a quote of a quote steps in again.
		Md::Quote(inner) => div()
			.flex()
			.w_full()
			.gap(px(space::BASE))
			.child(
				div()
					.flex_none()
					.w(px(2.0))
					.rounded(px(radius::PILL))
					.bg(theme.stroke),
			)
			.child(
				text::stack(space::BASE)
					.flex_1()
					.children(blocks(inner, id, cx)),
			)
			.into_any_element(),

		Md::Code { lang, body } => code::well(id, lang, body, cx).into_any_element(),

		Md::Rule => text::hairline(&theme)
			.my(px(space::SNUG))
			.into_any_element(),

		Md::Table { head, rows } => table(head, rows, &theme).into_any_element(),
	}
}

/// A heading. Three sizes for six levels, because a transcript is not a
/// document and a level-five heading inside a message is a bold line.
fn heading(level: u8, spans: &[Span], theme: &Theme) -> gpui::Div {
	let size = match level {
		1 => size::TITLE,
		2 => size::LEAD,
		_ => size::BODY,
	};
	runs(spans, theme)
		.w_full()
		.text_size(px(size))
		.line_height(px(size * size::LINE_TIGHT))
		.font_weight(if level <= 2 {
			weight::STRONG
		} else {
			weight::MEDIUM
		})
		.pt(px(space::TIGHT))
}

/// One list item: its marker, then its text.
///
/// The marker column is fixed, so wrapped text lines up under the first word
/// rather than under the bullet.
fn bullet(item: &Item, theme: &Theme) -> gpui::Div {
	let marker = match (item.done, item.kind) {
		// A task box is drawn as a box, not as a pair of brackets.
		(Some(done), _) => square(icon::scale::SMALL)
			.child(icon::at(
				if done { Icon::Check } else { Icon::Folded },
				icon::scale::SMALL,
				if done { theme.ok } else { theme.text_faint },
			))
			.into_any_element(),
		// A middot is a punctuation mark inside a line; a list marker is a
		// bullet, drawn a little smaller than the words it heads.
		(None, ListKind::Bullet) => text::line("•")
			.text_size(px(size::SMALL))
			.text_color(theme.text_faint)
			.into_any_element(),
		(None, ListKind::Ordered(number)) => text::line(format!("{number}."))
			.text_color(theme.text_faint)
			.text_size(px(size::SMALL))
			.into_any_element(),
	};

	div()
		.flex()
		.w_full()
		.gap(px(space::SNUG))
		.pl(px(f32::from(item.depth) * space::WIDE))
		.child(
			div()
				.flex_none()
				.w(px(icon::scale::BASE))
				.flex()
				// The marker ends where the column ends, so every marker sits the
				// same gap from its own words and a stack of numbers lines up on
				// the period. Centred, "•" and "10." start and end at four
				// different places down one list.
				.justify_end()
				.child(marker),
		)
		.child(runs(&item.spans, theme).flex_1())
}

/// A table. Rows of cells with a hairline under the head, in the well every
/// standalone block takes.
///
/// The well is what makes it a block rather than loose text: a table is lifted
/// out of the bubble its message reads in, so without a ground of its own it
/// lands on the canvas with nothing around it while the fence above it and the
/// patch below it are both cards.
fn table(head: &[Vec<Span>], rows: &[Vec<Vec<Span>>], theme: &Theme) -> gpui::Div {
	let cells = |cells: &[Vec<Span>], strong: bool| {
		let mut row = div().flex().w_full().gap(px(space::BASE));
		for cell in cells {
			let mut element = runs(cell, theme).flex_1().min_w(px(0.0));
			if strong {
				element = element.font_weight(weight::MEDIUM);
			}
			row = row.child(element);
		}
		row
	};

	let mut column = text::stack(space::TIGHT).w_full();
	if !head.is_empty() {
		column = column.child(cells(head, true)).child(text::hairline(theme));
	}
	for row in rows {
		column = column.child(cells(row, false));
	}
	card::well(theme)
		.w_full()
		.px(px(space::BASE))
		.py(px(space::SNUG))
		.child(column)
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
