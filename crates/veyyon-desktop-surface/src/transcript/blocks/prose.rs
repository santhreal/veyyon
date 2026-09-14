//! Prose block renderer for assistant turns (§5.2, §5.3).
//!
//! Renders Markdown text at assistant reading size with optional streaming
//! caret.
//!
//! A block still arriving is drawn in two pieces. Up to the boundary
//! `veyyon_desktop_model::text::markdown::settled_prefix_len` states, the
//! text is finished: it is drawn as it is and its spans are the spans the
//! selection path reads back, numbered from this block's own base. After the
//! boundary the block is the one still growing, so it is mended -- an
//! unterminated fence, table, list marker or emphasis is closed -- and drawn
//! as the shape it is becoming rather than as its own markers. The arriving
//! piece offers no span to drag over, because its shape changes with the next
//! delta.

use veyyon_desktop_kit::{ColorRole, Markdown, SelectableProse, SpacingStep, StrokeStep, TokenSet};
use veyyon_desktop_model::text::markdown::{mend, settled_prefix_len};
use veyyon_desktop_tokens::TranscriptSurfaceTokens;
use veyyon_gpui::{Div, ParentElement, Pixels, Styled, div, px};

use crate::transcript::selection::selectable_markdown;

/// One piece of a document, set at the ramp its caller states.
fn piece(text: String, size: Pixels, line_height: Pixels) -> Markdown {
	Markdown::new(text).prose_size(size, line_height)
}

/// A document a stream is still writing, drawn in its settled and arriving
/// pieces at the ramp the caller states.
///
/// Every surface that draws a model's markdown as it arrives goes through
/// here, so a reply and a thought summary share one boundary rule rather than
/// each carrying a copy of it.
pub fn streaming_document(
	text: &str,
	is_streaming: bool,
	size: Pixels,
	line_height: Pixels,
	selection: Option<SelectableProse>,
) -> Div {
	// A finished document has settled whole: the boundary is its end, and it
	// is drawn as one selectable document exactly as it was written.
	let settled = if is_streaming {
		settled_prefix_len(text)
	} else {
		text.len()
	};
	let mut body = div().w_full().flex().flex_col();
	if settled > 0 {
		body = body.child(selectable_markdown(
			piece(text[..settled].to_owned(), size, line_height),
			selection,
		));
	}
	if settled < text.len() {
		body = body.child(piece(mend(&text[settled..]), size, line_height));
	}
	body
}

/// Prose block, rendered as Markdown at assistant reading size with optional
/// streaming caret.
pub fn render_prose_block(
	text: &str,
	is_streaming: bool,
	caret_opacity: f32,
	geometry: &TranscriptSurfaceTokens,
	tokens: &TokenSet,
	selection: Option<SelectableProse>,
) -> Div {
	let mut block = div().w_full().child(streaming_document(
		text,
		is_streaming,
		px(geometry.assistant_turn_type_size.size),
		px(geometry.assistant_turn_type_size.line_height),
		selection,
	));

	// Two-step streaming caret (§5.3, §7.1 Caret motion role)
	if is_streaming && caret_opacity > 0.05 {
		block = block.child(
			div()
				.ml(tokens.spacing(SpacingStep::S2))
				.w(tokens.stroke(StrokeStep::Hairline))
				.h(px(geometry.assistant_turn_type_size.size))
				.bg(tokens.color(ColorRole::Foreground))
				.opacity(caret_opacity),
		);
	}

	block
}
