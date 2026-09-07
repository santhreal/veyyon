//! Subordinate transcript events and structural boundaries.

use veyyon_desktop_kit::{ColorRole, SpacingStep, StrokeStep, TextRamp, TokenSet};
use veyyon_gpui::{Div, ParentElement, Styled, div};

/// Render recorded annotations separately from assistant prose.
pub fn render_note_block(label: &str, text: &str, boundary: bool, tokens: &TokenSet) -> Div {
	let mut block = div()
		.w_full()
		.text_size(tokens.font_size(TextRamp::Small))
		.line_height(tokens.line_height(TextRamp::Small))
		.text_color(tokens.color(ColorRole::Muted));
	if boundary {
		block = block
			.border_t(tokens.stroke(StrokeStep::Hairline))
			.border_color(tokens.color(ColorRole::Muted))
			.pt(tokens.spacing(SpacingStep::S2));
	}
	block.child(format!("{label}: {text}"))
}
