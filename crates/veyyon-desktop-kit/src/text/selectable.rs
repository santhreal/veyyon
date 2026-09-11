//! Text a pointer can select, and the span ids it reports back (§8.25).
//!
//! WHY: the frame drew a document and the pointer could do nothing over it. A
//! reader could copy a whole turn from its menu and could not take one
//! sentence, one path out of a refusal, or one line of a command's output.
//!
//! A span draws through one text layout, which is the thing that turns a
//! pointer position into a byte offset: the layout shapes the text it drew, so
//! a wrapped line, a truncated line, a grapheme cluster spanning two runs and
//! a right-to-left run are measured by the same shaper that drew them rather
//! than by a second guess at the widths here.
//!
//! The span reports what the pointer did and draws what the surface hands
//! back. It keeps no selection of its own, because a selection that lives in
//! the element it started in cannot reach the span the pointer travelled to.

use std::ops::Range;

use veyyon_gpui::{
	AnyElement, Div, HighlightStyle, Hsla, InteractiveElement, IntoElement, MouseButton,
	MouseDownEvent, MouseMoveEvent, ParentElement, Pixels, Point, SharedString, Stateful,
	StyledText, TextLayout, div, prelude::*,
};

use crate::{
	text::{
		inline::{inline_prose, plain, shaped_prose},
		markdown::{MdBlock, blocks},
		span_selection::{SelectableProse, SpanGesture, SpanId, SpanPoint},
	},
	token_set::TokenSet,
};

/// One line of prose, selectable: set the way [`inline_prose`] sets it, with
/// the selected bytes drawn on the selection ground and the pointer reported
/// back as offsets into the text this span drew.
///
/// [`inline_prose`]: crate::text::inline::inline_prose
#[must_use]
pub fn selectable_prose(
	text: &str,
	tokens: &TokenSet,
	size: Pixels,
	line_height: Pixels,
	span: SpanId,
	prose: &SelectableProse,
) -> AnyElement {
	let shaped = shaped_prose(text, tokens);
	let mut highlights = shaped.highlights;
	let drawn = SharedString::from(shaped.drawn);
	if let Some(range) = prose.range_in(span, drawn.len()) {
		highlights.push((range, selected_style(tokens.row_selected())));
	}
	let styled = StyledText::new(drawn)
		.with_highlights(highlights)
		.with_font_family_overrides(shaped.mono);
	reporting(styled, span, prose)
		.text_size(size)
		.line_height(line_height)
		.into_any_element()
}

/// One line already set in one style, selectable: a line of a code pane, a
/// caption, a label.
#[must_use]
pub fn selectable_line(
	line: impl Into<SharedString>,
	tokens: &TokenSet,
	span: SpanId,
	prose: &SelectableProse,
) -> AnyElement {
	let drawn: SharedString = line.into();
	let mut highlights: Vec<(Range<usize>, HighlightStyle)> = Vec::new();
	if let Some(range) = prose.range_in(span, drawn.len()) {
		highlights.push((range, selected_style(tokens.row_selected())));
	}
	let styled = StyledText::new(drawn).with_highlights(highlights);
	reporting(styled, span, prose).into_any_element()
}

/// The style the selected bytes are drawn in: the ground every row surface
/// marks a selection with, behind the ink the text already had, so a selected
/// link is still a link and selected code is still code.
fn selected_style(ground: Hsla) -> HighlightStyle {
	HighlightStyle { background_color: Some(ground), ..HighlightStyle::default() }
}

/// The element `styled` is drawn in, with the pointer over it reported as
/// offsets into the text it drew.
///
/// The layout is taken before the text becomes an element and read back inside
/// the listeners: by the time a listener runs, the frame that registered it
/// has been laid out, so the layout it reads is the one the reader is looking
/// at.
fn reporting(styled: StyledText, span: SpanId, prose: &SelectableProse) -> Stateful<Div> {
	let layout = styled.layout().clone();
	let pressed = (layout.clone(), prose.clone());
	let dragged = (layout, prose.clone());

	div()
		.id(("selectable-span", span.0 as usize))
		.on_mouse_down(MouseButton::Left, move |event: &MouseDownEvent, window, cx| {
			let (layout, prose) = &pressed;
			let at = SpanPoint::new(span, offset_at(layout, event.position));
			prose.report(SpanGesture::Press { at, extend: event.modifiers.shift }, window, cx);
		})
		.on_mouse_move(move |event: &MouseMoveEvent, window, cx| {
			if !event.dragging() {
				return;
			}
			let (layout, prose) = &dragged;
			let at = SpanPoint::new(span, offset_at(layout, event.position));
			prose.report(SpanGesture::Extend(at), window, cx);
		})
		.child(styled)
}

/// The byte offset `at` names in the text `layout` drew.
///
/// The boundary taken is the CLOSEST one rather than the glyph the position
/// sits inside: a reader who drags to the right half of the last character
/// means that character, and a resolution that took the glyph's own start
/// could never select it -- the sentence came back one `?` short of what the
/// drag had crossed. A position above the text, past the end of a line or
/// below the last line resolves to the nearest offset rather than to nothing,
/// which is what a reader dragging past the end of a sentence means by it.
fn offset_at(layout: &TextLayout, at: Point<Pixels>) -> usize {
	let line_height = layout.line_height();
	let mut origin = layout.bounds().origin;
	let mut line_start = 0;
	for line in layout.line_layouts() {
		let bottom = origin.y + line.size(line_height).height;
		if at.y > bottom {
			origin.y = bottom;
			// The newline between two lines is a byte of the text they were
			// laid out from, and no line holds it.
			line_start += line.len() + 1;
			continue;
		}
		let within = at - origin;
		let (Ok(index) | Err(index)) = line.closest_index_for_position(within, line_height);
		return line_start + index;
	}
	layout.len()
}

/// One block's prose, selectable when the document carries a selection and
/// plain when it does not, so a surface that never offers selection draws
/// exactly what it drew before.
#[must_use]
pub fn prose_element(
	text: &str,
	tokens: &TokenSet,
	size: Pixels,
	line_height: Pixels,
	index: u16,
	selection: Option<&SelectableProse>,
) -> AnyElement {
	match selection {
		Some(prose) => selectable_prose(text, tokens, size, line_height, prose.span(index), prose),
		None => inline_prose(text, tokens, size, line_height),
	}
}

/// The text each span of a markdown document draws, in the order the document
/// draws them.
///
/// This is the other half of the numbering `Markdown` renders with: prose is
/// one span of the text with its markers off, and a code pane is one span per
/// line. A surface holding a selection over the document reads the words it
/// covers from here rather than from the frame.
#[must_use]
pub fn document_spans(source: &str) -> Vec<String> {
	let mut out = Vec::new();
	for block in blocks(source) {
		match block {
			MdBlock::Heading { text, .. }
			| MdBlock::Quote(text)
			| MdBlock::Paragraph(text)
			| MdBlock::Bullet { text, .. } => out.push(plain(&text)),
			MdBlock::Code { lines, .. } => out.extend(lines),
			// A cell is one span, numbered in the order the grid draws it:
			// every header cell, then every cell of every row.
			MdBlock::Table { head, rows, .. } => {
				out.extend(head.iter().map(|cell| plain(cell)));
				out.extend(rows.iter().flatten().map(|cell| plain(cell)));
			},
		}
	}
	out
}
