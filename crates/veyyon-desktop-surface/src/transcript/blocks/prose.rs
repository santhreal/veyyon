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
use veyyon_gpui::{Div, ParentElement, Styled, div, px};

use crate::transcript::selection::selectable_markdown;

/// One piece of a prose block, set at the assistant reading ramp.
fn piece(text: String, geometry: &TranscriptSurfaceTokens) -> Markdown {
	Markdown::new(text).prose_size(
		px(geometry.assistant_turn_type_size.size),
		px(geometry.assistant_turn_type_size.line_height),
	)
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
	// A finished block has settled whole: the boundary is its end, and it is
	// drawn as one selectable document exactly as it was written.
	let settled = if is_streaming {
		settled_prefix_len(text)
	} else {
		text.len()
	};
	let mut body = div().w_full().flex().flex_col();
	if settled > 0 {
		body =
			body.child(selectable_markdown(piece(text[..settled].to_owned(), geometry), selection));
	}
	if settled < text.len() {
		body = body.child(piece(mend(&text[settled..]), geometry));
	}
	let mut block = div().w_full().child(body);

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
