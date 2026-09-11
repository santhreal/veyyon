//! Subordinate transcript events and structural boundaries.

use veyyon_desktop_kit::{
	ColorRole, SelectableProse, SpacingStep, StrokeStep, TextRamp, TokenSet, selectable_line,
};
use veyyon_gpui::{Div, IntoElement, ParentElement, Styled, div};

/// Render recorded annotations separately from assistant prose.
pub fn render_note_block(
	label: &str,
	text: &str,
	boundary: bool,
	tokens: &TokenSet,
	selection: Option<SelectableProse>,
) -> Div {
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
	// The row is one span: the label and the text as one line, which is what
	// the row draws and what a reader dragging over it means by it.
	let line = if text.is_empty() {
		label.to_owned()
	} else {
		format!("{label}: {text}")
	};
	match &selection {
		Some(prose) => block.child(selectable_line(line, tokens, prose.span(0), prose)),
		None => block.child(line.into_any_element()),
	}
}
