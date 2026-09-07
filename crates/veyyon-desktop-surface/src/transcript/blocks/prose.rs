//! Prose block renderer for assistant turns (§5.2, §5.3).
//!
//! Renders Markdown text at assistant reading size with optional streaming
//! caret.

use veyyon_desktop_kit::{ColorRole, Markdown, SpacingStep, StrokeStep, TokenSet};
use veyyon_desktop_tokens::TranscriptSurfaceTokens;
use veyyon_gpui::{Div, ParentElement, Styled, div, px};

/// Prose block, rendered as Markdown at assistant reading size with optional
/// streaming caret.
pub fn render_prose_block(
	text: &str,
	is_streaming: bool,
	caret_opacity: f32,
	geometry: &TranscriptSurfaceTokens,
	tokens: &TokenSet,
) -> Div {
	let mut block = div()
		.w_full()
		.child(Markdown::new(text.to_owned()).prose_size(
			px(geometry.assistant_turn_type_size.size),
			px(geometry.assistant_turn_type_size.line_height),
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
