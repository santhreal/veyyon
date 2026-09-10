//! Text area multiline input primitive over an Editor entity (§8.25).
//!
//! Like [`super::text_field::TextField`], the area takes the editor itself:
//! an element rebuilt every frame keeps no keystroke, so a value passed in
//! its place is a value on display and not an input.

use veyyon_gpui::{App, ElementId, Entity, IntoElement, RenderOnce, Window, div, prelude::*};

use super::editor::Editor;
use crate::{
	state::InteractiveState,
	token_set::{ColorRole, RadiusStep, SpacingStep, TextRamp, TokenSet},
};

/// Multiline text input area primitive element.
#[derive(IntoElement)]
pub struct TextArea {
	id:     ElementId,
	editor: Entity<Editor>,
	state:  InteractiveState,
	rows:   usize,
}

impl TextArea {
	/// Creates a text area over `editor`, which holds the value and the
	/// placeholder it draws when empty.
	#[must_use]
	pub fn new(id: impl Into<ElementId>, editor: Entity<Editor>) -> Self {
		Self { id: id.into(), editor, state: InteractiveState::default(), rows: 4 }
	}

	/// Sets interactive state.
	#[must_use]
	pub fn state(mut self, state: InteractiveState) -> Self {
		self.state = state;
		self
	}

	/// Sets initial row count height.
	#[must_use]
	pub fn rows(mut self, rows: usize) -> Self {
		self.rows = rows.max(1);
		self
	}
}

impl RenderOnce for TextArea {
	fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
		let resolved_tokens = TokenSet::for_app(cx);
		let tokens: &TokenSet = &resolved_tokens;

		let is_entity_focused = self.editor.read(cx).focus_handle().is_focused(window);

		let (bg, border_color, fg) = match self.state {
			InteractiveState::Disabled => (
				tokens.color(ColorRole::Inset),
				tokens.color(ColorRole::Hairline),
				tokens.color(ColorRole::Muted),
			),
			InteractiveState::Focused => (
				tokens.color(ColorRole::Inset),
				tokens.color(ColorRole::Focus),
				tokens.color(ColorRole::Foreground),
			),
			_ if is_entity_focused => (
				tokens.color(ColorRole::Inset),
				tokens.color(ColorRole::Focus),
				tokens.color(ColorRole::Foreground),
			),
			_ => (
				tokens.color(ColorRole::Inset),
				tokens.color(ColorRole::Hairline),
				tokens.color(ColorRole::Foreground),
			),
		};

		let pad_x = tokens.spacing(SpacingStep::S3);
		let pad_y = tokens.spacing(SpacingStep::S2);
		let radius = tokens.radius(RadiusStep::Md);
		let font_size = tokens.font_size(TextRamp::Body);
		let line_h = tokens.line_height(TextRamp::Body);

		let id = self.id;
		let container = div()
			.id(id)
			.w_full()
			.bg(bg)
			.rounded(radius)
			.border_1()
			.border_color(border_color)
			.px(pad_x)
			.py(pad_y)
			.text_size(font_size)
			.line_height(line_h)
			.text_color(fg)
			.overflow_hidden();

		container.child(self.editor)
	}
}
